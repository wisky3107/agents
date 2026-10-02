/**
 * Every outside call the runner makes, in one place: `orca`, bootstrap.mjs agent-session, orca-wait,
 * curl, the optional orca-memory launcher. Paths resolve inside this repo (so a pilot from a worktree
 * runs the worktree's tools); PRODUCER_RUNNER_BOOTSTRAP / _ORCA_WAIT / ORCA_MEMORY_BIN override them in
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

export function memoryHarvest(wt, task, cwd) {
  const bin = MEMORY_BIN;
  if (!fs.existsSync(bin)) return { ran: false, status: 0 };
  const r = spawnSync(bin, ['hook', 'harvest', '--wt', wt, '--task', task], { encoding: 'utf8', timeout: 300000, cwd });
  return { ran: true, status: r.status, out: (r.stdout || '').slice(-300) };
}
