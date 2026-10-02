import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { project, fakes, runner, runnerChild, until, evRel, sliceState, approvedEvidence, commitStep, lastCommit } from './harness.mjs';

// PLAN §6: real SIGKILLs at the runner's risky points, then a restart. Nothing may be spawned or sent twice.
const H = evRel('S01', 'HANDOFF.json');
const W = (status, extra = {}) => ({ [H]: { role: 'writer', status, ...extra } });
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
async function gone(pid) {
  while (alive(pid)) await new Promise((r) => setTimeout(r, 25));
}
const exited = (child) => new Promise((r) => (child.exitCode !== null || child.signalCode ? r() : child.on('exit', r)));

test('kill during bootstrap after the terminal exists: the restart reattaches it from the registry', async () => {
  const p = project({ slices: { S01: { needs: false } } });
  const f = fakes();
  fs.writeFileSync(path.join(f.dir, 'bootstrap-sleep-after'), '1500');
  const child = runnerChild(p.root, f, 'start', '--once');
  await until(path.join(f.dir, 'bootstrap-created'));
  child.kill('SIGKILL'); // the runner only: its bootstrap child lives on, as after a crash
  await exited(child);
  await gone(Number(fs.readFileSync(path.join(f.dir, 'bootstrap-started'), 'utf8')));
  assert.equal(sliceState(p.root, 'S01').writer, undefined); // the handle never reached the state file
  // reattached, but bootstrap may have died before sending the prompt: one question, no second spawn
  const a = runner(p.root, f, 'start', '--once').out.at(-1);
  assert.deepEqual([a.waiting, a.kind], ['q1', 'prompt_not_sent']);
  assert.equal(f.spawns().length, 1);
  assert.equal(sliceState(p.root, 'S01').writer, 'term_1');
  runner(p.root, f, 'answer', '--id', 'q1', '--choice', 'prompt is in the terminal, continue');
  f.queue([]);
  runner(p.root, f, 'start', '--once');
  assert.match(fs.readFileSync(path.join(f.dir, 'calls.log'), 'utf8'), /terminal wait --terminal term_1/);
  assert.equal(f.spawns().length, 1);
});

test('kill during bootstrap before the terminal exists: ask, never a blind second spawn', async () => {
  const p = project({ slices: { S01: { needs: false } } });
  const f = fakes();
  fs.writeFileSync(path.join(f.dir, 'bootstrap-sleep-before'), '1500');
  const child = runnerChild(p.root, f, 'start', '--once');
  await until(path.join(f.dir, 'bootstrap-started'));
  child.kill('SIGKILL');
  await exited(child);
  fs.writeFileSync(path.join(f.dir, 'bootstrap-abort'), '1'); // the orphaned bootstrap dies before terminal create
  const a = runner(p.root, f, 'start', '--once').out.at(-1);
  assert.deepEqual([a.waiting, a.kind], ['q1', 'spawn_unconfirmed']);
  await gone(Number(fs.readFileSync(path.join(f.dir, 'bootstrap-started'), 'utf8')));
  for (const m of ['bootstrap-abort', 'bootstrap-sleep-before']) fs.rmSync(path.join(f.dir, m));
  assert.equal(f.spawns().length, 0);
  runner(p.root, f, 'answer', '--id', 'q1', '--choice', 'no lane terminal exists, spawn it');
  f.queue([]);
  runner(p.root, f, 'start', '--once');
  assert.equal(f.spawns().length, 1);
});

test('kill (whole process group) during a lane wait: the restart resumes the same lanes through the record', async () => {
  const p = project({ slices: { S01: { needs: false } } });
  const f = fakes();
  f.queue([
    { name: 'working', write: W('working') },
    { name: 'long wait', sleepMs: 4000 },
    { name: 'ready', write: { ...W('ready_for_review'), [evRel('S01', 'preview-startup.json')]: { previewUrl: 'http://127.0.0.1:7461/' } } },
    { name: 'approved', write: { [H]: { role: 'reviewer', status: 'approved' }, ...approvedEvidence('S01') } },
    commitStep('S01'),
  ]);
  const real = runnerChild(p.root, f, 'start', '--once');
  await until(path.join(f.dir, 'waits.log'));
  while (!fs.readFileSync(path.join(f.dir, 'waits.log'), 'utf8').includes('long wait')) await new Promise((r) => setTimeout(r, 25));
  // close the terminal: the runner, its orca-wait and the sleeping orca all die
  for (const line of spawnSync('pgrep', ['-P', String(real.pid)], { encoding: 'utf8' }).stdout.trim().split('\n').filter(Boolean)) {
    for (const g of spawnSync('pgrep', ['-P', line], { encoding: 'utf8' }).stdout.trim().split('\n').filter(Boolean)) process.kill(Number(g), 'SIGKILL');
    process.kill(Number(line), 'SIGKILL');
  }
  real.kill('SIGKILL');
  await exited(real);
  const out = runner(p.root, f, 'start', '--once').out;
  assert.deepEqual(out.find((o) => o.merged), { merged: 'S01', commit: lastCommit(f) });
  assert.deepEqual(f.spawns().map((s) => s.role), ['worker', 'worker']); // one writer, one reviewer
  assert.deepEqual(f.sends(), [{ to: 'term_1', text: 'approved — commit' }]);
});

test('two runners taking over the same dead lock: exactly one wins', async () => {
  const STATE = new URL('../scripts/lib/state.mjs', import.meta.url).pathname;
  const script = `import * as st from ${JSON.stringify(STATE)};
const [root, at] = process.argv.slice(1);
while (Date.now() < Number(at)) {}
console.log(JSON.stringify(st.acquireLock(root, 'runner')));
setTimeout(() => {}, 700);`;
  for (let round = 0; round < 6; round++) {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'runner-lock-')));
    fs.mkdirSync(path.join(root, '.cursor'));
    const dead = spawnSync(process.execPath, ['-e', 'console.log(process.pid)'], { encoding: 'utf8' });
    fs.writeFileSync(path.join(root, '.cursor', 'producer.lock'), JSON.stringify({ pid: Number(dead.stdout.trim()), host: os.hostname(), started_at: 'then' }));
    const at = String(Date.now() + 300);
    const kids = [0, 1].map(() => spawn(process.execPath, ['--input-type=module', '-e', script, root, at], { stdio: ['ignore', 'pipe', 'inherit'] }));
    const results = await Promise.all(kids.map((k) => new Promise((r) => {
      let out = '';
      k.stdout.on('data', (d) => (out += d));
      k.stdout.on('end', () => r(JSON.parse(out.trim())));
    })));
    assert.equal(results.filter((x) => x.ok).length, 1, `round ${round}: ${JSON.stringify(results)}`);
    const holder = JSON.parse(fs.readFileSync(path.join(root, '.cursor', 'producer.lock'), 'utf8'));
    assert.ok(kids.some((k) => k.pid === holder.pid));
  }
});
