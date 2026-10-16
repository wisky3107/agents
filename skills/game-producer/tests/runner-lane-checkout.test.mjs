import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { project } from './harness.mjs';
import { loadProject } from '../scripts/lib/project.mjs';
import { laneCheckout, promptValues, sliceBase, reviewVerdict, slicePort } from '../scripts/lib/lanes.mjs';
import * as st from '../scripts/lib/state.mjs';

// Phase 2 M0 (docs/plans/2026-10-15-runner-parallel-phase2): a single lane's checkout is main unless it records
// `lane_checkout`; then its prompt values, evidence, review file and base all follow that checkout, while the
// runner state stays in main.
test('laneCheckout: main by default; a recorded worktree moves PROJECT, EVIDENCE, PORT, BASE and the review file', () => {
  const p = project();
  const proj = loadProject(p.root);
  assert.equal(laneCheckout(p.root, 'S01'), p.root);
  const main = promptValues(proj, 'S01');
  assert.equal(main.PROJECT, p.root);
  assert.equal(main.EVIDENCE_DIR, path.join(p.root, '.cursor', 'evidence', 'tasks', 'T-S01', 'evidence'));

  // a worktree on a branch from the current commit, recorded as the lane's checkout
  const wt = `${p.root}-S01-lane`;
  const add = spawnSync('git', ['-C', p.root, 'worktree', 'add', '-q', '-b', 'S01-lane', wt], { encoding: 'utf8' });
  assert.equal(add.status, 0, add.stderr);
  const head = spawnSync('git', ['-C', wt, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
  st.writeSliceState(p.root, 'S01', { lane_checkout: wt, base_sha: head });
  const ev = path.join(wt, '.cursor', 'evidence', 'tasks', 'T-S01', 'evidence');
  fs.mkdirSync(ev, { recursive: true });
  fs.writeFileSync(path.join(ev, 'preview-startup.json'), JSON.stringify({ projectPath: wt, previewUrl: 'http://127.0.0.1:7466/' }));
  fs.writeFileSync(path.join(ev, 'review.md'), '# review\nAPPROVED\n');

  assert.equal(laneCheckout(p.root, 'S01'), wt);
  const v = promptValues(proj, 'S01');
  assert.equal(v.PROJECT, wt);
  assert.equal(v.EVIDENCE_DIR, ev);
  assert.equal(v.PORT, '7466', 'the port the lane recorded in its own checkout');
  assert.equal(sliceBase(p.root, 'S01', wt), head, 'base_sha checked against the lane checkout');
  assert.equal(reviewVerdict(proj, 'S01').verdict, 'APPROVED');
  // runner state stays in main; another slice still works in main
  assert.ok(fs.existsSync(path.join(p.root, '.cursor', 'evidence', 'tasks', 'T-S01', 'producer-state.json')));
  assert.equal(promptValues(proj, 'S02').PROJECT, p.root);
  spawnSync('git', ['-C', p.root, 'worktree', 'remove', '--force', wt]);
});

test('slicePort reads run_project_preview\'s `url` as well as `previewUrl` (pilot 24 S39)', () => {
  const p = project({ slices: { S01: { needs: false } } });
  const ev = path.join(p.root, '.cursor', 'evidence', 'tasks', 'T-S01', 'evidence');
  fs.mkdirSync(ev, { recursive: true });
  fs.writeFileSync(path.join(ev, 'preview-startup.json'), JSON.stringify({ url: 'http://localhost:7457/', mode: 'browser', source: 'funplay run_project_preview' }));
  assert.equal(slicePort(p.root, 'S01'), 7457);
  fs.writeFileSync(path.join(ev, 'preview-startup.json'), JSON.stringify({ previewUrl: 'http://localhost:7456/', projectPath: p.root }));
  assert.equal(slicePort(p.root, 'S01'), 7456);
});
