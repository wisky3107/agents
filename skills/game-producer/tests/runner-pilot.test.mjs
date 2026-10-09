import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { menu, parseReply, submit, extraChoices, PILOT_CHOICE } from '../scripts/lib/answer.mjs';
import { RUNNER, project, fakes, env } from './harness.mjs';

// "resolve by pilot agent" (2026-10-09, the director): while the workflow-pilot skill has a pilot
// registered on the project, every way to answer offers handing the question to the pilot agent. The
// question stays open (marked pilot_handoff) until the pilot answers with `answer --by pilot`.
const DIALOG = new URL('../scripts/answer-dialog.mjs', import.meta.url).pathname;
const GATE = { id: 'q1', key: 'S01:fleet_gate:g1', kind: 'fleet_gate', slice: 'S01', text: 'fleet gate g1: Approve PLAN?', options: ['approve', 'revise', 'stop'], ref: 'g1', answer: null };
const runnerFile = (root) => JSON.parse(fs.readFileSync(path.join(root, '.cursor', 'producer-runner.json'), 'utf8'));
const question = (root, id) => runnerFile(root).questions.find((q) => q.id === id);
const withQuestions = (qs, extra = {}) => {
  const p = project({ slices: { S01: { needs: false } } });
  fs.mkdirSync(path.join(p.root, '.cursor'), { recursive: true });
  fs.writeFileSync(path.join(p.root, '.cursor', 'producer-runner.json'), JSON.stringify({ slice: 'S01', step: 'blocked:x', questions: qs, ...extra }));
  return p;
};
const cli = (root, f, ...args) => spawnSync(process.execPath, [RUNNER, ...args, '--project', root], { encoding: 'utf8', timeout: 20000, env: env(root, f) });
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const lines = (out) => out.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));

test('answer lib: no pilot, no extra row; a pilot adds one numbered after the options, and handing leaves the question open', () => {
  const p = withQuestions([GATE]);
  assert.deepEqual(extraChoices(p.root, GATE), []);
  assert.throws(() => submit(p.root, 'q1', PILOT_CHOICE), /no pilot is registered/);
  assert.throws(() => submit(p.root, 'q1', 'approve', '', null, 'pilot'), /no pilot is registered/);

  const r = runnerFile(p.root);
  fs.writeFileSync(path.join(p.root, '.cursor', 'producer-runner.json'), JSON.stringify({ ...r, pilot: { n: 18 } }));
  const extras = extraChoices(p.root, GATE);
  assert.deepEqual(extras, [PILOT_CHOICE]);
  assert.match(menu(GATE, [], extras), / {2}3\) stop\n {2}4\) resolve by pilot agent\n/);
  assert.deepEqual(parseReply(GATE, '4 check the mock first', extras), { choice: PILOT_CHOICE, text: 'check the mock first' });
  assert.match(parseReply(GATE, '5', extras).error, /1 to 4/);

  submit(p.root, 'q1', PILOT_CHOICE, 'check the mock first', 'terminal');
  const q = question(p.root, 'q1');
  assert.equal(q.answer, null);
  assert.deepEqual([q.pilot_handoff.pilot, q.pilot_handoff.text, q.pilot_handoff.via], [18, 'check the mock first', 'terminal']);
  assert.deepEqual(extraChoices(p.root, q), [], 'handed once: no second row');
  assert.match(menu(q), /handed to the pilot agent .*; an answer here still wins/);
  assert.throws(() => submit(p.root, 'q1', PILOT_CHOICE), /already handed/);

  submit(p.root, 'q1', 'revise', 'smaller scope', null, 'pilot');
  assert.deepEqual([question(p.root, 'q1').answer.choice, question(p.root, 'q1').answer.by], ['revise', 'pilot']);
});

test('CLI: pilot --set / --clear, answer --choice "resolve by pilot agent", pilot-wait prints each handed question once', () => {
  const p = withQuestions([GATE, { ...GATE, id: 'q2', key: 'S01:fleet_gate:g2', ref: 'g2' }]);
  const f = fakes();
  assert.match(cli(p.root, f, 'pilot', '--set').stdout, /needs --n/);
  assert.deepEqual(lines(cli(p.root, f, 'pilot', '--set', '--n', '18').stdout)[0].pilot.n, 18);
  assert.equal(runnerFile(p.root).pilot.n, 18);
  assert.equal(cli(p.root, f, 'answer', '--id', 'q2', '--choice', PILOT_CHOICE, '--text', 'your call').status, 0);
  assert.deepEqual(lines(cli(p.root, f, 'pilot').stdout)[0].handed, ['q2']);

  const waited = spawnSync(process.execPath, [RUNNER, 'pilot-wait', '--timeout-ms', '300', '--project', p.root], { encoding: 'utf8', timeout: 20000, env: { ...env(p.root, f), PRODUCER_RUNNER_PILOT_POLL_MS: '50' } });
  const out = lines(waited.stdout);
  assert.deepEqual(out.map((x) => x.handed || x.pilot_wait), ['q2', 'timeout']);
  assert.equal(out[0].note, 'your call');
  assert.match(out[0].answer, /--id q2 --choice "<option>" --by pilot$/);

  assert.equal(cli(p.root, f, 'answer', '--id', 'q2', '--choice', 'approve', '--by', 'pilot').status, 0);
  assert.equal(question(p.root, 'q2').answer.by, 'pilot');
  assert.match(cli(p.root, f, 'answer', '--id', 'q1', '--choice', 'approve', '--by', 'robot').stdout, /--by is human or pilot/);
  // a question still handed when the pilot closes goes back to the director
  assert.equal(cli(p.root, f, 'pilot', '--set', '--n', '18').status, 0);
  assert.equal(cli(p.root, f, 'answer', '--id', 'q1', '--choice', PILOT_CHOICE).status, 0);
  assert.equal(question(p.root, 'q1').dialog_done, 'pilot');
  const cleared = lines(cli(p.root, f, 'pilot', '--clear').stdout)[0];
  assert.deepEqual([cleared.cleared.n, cleared.returned_to_director], [18, ['q1']]);
  assert.equal(runnerFile(p.root).pilot, null);
  assert.deepEqual([question(p.root, 'q1').pilot_handoff, question(p.root, 'q1').dialog_done], [undefined, undefined]);
  assert.match(cli(p.root, f, 'pilot', '--set', '--n', '0').stdout, /needs --n/);
});

test('dialog: the pilot row sits before "Show the whole question"; picking it hands the question and keeps the dialog closed', () => {
  const p = withQuestions([GATE], { pilot: { n: 18 } });
  const f = fakes();
  const bin = path.join(f.dir, 'osascript-fake');
  // choose → the pilot row, note → a hint
  fs.writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' "$@" >> ${JSON.stringify(path.join(f.dir, 'osa.log'))}\ncase "$*" in *"choose from list"*) echo "Resolve by pilot agent (pilot 18)";; *) echo "look at r2";; esac\n`, { mode: 0o755 });
  const r = spawnSync(process.execPath, [DIALOG, '--project', p.root, '--id', 'q1'], { encoding: 'utf8', timeout: 20000, env: { ...env(p.root, f), PRODUCER_RUNNER_OSASCRIPT: bin } });
  assert.equal(r.status, 0, r.stderr);
  const log = fs.readFileSync(path.join(f.dir, 'osa.log'), 'utf8');
  assert.match(log, /\nstop\nResolve by pilot agent \(pilot 18\)\nShow the whole question\n/);
  assert.match(log, /passed to the pilot agent word for word/);
  const q = question(p.root, 'q1');
  assert.equal(q.answer, null);
  assert.deepEqual([q.pilot_handoff.text, q.pilot_handoff.via, q.dialog_done], ['look at r2', 'dialog', 'pilot']);
});

// "nếu pilot ở mode tự động toàn bộ, thì tự động trả lời câu hỏi luôn" (2026-10-09, the director):
// a pilot registered with --auto gets every question the judge and autopilot leave, before the
// director is called; `pilot --return` gives one back, and only then is the director called.
test('pilot --auto: the runner hands the question itself, calls nobody; a returned question calls the director with the reason', async () => {
  const STUCK = { id: 'q1', key: '-:stuck', kind: 'stuck', slice: null, text: 'The runner cannot pick a slice. x', options: ['fixed, retry', 'stop'], answer: null };
  const p = withQuestions([STUCK]);
  const f = fakes();
  assert.equal(lines(cli(p.root, f, 'pilot', '--set', '--n', '18', '--auto').stdout)[0].pilot.auto, true);
  const child = spawn(process.execPath, [RUNNER, 'start', '--project', p.root], { env: env(p.root, f), stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  try {
    for (let i = 0; i < 200 && !out.includes('"waiting":"q1"'); i++) await pause(25);
    const q = question(p.root, 'q1');
    assert.deepEqual([q.answer, q.pilot_handoff.via, q.dialog_done], [null, 'auto', 'pilot']);
    assert.match(out, /"handed_to_pilot":"q1","kind":"stuck","via":"auto"/);
    await pause(200);
    assert.deepEqual(f.notices(), [], 'the director is not called for a question the pilot holds');
    assert.deepEqual(extraChoices(p.root, q), [], 'no handoff row: it is handed');

    const waited = spawnSync(process.execPath, [RUNNER, 'pilot-wait', '--timeout-ms', '100', '--project', p.root], { encoding: 'utf8', timeout: 20000, env: env(p.root, f) });
    assert.equal(lines(waited.stdout)[0].auto, true);
    assert.match(cli(p.root, f, 'pilot', '--return', 'q1').stdout, /say why/);
    assert.match(cli(p.root, f, 'pilot', '--return', 'q1', '--note', ' ').stdout, /say why/);
    assert.equal(lines(cli(p.root, f, 'pilot', '--return', 'q1', '--note', 'a budget call').stdout)[0].returned, 'q1');
    for (let i = 0; i < 200 && !f.notices().length; i++) await pause(25);
    assert.equal(f.notices().length, 1, 'given back: now the director is called');
    assert.match(out, /"returned_by_pilot":"q1","note":"a budget call"/);
    const back = question(p.root, 'q1');
    assert.deepEqual([back.pilot_handoff, back.dialog_done, back.pilot_returned.note], [undefined, undefined, 'a budget call']);
    assert.deepEqual(extraChoices(p.root, back), [], 'not handed again, not offered again');
    assert.match(menu(back), /The pilot agent gave this back to you: a budget call/);
    assert.throws(() => submit(p.root, 'q1', PILOT_CHOICE), /gave q1 back/);
  } finally {
    child.kill('SIGKILL');
  }
});

// "làm A" (2026-10-09, the director): a pilot that mostly waits should cost no wake-ups. pilot-wait
// --once has no time limit and exits on the first thing the pilot must act on.
test('pilot-wait --once: exits on a handed question, a slice change, a halt or a gone runner — and not before', async () => {
  const p = withQuestions([GATE], { pilot: { n: 18, auto: true } });
  const f = fakes();
  const waitOnce = () => spawn(process.execPath, [RUNNER, 'pilot-wait', '--once', '--project', p.root], { env: { ...env(p.root, f), PRODUCER_RUNNER_PILOT_POLL_MS: '30' }, stdio: ['ignore', 'pipe', 'pipe'] });
  const result = (child) => new Promise((resolve) => {
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.on('exit', () => resolve(lines(out)));
  });
  const lockFile = path.join(p.root, '.cursor', 'producer.lock');
  // no runner holds the lock
  assert.deepEqual((await result(waitOnce()))[0].event, 'runner_gone');

  // a live runner (this test process holds the lock): waits; then the runner moves to S02
  fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, host: os.hostname(), mode: 'runner' }));
  let child = waitOnce();
  let done = result(child);
  await pause(400);
  assert.equal(child.exitCode, null, 'nothing to act on: it keeps waiting');
  assert.equal(lines(cli(p.root, f, 'pilot').stdout)[0].waiter_alive, true);
  const r = runnerFile(p.root);
  fs.writeFileSync(path.join(p.root, '.cursor', 'producer-runner.json'), JSON.stringify({ ...r, slice: 'S02' }));
  assert.deepEqual((await done)[0], { event: 'slice_changed', from: 'S01', to: 'S02' });

  // a handed question: its line, then exit
  child = waitOnce();
  done = result(child);
  await pause(200);
  submit(p.root, 'q1', PILOT_CHOICE, 'take it');
  const handed = await done;
  assert.deepEqual([handed.length, handed[0].handed, handed[0].note], [1, 'q1', 'take it']);
  // still handed (not answered yet): a restarted wait shows it again at once
  assert.equal((await result(waitOnce()))[0].handed, 'q1');
  submit(p.root, 'q1', 'approve', '', null, 'pilot');

  // the director pauses the runner
  child = waitOnce();
  done = result(child);
  await pause(200);
  fs.writeFileSync(path.join(p.root, '.cursor', 'producer.control'), 'pause\n');
  assert.deepEqual((await done)[0], { event: 'runner_halting', control: 'pause' });
});
