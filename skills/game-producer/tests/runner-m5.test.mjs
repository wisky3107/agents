import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { NOTES, POLICY, project, fakes, runner, evRel, approvedEvidence, commitStep, lastCommit } from './harness.mjs';
import { loadProject, nextLanes, nextSlice, maxParallel, pairProblem, writeRelease, sliceStatuses, preflight } from '../scripts/lib/project.mjs';
import { stepLane } from '../scripts/lib/lanes.mjs';
import * as st from '../scripts/lib/state.mjs';

// Phase 2 M5 (docs/plans/2026-10-15-runner-parallel-phase2 §M5): the scheduler takes one step per lane.
process.env.PRODUCER_RUNNER_CURSOR = 'on';
const H = evRel('S01', 'HANDOFF.json');
const W = (status) => ({ [H]: { role: 'writer', status, detail: 'd', sha: null } });
const R = (status, verdict) => ({ [H]: { role: 'reviewer', status }, ...approvedEvidence('S01', verdict) });
const preview = { [evRel('S01', 'preview-startup.json')]: { projectPath: '/p', previewUrl: 'http://127.0.0.1:7461/', status: 'ready' } };

test('M5a stepLane: one step at a time — done / blocked phases, a stop control', () => {
  const p = project({ slices: { S01: { needs: false } } });
  const ctx = { project: loadProject(p.root), id: 'S01', lane: 'single', waitMs: 1000, idleMs: 0, sleep: () => {} };
  st.writeSliceState(p.root, 'S01', { phase: 'done' });
  assert.deepEqual(stepLane(ctx), { phase: 'done' });
  st.writeSliceState(p.root, 'S01', { phase: 'blocked' });
  assert.deepEqual(stepLane(ctx), { phase: 'blocked' });
  st.writeSliceState(p.root, 'S01', { phase: 'writer' });
  st.writeControl(p.root, 'pause');
  assert.deepEqual(stepLane(ctx), { stopped: 'pause' });
});

test('M5a harness: a per-terminal queue plays a single lane like the shared list', () => {
  const p = project({ slices: { S01: { needs: false } } });
  const f = fakes();
  // term_1 the writer, term_2 the reviewer (the fake bootstrap hands handles out in order)
  f.queue({
    term_1: [{ name: 'ready', write: { ...W('ready_for_review'), ...preview } }, commitStep('S01')],
    term_2: [{ name: 'approved', write: R('approved', 'APPROVED') }],
  });
  const out = runner(p.root, f, 'start', '--once').out;
  assert.equal(out.find((o) => o.merged)?.commit, lastCommit(f));
  const waits = fs.readFileSync(path.join(f.dir, 'waits.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual([...new Set(waits.filter((w) => w.step).map((w) => `${w.on}:${w.step}`))], ['term_1:ready', 'term_2:approved', 'term_1:committed']);
});

const TWO = POLICY.replace('max_parallel=1', 'max_parallel=2');
const inProgress = (root, ...ids) => writeRelease(loadProject(root), { slices: Object.fromEntries(ids.map((id) => [id, 'in_progress'])) });
const lanesOf = (root) => { const pr = loadProject(root); return nextLanes(pr, sliceStatuses(pr)); };

test('M5b nextLanes: max_parallel 1 is nextSlice; 2 adds the first runnable slice only when it pairs with the live lane', () => {
  const free = { S01: [], S02: [], S03: [] };
  const one = project({ slices: { S01: { needs: false }, S02: { needs: false }, S03: { needs: false } }, dag: free, parallelOk: [['S01', 'S02']] });
  const pr1 = loadProject(one.root);
  assert.equal(maxParallel(pr1), 1);
  assert.deepEqual(nextLanes(pr1, sliceStatuses(pr1)), nextSlice(pr1, sliceStatuses(pr1)));

  const p = project({ notes: NOTES(TWO), slices: { S01: { needs: false }, S02: { needs: false }, S03: { needs: false } }, dag: free, parallelOk: [['S01', 'S02']] });
  assert.equal(maxParallel(loadProject(p.root)), 2);
  assert.deepEqual(lanesOf(p.root), { live: [], next: 'S01' });
  inProgress(p.root, 'S01');
  assert.deepEqual(lanesOf(p.root), { live: ['S01'], next: 'S02' });
  inProgress(p.root, 'S01', 'S02');
  assert.deepEqual(lanesOf(p.root), { live: ['S01', 'S02'], next: null }, 'a restart with a valid pair resumes both');
  writeRelease(loadProject(p.root), { slices: { S01: 'merged', S02: 'in_progress' } });
  assert.deepEqual(lanesOf(p.root), { live: ['S02'], next: null, held: 'S03 waits for S02: S02 and S03 are not a parallel_ok pair in MILESTONES.md' });
  assert.deepEqual(preflight(loadProject(p.root), 'S03').filter((b) => b.code === 'max_parallel'), [], 'max_parallel=2 is no blocker');
});

test('M5b pairProblem: not a pair, a fleet slice, a shared exclusive group; two live slices that may not pair are stuck', () => {
  const p = project({
    notes: NOTES(TWO),
    slices: { S01: { needs: false }, S02: { needs: false, exclusive: ['api'] }, S03: { needs: false, size: 'L' }, S04: { needs: false } },
    dag: { S01: [], S02: [], S03: [], S04: [] },
    parallelOk: [['S01', 'S02'], ['S01', 'S03'], ['S02', 'S04']], exclusive: { api: ['S04'] },
  });
  const pr = loadProject(p.root);
  assert.equal(pairProblem(pr, 'S01', 'S02'), null);
  assert.equal(pairProblem(pr, 'S01', 'S04'), 'S01 and S04 are not a parallel_ok pair in MILESTONES.md');
  assert.equal(pairProblem(pr, 'S01', 'S03'), 'S03 is a fleet (L) slice: phase 2 pairs single lanes only');
  assert.equal(pairProblem(pr, 'S02', 'S04'), 'S02 and S04 share the exclusive group api', 'front matter + MILESTONES groups');
  inProgress(p.root, 'S01', 'S04');
  assert.deepEqual(lanesOf(p.root), { stuck: true, reason: 'two slices in progress that may not run together: S01 and S04 are not a parallel_ok pair in MILESTONES.md' });
  const q = project({ notes: NOTES(POLICY.replace('max_parallel=1', 'max_parallel=3')), slices: { S01: { needs: false } } });
  assert.match(preflight(loadProject(q.root), 'S01').find((b) => b.code === 'max_parallel').detail, /runs one or two lanes/);
});
