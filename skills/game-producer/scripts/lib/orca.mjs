/**
 * Every outside call the runner makes, in one place: `orca`, bootstrap.mjs agent-session, orca-wait,
 * curl, the optional orca-memory launcher, the optional cocos-playbook kit.mjs. Paths resolve inside this repo (so a pilot from a worktree
 * runs the worktree's tools); PRODUCER_RUNNER_BOOTSTRAP / _ORCA_WAIT / ORCA_MEMORY_BIN / KIT_MJS override them in
 * tests, and `orca` comes from PATH.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SKILLS = path.resolve(HERE, '..', '..', '..');
export const BOOTSTRAP = process.env.PRODUCER_RUNNER_BOOTSTRAP || path.join(SKILLS, 'new-cocos-game', 'scripts', 'bootstrap.mjs');
export const ORCA_WAIT = process.env.PRODUCER_RUNNER_ORCA_WAIT || path.join(SKILLS, 'cocos-orca-fleet', 'scripts', 'orca-wait.mjs');
const MEMORY_BIN = process.env.ORCA_MEMORY_BIN || path.join(os.homedir(), '.orca-memory', 'bin', 'orca-memory');
const KIT_MJS = process.env.KIT_MJS || path.join(SKILLS, 'cocos-playbook', 'kits', 'kit.mjs');

function json(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });
  if (r.error?.code === 'ENOENT') throw new Error(`${cmd} is not on PATH`);
  // orca --json and bootstrap --json pretty-print one object; a stray log line before it falls back to the last line
  let parsed = null;
  for (const text of [r.stdout || '', (r.stdout || '').trim().split('\n').pop()]) {
    try {
      parsed = JSON.parse(text);
      break;
    } catch {
      /* try the next form */
    }
  }
  return { status: r.status, parsed, stdout: r.stdout || '', stderr: r.stderr || '' };
}

export const orca = (args, opts) => json('orca', [...args, '--json'], opts);

/** Spawn one lane terminal. → handle (throws when bootstrap did not return one: never spawn twice blind). */
export function spawnLane({ root, agent, role, slice, title, prompt }) {
  const r = json(process.execPath, [BOOTSTRAP, 'agent-session', '--json', '--path', root, '--agent', agent, '--role', role,
    ...(slice ? ['--slice', slice] : []), '--title', title, '--prompt', prompt]);
  const handle = r.parsed?.session?.handle;
  if (!handle) throw new Error(`agent-session returned no handle (exit ${r.status}): ${(r.stderr || r.stdout).slice(-300)}`);
  return { handle, ok: Boolean(r.parsed?.ok), promptSent: Boolean(r.parsed?.session?.promptSent) };
}

const registryFile = () => process.env.CC_SPAWN_REGISTRY || path.join(os.homedir(), '.agents', 'logs', 'spawns.jsonl');

/** A row of our own (the judge's `claude -p`), so token-report books it under the producer. */
export function appendRegistry(row) {
  try {
    fs.mkdirSync(path.dirname(registryFile()), { recursive: true });
    fs.appendFileSync(registryFile(), JSON.stringify(row) + '\n');
  } catch {
    /* the registry is for reports only */
  }
}

/** The spawn registry bootstrap appends to (one JSON row per terminal create; bad rows skipped). */
export function spawnRows() {
  const f = registryFile();
  let text = '';
  try {
    text = fs.readFileSync(f, 'utf8');
  } catch {
    return [];
  }
  return text.split('\n').flatMap((l) => {
    try {
      return l.trim() ? [JSON.parse(l)] : [];
    } catch {
      return [];
    }
  });
}

/** Spawns of this project / slice / role recorded by bootstrap since `sinceIso` (resume after a kill). */
export function registeredSpawn({ root, slice, role, sinceIso }) {
  return spawnRows().filter((r) => r.cwd === root && r.slice === slice && r.role === role && r.handle && (!sinceIso || r.ts >= sinceIso)).pop() || null;
}

export function waitLane({ handoff, state, run, handle, maxMs = 540000 }) {
  const args = [ORCA_WAIT, 'lane', '--handoff', handoff, '--state', state, '--max-ms', String(maxMs)];
  if (run) args.push('--run', run);
  else args.push('--handle', handle);
  const r = json(process.execPath, args);
  if (!r.parsed) throw new Error(`orca-wait gave no result: ${(r.stderr || r.stdout).slice(-300)}`);
  // an orca-error event carries `error` too: that is a result for the lane rules, not a runner failure
  if (r.parsed.error && !r.parsed.event) throw new Error(`orca-wait: ${r.parsed.error}`);
  return r.parsed;
}

export function send(handle, text) {
  const r = orca(['terminal', 'send', '--terminal', handle, '--text', text, '--enter']);
  if (r.status !== 0 || r.parsed?.ok === false) {
    const e = r.parsed?.error;
    throw new Error(`terminal send to ${handle} failed: ${e ? [e.code, e.message].filter(Boolean).join(': ') : (r.stderr || r.stdout).trim().slice(-200)}`);
  }
}

/**
 * A slice's own Orca worktree (phase 2 M1): `orca worktree create` from the slice's base commit with the repo's setup
 * hook (seeds library/ and extensions/, pins this checkout's Funplay port, opens its Creator). The caller finds the
 * path with `git worktree list` (sliceWorktrees), not in this answer. → { ok, error }
 */
export function createWorktree({ root, name, base }) {
  const r = orca(['worktree', 'create', '--repo', `path:${root}`, '--name', name, '--base-branch', base, '--setup', 'run', '--no-parent']);
  if (r.status !== 0 || r.parsed?.ok === false) {
    const e = r.parsed?.error;
    return { ok: false, error: e ? [e.code, e.message].filter(Boolean).join(': ') : (r.stderr || r.stdout || '').trim().slice(-200) };
  }
  return { ok: true };
}

/** One interrupt-style input (Claude Code: the running turn stops at the prompt). Throws when Orca refuses it. */
export function interrupt(handle) {
  const r = orca(['terminal', 'send', '--terminal', handle, '--interrupt']);
  if (r.status !== 0 || r.parsed?.ok === false) {
    const e = r.parsed?.error;
    throw new Error(`terminal interrupt to ${handle} failed: ${e ? [e.code, e.message].filter(Boolean).join(': ') : (r.stderr || r.stdout).trim().slice(-200)}`);
  }
}

/** A visible Orca terminal in the project that runs `producer-runner.mjs start`. → handle | null */
export function launchRunner(root, runner) {
  const title = `producer-runner-${path.basename(root).replace(/^cc4?-/, '')}`;
  // single quotes: the shell expands nothing inside ($, `, ! in a path stay literal)
  const q = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;
  const r = orca(['terminal', 'create', '--worktree', `path:${root}`, '--title', title,
    '--command', `node ${q(runner)} start --project ${q(root)}`]);
  return r.parsed?.result?.handle || r.parsed?.result?.terminal?.handle || null;
}

/** → true when Orca confirmed the close. */
export function closeTerminal(handle) {
  if (!handle) return false;
  const r = orca(['terminal', 'close', '--terminal', handle]);
  return r.status === 0 && r.parsed?.ok !== false;
}

/**
 * Is this terminal still live in Orca? true | false (closed: orphaned / not connected, or a stale or
 * unknown handle) | null (Orca did not answer). A closed terminal can still be shown (orphaned).
 */
export function terminalAlive(handle) {
  if (!handle) return false;
  const r = orca(['terminal', 'show', '--terminal', handle]);
  if (r.status === 0 && r.parsed?.ok === true) {
    const t = r.parsed.result?.terminal || {};
    return !(t.orphaned === true || t.connected === false);
  }
  const code = r.parsed?.error?.code || '';
  return /stale|not_found|no_such|unknown_terminal|terminal_missing|terminal_closed|terminal_gone/i.test(code) ? false : null;
}

/** The Run's coordinator now (takeovers replace it); null when run-show does not answer. */
export function runCoordinator(run) {
  return orca(['orchestration', 'run-show', '--id', run]).parsed?.result?.run?.coordinator_handle || null;
}

/**
 * The Run's supervised workers still on their task → [{ dispatch, task, handle }]; [] when Orca does not answer.
 * A settled worker (outcome other than in_progress) or a released terminal is not listed.
 */
export function runWorkers(run) {
  const r = orca(['orchestration', 'worker-list', '--run', run]);
  const rows = r.parsed?.result?.workers;
  return (Array.isArray(rows) ? rows : [])
    .filter((x) => x.agentTerminalHandle && (x.projection?.outcome ?? 'in_progress') === 'in_progress' && !/^release/.test(x.terminalState || ''))
    .map((x) => ({ dispatch: x.dispatchId, task: x.taskId, handle: x.agentTerminalHandle }));
}

/** The fleet Run whose coordinator is this terminal (it appears once the coordinator ran run-create). */
export function runFor(coordinatorHandle) {
  const r = orca(['orchestration', 'run-list']);
  const runs = r.parsed?.result?.runs || r.parsed?.result || [];
  return (Array.isArray(runs) ? runs : []).find((x) => x.coordinator_handle === coordinatorHandle)?.id || null;
}

export function httpStatus(port) {
  const r = spawnSync('curl', ['-s', '-o', '/dev/null', '-w', '%{http_code}', '--max-time', '5', `http://127.0.0.1:${port}/`], { encoding: 'utf8' });
  return Number(r.stdout) || 0;
}

/** Optional orca-memory pack: a path only when the launcher exists and says inject: true. */
export function memoryPack(kind, args, cwd) {
  const bin = MEMORY_BIN;
  if (!fs.existsSync(bin)) return 'none';
  const out = args[args.indexOf('--out') + 1];
  // the hook resolves the project from --cwd / process.cwd(): run it in the checkout
  const r = spawnSync(bin, ['hook', kind, ...args], { encoding: 'utf8', timeout: 120000, cwd });
  const pack = path.join(out, 'memory-context.md');
  return r.status === 0 && /inject["':\s]+true/.test(r.stdout) && fs.existsSync(pack) ? pack : 'none';
}

/** Optional kit check at slice acceptance: new self-contained features → kit_signal candidates. */
export function kitSliceCheck(root, slice, base, evidenceDir) {
  if (!fs.existsSync(KIT_MJS)) return { ran: false, status: 0 };
  const r = spawnSync(process.execPath, [KIT_MJS, 'slice-check', root, '--base', base, '--write', evidenceDir, '--slice', slice],
    { encoding: 'utf8', timeout: 120000, cwd: root });
  return { ran: true, status: r.status, out: ((r.stdout || '') + (r.stderr || '')).trim().slice(-300) };
}

/** One orca-memory hook call with its status line read: exit 0 also covers `off` and `nothing`. */
function memoryHook(args, cwd, timeout) {
  const bin = MEMORY_BIN;
  if (!fs.existsSync(bin)) return { ran: false, status: 0 };
  const r = spawnSync(bin, ['hook', ...args], { encoding: 'utf8', timeout, cwd });
  let line = null;
  try { line = JSON.parse((r.stdout || '').trim().split('\n').at(-1)); } catch { /* no status line */ }
  return { ran: true, status: r.status, memory: line?.status ?? null, reason: line?.reason ?? null, unregistered: line?.unregistered ?? null, refresh: line?.refresh ?? null, out: (r.stdout || '').slice(-300) };
}

export function memoryHarvest(wt, task, cwd) {
  return memoryHook(['harvest', '--wt', wt, '--task', task], cwd, 300000);
}

/** A reviewer pack recorded at merge time for a lane whose coordinator ran no `hook review`. */
export function memoryReview(task, acceptance, changed, out, cwd) {
  return memoryHook(['review', '--task', task, '--acceptance', acceptance, '--changed', changed.join(','), '--out', out], cwd, 120000);
}

/**
 * The coordinator's rendered screen (`terminal read --screen`) → { lines, source } | null. Null when Orca
 * does not answer or only has the accumulated stream (`source: stream | screen-unavailable`): a stream still
 * holds a question panel long after it closed, so it is never read as the screen.
 */
export function readScreen(handle) {
  const r = orca(['terminal', 'read', '--terminal', handle, '--screen']);
  if (r.status !== 0 || r.parsed?.ok === false) return null;
  const t = r.parsed?.result?.terminal || r.parsed?.result || {};
  if (t.source === 'stream' || t.source === 'screen-unavailable') return null;
  const lines = Array.isArray(t.tail) ? t.tail.map(String) : typeof t.tail === 'string' ? t.tail.split('\n') : null;
  return lines ? { lines, source: t.source || null } : null;
}

/**
 * Raw input without Enter (a key sequence, or text typed into a TUI panel). Throws when Orca refuses it.
 * A value that starts with `-` could be read as a flag by the CLI: it goes with one leading space (a TUI
 * input ignores it), never as `--text=` (unverified on this CLI).
 */
export function sendKeys(handle, text) {
  const r = orca(['terminal', 'send', '--terminal', handle, '--text', String(text).startsWith('-') ? ` ${text}` : text]);
  if (r.status !== 0 || r.parsed?.ok === false) {
    const e = r.parsed?.error;
    throw new Error(`terminal keys to ${handle} failed: ${e ? [e.code, e.message].filter(Boolean).join(': ') : (r.stderr || r.stdout).trim().slice(-200)}`);
  }
}

// ---- Fleet driver (plan 2026-10-16-fleet-script-coordinator): the runner's own terminal is the Run's coordinator.
// Each call returns { ok, ...fields, error } and never throws on an Orca refusal: the driver records the
// result before it decides, so a kill between the call and the record is reconciled from Orca state.

const result = (r) => (r.status === 0 && r.parsed?.ok !== false ? r.parsed?.result ?? {} : null);
const failure = (r) => {
  const e = r.parsed?.error, x = r.parsed?.result;
  if (e) return [e.code, e.message].filter(Boolean).join(': ');
  // a failed receipt (worker-start) comes back as a result with ok: false
  if (x) return [x.failedStage ?? x.stage, x.lastError ?? x.reason ?? x.message].filter(Boolean).join(': ') || JSON.stringify(x).slice(0, 300);
  return (r.stderr || r.stdout || `exit ${r.status}`).trim().slice(-300);
};

/** Create and bind a Run to this terminal. → { ok, run } */
export function runCreate(objective) {
  const r = orca(['orchestration', 'run-create', '--objective', objective]);
  const x = result(r);
  return x?.run?.id ? { ok: true, run: x.run.id, coordinator: x.run.coordinator_handle } : { ok: false, error: failure(r) };
}

/** Re-bind a Run after a runner restart (the same terminal or its successor). */
export function runUse(run) {
  const r = orca(['orchestration', 'run-use', '--id', run]);
  return result(r) ? { ok: true } : { ok: false, error: failure(r) };
}

/** → { ok, task } */
export function taskCreate({ run, title, spec }) {
  const r = orca(['orchestration', 'task-create', '--run', run, '--task-title', title, '--spec', spec]);
  const x = result(r);
  const id = x?.task?.id ?? x?.taskId ?? x?.id;
  return id ? { ok: true, task: id } : { ok: false, error: failure(r) };
}

/** The Run's tasks → [{ id, title, status }] (for reconcile after a kill); null when Orca does not answer. */
export function taskList(run) {
  const x = result(orca(['orchestration', 'task-list', '--run', run]));
  const rows = x?.tasks ?? (Array.isArray(x) ? x : null);
  return rows ? rows.map((t) => ({ id: t.id, title: t.task_title, status: t.status })) : null;
}

/** The task's current dispatch → { id, status, handle, heartbeat } | null. */
export function dispatchShow(task) {
  const d = result(orca(['orchestration', 'dispatch-show', '--task', task]))?.dispatch;
  return d ? { id: d.id, status: d.status, handle: d.assignee_handle, heartbeat: d.last_heartbeat_at } : null;
}

/**
 * Start one worker on a created task: a fresh managed terminal (`agent` launch spec) or an existing one
 * (`terminal`). → { ok, dispatch, handle, receipt } — a failed receipt is returned whole (failedStage,
 * residualResources): the protocol forbids a blind relaunch.
 */
export function workerStart({ run, task, agent = null, terminal = null, worktree = 'current', retryOf = null }) {
  const args = ['orchestration', 'worker-start', '--run', run, '--task', task, '--worktree', worktree];
  if (terminal) args.push('--terminal', terminal);
  else {
    const [id, ...rest] = String(agent).trim().split(/\s+/);
    args.push('--agent', id === 'agy' ? 'antigravity' : id);
    const flag = (n) => { const i = rest.indexOf(`--${n}`); return i >= 0 ? rest[i + 1] : null; };
    if (flag('model')) args.push('--model', flag('model'));
    if (flag('model') && flag('effort')) args.push('--effort', flag('effort'));
  }
  if (retryOf) args.push('--retry-of', retryOf);
  const r = orca(args, { timeout: 300000 });
  const x = result(r);
  const handle = terminal || x?.effects?.find((e) => e.kind === 'terminal' && e.role === 'agent')?.id || null;
  if (x?.dispatchId) return { ok: true, dispatch: x.dispatchId, handle, receipt: x };
  const receipt = r.parsed?.result ?? r.parsed?.error?.data ?? r.parsed ?? null;
  return { ok: false, error: failure(r), receipt, dispatch: receipt?.dispatchId ?? null };
}

/**
 * One consuming wait on the Run inbox. → { ok, delivery, messages: [{ id, type, from, subject, body, task, dispatch, outcome, question, options }] }
 * (`payload` is a JSON string; its ids are lifted). An empty result is a checkpoint, not a failure.
 */
export function runCheck({ run, ack = null, waitMs = 60000 }) {
  const args = ['orchestration', 'check', '--run', run, '--wait', '--types', 'worker_done,escalation,question', '--timeout-ms', String(waitMs)];
  if (ack) args.push('--ack', ack);
  const r = orca(args, { timeout: waitMs + 30000 });
  const x = result(r);
  if (!x) return { ok: false, error: failure(r), messages: [] };
  const messages = (x.messages ?? []).map((m) => {
    let p = {};
    try { p = typeof m.payload === 'string' ? JSON.parse(m.payload) : m.payload ?? {}; } catch { /* prose payload */ }
    return { id: m.id, type: m.type, from: m.from_handle, subject: m.subject, body: m.body, task: p.taskId ?? null, dispatch: p.dispatchId ?? null,
      outcome: p.outcome ?? null, question: p.question ?? null, options: Array.isArray(p.options) ? p.options : [] };
  });
  return { ok: true, delivery: x.deliveryId ?? null, messages };
}

export function reply(msgId, text) {
  const r = orca(['orchestration', 'reply', '--id', msgId, '--body', text]);
  return result(r) ? { ok: true } : { ok: false, error: failure(r) };
}

/** → { ok, state: released|retained|release_pending|release_unknown, reason } */
export function workerRelease(dispatch) {
  const r = orca(['orchestration', 'worker-release', '--dispatch', dispatch]);
  const x = result(r);
  return x ? { ok: true, state: x.state, reason: x.reason ?? null } : { ok: false, error: failure(r) };
}

export function workerStop(dispatch) {
  const r = orca(['orchestration', 'worker-stop', '--dispatch', dispatch]);
  return result(r) ? { ok: true } : { ok: false, error: failure(r) };
}

/** Wait until a reused terminal's agent is idle (a worker sends worker_done before its turn ends). → true | false */
export function terminalWaitIdle(handle, timeoutMs = 90000) {
  const r = orca(['terminal', 'wait', '--terminal', handle, '--for', 'tui-idle', '--timeout-ms', String(timeoutMs)], { timeout: timeoutMs + 30000 });
  return r.status === 0 && r.parsed?.ok !== false;
}
