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
 *     --state keeps idle_streak / last HANDOFF mtime across calls and restarts; keep it in the main
 *     checkout (T-<Sxx>/producer-state.json), never in the lane's evidence dir.
 *
 * Every call also reports, only when something is wrong: a stale orca cheatsheet, and (for a session
 * launched with --role) a coordinator guard that never logged this very call.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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

function coord(v) {
  const limit = maxMs(v);
  const args = ['orchestration', 'check'];
  if (v.ack) args.push('--ack', v.ack);
  if (v.run) args.push('--run', v.run);
  args.push('--wait', '--types', v.types || 'worker_done,escalation,question', '--timeout-ms', String(limit));
  const started = Date.now();
  const r = orcaJson(args, limit + 30000);
  const res = r.parsed?.result;
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
        .map((g) => ({ id: g.id, question: firstLines(g.question, 1, 200), options: g.options }));
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
      event = 'idle';
      break;
    }
    if (w.status !== 0 && !/timed? ?out/i.test(JSON.stringify(w.parsed) + w.stderr)) {
      const why = JSON.stringify(w.parsed?.error || w.parsed || '') + w.stderr;
      // a stale or unknown handle is a gone terminal; anything else (runtime down, ECONNREFUSED) is not
      event = /stale|not[ _]found|unknown terminal|no such terminal/i.test(why) ? 'terminal-missing' : 'orca-error';
      if (event === 'orca-error') errorText = why.slice(0, 200);
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
  const idleStreak = event === 'idle' ? (!handoffChanged && !handleChanged ? (prev.idle_streak || 0) + 1 : 1) : 0;
  const out = {
    event, handle, handle_changed: handleChanged, ...(errorText ? { error: errorText } : {}),
    status: after.status, detail: after.detail, sha: after.sha, handoff_changed: handoffChanged,
    idle_streak: idleStreak, pending_gates: pendingGates, unread_to_run: unread, waited_ms: Date.now() - started,
  };
  fs.mkdirSync(path.dirname(path.resolve(v.state)), { recursive: true });
  const next = { ...prev, handle, last_mtime: after.mtime, last_status: after.status, idle_streak: idleStreak, last_event: event, updated: new Date().toISOString() };
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
