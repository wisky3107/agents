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
export function project({ notes = NOTES(POLICY), slices = { S01: { needs: false }, S02: { needs: true }, S03: { needs: false } }, dag } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'runner-proj-')));
  const ids = Object.keys(slices);
  const ms = { slices: ids, dag: dag || Object.fromEntries(ids.map((id, i) => [id, i ? [ids[i - 1]] : []])), parallel_ok: [], v1_slice: 'S01', release_slice: ids[ids.length - 1] };
  fs.writeFileSync(path.join(root, 'AGENT_NOTES.md'), notes);
  fs.writeFileSync(path.join(root, 'MILESTONES.md'), `# MILESTONES\n\n\`\`\`yaml\n${JSON.stringify(ms, null, 2)}\n\`\`\`\n`);
  fs.mkdirSync(path.join(root, 'slices'));
  for (const [id, o] of Object.entries(slices)) {
    const assets = o.assets ? `assets:\n  2d:\n    - ${o.assets}\n  3d: []\n` : 'assets:\n  2d: []\n  3d: []\n';
    fs.writeFileSync(path.join(root, 'slices', `${id}-x.md`),
      `---\nid: ${id}\nsize: ${o.size || 'M'}             # S | M | L\nneeds_director_ok: ${o.needs}\n${o.study ? 'rip_study:\n  - a\n' : ''}${assets}---\n# ${id}\n`);
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
  if (step.dead) fs.writeFileSync(path.join(D, 'dead.json'), JSON.stringify([...read('dead.json', []), ...step.dead]));
  if (step.runs) fs.writeFileSync(path.join(D, 'runs.json'), JSON.stringify(step.runs));
  if (step.result === 'idle') out({ ok: true, result: { wait: { handle: arg('--terminal'), satisfied: true } } });
  if (step.result === 'missing') out({ ok: false, error: { code: 'terminal_handle_stale' } }, 1);
  if (step.result === 'error') out({ ok: false, error: { code: 'runtime_unreachable', message: 'connect ECONNREFUSED' } }, 1);
  out({ ok: true, result: { wait: { satisfied: false } } });
}
if (cmd === 'terminal send') { log('sends.log', { to: arg('--terminal'), text: arg('--text') }); out({ ok: true }); }
if (cmd === 'terminal close') { log('closes.log', { handle: arg('--terminal') }); out({ ok: true }); }
if (cmd === 'terminal list') out({ ok: true, result: { terminals: [] } });
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

export function fakes() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'runner-fake-')));
  fs.writeFileSync(path.join(dir, 'orca'), FAKE_ORCA, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'bootstrap.cjs'), FAKE_BOOTSTRAP);
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
    closes: () => lines('closes.log').map((c) => c.handle),
    waits: () => lines('waits.log'),
  };
}

const env = (root, fake) => ({
  ...process.env,
  PATH: `${fake.dir}:${process.env.PATH}`,
  FAKE_DIR: fake.dir,
  FAKE_PROJECT: root,
  PRODUCER_RUNNER_BOOTSTRAP: path.join(fake.dir, 'bootstrap.cjs'),
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

/** Run the runner CLI against a project with the fakes. → { status, out: [json lines], stderr } */
export function runner(root, fake, ...args) {
  const r = spawnSync(process.execPath, [RUNNER, ...args, '--project', root], {
    encoding: 'utf8',
    timeout: 90000,
    env: env(root, fake),
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

export const ev = (root, id, ...rel) => path.join(root, '.cursor', 'evidence', 'tasks', `T-${id}`, ...rel);
export const evRel = (id, file) => `.cursor/evidence/tasks/T-${id}/evidence/${file}`;
export const sliceState = (root, id) => JSON.parse(fs.readFileSync(ev(root, id, 'producer-state.json'), 'utf8'));
export const clearControl = (root) => fs.rmSync(path.join(root, '.cursor', 'producer.control'), { force: true });
