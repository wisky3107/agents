import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { NOTES, POLICY, project, fakes, runner, evRel, ev, sliceState, approvedEvidence, commitStep, lastCommit } from './harness.mjs';

// Pilot 23 (cc-capytal-war S06): a Claude Code writer waiting on Monitor / run_in_background work ends its turn between
// events. The TUI is idle ("✻ Baked for 3s · done 7:52 AM · 2 monitors still running", footer "· 2 monitors"), but the
// agent is working: the runner nudged it at idle 2, respawned it at idle 3 (killing its monitors) and, after one respawn,
// asked lane_hung, where autopilot picked "respawn" again.
process.env.PRODUCER_RUNNER_CURSOR = 'on';
const H = evRel('S01', 'HANDOFF.json');
const W = (status, extra = {}) => ({ [H]: { role: 'writer', status, detail: 'd', sha: null, ...extra } });
const preview = { [evRel('S01', 'preview-startup.json')]: { projectPath: '/p', previewUrl: 'http://127.0.0.1:7461/', status: 'ready' } };
const R = (status, verdict) => ({ [H]: { role: 'reviewer', status }, ...approvedEvidence('S01', verdict) });
const single = (extra = '') => project({ notes: NOTES(POLICY, '{}', extra), slices: { S01: { needs: false } } });
const runnerFile = (root) => JSON.parse(fs.readFileSync(path.join(root, '.cursor', 'producer-runner.json'), 'utf8'));
const question = (root, id) => runnerFile(root).questions.find((q) => q.id === id);
const log = (root) => fs.readFileSync(ev(root, 'S01', 'producer-log.md'), 'utf8');
const idle = (n) => Array.from({ length: n }, (_, i) => ({ name: `idle ${i + 1}`, result: 'idle' }));
const screen = (handle, lines) => ({ [handle]: { at: 'a', frames: { a: { lines } } } });
const MONITORS = ['● Monitor event: build finished', '', '✻ Baked for 3s · done 7:52 AM · 2 monitors still running', '', '  ⏵⏵ bypass permissions on · 2 monitors · ← 1 agent'];
const PLAIN = ['● Done for now.', '', '  ⏵⏵ bypass permissions on'];

test('a writer whose idle screen shows live monitors is not nudged or respawned; plain idle still is', () => {
  const p = single();
  const f = fakes();
  f.screens(screen('term_1', MONITORS));
  f.queue([...idle(6), { name: 'ready', write: { ...W('ready_for_review'), ...preview } }, { name: 'approved', write: R('approved', 'APPROVED') }, commitStep('S01')]);
  const out = runner(p.root, f, 'start', '--once').out;
  assert.equal(out.find((o) => o.merged)?.commit, lastCommit(f));
  assert.equal(f.spawns().length, 2, 'one writer, one reviewer: no resume lane');
  assert.deepEqual(f.sends().map((s) => s.text.slice(0, 8)), ['approved'], 'no status-check nudge, only the commit request');
  assert.equal(sliceState(p.root, 'S01').respawns, undefined);
  assert.doesNotMatch(log(p.root), /resume lane/);

  // control: the same idles on a screen without background work nudge at 2 and respawn at 3
  const q = single();
  const g = fakes();
  g.screens(screen('term_1', PLAIN));
  g.queue([...idle(3), { name: 'ready', write: { ...W('ready_for_review'), ...preview } }, { name: 'approved', write: R('approved', 'APPROVED') }, commitStep('S01')]);
  runner(q.root, g, 'start', '--once');
  assert.match(log(q.root), /writer term_1 stopped \(idle, idle_streak 3\): resume lane/);
});

test('footer-only and shell wording count; text far above the footer does not', () => {
  for (const [name, lines, live] of [
    ['footer monitors', ['x', '  ⏵⏵ bypass permissions on · 1 monitor'], true],
    ['shells', ['x', '  ⏵⏵ bypass permissions on · 1 shell'], true],
    ['prose inside the window', ['the build ran 3 monitors', 'x'], false],
    ['old output', ['the build ran 3 monitors', ...Array.from({ length: 10 }, (_, i) => `line ${i}`)], false],
  ]) {
    const p = single();
    const f = fakes();
    f.screens(screen('term_1', lines));
    f.queue(idle(3));
    runner(p.root, f, 'start', '--once');
    assert.equal(/resume lane/.test(log(p.root)), !live, name);
  }
});

test('a live-looking screen that never changes is idle again after ORCA_WAIT_BG_STUCK_MS: lane_hung names the screen, offers "alive, keep waiting", autopilot leaves it', () => {
  const p = single('  autopilot: retry_once\n');
  const f = fakes();
  f.screens(screen('term_1', MONITORS));
  f.queue(idle(5));
  const out = runner(p.root, f, 'start', '--once', { env: { ORCA_WAIT_BG_STUCK_MS: '1' } }).out;
  const q = out.at(-1);
  assert.equal(q.kind, 'lane_hung', 'asked at once, not a silent first respawn');
  assert.ok(q.options.includes('writer is alive, keep waiting'));
  const row = question(p.root, q.waiting);
  assert.match(row.text, /live background work \(2 monitors, 1 agent\)/);
  assert.equal(row.background, '2 monitors, 1 agent');
  assert.equal(row.answer, null, 'autopilot does not respawn a writer whose screen shows background work');
  assert.equal(out.some((o) => o.autopilot), false);
  assert.deepEqual([f.closes().length, f.spawns().length], [0, 1], 'nothing closed, no resume lane');

  // "writer is alive, keep waiting": nothing is closed or spawned, the idle count starts again
  runner(p.root, f, 'answer', '--id', q.waiting, '--choice', 'writer is alive, keep waiting');
  f.queue([{ name: 'ready', write: { ...W('ready_for_review'), ...preview } }, { name: 'approved', write: R('approved', 'APPROVED') }, commitStep('S01')]);
  const after = runner(p.root, f, 'start', '--once', { env: { ORCA_WAIT_BG_STUCK_MS: '60000' } }).out;
  assert.equal(after.find((o) => o.merged)?.commit, lastCommit(f));
  assert.equal(f.spawns().length, 2, 'only the reviewer was spawned');
  assert.deepEqual(f.closes(), ['term_2', 'term_1'], 'the live writer was closed only after its commit');
  assert.match(log(p.root), /writer term_1 is alive \(answered\): idle count restarts, terminal kept/);
});

test('no "alive, keep waiting" option when the terminal is gone', () => {
  const p = single();
  const f = fakes();
  f.queue([{ name: 'gone', result: 'missing' }, { name: 'gone again', result: 'missing' }, { name: 'gone 3', result: 'missing' }]);
  const out = runner(p.root, f, 'start', '--once').out;
  const q = out.find((o) => o.kind === 'lane_hung' || o.blocked === 'lane_hung');
  if (q) assert.ok(!q.options.includes('writer is alive, keep waiting'));
});

test('autopilot still respawns a hung writer that shows no background work', () => {
  const p = single('  autopilot: retry_once\n');
  const f = fakes();
  f.screens({ ...screen('term_1', PLAIN), ...screen('term_2', PLAIN) });
  f.queue([...idle(3), ...idle(3), { name: 'ready', write: { ...W('ready_for_review'), ...preview } }, { name: 'approved', write: R('approved', 'APPROVED') }, commitStep('S01')]);
  const out = runner(p.root, f, 'start', '--once').out;
  assert.deepEqual(out.find((o) => o.autopilot), { autopilot: 'q1', kind: 'lane_hung', choice: 'spawn another resume lane' });
});
