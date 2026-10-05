/**
 * Auto-rotate agy accounts on 429 QUOTA_EXHAUSTED.
 *
 * One pass (`check`), run every ~15 s by `watch`:
 *   1. Read new bytes of every recent agy log (~/.gemini/antigravity-cli/log/cli-*.log, one per
 *      agy process) and record each QUOTA_EXHAUSTED as exhausted[email][model] = reset time.
 *      The email is the log's "authenticated successfully as <email>".
 *   2. For a live agy process whose log has a fresh 429 (≤ FRESH_MS) on an account that is still
 *      exhausted for that model: if agy's slot holds an exhausted account, switch it to the next
 *      OmniRoute account (priority order) not exhausted for the model; then stop the process and
 *      relaunch it in its Orca terminal (ORCA_TERMINAL_HANDLE from its environment) with
 *      `--conversation <id>`, and tell it to retry.
 *   3. No account left → tell the worker once that every account is out until <reset>, so it
 *      takes the fallback its contract names.
 *
 * An account Google wants re-verified (403 VALIDATION_REQUIRED, "Verify your account to
 * continue") or calls ineligible (age, location) counts as out for every model for INVALID_MS; it is caught in agy logs and by
 * `probe` before each switch. OmniRoute is no judge here: it still serves such accounts.
 *
 * State: ~/.agents/logs/agy-rotate-state.json. Events: ~/.agents/logs/agy-rotate.jsonl.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { omniAccounts, currentEmail, switchTo } from './accounts.mjs';

const LOG_DIR = path.join(os.homedir(), '.gemini', 'antigravity-cli', 'log');
const CONV_DIR = path.join(os.homedir(), '.gemini', 'antigravity-cli', 'conversations');
const AGENTS_LOGS = path.join(os.homedir(), '.agents', 'logs');
export const STATE_FILE = path.join(AGENTS_LOGS, 'agy-rotate-state.json');
export const EVENTS_FILE = path.join(AGENTS_LOGS, 'agy-rotate.jsonl');
const FRESH_MS = 10 * 60_000;
const LOG_WINDOW_MS = 12 * 3600_000;
const DEFAULT_RESET_MS = 3600_000;
const INVALID_MS = 24 * 3600_000;
const PROBE_URL = 'https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary';
const TRUST_PROMPT = 'Do you trust the contents of this project?';
// Body lines after the "429 Too Many Requests" line that hold reason / model / reset.
const BODY_WINDOW = 2500;
// agy flags kept on relaunch, with whether each takes a value. Prompts are never replayed.
const KEEP_FLAGS = {
  '--dangerously-skip-permissions': false, '--sandbox': false, '--model': true, '--effort': true,
  '--mode': true, '--agent': true, '--project': true, '--add-dir': true,
};

/** glog prefix "E1005 02:23:33.092018" → local Date (the year is not logged). */
function glogTime(line, year) {
  const m = line.match(/^[IWEF](\d\d)(\d\d) (\d\d):(\d\d):(\d\d)/);
  return m ? new Date(year, +m[1] - 1, +m[2], +m[3], +m[4], +m[5]) : null;
}

function parseDelay(s) {
  const m = String(s || '').match(/^(?:(\d+)h)?(?:(\d+)m)?(?:([\d.]+)s)?$/);
  return m && (m[1] || m[2] || m[3]) ? ((+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0)) * 1000 : null;
}

/**
 * QUOTA_EXHAUSTED events in a log chunk. `consumed` stops before a 429 whose body is not fully
 * in the chunk yet, so the next pass reads it whole.
 */
export function parseQuotaEvents(text, { year = new Date().getFullYear() } = {}) {
  const events = [];
  let consumed = text.length;
  const re = /^E\d{4} [^\n]*429 Too Many Requests[^\n]*$/gm;
  for (let m; (m = re.exec(text));) {
    const body = text.slice(m.index, m.index + BODY_WINDOW);
    const end = body.search(/\n\}\n/);
    if (end < 0) {
      if (text.length - m.index < BODY_WINDOW) { consumed = m.index; break; }
      continue;
    }
    const json = body.slice(0, end + 2);
    if (!/"reason":\s*"QUOTA_EXHAUSTED"/.test(json)) continue;
    const at = glogTime(m[0], year);
    const model = (json.match(/"model":\s*"([^"]+)"/) || [])[1] || 'unknown';
    const stamp = (json.match(/"quotaResetTimeStamp":\s*"([^"]+)"/) || [])[1];
    const delay = parseDelay((json.match(/"quotaResetDelay":\s*"([^"]+)"/) || [])[1]);
    const resetAt = stamp ? new Date(stamp) : new Date((at || new Date()).getTime() + (delay ?? DEFAULT_RESET_MS));
    events.push({ at: at && at.toISOString(), model, resetAt: resetAt.toISOString() });
  }
  return { events, consumed };
}

/**
 * Times of lines saying Google will not let agy in with this account: 403 VALIDATION_REQUIRED
 * ("Verify your account to continue") or "Account ineligible" (age, location).
 */
export function parseInvalidEvents(text, { year = new Date().getFullYear() } = {}) {
  const out = [];
  for (const m of text.matchAll(/^[EW]\d{4} [^\n]*(?:VALIDATION_REQUIRED|Verify your account to continue|Account ineligible)[^\n]*$/gm)) {
    const at = glogTime(m[0], year);
    if (at) out.push({ at: at.toISOString() });
  }
  return out;
}

/** Last signed-in email and last active conversation id in a log chunk. */
export function logFacts(text) {
  const last = (re) => { let v = null; for (const m of text.matchAll(re)) v = m[1]; return v; };
  return {
    email: last(/authenticated successfully as (\S+)/g),
    conversation: last(/(?:Created conversation|found conversation) ([0-9a-f-]{36})/g),
  };
}

/** agy argv (from ps) → the relaunch command for the same conversation (`cd cwd` first when given). */
export function relaunchCommand(argv, conversation, cwd) {
  const words = String(argv).trim().split(/\s+/);
  const keep = [];
  for (let i = 1; i < words.length; i++) {
    const [flag, inline] = words[i].split(/=(.*)/s);
    if (!(flag in KEEP_FLAGS)) continue;
    if (!KEEP_FLAGS[flag]) keep.push(flag);
    else if (inline !== undefined) keep.push(`${flag}=${inline}`);
    else if (i + 1 < words.length) keep.push(flag, words[++i]);
  }
  const q = (s) => (/^[\w./:=@%+-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);
  const cmd = `agy ${[...keep, '--conversation', conversation].map(q).join(' ')}`;
  return cwd ? `cd ${q(cwd)} && ${cmd}` : cmd;
}

/** Out for `model` (or, for "*", only when it needs re-verification). */
const isExhausted = (state, email, model, now) => {
  const bad = state.invalid?.[email];
  if (bad && Date.parse(bad) > now) return true;
  const t = model === '*' ? null : state.exhausted?.[email]?.[model];
  return !!t && Date.parse(t) > now;
};

/**
 * Highest-priority usable account not out for `model`, or null. For "*" (the last one needed
 * re-verification, so the failing model is unknown) an account with no live exhaustion wins.
 */
export function nextAccount(accounts, state, model, now = Date.now()) {
  const usable = accounts.filter((a) => a.active && a.refreshToken && a.email && !isExhausted(state, a.email, model, now));
  if (model !== '*') return usable[0] || null;
  const clean = (a) => !Object.values(state.exhausted?.[a.email] || {}).some((t) => Date.parse(t) > now);
  return usable.find(clean) || usable[0] || null;
}

/** Earliest reset among exhausted accounts for `model`. */
function earliestReset(accounts, state, model) {
  const ts = accounts.map((a) => state.exhausted?.[a.email]?.[model] || state.invalid?.[a.email]).filter(Boolean).sort();
  return ts[0] || null;
}

/** Probe every account and record the ones that need re-verification. */
export async function probeAll(accounts) {
  const state = loadState();
  const out = {};
  for (const a of accounts) {
    out[a.email] = await probe(a);
    if (out[a.email] === 'invalid') state.invalid[a.email] = new Date(Date.now() + INVALID_MS).toISOString();
    else if (out[a.email] === 'ok') delete state.invalid[a.email];
  }
  saveState(state);
  return out;
}

export function loadState(file = STATE_FILE) {
  const empty = { offsets: {}, emails: {}, exhausted: {}, invalid: {}, handled: {}, told: {} };
  try { return { ...empty, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch {
    return empty;
  }
}

function saveState(state, file = STATE_FILE) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(state, null, 1));
  fs.renameSync(`${file}.tmp`, file);
}

function event(row) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...row });
  fs.mkdirSync(AGENTS_LOGS, { recursive: true });
  fs.appendFileSync(EVENTS_FILE, `${line}\n`);
  console.log(line);
}

const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], ...opts });

/** Live agy processes with their Orca terminal, cwd, argv and log file. */
function agyProcesses() {
  let pids = [];
  try { pids = sh('pgrep', ['-x', 'agy']).trim().split('\n').filter(Boolean).map(Number); } catch { return []; }
  return pids.map((pid) => {
    const p = { pid, handle: null, cwd: null, shellCwd: null, argv: '', log: null };
    try { p.argv = sh('ps', ['-o', 'command=', '-p', String(pid)]).trim(); } catch { /* exited */ }
    try { p.handle = (sh('ps', ['-E', '-ww', '-o', 'command=', '-p', String(pid)]).match(/ORCA_TERMINAL_HANDLE=(\S+)/) || [])[1] || null; } catch { /* exited */ }
    try {
      const out = sh('lsof', ['-p', String(pid), '-Fn']);
      p.log = (out.match(/^n(\S*\/antigravity-cli\/log\/cli-[^\n]+\.log)$/m) || [])[1] || null;
    } catch { /* exited */ }
    const cwdOf = (id) => { try { return (sh('lsof', ['-a', '-p', String(id), '-d', 'cwd', '-Fn']).match(/^n(.+)$/m) || [])[1] || null; } catch { return null; } };
    p.cwd = cwdOf(pid);
    try { p.shellCwd = cwdOf(Number(sh('ps', ['-o', 'ppid=', '-p', String(pid)]).trim())); } catch { /* exited */ }
    return p;
  });
}

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function terminalSend(handle, text, extra = []) {
  sh('orca', ['terminal', 'send', '--terminal', handle, '--text', text, '--enter', ...extra, '--json'], { timeout: 60_000 });
}

const screenTail = (handle) => {
  try { return sh('orca', ['terminal', 'read', '--terminal', handle], { timeout: 30_000 }).split('\n').slice(-15).join('\n'); } catch { return ''; }
};

/**
 * Does Google still let agy in with this account? "ok" | "invalid" | "unknown".
 * agy's own endpoint answers an empty retrieveUserQuotaSummary with 403 VALIDATION_REQUIRED for
 * an account that needs re-verification, and 403 SUBSCRIPTION_REQUIRED (missing project) for a
 * good one: verification is checked first. Uses the access token OmniRoute keeps fresh.
 */
export async function probe(account) {
  if (!account.accessToken || !account.expiry || Date.parse(account.expiry) < Date.now() + 30_000) return 'unknown';
  try {
    const r = await fetch(PROBE_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${account.accessToken}`, 'Content-Type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(30_000),
    });
    const body = await r.text();
    if (r.status === 403 && /VALIDATION_REQUIRED/.test(body)) return 'invalid';
    return r.status === 401 ? 'unknown' : 'ok';
  } catch {
    return 'unknown';
  }
}

async function restartWorker(p, conversation, note) {
  process.kill(p.pid, 'SIGTERM');
  for (let i = 0; i < 30 && alive(p.pid); i++) await sleep(500);
  if (alive(p.pid)) process.kill(p.pid, 'SIGKILL');
  await sleep(1500);
  // The shell that launched agy normally still sits in its folder; only cd when it does not
  // (lsof gives real paths, and agy's folder trust is keyed by the path it was started from).
  terminalSend(p.handle, relaunchCommand(p.argv, conversation, p.shellCwd === p.cwd ? null : p.cwd));
  // Wait for the input box; accept the folder-trust dialog if this path was never trusted.
  for (let i = 0; i < 45; i++) {
    await sleep(2000);
    const tail = screenTail(p.handle);
    if (tail.includes(TRUST_PROMPT) && !/^\s*>\s*$/m.test(tail.split(TRUST_PROMPT).pop().split('Confirm').pop())) {
      terminalSend(p.handle, '');
      continue;
    }
    if (/^>\s*$/m.test(tail)) break;
  }
  await sleep(1500);
  terminalSend(p.handle, note, ['--wait-submit', '15']);
}

/** One rotation pass. Returns the actions taken (or planned, with dryRun). */
export async function check({ dryRun = false, now = Date.now() } = {}) {
  const state = loadState();
  const year = new Date(now).getFullYear();
  const fresh = []; // { log, email, model, resetAt }

  // 1. Learn exhaustion from new log bytes.
  let files = [];
  try { files = fs.readdirSync(LOG_DIR).filter((f) => /^cli-.*\.log$/.test(f)).map((f) => path.join(LOG_DIR, f)); } catch { /* no agy */ }
  for (const file of files) {
    let st;
    try { st = fs.statSync(file); } catch { continue; }
    if (now - st.mtimeMs > LOG_WINDOW_MS) { delete state.offsets[file]; delete state.emails[file]; continue; }
    const from = Math.min(state.offsets[file] || 0, st.size);
    if (from === st.size) continue;
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(st.size - from);
    fs.readSync(fd, buf, 0, buf.length, from);
    fs.closeSync(fd);
    const text = buf.toString('latin1'); // 1 byte = 1 char, so offsets stay byte offsets
    const facts = logFacts(text);
    if (facts.email) state.emails[file] = facts.email;
    const { events, consumed } = parseQuotaEvents(text, { year });
    state.offsets[file] = from + consumed;
    const email = state.emails[file];
    if (!email) continue;
    for (const e of parseInvalidEvents(text, { year })) {
      const until = new Date(Date.parse(e.at) + INVALID_MS).toISOString();
      if (!state.invalid[email] || state.invalid[email] < until) state.invalid[email] = until;
      if (now - Date.parse(e.at) <= FRESH_MS) fresh.push({ log: file, email, model: '*' });
    }
    for (const e of events) {
      const known = state.exhausted[email]?.[e.model];
      if (!known || known < e.resetAt) (state.exhausted[email] ||= {})[e.model] = e.resetAt;
      if (e.at && now - Date.parse(e.at) <= FRESH_MS) fresh.push({ log: file, email, model: e.model, resetAt: e.resetAt });
    }
  }
  for (const [email, models] of Object.entries(state.exhausted)) {
    for (const [model, t] of Object.entries(models)) if (Date.parse(t) <= now) delete models[model];
    if (!Object.keys(models).length) delete state.exhausted[email];
  }
  for (const [email, t] of Object.entries(state.invalid)) if (Date.parse(t) <= now) delete state.invalid[email];

  // 2. Rotate and relaunch the processes that hit it.
  const actions = [];
  const act = (a) => { actions.push(a); if (!dryRun) event(a); };
  const procs = agyProcesses();
  for (const pid of Object.keys(state.handled)) if (!procs.some((p) => String(p.pid) === pid)) delete state.handled[pid];
  for (const pid of Object.keys(state.told)) if (!procs.some((p) => String(p.pid) === pid)) delete state.told[pid];
  const hits = new Map();
  for (const f of fresh) {
    const p = procs.find((x) => x.log === f.log);
    if (p && !state.handled[p.pid] && isExhausted(state, f.email, f.model, now)) hits.set(p.pid, { p, ...f });
  }
  let accounts = null;
  for (const { p, email, model } of hits.values()) {
    accounts ||= omniAccounts();
    const conversation = logFacts(fs.readFileSync(p.log, 'latin1')).conversation;
    const base = { pid: p.pid, terminal: p.handle, from: email, model };
    if (!p.handle || !p.cwd || !conversation || !fs.existsSync(path.join(CONV_DIR, `${conversation}.db`))) {
      act({ ...base, action: 'skip', why: !p.handle ? 'not in an Orca terminal' : !conversation ? 'no conversation id in its log' : 'no cwd / conversation db' });
      state.handled[p.pid] = new Date(now).toISOString();
      continue;
    }
    let slot = currentEmail(accounts);
    if (!slot || isExhausted(state, slot, model, now)) {
      let next;
      while ((next = nextAccount(accounts, state, model, now)) && !dryRun) {
        if ((await probe(next)) !== 'invalid') break;
        state.invalid[next.email] = new Date(now + INVALID_MS).toISOString();
        act({ action: 'needs-verification', account: next.email, until: state.invalid[next.email] });
      }
      if (!next) {
        const until = earliestReset(accounts, state, model);
        if (!state.told[p.pid]) {
          act({ ...base, action: 'all-exhausted', until });
          if (!dryRun) {
            const what = model === '*' ? 'is blocked by Google (verification / eligibility)' : `is out of quota for ${model}`;
            terminalSend(p.handle, `agy-rotate: every usable Antigravity account ${what} until ${until}. Do not retry on Antigravity; take the fallback your task contract names, or report blocked to the coordinator.`);
            state.told[p.pid] = new Date(now).toISOString();
          }
        }
        continue;
      }
      if (!dryRun) switchTo(next, accounts);
      act({ ...base, action: 'switch', to: next.email });
      slot = next.email;
    }
    act({ ...base, action: 'restart', to: slot, conversation, command: relaunchCommand(p.argv, conversation, p.shellCwd === p.cwd ? null : p.cwd) });
    if (!dryRun) {
      state.handled[p.pid] = new Date(now).toISOString();
      saveState(state);
      await restartWorker(p, conversation,
        `agy-rotate: ${model === '*' ? `Google blocks ${email} (verification / eligibility)` : `Antigravity quota for ${model} ran out on ${email}`}; this CLI was restarted on ${slot} with the same conversation. Retry the step that failed and continue your task, then run: orca orchestration check --json`);
    }
  }
  if (!dryRun) saveState(state);
  return { actions, exhausted: state.exhausted, procs };
}

/** Loop `check` forever; one failed pass never stops the loop. */
export async function watch({ intervalMs = 15_000 } = {}) {
  event({ action: 'watch-start', intervalMs });
  for (;;) {
    try { await check(); } catch (e) { event({ action: 'error', error: String(e?.message || e) }); }
    await sleep(intervalMs);
  }
}
