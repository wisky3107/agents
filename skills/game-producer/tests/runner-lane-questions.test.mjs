import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { NOTES, POLICY, RUNNER, project, fakes, runner, env, evRel } from './harness.mjs';
import { menu } from '../scripts/lib/answer.mjs';
import { laneTag } from '../scripts/lib/lanes.mjs';

// Phase 2 M3 (docs/plans/2026-10-15-runner-parallel-phase2): a question says which lane asks (main or its own
// worktree), status lists the live lanes, and pilot-wait --once tells lane_started / lane_done once two lanes live.
process.env.PRODUCER_RUNNER_CURSOR = 'on';
const lines = (out) => out.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
const runnerFile = (root) => JSON.parse(fs.readFileSync(path.join(root, '.cursor', 'producer-runner.json'), 'utf8'));
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

test('a question from a lane in its own worktree carries lane + checkout; the menu and status show it', () => {
  const p = project({ notes: NOTES(POLICY, '{}', '  lane_worktree: true\n'), slices: { S01: { needs: false } } });
  const f = fakes();
  f.queue([{ name: 'blocked', wt: 'S01', write: { [evRel('S01', 'HANDOFF.json')]: { role: 'writer', status: 'blocked', detail: 'need a ruling', sha: null } } }]);
  const q = runner(p.root, f, 'start', '--once').out.at(-1);
  assert.equal(q.kind, 'lane_blocked');
  const row = runnerFile(p.root).questions.find((x) => x.id === q.waiting);
  const wt = `${p.root}-wt-S01-x`;
  assert.deepEqual([row.lane, row.checkout], ['worktree', wt]);
  assert.match(menu(row), new RegExp(`^${row.id} · lane_blocked · S01 · worktree ${path.basename(wt)}$`, 'm'));
  const status = lines(spawnSync(process.execPath, [RUNNER, 'status', '--project', p.root], { encoding: 'utf8', env: env(p.root, f) }).stdout)[0];
  assert.deepEqual(status.lanes.map((l) => [l.slice, l.lane, l.checkout, l.phase]), [['S01', 'worktree', wt, 'writer']]);
  assert.deepEqual(laneTag(p.root, 'S02'), { lane: 'main', checkout: p.root });
  assert.doesNotMatch(menu({ id: 'q9', kind: 'x', slice: 'S02', lane: 'main', checkout: p.root, text: 't', options: ['a'] }), /worktree/);
});

test('pilot-wait --once: one lane keeps slice_changed; two lanes tell lane_done / lane_started', async () => {
  const p = project();
  const f = fakes();
  const file = path.join(p.root, '.cursor', 'producer-runner.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(path.join(p.root, '.cursor', 'producer.lock'), JSON.stringify({ pid: process.pid, host: os.hostname(), mode: 'runner' }));
  const setRunner = (o) => fs.writeFileSync(file, JSON.stringify({ questions: [], ...o }));
  const waitOnce = () => {
    const child = spawn(process.execPath, [RUNNER, 'pilot-wait', '--once', '--project', p.root], { env: { ...env(p.root, f), PRODUCER_RUNNER_PILOT_POLL_MS: '30' }, stdio: ['ignore', 'pipe', 'pipe'] });
    return new Promise((resolve) => { let out = ''; child.stdout.on('data', (d) => (out += d)); child.on('exit', () => resolve(lines(out))); });
  };
  setRunner({ slice: 'S30', lanes: [{ slice: 'S30' }, { slice: 'S21' }] });
  let done = waitOnce();
  await pause(300);
  setRunner({ slice: 'S21', lanes: [{ slice: 'S21' }] });
  assert.deepEqual((await done)[0], { event: 'lane_done', slices: ['S30'], lanes: ['S21'] });

  setRunner({ slice: 'S21', lanes: [{ slice: 'S21' }] });
  done = waitOnce();
  await pause(300);
  setRunner({ slice: 'S21', lanes: [{ slice: 'S21' }, { slice: 'S22' }] });
  assert.deepEqual((await done)[0], { event: 'lane_started', slices: ['S22'], lanes: ['S21', 'S22'] });

  setRunner({ slice: 'S21', lanes: [{ slice: 'S21' }] });
  done = waitOnce();
  await pause(300);
  setRunner({ slice: 'S22', lanes: [{ slice: 'S22' }] });
  assert.deepEqual((await done)[0], { event: 'slice_changed', from: 'S21', to: 'S22' }, 'one lane at a time: as before');
});
