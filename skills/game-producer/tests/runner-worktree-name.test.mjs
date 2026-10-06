// Slice worktrees and merged slices are found by the Sxx token anywhere in the name (pilot 5, S12):
// orca named the fleet worktree `feature-S12-scene-structure`, the runner looked for `^S12-` only and
// never read its HANDOFF (offer_commit sat for 15+ min).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { sliceWorktrees, gitMergedSlices } from '../scripts/lib/project.mjs';

const g = (cwd, ...args) => {
  const r = spawnSync('git', ['-C', cwd, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
};

function repo() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'runner-wt-name-')));
  g(root, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(root, 'a.txt'), 'a');
  g(root, 'add', '.');
  g(root, 'commit', '-qm', 'init');
  return root;
}

test('a worktree named feature-S12-… is the S12 worktree; unrelated names are not slices', () => {
  const root = repo();
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-wt-'));
  const wt12 = path.join(base, 'feature-S12-scene-structure');
  const wt11 = path.join(base, 's11-model-pack-2');
  const other = path.join(base, 'issues-s123-cleanup');
  g(root, 'worktree', 'add', '-q', '-b', 'owner/feature-S12-scene-structure', wt12);
  g(root, 'worktree', 'add', '-q', '-b', 'owner/s11-model-pack-2', wt11);
  g(root, 'worktree', 'add', '-q', '-b', 'chore/cleanup', other);
  const live = sliceWorktrees(root);
  assert.equal(fs.realpathSync(live.S12), fs.realpathSync(wt12));
  assert.equal(fs.realpathSync(live.S11), fs.realpathSync(wt11));
  assert.deepEqual(Object.keys(live).sort(), ['S11', 'S12']);
});

test('merges of owner/Sxx-… and owner/feature-Sxx-… branches count as merged; other merges do not', () => {
  const root = repo();
  for (const b of ['owner/feature-S12-scene-structure', 'owner/S10-drag-drop', 'S08-level-pack', 'docs/bulk-ui-funplay']) {
    g(root, 'checkout', '-q', '-b', b, 'main');
    fs.writeFileSync(path.join(root, `${b.replace(/\W/g, '_')}.txt`), b);
    g(root, 'add', '.');
    g(root, 'commit', '-qm', `work on ${b}`);
    g(root, 'checkout', '-q', 'main');
    g(root, 'merge', '-q', '--no-ff', b, '-m', `Merge branch '${b}'`);
  }
  const merged = gitMergedSlices(root);
  assert.deepEqual([...merged].sort(), ['S08', 'S10', 'S12']);
});
