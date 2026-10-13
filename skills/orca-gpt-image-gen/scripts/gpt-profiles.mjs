#!/usr/bin/env node
/**
 * ChatGPT account rotation over Orca browser profiles.
 *
 * Each Orca browser profile is its own cookie jar, so one signed-in ChatGPT account per profile
 * (labels gpt-1, gpt-2, …) lets a run move to another account without logging out. This tool
 * probes every such profile from a chatgpt.com tab bound to it:
 *   - GET  /api/auth/session            → signed in? email, plan
 *   - POST /backend-api/conversation/init → limits_progress[image_gen] = { remaining, reset_after }
 * and merges what the UI saw (mark) from ~/.agents/logs/gpt-image-profiles.json.
 * The access token stays inside the page; it is never returned or printed.
 *
 *   status [--json]                      probe every gpt profile
 *   pick [--need N] [--exclude a,b] [--json]
 *                                         best usable profile (prefers one with ≥ N images left,
 *                                         then the most left) and a chatgpt.com page bound to it
 *   mark <profile> --limited [--reset <iso|minutes>] | --signed-out | --clear
 *                                         record what the ChatGPT UI showed
 *   close-probes [--keep <pageId,…>]      close chatgpt.com tabs this tool opened
 *
 * <profile> is a label (gpt-3) or a profile id. Label pattern: --pattern / GPT_PROFILE_PATTERN
 * (default ^gpt-\d+$). Exit 2 from pick = no usable profile; the JSON names the earliest reset.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';

export const STATE_FILE = path.join(os.homedir(), '.agents', 'logs', 'gpt-image-profiles.json');
const CHATGPT = 'https://chatgpt.com/';
const ORCA = process.env.ORCA_BIN || 'orca';
// A limit seen in the UI without a reset time keeps the profile out this long.
const DEFAULT_LIMIT_MS = 3 * 3600_000;
const SIGNED_OUT_MS = 24 * 3600_000;

const PROBE_JS = `(async () => {
  const out = { signedIn: false };
  try {
    const s = await (await fetch('/api/auth/session', { credentials: 'include' })).json();
    if (!s || !s.accessToken) return JSON.stringify(out);
    out.signedIn = true;
    out.email = s.user && s.user.email || null;
    out.plan = s.account && s.account.planType || null;
    const r = await fetch('/backend-api/conversation/init', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + s.accessToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ gizmo_id: null, requested_default_model: null, conversation_id: null,
        timezone_offset_min: new Date().getTimezoneOffset(), system_hints: ['picture_v2'] }),
    });
    out.initStatus = r.status;
    if (r.ok) {
      const j = await r.json();
      const g = (j.limits_progress || []).find((x) => x.feature_name === 'image_gen');
      out.imageGen = g ? { remaining: g.remaining, resetAfter: g.reset_after } : null;
      out.blocked = (j.blocked_features || []).map((x) => x.feature_name || x).filter(Boolean);
    }
  } catch (e) { out.error = String(e && e.message || e); }
  return JSON.stringify(out);
})()`;

const unwrap = (raw, args) => {
  const d = JSON.parse(raw);
  if (!d.ok) throw new Error(`orca ${args.slice(0, 2).join(' ')}: ${JSON.stringify(d.error || d)}`);
  return d.result;
};
const orca = (args) => unwrap(execFileSync(ORCA, [...args, '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 }), args);
const execFileP = promisify(execFile);
const orcaAsync = async (args) => unwrap((await execFileP(ORCA, [...args, '--json'], { encoding: 'utf8', timeout: 60_000 })).stdout, args);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function loadState(file = STATE_FILE) {
  const empty = { profiles: {}, probeTabs: [] };
  try { return { ...empty, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch { return empty; }
}

export function saveState(state, file = STATE_FILE) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(state, null, 1));
  fs.renameSync(`${file}.tmp`, file);
}

/** "j***@gmail.com" — enough to tell accounts apart in a report. */
const setPatternOf = (s) => (s.set.length ? `^(${s.set.join('|')})$` : null);

export const maskEmail = (e) => (e ? e.replace(/^(.)[^@]*/, '$1***') : null);

/** --reset value → ISO time: an ISO string, or a number of minutes from `now`. */
export function resetTime(value, now = Date.now()) {
  if (value == null || value === true) return new Date(now + DEFAULT_LIMIT_MS).toISOString();
  if (/^\d+(\.\d+)?$/.test(String(value))) return new Date(now + Number(value) * 60_000).toISOString();
  const t = Date.parse(value);
  if (Number.isNaN(t)) throw new Error(`--reset: not an ISO time or minutes: ${value}`);
  return new Date(t).toISOString();
}

/**
 * One profile's verdict from its live probe and the marks in `state`.
 * usable: signed in, not marked out, and image_gen remaining > 0 (unknown counts as usable).
 */
export function verdict(probe, mark = {}, now = Date.now()) {
  const until = (t) => (t && Date.parse(t) > now ? t : null);
  if (!probe || probe.error && !probe.signedIn) return { usable: false, reason: 'probe-failed', until: null };
  if (!probe.signedIn) return { usable: false, reason: 'signed-out', until: null };
  if (until(mark.signedOutUntil)) return { usable: false, reason: 'signed-out', until: mark.signedOutUntil };
  if (until(mark.limitedUntil)) return { usable: false, reason: 'limited', until: mark.limitedUntil };
  if (probe.blocked?.includes('image_gen')) return { usable: false, reason: 'blocked', until: null };
  const g = probe.imageGen;
  if (g && g.remaining <= 0) return { usable: false, reason: 'limited', until: g.resetAfter || null };
  return { usable: true, reason: 'ok', until: null, remaining: g ? g.remaining : null };
}

/** Best usable row: one with ≥ need left first, then the most left, then label order. */
export function rank(rows, need = 1) {
  const left = (r) => (r.verdict.remaining == null ? Infinity : r.verdict.remaining);
  return rows.filter((r) => r.verdict.usable).sort((a, b) =>
    (left(b) >= need) - (left(a) >= need) || left(b) - left(a)
    || a.label.localeCompare(b.label, undefined, { numeric: true }))[0] || null;
}

function gptProfiles(pattern) {
  const re = new RegExp(pattern);
  return orca(['tab', 'profile', 'list']).profiles.filter((p) => re.test(p.label));
}

function resolveProfile(key, pattern) {
  const all = orca(['tab', 'profile', 'list']).profiles;
  const p = all.find((x) => x.id === key || x.label === key);
  if (!p) throw new Error(`no browser profile "${key}" (have: ${all.map((x) => x.label).join(', ')})`);
  if (!new RegExp(pattern).test(p.label)) console.error(`warning: ${p.label} does not match ${pattern}`);
  return p;
}

/** A chatgpt.com page bound to `profileId`: an open one when there is one, else a new tab. */
function pageFor(profileId, tabs, state) {
  const open = tabs.find((t) => t.profileId === profileId && String(t.url || '').startsWith(CHATGPT));
  if (open) return { page: open.browserPageId, created: false };
  const r = orca(['tab', 'create', '--url', CHATGPT, '--profile', profileId]);
  const page = r.browserPageId || r.tab?.browserPageId;
  state.probeTabs = [...new Set([...(state.probeTabs || []), page])];
  return { page, created: true };
}

/**
 * Probe one page. `orca wait --load` never settles on chatgpt.com, so retry the probe itself
 * until the page answers (a fresh tab needs a few seconds before fetch works).
 */
async function probe(page, deadlineMs = 30_000) {
  const end = Date.now() + deadlineMs;
  let last = 'probe failed';
  while (Date.now() < end) {
    try {
      const v = JSON.parse((await orcaAsync(['eval', '--page', page, '--expression', PROBE_JS])).result);
      if (v.signedIn || !v.error) return v;
      last = v.error;
    } catch (e) { last = String(e.message || e); }
    await sleep(1500);
  }
  return { signedIn: false, error: last };
}

async function survey(pattern, state, only = null) {
  const tabs = orca(['tab', 'list', '--worktree', 'all']).tabs || [];
  const profiles = gptProfiles(pattern).filter((p) => !only || only(p));
  const pages = profiles.map((p) => pageFor(p.id, tabs, state));
  const lives = await Promise.all(pages.map(({ page }) => probe(page)));
  return profiles.map((p, i) => {
    const { page, created } = pages[i];
    const live = lives[i];
    const mark = state.profiles[p.id] || {};
    state.profiles[p.id] = { ...mark, label: p.label, email: maskEmail(live.email) || mark.email || null,
      lastProbe: { at: new Date().toISOString(), ...live, email: undefined } };
    return { id: p.id, label: p.label, page, createdTab: created, email: maskEmail(live.email), plan: live.plan || null,
      imageGen: live.imageGen || null, verdict: verdict(live, mark) };
  });
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const [k, inline] = a.slice(2).split(/=(.*)/s);
    if (inline !== undefined) out[k] = inline;
    else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) out[k] = argv[++i];
    else out[k] = true;
  }
  return out;
}

function row(r) {
  const v = r.verdict;
  const left = r.imageGen ? `${r.imageGen.remaining} left, resets ${r.imageGen.resetAfter}` : 'quota unknown';
  return `${r.label.padEnd(8)} ${v.usable ? 'OK     ' : v.reason.padEnd(7)} ${String(r.email || '-').padEnd(26)} ${left}${v.until && !v.usable ? ` (out until ${v.until})` : ''}  page=${r.page}`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  // an account split (account-split.mjs) narrows pick to its ChatGPT set; an explicit --pattern wins
  const split = args.pattern || process.env.GPT_PROFILE_PATTERN ? null : (await import('./account-split.mjs')).loadSplit();
  const pattern = args.pattern || process.env.GPT_PROFILE_PATTERN || (cmd === 'pick' && split && setPatternOf(split)) || '^gpt-\\d+$';
  const state = loadState();
  const print = (obj, text) => console.log(args.json ? JSON.stringify(obj, null, 1) : text);

  if (cmd === 'status') {
    const rows = await survey(pattern, state);
    saveState(state);
    print({ profiles: rows }, rows.length ? rows.map(row).join('\n') : `no profile matches ${pattern}`);
    return 0;
  }

  if (cmd === 'pick') {
    const need = Math.max(1, Number(args.need) || 1);
    const exclude = new Set(String(args.exclude || '').split(',').filter(Boolean));
    const rows = await survey(pattern, state, (p) => !exclude.has(p.id) && !exclude.has(p.label));
    saveState(state);
    let best = rank(rows, need);
    if (!best && split) {
      // nothing usable left in the ChatGPT set: rotate to other profiles (OmniRoute follows), then pick again
      const { rotate, saveSplit, setPattern } = await import('./account-split.mjs');
      const r = rotate(split); saveSplit(split);
      console.error(`account split rotated: ${JSON.stringify(r)}`);
      if (r.ok) rows.splice(0, rows.length, ...await survey(setPattern(split), state, (p) => !exclude.has(p.id) && !exclude.has(p.label)));
      saveState(state);
      best = rank(rows, need);
    }
    if (!best) {
      const resets = rows.map((r) => r.verdict.until).filter(Boolean).sort();
      print({ ok: false, reason: 'no usable profile', earliestReset: resets[0] || null, profiles: rows },
        `no usable gpt profile${resets[0] ? `; earliest reset ${resets[0]}` : ''}\n${rows.map(row).join('\n')}`);
      return 2;
    }
    print({ ok: true, profile: best, enough: best.verdict.remaining == null || best.verdict.remaining >= need },
      row(best));
    return 0;
  }

  if (cmd === 'mark') {
    const p = resolveProfile(args._[1], pattern);
    const m = { ...(state.profiles[p.id] || {}), label: p.label };
    if (args.clear) { delete m.limitedUntil; delete m.signedOutUntil; }
    else if (args['signed-out']) m.signedOutUntil = new Date(Date.now() + SIGNED_OUT_MS).toISOString();
    else if (args.limited) m.limitedUntil = resetTime(args.reset);
    else throw new Error('mark needs --limited [--reset …], --signed-out or --clear');
    m.markedAt = new Date().toISOString();
    state.profiles[p.id] = m;
    saveState(state);
    const sp = (await import('./account-split.mjs')).loadSplit();
    if (args.limited && sp && sp.set.includes(p.label)) {
      // a ChatGPT-set profile hit its limit: rotate it out now (its account goes back to Codex in OmniRoute)
      const { rotate, saveSplit } = await import('./account-split.mjs');
      const r = rotate(sp); saveSplit(sp);
      console.error(`account split rotated: ${JSON.stringify(r)}`);
    }
    print({ ok: true, id: p.id, label: p.label, mark: m },
      `${p.label}: ${m.limitedUntil ? `limited until ${m.limitedUntil}` : m.signedOutUntil ? `signed out until ${m.signedOutUntil}` : 'cleared'}`);
    return 0;
  }

  if (cmd === 'close-probes') {
    const keep = new Set(String(args.keep || '').split(',').filter(Boolean));
    const open = new Set((orca(['tab', 'list', '--worktree', 'all']).tabs || []).map((t) => t.browserPageId));
    const closed = [];
    for (const page of state.probeTabs || []) {
      if (keep.has(page) || !open.has(page)) continue;
      try { orca(['tab', 'close', '--page', page]); closed.push(page); } catch { /* already gone */ }
    }
    state.probeTabs = (state.probeTabs || []).filter((p) => keep.has(p));
    saveState(state);
    print({ ok: true, closed }, `closed ${closed.length} probe tab(s)`);
    return 0;
  }

  console.error('usage: gpt-profiles.mjs status | pick [--need N] [--exclude a,b] | mark <profile> --limited [--reset t] | --signed-out | --clear | close-probes [--keep ids]  [--json] [--pattern re]');
  return 64;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then((code) => { process.exitCode = code; }, (e) => { console.error(String(e.message || e)); process.exitCode = 1; });
}
