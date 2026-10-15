#!/usr/bin/env node
/**
 * orca-wait.mjs — the one way the coordinator and the producer wait (M2 of
 * docs/plans/2026-10-01-coordinator-token-optimization). Runs in the foreground, never past --max-ms
 * (default 540000, under Claude Code's 600000 Bash cap), and prints ONE JSON line on stdout.
 *
 *   orca-wait.mjs coord [--ack <delivery_id>] [--run <run_id>] [--types worker_done,escalation,question] [--max-ms N]
 *     → {"delivery","count","messages":[{id,type,from,subject,task,dispatch,outcome,body}],"full":<path>} | {"timeout":true}
 *       Bodies are cut to 2 lines; the whole Delivery is in `full` — read it before answering a question
 *       or an escalation. Keepalives are swallowed (they would only cost tokens).
 *
 *   orca-wait.mjs lane --handoff <HANDOFF.json> --state <file> (--run <run_id> | --handle <h>) [--max-ms N] [--chunk-ms N]
 *     Fleet lanes pass --run: the coordinator handle is re-read from run-show every chunk, because a
 *     takeover replaces it. Returns on the first of: lane terminal idle, HANDOFF.json changed, a pending
 *     gate on the Run, the terminal gone (`terminal-missing`), orca itself failing (`orca-error`), or
 *     --max-ms (`timeout`, a checkpoint). --max-ms is clamped to 570000 (ORCA_WAIT_CAP_MS).
 *     → {"event","handle","handle_changed","status","detail","sha","handoff_changed","idle_streak",
 *        "pending_gates","unread_to_run","waited_ms"}
 *     pending_gates carry each gate's whole question (up to GATE_CHARS): the producer relays it to the
 *     director, who must see all of it to decide (the runner's dialog showed a 200-char cut, 2026-10-04).
 *     --state keeps idle_streak / last HANDOFF mtime across calls and restarts; keep it in the main
 *     checkout (T-<Sxx>/producer-state.json), never in the lane's evidence dir.
 *
 *     An idle terminal whose screen shows live background work (Claude Code: "2 monitors still running", footer
 *     "· 2 monitors", "1 shell") is reported with idle_streak 0 and "background":"2 monitors": the agent ended its
 *     turn between Monitor events, it is not stalled. The same screen unchanged for ORCA_WAIT_BG_STUCK_MS (45 min)
 *     counts as idle again ("background_stuck":true), and so does background work seen continuously for
 *     ORCA_WAIT_BG_MAX_MS (4 h), whatever the screen does (a ticking status line).
 *
 *     Orca's tui-idle can also fire while the agent is mid-turn (pilot 24: S03 q1, S17 q13, S30 q17 — Claude Code
 *     showing "· Bloviating… (28m 36s · ↓ 183.9k tokens)" over a foreground Bash "(ctrl+b to run in background)"):
 *     the runner then nudged a busy writer and Orca refused the send. An idle answer whose screen still shows a
 *     running spinner, a foreground tool or "esc to interrupt" is overruled: the wait goes on, and the result
 *     counts it as "idle_overruled".
 *
 *     A terminal that stays busy is not always working (pilot 24, cc-capytal-war S27): a Claude writer whose context
 *     grew to ~309k spent 3h46m on "Request timed out · Retrying in 0s · attempt 4/9" while the spinner kept the TUI
 *     busy. Every timeout result carries "busy_ms" (busy since the last idle / HANDOFF / handle change), and when
 *     the screen has shown request retries on every look for ORCA_WAIT_RETRY_STALL_MS (10 min),
 *     "stall":{"reason":"request timeouts","minutes":N,"line":"…"}. The runner decides what to do with it.
 *
 *     While it waits, coord also rescues lost Enters (pilot 18 F3): `worker-start` can paste the brief into a
 *     Claude Code TUI and lose the Enter, leaving the dispatch `dispatched` with no heartbeat forever. Every
 *     ~30 s it looks at the Run's dispatches; one that is `dispatched`, has `last_heartbeat_at` null and is
 *     older than 45 s gets its assignee read, and if the screen starts with `draft:` ONE bare
 *     `orca terminal send --enter`, at most once per dispatch id (kept in --state, default
 *     <TMPDIR>/orca-wait/<run>/draft-state.json). Reported as "draft_submitted":[{handle,dispatch,task}] on the
 *     result. Every orca call is bounded and a failing probe never breaks the wait.
 *
 * Every call also reports, only when something is wrong: a stale orca cheatsheet, and (for a session
 * launched with --role) a coordinator guard that never logged this very call.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_MAX_MS = 540000;
const CAP_MS = Number(process.env.ORCA_WAIT_CAP_MS) || 570000; // under Claude Code's 600000 Bash cap, whatever the caller asks

function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  const v = {};
  for (let i = 0; i < rest.length; i++) {
    if (!rest[i].startsWith('--')) fail(`unexpected argument ${rest[i]}`);
    const key = rest[i].slice(2);
    const val = rest[i + 1];
    if (val === undefined || val.startsWith('--')) fail(`--${key} needs a value`);
    v[key] = val;
    i++;
  }
  return { cmd, v };
}

function fail(msg, code = 2) {
  process.stdout.write(JSON.stringify({ error: msg }) + '\n');
  process.exit(code);
}

function orcaJson(args, timeoutMs) {
  const r = spawnSync('orca', [...args, '--json'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    ...(timeoutMs ? { timeout: timeoutMs } : {}),
  });
  if (r.error?.code === 'ENOENT') fail('orca is not on PATH');
  let parsed = null;
  try {
    parsed = JSON.parse(r.stdout);
  } catch {
    /* non-JSON output */
  }
  return { status: r.status, parsed, stderr: r.stderr || '' };
}

const maxMs = (v) => {
  const n = Number(v['max-ms'] || DEFAULT_MAX_MS);
  if (!(n > 0)) fail('--max-ms must be a positive number');
  return Math.min(n, CAP_MS);
};

/** A gate question for the producer: every non-empty line (joined with " / "), cut only past this many characters. */
const GATE_CHARS = 4000;

function firstLines(text, n = 2, cap = 200) {
  const s = String(text || '').split('\n').filter((l) => l.trim()).slice(0, n).join(' / ');
  return s.length > cap ? `${s.slice(0, cap)}…` : s;
}

/** Last `bytes` of a file (the guard log only grows; never read it whole). */
function tail(file, bytes = 65536) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const buf = Buffer.alloc(Math.min(bytes, size));
    fs.readSync(fd, buf, 0, buf.length, size - buf.length);
    return buf.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

/** Problems worth a line in the result: stale cheatsheet, guard not running. Never fatal. */
function healthNotes(startedAt) {
  const notes = {};
  const check = spawnSync(process.execPath, [path.join(HERE, 'gen-orca-cheatsheet.mjs'), '--check'], { encoding: 'utf8' });
  if (check.status === 1) notes.cheatsheet = check.stdout.trim();
  if (process.env.CC_ROLE && (process.env.CC_GUARD_MODE || 'shadow') !== 'off') {
    const log = process.env.CC_GUARD_LOG || path.join(os.homedir(), '.agents', 'logs', 'coordinator-guard.jsonl');
    let seen = false;
    try {
      // the hook logged this call before it started, so look back from the start, not from now
      const since = startedAt - 60000;
      seen = tail(log).split('\n').some((l) => {
        try {
          const e = JSON.parse(l);
          return Date.parse(e.ts) >= since && /orca-wait/.test(e.cmd || '') && (!process.env.CC_PROJECT || e.project === process.env.CC_PROJECT);
        } catch {
          return false;
        }
      });
    } catch {
      /* no log yet */
    }
    // the hook runs before this command, so a working guard has just logged it
    if (!seen) notes.guard = 'inactive → layer-1 only (no guard log entry for this call)';
  }
  return notes;
}

const DRAFT_AGE_MS = Number(process.env.ORCA_WAIT_DRAFT_AGE_MS ?? 45000);
const PROBE_MS = Number(process.env.ORCA_WAIT_PROBE_MS) || 30000;
const PROBE_CALL_MS = 15000;

function toMs(t) {
  if (t == null || t === '') return NaN;
  if (typeof t === 'number' || /^\d+(\.\d+)?$/.test(String(t))) {
    const n = Number(t);
    return n < 1e12 ? n * 1000 : n;
  }
  const str = String(t);
  // dispatch-show prints UTC without a zone ("2026-10-09 17:08:12"); Date.parse would read it as local time
  return Date.parse(/^\d{4}-\d\d-\d\d[ T]\d\d:\d\d(:\d\d(\.\d+)?)?$/.test(str) ? `${str.replace(' ', 'T')}Z` : str);
}

/** All text in a terminal-read result, whatever the key (tail, lines, text ...). */
function textOf(x, depth = 0) {
  if (typeof x === 'string') return x;
  if (depth > 4 || x == null) return '';
  if (Array.isArray(x)) return x.map((e) => textOf(e, depth + 1)).join('\n');
  if (typeof x === 'object') return Object.values(x).map((e) => textOf(e, depth + 1)).filter(Boolean).join('\n');
  return '';
}

/**
 * Pilot 18 F3: submit a pasted-but-unsent worker brief. Returns the [{handle,dispatch,task}] it nudged.
 * Dispatches of the bound Run that are `dispatched`, never heartbeated and older than DRAFT_AGE_MS get their
 * assignee read; a screen whose first line starts with `draft:` gets one bare Enter, once per dispatch id.
 */
function rescueDrafts(run, stateFile) {
  const done = [];
  try {
    const st = readState(stateFile);
    const sent = new Set(st.draft_enter_sent || []);
    const tl = orcaJson(['orchestration', 'task-list', ...(run ? ['--run', run] : [])], PROBE_CALL_MS);
    const tr = tl.parsed?.result;
    const tasks = Array.isArray(tr) ? tr : tr?.tasks || [];
    for (const t of tasks) {
      if (/^(pending|ready|completed|done|failed|cancell?ed|blocked)$/i.test(String(t.status || ''))) continue;
      const ds = orcaJson(['orchestration', 'dispatch-show', '--task', t.id], PROBE_CALL_MS).parsed?.result;
      const list = Array.isArray(ds) ? ds : ds?.dispatches || [ds?.dispatch || ds?.context || ds].filter(Boolean);
      for (const d of list) {
        const id = d.id || d.dispatch_id;
        const handle = d.assignee_handle || d.assignee || d.terminal_handle || d.worker_handle;
        const age = Date.now() - toMs(d.dispatched_at);
        if (!id || !handle || d.status !== 'dispatched' || d.last_heartbeat_at || !(age >= DRAFT_AGE_MS) || sent.has(id)) continue;
        const rd = orcaJson(['terminal', 'read', '--terminal', handle], PROBE_CALL_MS);
        // `terminal read --json` carries the unsent input as result.terminal.draft (the text view prints `draft: "…"`)
        const term = rd.parsed?.result?.terminal ?? rd.parsed?.result;
        const draft = typeof term?.draft === 'string' ? term.draft.trim() : /^\s*draft:/.test(textOf(term?.tail).split('\n').find((l) => l.trim()) || '');
        if (!draft) continue;
        sent.add(id); // once per dispatch, even when the send fails: no Enter storms
        const se = spawnSync('orca', ['terminal', 'send', '--terminal', handle, '--enter', '--json'], { encoding: 'utf8', timeout: PROBE_CALL_MS });
        if (se.status === 0) done.push({ handle, dispatch: id, task: t.id });
      }
    }
    if (sent.size !== (st.draft_enter_sent || []).length) {
      fs.mkdirSync(path.dirname(path.resolve(stateFile)), { recursive: true });
      fs.writeFileSync(`${stateFile}.tmp`, JSON.stringify({ ...st, draft_enter_sent: [...sent] }, null, 1));
      fs.renameSync(`${stateFile}.tmp`, stateFile);
    }
  } catch {
    /* a failing probe never breaks the wait */
  }
  return done;
}

function coord(v) {
  const limit = maxMs(v);
  const started = Date.now();
  const deadline = started + limit;
  const stateFile = v.state || path.join(process.env.TMPDIR || os.tmpdir(), 'orca-wait', String(v.run || 'bound'), 'draft-state.json');
  const drafts = [];
  let ack = v.ack;
  for (;;) {
    drafts.push(...rescueDrafts(v.run, stateFile));
    const slice = Math.max(1000, Math.min(PROBE_MS, deadline - Date.now()));
    const t0 = Date.now();
    const out = coordCheck(v, ack, slice, started);
    ack = undefined; // consumed by the first check
    if (!out.timeout || Date.now() + 1000 >= deadline) {
      return drafts.length ? { ...out, draft_submitted: drafts } : out;
    }
    // a check that timed out early (fakes, a restarted runtime) must not spin
    const pause = Math.min(slice - (Date.now() - t0), deadline - Date.now());
    if (pause > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, pause);
  }
}

function coordCheck(v, ackId, limit, started) {
  const args = ['orchestration', 'check'];
  if (ackId) args.push('--ack', ackId);
  if (v.run) args.push('--run', v.run);
  args.push('--wait', '--types', v.types || 'worker_done,escalation,question', '--timeout-ms', String(limit));
  const r = orcaJson(args, limit + 30000);
  const res = r.parsed?.result;
  // the documented shape is result.timedOut; an ok:false error whose code is a wait timeout is the same
  // checkpoint (the code only: ETIMEDOUT and other runtime failures stay errors)
  if (!res && /^(?:timeout|timed_out|wait_timeout)$/i.test(String(r.parsed?.error?.code || ''))) {
    return { timeout: true, waited_ms: Date.now() - started };
  }
  if (r.status !== 0 || !res) {
    return { error: (r.parsed?.error?.message || r.stderr.split('\n').filter((l) => l.trim() && !l.includes('_keepalive')).pop() || `orca exited ${r.status}`).slice(0, 300) };
  }
  if (res.timedOut || !res.count) return { timeout: true, waited_ms: Date.now() - started };
  const dir = path.join(process.env.TMPDIR || os.tmpdir(), 'orca-wait', String(res.runId || v.run || 'bound'));
  fs.mkdirSync(dir, { recursive: true });
  const full = path.join(dir, `${res.deliveryId}.json`);
  fs.writeFileSync(full, JSON.stringify(res, null, 1));
  const messages = (res.messages || []).map((m) => {
    let p = {};
    try {
      p = typeof m.payload === 'string' ? JSON.parse(m.payload) : m.payload || {};
    } catch {
      /* free-form payload */
    }
    return {
      id: m.id, type: m.type, from: m.from_handle, subject: m.subject || '',
      task: p.taskId || null, dispatch: p.dispatchId || null, outcome: p.outcome || null,
      body: firstLines(m.body),
    };
  });
  return { delivery: res.deliveryId, count: res.count, replayed: Boolean(res.replayed), messages, full };
}

function readState(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

function readHandoff(file) {
  try {
    const st = fs.statSync(file);
    const d = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { mtime: st.mtimeMs, status: d.status ?? null, detail: firstLines(d.detail, 1, 240), sha: d.sha ?? null };
  } catch {
    return { mtime: null, status: null, detail: '', sha: null };
  }
}

// pilot 23 (cc-capytal-war S06): a Claude Code writer that waits on `Monitor` / run_in_background work ends its turn
// between events. The TUI is idle then, but the screen says "N monitors still running" and the footer "· N monitors"
// (also "N shells", "· N background agents"). That is a working agent, not a stalled one: the runner nudged and respawned it
// (killing the monitors) twice. The idle streak is held while such a screen keeps changing; one that stays
// byte-identical for BG_STUCK_MS counts as idle again, so a truly stuck agent is still caught.
const BG_STUCK_MS = Number(process.env.ORCA_WAIT_BG_STUCK_MS ?? 45 * 60 * 1000);
const RETRY_STALL_MS = Number(process.env.ORCA_WAIT_RETRY_STALL_MS ?? 10 * 60 * 1000);
// a request the agent's client keeps retrying (Claude Code: "Request timed out · Retrying in 0s · attempt 4/9")
// (not a bare "attempt 2/5": a script the agent runs may print that)
const RETRY_LINE = /Request timed out|Retrying in \d+\s*s\b|API Error:? \(?(?:Request timed out|Overloaded|5\d\d)|overloaded_error/i;
const BG_MAX_MS = Number(process.env.ORCA_WAIT_BG_MAX_MS ?? 4 * 60 * 60 * 1000); // ticking status lines can keep the screen "changing": a hard ceiling
const BG_UNIT = '\\d+ (?:monitors?|shells?|background (?:tasks?|shells?|commands?))';
const BG_WORK = new RegExp(`(?:[·←]\\s*${BG_UNIT}\\b|^\\s*${BG_UNIT}\\s*(?:[·←↓]|$)|\\b${BG_UNIT} still running)`, 'i'); // footer "· 2 monitors" / "1 shell · ↓ to manage" / status "2 monitors still running", not prose
// "← 1 agent" is on every Orca worker's footer, idle or not (pilot 23 S10: it held a finished writer for 45 min): never count it
const BG_AGENTS = /·\s*\d+ (?:local |background )agents?\b/;

// a turn in progress (Claude Code): a spinner verb with "…" and a running clock, a foreground tool, the interrupt hint.
// A finished turn reads "✻ Baked for 3s" (no ellipsis, no clock in parentheses).
const BUSY_LINE = /^\s*\S\s+[A-Z][\w-]*(?:…|\.\.\.)\s*\((?:\d+h\s*)?(?:\d+m\s*)?\d+s\b|\(ctrl\+b to run in background\)|\besc to interrupt\b/;

/** A busy line among the last screen lines of a terminal Orca just called idle → the line | null. A failing probe is null. */
function busyScreen(handle) {
  try {
    const rd = orcaJson(['terminal', 'read', '--terminal', handle], PROBE_CALL_MS);
    const term = rd.parsed?.result?.terminal ?? rd.parsed?.result;
    const lines = textOf(term?.tail).split('\n').filter((l) => l.trim()).slice(-12);
    const hit = lines.find((l) => BUSY_LINE.test(l));
    return hit ? hit.trim().slice(0, 160) : null;
  } catch {
    return null;
  }
}

/** A request-retry line among a busy terminal's last screen lines → the line | null. A failing probe is null. */
function retryingScreen(handle) {
  try {
    const rd = orcaJson(['terminal', 'read', '--terminal', handle], PROBE_CALL_MS);
    const term = rd.parsed?.result?.terminal ?? rd.parsed?.result;
    const lines = textOf(term?.tail).split('\n').filter((l) => l.trim()).slice(-12);
    const hit = lines.find((l) => RETRY_LINE.test(l));
    return hit ? hit.trim().slice(0, 160) : null;
  } catch {
    return null;
  }
}

/** Live background work on an idle terminal's screen (the last lines: status line + footer). → { what, hash } | null */
function backgroundWork(handle) {
  try {
    const rd = orcaJson(['terminal', 'read', '--terminal', handle], PROBE_CALL_MS);
    const term = rd.parsed?.result?.terminal ?? rd.parsed?.result;
    const lines = textOf(term?.tail).split('\n').filter((l) => l.trim()).slice(-8);
    const what = [];
    for (const l of lines) {
      for (const m of [l.match(BG_WORK), l.match(BG_AGENTS)]) {
        const t = m && m[0].replace(/^[\s·←]+/, '').replace(/[\s·←↓]+$/, '');
        if (t && !what.includes(t)) what.push(t);
      }
    }
    return what.length ? { what: what.join(', '), hash: crypto.createHash('sha1').update(lines.join('\n')).digest('hex') } : null;
  } catch {
    return null; // a failing probe never breaks the wait
  }
}

function lane(v) {
  if (!v.handoff || !v.state) fail('lane needs --handoff <HANDOFF.json> and --state <file>');
  if (!v.run && !v.handle) fail('lane needs --run <run_id> (fleet) or --handle <h> (single lane)');
  const limit = maxMs(v);
  const chunk = Math.min(Number(v['chunk-ms'] || 60000), limit);
  const prev = readState(v.state);
  const started = Date.now();
  const deadline = started + limit;
  let handle = v.handle || null;
  let event = 'timeout';
  let pendingGates = [];
  let unread = null;
  let errorText = null;
  let staleRechecks = 0; // `terminal wait` said stale / not found but `terminal show` still found the terminal
  let missingWhy = null;
  let overruled = 0;
  let overruledLine = null;
  const before = readHandoff(v.handoff);
  // a HANDOFF written while the caller was busy elsewhere is news already: report it at once
  const baseMtime = prev.last_mtime !== undefined ? prev.last_mtime : before.mtime;
  if (before.mtime !== baseMtime) event = 'handoff';
  while (event === 'timeout' && Date.now() < deadline) {
    if (v.run) {
      const rs = orcaJson(['orchestration', 'run-show', '--id', v.run]);
      handle = rs.parsed?.result?.run?.coordinator_handle || handle;
      const gl = orcaJson(['orchestration', 'gate-list', '--run', v.run]);
      const gates = gl.parsed?.result?.gates || gl.parsed?.result || [];
      pendingGates = (Array.isArray(gates) ? gates : []).filter((g) => g.status === 'pending')
        .map((g) => ({ id: g.id, question: firstLines(g.question, Infinity, GATE_CHARS), options: g.options }));
      if (pendingGates.length) {
        event = 'gate';
        break;
      }
    }
    if (!handle) fail('no coordinator handle on the Run');
    const now = readHandoff(v.handoff);
    if (now.mtime !== baseMtime) {
      event = 'handoff';
      break;
    }
    const w = orcaJson(['terminal', 'wait', '--terminal', handle, '--for', 'tui-idle', '--timeout-ms', String(Math.max(1000, Math.min(chunk, deadline - Date.now())))], chunk + 30000);
    if (w.parsed?.result?.wait?.satisfied) {
      const busy = handle ? busyScreen(handle) : null;
      if (!busy) {
        event = 'idle';
        break;
      }
      // Orca called it idle, the screen says mid-turn: wait on (a short pause so a tight idle answer is not a hot loop)
      overruled += 1;
      overruledLine = busy;
      const pause = Math.min(5000, Math.max(0, deadline - Date.now()));
      if (pause) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, pause);
      continue;
    }
    if (w.status !== 0 && !/timed? ?out/i.test(JSON.stringify(w.parsed) + w.stderr)) {
      const why = JSON.stringify(w.parsed?.error || w.parsed || '') + w.stderr;
      // a stale or unknown handle is a gone terminal; anything else (runtime down, ECONNREFUSED) is not
      event = /stale|not[ _]found|unknown terminal|no such terminal/i.test(why) ? 'terminal-missing' : 'orca-error';
      if (event === 'orca-error') errorText = why.slice(0, 200);
      if (event === 'terminal-missing') {
        // pilots 5 and 6: `terminal wait` answered terminal_handle_stale for a live coordinator while
        // `terminal show` found it. Ask show first; only a terminal show cannot find (or an orphan) is gone.
        missingWhy = why.slice(0, 200);
        const sh = orcaJson(['terminal', 'show', '--terminal', handle], Math.min(30000, Math.max(2000, deadline - Date.now())));
        const t = sh.status === 0 ? sh.parsed?.result?.terminal : null;
        // same liveness rule as the runner's terminalAlive(): an orphan or a disconnected pane is closed
        if (t && t.orphaned !== true && t.connected !== false) {
          staleRechecks += 1;
          if (t.handle && t.handle !== handle) handle = t.handle; // Orca re-issued the handle
          event = 'timeout';
          const pause = Math.min(5000, Math.max(0, deadline - Date.now()));
          if (pause) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, pause);
          continue;
        }
      }
      break;
    }
  }
  if (v.run) {
    const ib = orcaJson(['orchestration', 'inbox', '--limit', '200']);
    unread = (ib.parsed?.result?.messages || []).filter((m) => m.to_handle === `run:${v.run}` && !m.read).length;
  }
  const after = readHandoff(v.handoff);
  const handoffChanged = after.mtime !== baseMtime;
  const handleChanged = Boolean(prev.handle && handle && prev.handle !== handle);
  // a new terminal (resume lane, takeover) starts its own streak
  let idleStreak = event === 'idle' ? (!handoffChanged && !handleChanged ? (prev.idle_streak || 0) + 1 : 1) : 0;
  // an idle screen that shows live background work is a busy agent: hold the streak, until the screen stops changing
  const bg = event === 'idle' && handle ? backgroundWork(handle) : null;
  let bgChanged = null;
  let bgStuck = false;
  let bgSince = null;
  if (bg) {
    // a new terminal, or progress in the HANDOFF, starts both clocks again
    const same = !handleChanged && !handoffChanged;
    bgChanged = same && prev.bg_hash === bg.hash && prev.bg_changed_at ? prev.bg_changed_at : Date.now();
    bgSince = same && prev.bg_since ? prev.bg_since : Date.now();
    bgStuck = Date.now() - bgChanged >= BG_STUCK_MS || Date.now() - bgSince >= BG_MAX_MS;
    if (!bgStuck) idleStreak = 0;
  }
  // busy the whole wait: how long, and whether the screen keeps showing request retries
  const fresh = handleChanged || handoffChanged;
  const busySince = event === 'timeout' ? (!fresh && prev.busy_since ? prev.busy_since : started) : null;
  const retry = event === 'timeout' && handle ? retryingScreen(handle) : null;
  const retrySince = retry ? (!fresh && prev.retry_since ? prev.retry_since : Date.now()) : null;
  const stall = retry && Date.now() - retrySince >= RETRY_STALL_MS
    ? { reason: 'request timeouts', minutes: Math.round((Date.now() - retrySince) / 60000), line: retry } : null;
  const out = {
    event, handle, handle_changed: handleChanged, ...(errorText ? { error: errorText } : {}),
    ...(event === 'terminal-missing' && missingWhy ? { error: missingWhy } : {}),
    ...(staleRechecks ? { stale_rechecks: staleRechecks } : {}),
    status: after.status, detail: after.detail, sha: after.sha, handoff_changed: handoffChanged,
    idle_streak: idleStreak, ...(bg ? { background: bg.what, ...(bgStuck ? { background_stuck: true } : {}) } : {}), pending_gates: pendingGates, unread_to_run: unread, waited_ms: Date.now() - started,
    ...(overruled ? { idle_overruled: overruled, overruled_line: overruledLine } : {}),
    ...(busySince ? { busy_ms: Date.now() - busySince } : {}), ...(retry ? { retrying: retry } : {}), ...(stall ? { stall } : {}),
  };
  fs.mkdirSync(path.dirname(path.resolve(v.state)), { recursive: true });
  const next = { ...prev, handle, last_mtime: after.mtime, last_status: after.status, idle_streak: idleStreak, bg_hash: bg ? bg.hash : null, bg_changed_at: bg ? bgChanged : null, bg_since: bg ? bgSince : event === 'idle' || handleChanged || handoffChanged ? null : prev.bg_since ?? null, busy_since: busySince, retry_since: retrySince, last_event: event, updated: new Date().toISOString() };
  fs.writeFileSync(`${v.state}.tmp`, JSON.stringify(next, null, 1));
  fs.renameSync(`${v.state}.tmp`, v.state);
  return out;
}

const { cmd, v } = parseArgs(process.argv.slice(2));
const startedAt = Date.now();
let result;
if (cmd === 'coord') result = coord(v);
else if (cmd === 'lane') result = lane(v);
else fail('usage: orca-wait.mjs coord [--ack <id>] [--run <id>] [--types …] [--max-ms N] | lane --handoff <f> --state <f> (--run <id> | --handle <h>) [--max-ms N] [--chunk-ms N]');
const notes = healthNotes(startedAt);
process.stdout.write(JSON.stringify({ ...result, ...(Object.keys(notes).length ? { notes } : {}) }) + '\n');
if (result.error) process.exitCode = 1;
