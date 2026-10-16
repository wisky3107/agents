import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { project, fakes, runner, evRel, approvedEvidence, commitStep, lastCommit } from './harness.mjs';
import { loadProject } from '../scripts/lib/project.mjs';
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
