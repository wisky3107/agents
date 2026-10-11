// pilot 21 F11: a fleet gate's own option "C: stop, report FAIL to producer" got past the judge's
// option filter (it only removed the runner's literal 'stop'), and the judge picked it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { judgeOptions } from '../scripts/lib/judge.mjs';

test('judge never gets a lane-written stop / abandon / report-FAIL option on a fleet gate', () => {
  const gate = ['A: one extra regen round for failing chrome rows (cap exception)', 'B: deterministic recolour of passing cream card chrome via gen_2d.py (recorded method deviation)', 'C: stop, report FAIL to producer', 'stop'];
  assert.deepEqual(judgeOptions('fleet_gate', gate), gate.slice(0, 2));
  assert.deepEqual(judgeOptions('fleet_gate', ['approve', 'revise', 'stop', 'mark blocked', 'skip this slice', 'abandon the slice', 'halt the lane']), ['approve', 'revise']);
  // conservative on purpose: an option that starts with "stop" goes to the pilot/director even when it is a design choice;
  // one that only mentions stopping later stays with the judge
  assert.deepEqual(judgeOptions('fleet_gate', ['keep the sway', 'stop the crowd sway at rest', 'fade the sway, then stop it']), ['keep the sway', 'fade the sway, then stop it']);
  assert.deepEqual(judgeOptions('lane_blocked', ['send this answer to the lane', 'stop']), ['send this answer to the lane']);
});
