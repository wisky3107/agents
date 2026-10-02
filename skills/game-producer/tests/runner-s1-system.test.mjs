import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { systemFor, withSystem, SYSTEMS } from '../scripts/lib/attribution.mjs';
import { appendLessons } from '../scripts/lib/merge.mjs';

// Lessons attribution (workflow scorecard S1): the runner's cost rows say which system cost the time.

test('systemFor maps every runner cost row to a known system', () => {
  const cases = [
    [{ event: 'fix_round', cause: 'review CHANGES_REQUESTED' }, 'agent'],
    [{ event: 'infra_blocked', cause: 'reviewer could not reach localhost → cursor --model auto' }, 'agent:review'],
    [{ event: 'infra_blocked', cause: 'preview down, writer restarted it' }, 'engine'],
    [{ event: 'respawn', cause: 'writer stopped' }, 'orca'],
    [{ event: 'merge_conflict', cause: 'merge of S01-x' }, 'orca'],
    [{ event: 'budget_bump' }, 'brief'],
    [{ event: 'director_gate' }, 'brief'],
    [{ event: 'other', cause: 'blocked: by the director' }, 'other'],
  ];
  for (const [row, want] of cases) {
    assert.equal(systemFor(row), want, row.event);
    assert.ok(SYSTEMS.includes(want.split(':')[0]));
  }
});

test('withSystem leaves learning rows and written systems alone', () => {
  assert.equal(withSystem({ event: 'recipe_candidate', candidate_id: 'c' }).system, undefined);
  assert.equal(withSystem({ event: 'fix_round', system: 'art:antigravity' }).system, 'art:antigravity');
  assert.equal(withSystem({ event: 'respawn' }).system, 'orca');
});

test('appendLessons writes system and does not repeat a row recorded before S1', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lessons-s1-'));
  const f = path.join(root, '.cursor', 'evidence', 'lessons.jsonl');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const old = { slice: 'S01', event: 'fix_round', count: 1, cost: '1 fix round(s)', cause: 'review CHANGES_REQUESTED', fix_target: 'none', at: 'then' };
  fs.writeFileSync(f, `${JSON.stringify(old)}\n`);
  const added = appendLessons(root, [
    { ...old, at: 'now' }, // the same fact again after a kill: not appended
    { slice: 'S01', event: 'respawn', count: 1, cost: '1 resume lane(s)', cause: 'writer stopped', fix_target: 'none', at: 'now' },
    { event: 'recipe_candidate', candidate_id: 'p/T-S01/c1', slice: 'S01', at: 'now' },
  ]);
  assert.equal(added, 2);
  const rows = fs.readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(rows.map((r) => [r.event, r.system]), [['fix_round', undefined], ['respawn', 'orca'], ['recipe_candidate', undefined]]);
  assert.equal(appendLessons(root, [{ slice: 'S01', event: 'respawn', count: 1, cost: '1 resume lane(s)', cause: 'writer stopped', fix_target: 'none', at: 'later' }]), 0);
});
