import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NOTES, POLICY, project, fakes, runner, ev, evRel, clearControl } from './harness.mjs';

// `producer-runner cancel <Sxx>` (pilot 24: the director cancelled S21 mid-writer and the pilot did each step by hand).
process.env.PRODUCER_RUNNER_CURSOR = 'on';
const runnerFile = (root) => JSON.parse(fs.readFileSync(path.join(root, '.cursor', 'producer-runner.json'), 'utf8'));
const lines = (dir, f) => (fs.existsSync(path.join(dir, f)) ? fs.readFileSync(path.join(dir, f), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

test('cancel a main lane: terminals closed, changes listed (never reverted), T-Sxx archived, cache cancelled, questions closed, next slice runs', () => {
  const p = project({ slices: { S01: { needs: false }, S02: { needs: false } }, dag: { S01: [], S02: [] } });
  const f = fakes();
  f.queue([{ name: 'blocked', write: { 'src/wallet.ts': 'export const w = 1;\n', 'assets/art/turn.png': 'png', [evRel('S01', 'HANDOFF.json')]: { role: 'writer', status: 'blocked', detail: 'need a ruling', sha: null } } }]);
  const q = runner(p.root, f, 'start', '--once').out.at(-1);
  assert.equal(q.kind, 'lane_blocked');
  const out = runner(p.root, f, 'cancel', 'S01', '--note', 'director: the request meant another icon').out.at(-1);
  assert.equal(out.cancelled, 'S01');
  assert.deepEqual(out.closed, ['term_1']);
  assert.deepEqual(out.changed_in_main.files.sort(), ['assets/art/turn.png', 'src/wallet.ts']);
  assert.match(out.changed_in_main.note, /refresh_assets those paths \(Funplay MCP\) so the editor's library matches the disk: assets\/art\/turn\.png$/);
  assert.match(out.next, /`producer-runner clear` \(the stop you set\) and launch/);
  assert.ok(fs.existsSync(path.join(p.root, 'src/wallet.ts')), 'the change is left for the director');
  assert.match(out.archived, /T-S01\.cancelled-/);
  assert.equal(fs.existsSync(ev(p.root, 'S01')), false);
  assert.match(fs.readFileSync(path.join(out.archived, 'producer-log.md'), 'utf8'), /cancelled by the director: director: the request meant another icon/);
  assert.match(fs.readFileSync(path.join(p.root, 'AGENT_NOTES.md'), 'utf8'), /S01: cancelled/);
  const r = runnerFile(p.root);
  assert.equal(r.slice, null);
  assert.deepEqual(r.lanes, []);
  assert.equal(r.questions.find((x) => x.id === q.waiting).answer.by, 'cancel');
  // the runner goes on with S02
  fs.rmSync(path.join(p.root, 'src/wallet.ts'));
  fs.rmSync(path.join(p.root, 'assets'), { recursive: true });
  clearControl(p.root);
  const dry = runner(p.root, f, 'start', '--dry-run').out.at(-1);
  assert.equal(dry.slice, 'S02');
});

test('cancel a lane in a clean worktree: removed (its evidence kept in the archive), branch kept', () => {
  const p = project({ notes: NOTES(POLICY, '{}', '  lane_worktree: true\n'), slices: { S01: { needs: false } } });
  const f = fakes();
  f.queue([{ name: 'notes', wt: 'S01', write: { [evRel('S01', 'integration-notes.md')]: '# notes\n' } }]);
  runner(p.root, f, 'start', '--once');
  const wt = `${p.root}-wt-S01-x`;
  assert.ok(fs.existsSync(wt));
  const out = runner(p.root, f, 'cancel', 'S01').out.at(-1);
  assert.deepEqual(out.worktree, { path: wt, removed: true, branch_kept: true });
  assert.equal(fs.existsSync(wt), false);
  assert.ok(fs.existsSync(path.join(out.archived, 'worktree-evidence', 'evidence', 'integration-notes.md')));
  assert.equal(lines(f.dir, 'rm.log').filter((x) => x.phase === 'done').length, 1);
});

test('cancel refuses while a runner runs and for a merged slice; a slice that needs a cancelled one waits with the reason', () => {
  const p = project({ slices: { S01: { needs: false }, S02: { needs: false } } });  // dag: S02 needs S01
  const f = fakes();
  fs.mkdirSync(path.join(p.root, '.cursor'), { recursive: true });
  fs.writeFileSync(path.join(p.root, '.cursor', 'producer.lock'), JSON.stringify({ pid: process.pid, host: os.hostname(), mode: 'runner' }));
  assert.match(runner(p.root, f, 'cancel', 'S01').out.at(-1).refused, /a runner holds the lock: stop it first/);
  fs.rmSync(path.join(p.root, '.cursor', 'producer.lock'));
  assert.match(runner(p.root, f, 'cancel', 'x1').out.at(-1).refused, /usage: producer-runner cancel <Sxx>/);
  p.commit('feat(S01): already done');
  assert.match(runner(p.root, f, 'cancel', 'S01').out.at(-1).refused, /S01 is merged: revert its merge/);

  const q = project({ slices: { S01: { needs: false }, S02: { needs: false } } });
  assert.equal(runner(q.root, f, 'cancel', 's01').out.at(-1).cancelled, 'S01');
  const dry = runner(q.root, f, 'start', '--dry-run').out.at(-1);
  assert.match(dry.stuck, /waiting on a cancelled slice — drop it from their MILESTONES dag: S02 \(needs S01\)/);
});
