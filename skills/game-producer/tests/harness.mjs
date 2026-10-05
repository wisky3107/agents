/**
 * Test harness for producer-runner: a throwaway git project, a fake `orca` on PATH and a fake
 * bootstrap (PRODUCER_RUNNER_BOOTSTRAP), with the real orca-wait in between. Nothing here can reach
 * the real Orca runtime, a real agent CLI or the real spawn registry.
 *
 * The fake `orca terminal wait` plays queue.json one step per call: a step may write files into the
 * project (`write: {relpath: json|string}`), replace gates.json / runs.json, and answers `busy`
 * (default), `idle`, `missing` or `error`. An empty queue writes the `stop` control file, so a
 * scenario that runs out ends the runner instead of hanging the test.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, spawn } from 'node:child_process';

export const RUNNER = new URL('../scripts/producer-runner.mjs', import.meta.url).pathname;

export const NOTES = (policy, slices = '{}', extra = '', fleetExtra = '') => `# AGENT_NOTES.md

\`\`\`yaml
fleet:
  orchestrator_agent: claude --model sonnet       # launch spec
  scanner_agent: claude --model sonnet
  writer_agent: claude --model sonnet --effort high
  reviewer_agent: claude --model opus
  art_backend: antigravity
  mesh_backend: auto
${fleetExtra}brief:
  contract_depth: full
release:
  goal: end_to_end                                # end_to_end | playable
  auto_commit: true
  auto_merge: true
  deploy: preview
  current_slice: ""                               # e.g. S03
  slices: ${slices}                                      # S01: planned | in_progress
${extra}\`\`\`

## Notes — game-producer

${policy}
`;
export const POLICY = '- policy: goal=end_to_end auto_commit=true auto_merge=true deploy=preview budget=advisory max_parallel=1 (director gate: S02 GIVEN)';

/** slices: { S01: { needs, size, study, assets } } */
export function project({ notes = NOTES(POLICY), slices = { S01: { needs: false }, S02: { needs: true }, S03: { needs: false } }, dag, prefix = 'runner-proj-', files = {} } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), body);
  }
  const ids = Object.keys(slices);
  const ms = { slices: ids, dag: dag || Object.fromEntries(ids.map((id, i) => [id, i ? [ids[i - 1]] : []])), parallel_ok: [], v1_slice: 'S01', release_slice: ids[ids.length - 1] };
  fs.writeFileSync(path.join(root, 'AGENT_NOTES.md'), notes);
  fs.writeFileSync(path.join(root, 'MILESTONES.md'), `# MILESTONES\n\n\`\`\`yaml\n${JSON.stringify(ms, null, 2)}\n\`\`\`\n`);
  fs.mkdirSync(path.join(root, 'slices'));
  for (const [id, o] of Object.entries(slices)) {
    const assets = o.assets ? `assets:\n  2d:\n    - ${o.assets}\n  3d: []\n` : 'assets:\n  2d: []\n  3d: []\n';
    fs.writeFileSync(path.join(root, 'slices', `${id}-x.md`),
      `---\nid: ${id}\nsize: ${o.size || 'M'}             # S | M | L\nneeds_director_ok: ${o.needs}\n${o.study ? 'rip_study:\n  - a\n' : ''}${assets}---\n# ${id}\n${o.body || ''}`);
  }
  const g = (...a) => spawnSync('git', ['-C', root, ...a], { encoding: 'utf8' });
  g('init', '-q');
  g('-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '-A');
  g('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init');
  return { root, commit: (msg) => g('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-qm', msg) };
}

const FAKE_ORCA = `#!/usr/bin/env node
const fs = require('fs'), path = require('path');
const D = process.env.FAKE_DIR, P = process.env.FAKE_PROJECT, a = process.argv.slice(2);
fs.appendFileSync(path.join(D, 'calls.log'), a.join(' ') + '\\n');
// pretty-printed like the real orca --json (a last-line parser would break on it)
const out = (o, code = 0) => { process.stdout.write(JSON.stringify(o, null, 2) + '\\n'); process.exit(code); };
const arg = (f) => a[a.indexOf(f) + 1];
const read = (f, d) => { try { return JSON.parse(fs.readFileSync(path.join(D, f), 'utf8')); } catch { return d; } };
const log = (f, o) => fs.appendFileSync(path.join(D, f), JSON.stringify(o) + '\\n');
const cmd = a[0] + ' ' + a[1];
if (a[0] === '--version') { console.log('1.4.218'); process.exit(0); }
// handles listed in dead.json are closed terminals: send / close / wait fail like a stale handle
if (a[0] === 'terminal' && read('dead.json', []).includes(arg('--terminal')) && cmd !== 'terminal wait') out({ ok: false, error: { code: 'terminal_handle_stale', message: 'terminal not found' } }, 1);
if (cmd === 'terminal wait') {
  const q = read('queue.json', []);
  const step = q.shift();
  fs.writeFileSync(path.join(D, 'queue.json'), JSON.stringify(q));
  if (!step) {
    fs.mkdirSync(path.join(P, '.cursor'), { recursive: true });
    fs.writeFileSync(path.join(P, '.cursor', 'producer.control'), 'stop\\n');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    out({ ok: true, result: { wait: { satisfied: false } } });
  }
  log('waits.log', { on: arg('--terminal'), step: step.name || null });
  if (step.sleepMs) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, step.sleepMs);
  for (const [rel, body] of Object.entries(step.write || {})) {
    const f = path.resolve(P, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, typeof body === 'string' ? body : JSON.stringify(body));
  }
  if (step.gates) fs.writeFileSync(path.join(D, 'gates.json'), JSON.stringify(step.gates));
  if (step.screens) fs.writeFileSync(path.join(D, 'screens.json'), JSON.stringify(step.screens));
  if (step.dead) fs.writeFileSync(path.join(D, 'dead.json'), JSON.stringify([...read('dead.json', []), ...step.dead]));
  if (step.commit) {
    // the lane commits on main for real (single lane), then reports the sha in its HANDOFF
    const cp = require('child_process');
    cp.spawnSync('git', ['-C', P, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-qm', step.commit.message]);
    const sha = cp.spawnSync('git', ['-C', P, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
    // noHandoff: the writer commits and says nothing (pilot 2)
    if (!step.commit.noHandoff) fs.writeFileSync(path.resolve(P, step.commit.handoff), JSON.stringify({ role: 'writer', status: 'committed', sha }));
    fs.writeFileSync(path.join(D, 'last-commit'), sha);
  }
  if (step.runs) fs.writeFileSync(path.join(D, 'runs.json'), JSON.stringify(step.runs));
  if (step.result === 'idle') out({ ok: true, result: { wait: { handle: arg('--terminal'), satisfied: true } } });
  if (step.result === 'missing') out({ ok: false, error: { code: 'terminal_handle_stale' } }, 1);
  if (step.result === 'error') out({ ok: false, error: { code: 'runtime_unreachable', message: 'connect ECONNREFUSED' } }, 1);
  out({ ok: true, result: { wait: { satisfied: false } } });
}
if (cmd === 'worktree rm') {
  // the real one runs the archive hook and removes the checkout; here: git worktree remove (--force passed on)
  const wt = arg('--worktree').replace(/^path:/, '');
  log('rm.log', { wt, phase: 'start' });
  if (fs.existsSync(path.join(D, 'worktree-rm-sleep'))) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(fs.readFileSync(path.join(D, 'worktree-rm-sleep'), 'utf8')));
  if (fs.existsSync(path.join(D, 'worktree-rm-fail'))) out({ ok: false, error: { code: 'worktree_archive_hook_failed' } }, 1);
  const r = require('child_process').spawnSync('git', ['-C', P, 'worktree', 'remove', ...(a.includes('--force') ? ['--force'] : []), wt], { encoding: 'utf8' });
  log('rm.log', { wt, phase: 'done', status: r.status, ...(a.includes('--force') ? { force: true } : {}) });
  out(r.status === 0 ? { ok: true, result: { removed: wt } } : { ok: false, error: { code: 'worktree_remove_failed', message: r.stderr } }, r.status === 0 ? 0 : 1);
}
if (cmd === 'terminal create') {
  log('creates.log', { worktree: arg('--worktree'), title: arg('--title'), command: arg('--command') });
  out({ ok: true, result: { handle: 'term_created' } });
}
if (cmd === 'terminal send') {
  // --enter = a message to the agent (sends.log); without it, raw keys or text typed into a TUI panel (keys.log).
  // keystream.log keeps both in order. A raw send moves the terminal's screen frame (screens.json).
  const entry = { to: arg('--terminal'), text: arg('--text') };
  log(a.includes('--enter') ? 'sends.log' : 'keys.log', entry);
  log('keystream.log', { ...entry, enter: a.includes('--enter') });
  const screens = read('screens.json', {}), sc = screens[entry.to];
  if (sc && !a.includes('--enter')) {
    const keys = sc.frames[sc.at].keys || {};
    const next = entry.text in keys ? keys[entry.text] : keys['*'];
    if (next) { sc.at = next; fs.writeFileSync(path.join(D, 'screens.json'), JSON.stringify(screens)); }
  }
  out({ ok: true });
}
// the rendered screen: screens.json = { handle: { at: frame, frames: { frame: { lines, keys: { sentText: nextFrame, '*': any } } } } }
if (cmd === 'terminal read') {
  const sc = read('screens.json', {})[arg('--terminal')];
  log('reads.log', { on: arg('--terminal'), frame: sc ? sc.at : null });
  out({ ok: true, result: { terminal: { handle: arg('--terminal'), source: (sc && sc.source) || 'screen', tail: sc ? sc.frames[sc.at].lines : [] } } });
}
if (cmd === 'terminal close') { log('closes.log', { handle: arg('--terminal') }); out({ ok: true }); }
if (cmd === 'terminal list') out({ ok: true, result: { terminals: [] } });
// a handle not in dead.json is shown (dead ones were answered stale above); orphaned.json: closed but still shown
if (cmd === 'terminal show') {
  const orphan = read('orphaned.json', []).includes(arg('--terminal'));
  out({ ok: true, result: { terminal: { handle: arg('--terminal'), connected: !orphan, orphaned: orphan } } });
}
if (cmd === 'orchestration run-list') out({ ok: true, result: { runs: read('runs.json', []) } });
if (cmd === 'orchestration run-show') out({ ok: true, result: { run: read('runs.json', []).find((r) => r.id === arg('--id')) || null } });
if (cmd === 'orchestration gate-list') out({ ok: true, result: { gates: read('gates.json', []) } });
if (cmd === 'orchestration inbox') out({ ok: true, result: { messages: [] } });
out({ ok: false, error: { code: 'unknown_command', message: cmd } }, 1);
`;

// Modes (files in FAKE_DIR): bootstrap-fail (no terminal), bootstrap-no-prompt (terminal, prompt not
// sent), bootstrap-sleep-before / -after (ms around terminal create, for kill tests), bootstrap-abort
// (checked after sleep-before: the killed bootstrap never creates its terminal).
const FAKE_BOOTSTRAP = `const fs = require('fs'), path = require('path');
const D = process.env.FAKE_DIR, a = process.argv.slice(2);
const arg = (f) => (a.includes(f) ? a[a.indexOf(f) + 1] : null);
const mode = (f) => (fs.existsSync(path.join(D, f)) ? fs.readFileSync(path.join(D, f), 'utf8').trim() || '1' : null);
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(ms));
if (a[0] === 'wait-mcp' && a.includes('--json')) {
  fs.appendFileSync(path.join(D, 'wait-mcp.log'), arg('--path') + '\\n');
  if (mode('bootstrap-sleep-wait')) sleep(1500);
  const code = Number(mode('wait-mcp-exit') || 0);
  const mcp = code ? { ok: false, error: 'timeout waiting for Funplay', hint: 'open the Editor' } : { ok: true, url: 'http://127.0.0.1:1/', projectName: path.basename(arg('--path')) };
  process.stdout.write(JSON.stringify({ ok: !code, projectPath: arg('--path'), mcp }, null, 2) + '\\n');
  process.exit(code);
}
if (a[0] !== 'agent-session' || !a.includes('--json')) { console.error('fake bootstrap: unexpected ' + a.join(' ')); process.exit(2); }
fs.writeFileSync(path.join(D, 'bootstrap-started'), String(process.pid));
if (mode('bootstrap-fail')) { console.error('boom'); process.exit(1); }
if (mode('bootstrap-sleep-before')) sleep(mode('bootstrap-sleep-before'));
if (mode('bootstrap-abort')) process.exit(1);
const log = path.join(D, 'spawns.log');
const n = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\\n').filter(Boolean).length : 0;
const handle = 'term_' + (n + 1);
const row = { agent: arg('--agent'), role: arg('--role'), slice: arg('--slice'), title: arg('--title'), path: arg('--path'), prompt: arg('--prompt'), handle };
fs.appendFileSync(log, JSON.stringify(row) + '\\n');
fs.appendFileSync(process.env.CC_SPAWN_REGISTRY, JSON.stringify({ ts: new Date().toISOString(), project: row.path, cwd: row.path, role: row.role, slice: row.slice, handle }) + '\\n');
fs.writeFileSync(path.join(D, 'bootstrap-created'), handle);
if (mode('bootstrap-sleep-after')) sleep(mode('bootstrap-sleep-after'));
console.error('→ orca terminal create (fake)');
const promptSent = !mode('bootstrap-no-prompt');
// pretty-printed like the real bootstrap --json (emitResult: JSON.stringify(obj, null, 2))
process.stdout.write(JSON.stringify({ ok: promptSent, session: { handle, ready: true, promptSent } }, null, 2) + '\\n');
`;

// The judge: never the real claude in tests. It records stdin / env / args and answers with
// judge-reply.json (as structured_output), or judge-raw.txt verbatim, or fails with judge-fail.
const FAKE_JUDGE = `#!/usr/bin/env node
const fs = require('fs'), path = require('path');
const D = process.env.FAKE_DIR;
const input = fs.readFileSync(0, 'utf8');
const n = fs.readdirSync(D).filter((f) => f.startsWith('judge-call-')).length + 1;
fs.writeFileSync(path.join(D, 'judge-call-' + n + '.json'), JSON.stringify({ input, args: process.argv.slice(2), cwd: process.cwd(), role: process.env.CC_ROLE, slice: process.env.CC_SLICE, route: process.env.JUDGE_ROUTE_PROBE || null }));
if (fs.existsSync(path.join(D, 'judge-sleep'))) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(fs.readFileSync(path.join(D, 'judge-sleep'), 'utf8')));
if (fs.existsSync(path.join(D, 'judge-fail'))) { console.error('boom'); process.exit(1); }
if (fs.existsSync(path.join(D, 'judge-raw.txt'))) { process.stdout.write(fs.readFileSync(path.join(D, 'judge-raw.txt'), 'utf8')); process.exit(0); }
const reply = JSON.parse(fs.readFileSync(path.join(D, 'judge-reply.json'), 'utf8'));
process.stdout.write(JSON.stringify({ type: 'result', is_error: false, result: 'done', structured_output: reply }, null, 2) + '\\n');
`;

export function fakes() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'runner-fake-')));
  fs.writeFileSync(path.join(dir, 'orca'), FAKE_ORCA, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'bootstrap.cjs'), FAKE_BOOTSTRAP);
  fs.writeFileSync(path.join(dir, 'judge'), FAKE_JUDGE, { mode: 0o755 });
  // the director's desktop notification: logged, never shown
  fs.writeFileSync(path.join(dir, 'notify'), `#!/bin/sh\nprintf '%s | %s\\n' "$1" "$2" >> "${dir}/notify.log"\n`, { mode: 0o755 });
  // the judge's Claude settings: a stand-in env block, never the real one (it holds the auth token)
  fs.writeFileSync(path.join(dir, 'claude-settings.json'), JSON.stringify({ env: { JUDGE_ROUTE_PROBE: 'via-settings' } }));
  fs.writeFileSync(path.join(dir, 'registry.jsonl'), '');
  const lines = (f) => {
    try {
      return fs.readFileSync(path.join(dir, f), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    } catch {
      return [];
    }
  };
  return {
    dir,
    queue: (steps) => fs.writeFileSync(path.join(dir, 'queue.json'), JSON.stringify(steps)),
    left: () => JSON.parse(fs.readFileSync(path.join(dir, 'queue.json'), 'utf8')),
    set: (name, value) => fs.writeFileSync(path.join(dir, name), JSON.stringify(value)),
    spawns: () => lines('spawns.log'),
    sends: () => lines('sends.log'),
    keys: () => lines('keys.log'),
    keystream: () => lines('keystream.log'),
    reads: () => lines('reads.log'),
    screens: (map) => fs.writeFileSync(path.join(dir, 'screens.json'), JSON.stringify(map)),
    closes: () => lines('closes.log').map((c) => c.handle),
    waits: () => lines('waits.log'),
    creates: () => lines('creates.log'),
    notices: () => (fs.existsSync(path.join(dir, 'notify.log')) ? fs.readFileSync(path.join(dir, 'notify.log'), 'utf8').trim().split('\n') : []),
    judgeCalls: () => fs.readdirSync(dir).filter((f) => f.startsWith('judge-call-')).sort().map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))),
  };
}

export const env = (root, fake) => ({
  ...process.env,
  PATH: `${fake.dir}:${process.env.PATH}`,
  FAKE_DIR: fake.dir,
  FAKE_PROJECT: root,
  PRODUCER_RUNNER_BOOTSTRAP: path.join(fake.dir, 'bootstrap.cjs'),
  PRODUCER_RUNNER_JUDGE_CMD: path.join(fake.dir, 'judge'),
  PRODUCER_RUNNER_CLAUDE_SETTINGS: path.join(fake.dir, 'claude-settings.json'),
  PRODUCER_RUNNER_NOTIFY_CMD: path.join(fake.dir, 'notify'),
  PRODUCER_RUNNER_DIALOG: '0', // never a real dialog; tests that want one set it with a fake osascript
  PRODUCER_RUNNER_TTY: '0', // no terminal prompt unless a test pipes one
  PRODUCER_RUNNER_CURSOR: 'on', // no real cursor-agent probe in tests
  CC_SPAWN_REGISTRY: path.join(fake.dir, 'registry.jsonl'),
  ORCA_MEMORY_BIN: path.join(fake.dir, 'no-orca-memory'),
  PRODUCER_RUNNER_WAIT_MS: '1500',
  PRODUCER_RUNNER_IDLE_MS: '5',
  PRODUCER_RUNNER_POLL_MS: '20',
  CC_ROLE: '',
  CC_GUARD_LOG: path.join(fake.dir, 'guard.jsonl'),
  TMPDIR: fake.dir,
});

/** The runner as a child process, for kill tests. */
export const runnerChild = (root, fake, ...args) =>
  spawn(process.execPath, [RUNNER, ...args, '--project', root], { env: env(root, fake), stdio: ['ignore', 'pipe', 'pipe'] });

/** Resolve once `file` exists (polling), or reject after `ms`. */
export async function until(file, ms = 20000) {
  const t0 = Date.now();
  while (!fs.existsSync(file)) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${file}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

/**
 * Run the runner CLI against a project with the fakes; a trailing `{ env, input }` adds variables
 * and stdin. → { status, out: [json lines], stderr }
 */
export function runner(root, fake, ...args) {
  const opts = args.length && typeof args[args.length - 1] === 'object' ? args.pop() : {};
  const r = spawnSync(process.execPath, [RUNNER, ...args, '--project', root], {
    encoding: 'utf8',
    timeout: 90000,
    env: { ...env(root, fake), ...(opts.env || {}) },
    ...(opts.input !== undefined ? { input: opts.input } : {}),
  });
  const out = (r.stdout || '').trim().split('\n').filter(Boolean).map((l) => {
    try {
      return JSON.parse(l);
    } catch {
      return { raw: l };
    }
  });
  return { status: r.status, out, stderr: r.stderr || '' };
}

/** Step 2d evidence of an APPROVED single-lane review (all files the runner checks). */
export const approvedEvidence = (id, verdict = 'APPROVED', runtime = { status: 'verified' }) => ({
  [evRel(id, 'review.md')]: `# Review\n\nF1 …\n\n${verdict}\n`,
  [evRel(id, 'runtime-state.json')]: runtime,
  ...Object.fromEntries(['integration-notes.md', 'preflight.json', 'preview.png', 'stats.json', 'final-report.md'].map((f) => [evRel(id, f), f.endsWith('.json') ? {} : 'x'])),
});

/** A single-lane writer committing for real: `{ commit: … }` queue step. */
export const commitStep = (id, message = `feat(${id}): slice`) => ({ name: 'committed', commit: { message, handoff: `.cursor/evidence/tasks/T-${id}/evidence/HANDOFF.json` } });
export const lastCommit = (fake) => fs.readFileSync(path.join(fake.dir, 'last-commit'), 'utf8').trim();

/** The single-lane commit request (M6c): it says what to write in HANDOFF.json after the commit. */
export const singleCommitText = (root, id) => `approved — commit: run /commit-guard on this checkout, then write ${path.join(root, '.cursor', 'evidence', 'tasks', `T-${id}`, 'evidence', 'HANDOFF.json')} with "status": "committed" and "sha": the full sha of that commit.`;
export const ev = (root, id, ...rel) => path.join(root, '.cursor', 'evidence', 'tasks', `T-${id}`, ...rel);
export const evRel = (id, file) => `.cursor/evidence/tasks/T-${id}/evidence/${file}`;
export const sliceState = (root, id) => JSON.parse(fs.readFileSync(ev(root, id, 'producer-state.json'), 'utf8'));
export const clearControl = (root) => fs.rmSync(path.join(root, '.cursor', 'producer.control'), { force: true });
