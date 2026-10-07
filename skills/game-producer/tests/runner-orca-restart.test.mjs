import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { textNeed, answerProblem } from '../scripts/lib/answer.mjs';
import { project, fakes, runner, ev, evRel, sliceState, clearControl } from './harness.mjs';

// Pilot 12 (cc-car-service-kids S03): Orca restarted mid-slice. Every terminal got a new handle, the claude
// sessions were resumed without their wait loop, and the Run still named the old coordinator handle. The
// runner asked coordinator_missing with no way to help: the human had to rebind by hand.
process.env.PRODUCER_RUNNER_CURSOR = 'on';
const H = evRel('S01', 'HANDOFF.json');
const REBIND = 'rebind the coordinator given in --text';
const runnerFile = (root) => JSON.parse(fs.readFileSync(path.join(root, '.cursor', 'producer-runner.json'), 'utf8'));
const question = (root, id) => runnerFile(root).questions.find((q) => q.id === id);
const log = (root) => fs.readFileSync(ev(root, 'S01', 'producer-log.md'), 'utf8');
const waits = (f) => fs.readFileSync(path.join(f.dir, 'waits.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

// the coordinator's terminal is stale for Orca (restarted): coordinator_missing, with a Run
function missingWithRun() {
  const p = project({ slices: { S01: { needs: false, size: 'L' } } });
  const f = fakes();
  f.queue([
    { name: 'run', runs: [{ id: 'run_1', coordinator_handle: 'term_1' }], write: { [H]: { role: 'coordinator', status: 'working' } } },
    { name: 'gone', result: 'missing', dead: ['term_1'] },
  ]);
  const a = runner(p.root, f, 'start', '--once').out.at(-1);
  assert.deepEqual([a.waiting, a.kind], ['q1', 'coordinator_missing']);
  return { p, f };
}

test('coordinator_missing with a Run offers to rebind the resumed coordinator and names the likely cause', () => {
  const { p } = missingWithRun();
  const q = question(p.root, 'q1');
  assert.deepEqual(q.options, ['taken over, continue', REBIND, 'mark blocked', 'stop']);
  assert.match(q.text, /Orca may have restarted/);
  assert.match(q.text, /orca terminal list/);
});

test('coordinator_missing without a Run has nothing to rebind to: no rebind option', () => {
  const p = project({ slices: { S01: { needs: false, size: 'L' } } });
  const f = fakes();
  f.queue([{ name: 'gone', result: 'missing', dead: ['term_1'] }]);
  const a = runner(p.root, f, 'start', '--once').out.at(-1);
  assert.deepEqual([a.waiting, a.kind], ['q1', 'coordinator_missing']);
  assert.deepEqual(question(p.root, 'q1').options, ['taken over, continue', 'mark blocked', 'stop']);
});

test('the rebind answer needs the new handle as one token (--text)', () => {
  const { p, f } = missingWithRun();
  const q = question(p.root, 'q1');
  assert.equal(textNeed(q, REBIND), 'required');
  assert.match(answerProblem(q, REBIND, ''), /terminal handle/);
  assert.match(answerProblem(q, REBIND, 'term_9 and more'), /terminal handle/);
  assert.equal(answerProblem(q, REBIND, 'term_9'), null);
  assert.equal(answerProblem(q, 'taken over, continue', ''), null);
  const bad = runner(p.root, f, 'answer', '--id', 'q1', '--choice', REBIND);
  assert.notEqual(bad.status, 0);
  assert.equal(question(p.root, 'q1').answer, null);
  assert.deepEqual(f.sends(), []);
});

test('rebind answer: the new terminal is told to run-use the Run and re-dispatch lost tasks; later waits use its handle', () => {
  const { p, f } = missingWithRun();
  assert.equal(runner(p.root, f, 'answer', '--id', 'q1', '--choice', REBIND, '--text', 'term_9').status, 0);
  clearControl(p.root);
  f.queue([
    // the Run still names the old handle until the resumed coordinator runs run-use: only waits
    { name: 'old handle still named', result: 'missing' },
    { name: 'run-use done', runs: [{ id: 'run_1', coordinator_handle: 'term_9' }], write: { [H]: { role: 'coordinator', status: 'working', detail: 'implement re-dispatched' } } },
    { name: 'working on the new handle', write: { [H]: { role: 'coordinator', status: 'working', detail: 'implement running' } } },
  ]);
  runner(p.root, f, 'start', '--once', { env: { PRODUCER_RUNNER_IDLE_MS: '20' } });
  const sends = f.sends();
  assert.equal(sends.length, 1);
  assert.equal(sends[0].to, 'term_9');
  assert.match(sends[0].text, /orca orchestration run-use --id run_1/);
  assert.match(sends[0].text, /re-dispatch/);
  assert.match(sends[0].text, /CONTINUE from the existing changes/);
  assert.match(sends[0].text, /orca-wait\.mjs coord/);
  assert.doesNotMatch(sends[0].text, /\n/); // one line: a newline could submit early
  assert.equal(question(p.root, 'q1').answer.choice, REBIND);
  assert.equal(runnerFile(p.root).questions.length, 1); // not asked again while the Run names the old handle
  assert.equal(sliceState(p.root, 'S01').coordinator, 'term_9');
  assert.match(log(p.root), /coordinator rebind: term_1 → term_9/);
  assert.match(log(p.root), /coordinator is now term_9 \(takeover\)/);
  assert.equal(waits(f).at(-1).on, 'term_9');
});
