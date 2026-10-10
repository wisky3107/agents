import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { project, fakes, runner } from './harness.mjs';

// pilot 20 (cat-dash): the runner asked contracts_uncommitted with the fallback options and routed the
// answer to the lane handler, which threw "no action for contracts_uncommitted: fixed, retry" (q2 runner_error)
test('contracts_uncommitted: its own retry option, and the answer only clears the stop', () => {
  const p = project({ slices: { S01: { needs: false }, S02: { needs: false } } });
  const f = fakes();
  p.commit('feat(S01): first slice'); // past the brief gate
  fs.writeFileSync(path.join(p.root, 'HOW_TO.md'), '# how\n');
  const first = runner(p.root, f, 'start', '--once').out.find((o) => o.blocked);
  assert.equal(first.blocked, 'contracts_uncommitted');
  assert.deepEqual(first.options, ['committed, retry', 'stop']);
  runner(p.root, f, 'answer', '--id', first.question, '--choice', 'committed, retry');
  // still uncommitted: the same block again, never a runner_error
  const again = runner(p.root, f, 'start', '--once').out;
  assert.equal(again.find((o) => o.blocked)?.blocked, 'contracts_uncommitted');
  assert.ok(!again.some((o) => o.blocked === 'runner_error'), JSON.stringify(again));
});
