import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { project, fakes, runner, evRel } from './harness.mjs';

// Pilot 18 F4: a worker's `blocked` hand-off to the coordinator is the coordinator's to settle first.
const H = evRel('S01', 'HANDOFF.json');
const fleet = () => project({ slices: { S01: { needs: false, size: 'L' } } });
const hand = (role, status, detail) => ({ [H]: { role, status, detail } });
const start = (w) => ({ name: 'run created', runs: [{ id: 'run_1', coordinator_handle: 'term_1' }], write: w });
const GRACE = 60000; // longer than one runner invocation
const SHORT = 300;
const run = (root, f, grace = GRACE) => {
  fs.rmSync(path.join(root, '.cursor', 'producer.control'), { force: true }); // --once leaves a stop behind
  const r = runner(root, f, 'start', '--once', { env: { PRODUCER_RUNNER_KEY_MS: '0', PRODUCER_RUNNER_WORKER_BLOCKED_GRACE_MS: String(grace) } });
  if (process.env.DBG) console.error(JSON.stringify(r));
  return r.out;
};
const runnerFile = (root) => JSON.parse(fs.readFileSync(path.join(root, '.cursor', 'producer-runner.json'), 'utf8'));
const asked = (out) => out.some((o) => o.waiting || o.kind);
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const WB = 'S03-04 realPicture false -> F-I3 writer fix';

test('F4: worker blocked, then the coordinator updates the HANDOFF inside the window -> no question', () => {
  const p = fleet();
  const f = fakes();
  f.queue([start(hand('integrator', 'blocked', WB))]);
  assert.equal(asked(run(p.root, f)), false);
  f.queue([{ name: 'coordinator routes it', write: hand('coordinator', 'working', 'routing F-I3 to the writer') }]);
  assert.equal(asked(run(p.root, f)), false);
  f.queue([{ name: 'still working', write: hand('coordinator', 'working', 'routing F-I3 to the writer, still') }]);
  assert.equal(asked(run(p.root, f, SHORT)), false);
  sleep(SHORT + 100);
  f.queue([{ name: 'later', write: hand('coordinator', 'working', 'later') }]);
  assert.equal(asked(run(p.root, f, SHORT)), false);
  assert.equal(runnerFile(p.root).questions?.length ?? 0, 0);
});

test('F4: the same worker blocked past the window -> lane_blocked with a note', () => {
  const p = fleet();
  const f = fakes();
  f.queue([start(hand('integrator', 'blocked', WB))]);
  assert.equal(asked(run(p.root, f)), false);
  sleep(SHORT + 100);
  f.queue([{ name: 'nothing changed' }]);
  const out = run(p.root, f, SHORT);
  assert.equal(out.find((o) => o.blocked)?.blocked, 'lane_blocked');
  assert.match(runnerFile(p.root).questions[0].text, /fleet HANDOFF blocked: S03-04 realPicture false.*\(the coordinator did not settle it within \d+ s\)/);
});

test('F4: a coordinator blocked is asked at once', () => {
  const p = fleet();
  const f = fakes();
  f.queue([start(hand('coordinator', 'blocked', 'need a director decision'))]);
  const out = run(p.root, f);
  assert.equal(out.find((o) => o.blocked)?.blocked, 'lane_blocked');
  assert.equal(runnerFile(p.root).questions[0].text, 'fleet HANDOFF blocked: need a director decision');
});
