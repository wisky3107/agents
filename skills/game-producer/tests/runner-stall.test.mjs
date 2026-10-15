import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { NOTES, POLICY, project, fakes, runner, evRel, ev, sliceState, approvedEvidence, commitStep, lastCommit } from './harness.mjs';

// Pilot 24 (cc-capytal-war S27): a Claude writer whose context grew to ~309k sat 3h46m on "Request timed out ·
// Retrying in 0s · attempt 4/9". The spinner kept the TUI busy, so orca-wait never read idle and nothing asked;
// one interrupt + /compact by hand let it finish in 90 min.
process.env.PRODUCER_RUNNER_CURSOR = 'on';
const H = evRel('S01', 'HANDOFF.json');
const W = (status, extra = {}) => ({ [H]: { role: 'writer', status, detail: 'd', sha: null, ...extra } });
const preview = { [evRel('S01', 'preview-startup.json')]: { projectPath: '/p', previewUrl: 'http://127.0.0.1:7461/', status: 'ready' } };
const R = (status, verdict) => ({ [H]: { role: 'reviewer', status }, ...approvedEvidence('S01', verdict) });
const single = (extra = '') => project({ notes: NOTES(POLICY, '{}', extra), slices: { S01: { needs: false } } });
const runnerFile = (root) => JSON.parse(fs.readFileSync(path.join(root, '.cursor', 'producer-runner.json'), 'utf8'));
const question = (root, id) => runnerFile(root).questions.find((q) => q.id === id);
const log = (root) => fs.readFileSync(ev(root, 'S01', 'producer-log.md'), 'utf8');
// a busy look: the fake terminal never reads idle within one orca-wait call
const busy = (n, extra = {}) => Array.from({ length: n }, (_, i) => ({ name: `busy ${i + 1}`, sleepMs: 1700, ...extra }));
const idle = (n) => Array.from({ length: n }, (_, i) => ({ name: `idle ${i + 1}`, result: 'idle' }));
const screen = (handle, lines) => ({ [handle]: { at: 'a', frames: { a: { lines } } } });
const RETRYING = ['✻ Thinking… (24m 12s · ↓ 1.2k tokens)', '  ⎿  Request timed out · Retrying in 0s · attempt 4/9', '', '  ⏵⏵ bypass permissions on'];
const SPINNER = ['✻ Thinking… (2m 3s · ↓ 300 tokens)', '', '  ⏵⏵ bypass permissions on'];
const COMPACT = 'interrupt and /compact, keep the writer';
const keystream = (dir) => (fs.existsSync(path.join(dir, 'keystream.log')) ? fs.readFileSync(path.join(dir, 'keystream.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);

test('a busy writer whose screen keeps retrying requests is asked lane_stalled; /compact interrupts, compacts, and the idle nudge resumes it', () => {
  const p = single();
  const f = fakes();
  f.screens(screen('term_1', RETRYING));
  f.queue(busy(3));
  const out = runner(p.root, f, 'start', '--once', { env: { ORCA_WAIT_RETRY_STALL_MS: '0' } }).out;
  const q = out.at(-1);
  assert.equal(q.kind, 'lane_stalled');
  assert.deepEqual(q.options, [COMPACT, 'writer is alive, keep waiting', 'spawn another resume lane', 'mark blocked', 'stop']);
  assert.match(question(p.root, q.waiting).text, /writer term_1 is busy but stalled: its screen has shown request retries for 0 min \("⎿  Request timed out · Retrying in 0s · attempt 4\/9"\)/);
  assert.deepEqual([f.closes().length, f.spawns().length], [0, 1], 'nothing closed or respawned while asking');

  runner(p.root, f, 'answer', '--id', q.waiting, '--choice', COMPACT);
  f.screens(screen('term_1', ['● compacted', '', '  ⏵⏵ bypass permissions on']));
  f.queue([...idle(2), { name: 'ready', write: { ...W('ready_for_review'), ...preview } }, { name: 'approved', write: R('approved', 'APPROVED') }, commitStep('S01')]);
  const after = runner(p.root, f, 'start', '--once').out;
  assert.equal(after.find((o) => o.merged)?.commit, lastCommit(f));
  const ks = keystream(f.dir).filter((k) => k.to === 'term_1');
  assert.equal(ks[0].interrupt, true, 'the interrupt goes first');
  assert.match(ks[1].text, /^\/compact Keep: slice S01 \(slices\/S01[^)]*\.md\) and its acceptance rows/);
  assert.equal(ks[1].enter, true);
  assert.match(ks[2].text, /^Status check: HANDOFF\.json is not ready_for_review yet/, 'the idle nudge resumes the compacted writer');
  assert.equal(f.spawns().length, 2, 'the same writer, then the reviewer: no resume lane');
  assert.equal(sliceState(p.root, 'S01').compacts, 1);
  assert.match(log(p.root), /writer term_1 stalled: interrupted, \/compact sent/);
});

test('busy for STALL_MS with no change in the tree or HANDOFF asks; a file the writer saves restarts the clock', () => {
  const p = single();
  const f = fakes();
  f.screens(screen('term_1', SPINNER));
  // look 1 sets the baseline, look 2 sees the writer save a file (progress), look 3 sees nothing new → ask
  f.queue([...busy(1), ...busy(1, { write: { 'assets/scripts/Wallet.ts': 'export const x = 1;\n' } }), ...busy(2)]);
  const out = runner(p.root, f, 'start', '--once', { env: { PRODUCER_RUNNER_STALL_MS: '1' } }).out;
  const q = out.at(-1);
  assert.equal(q.kind, 'lane_stalled');
  assert.match(question(p.root, q.waiting).text, /it has been busy for \d+ min, and nothing changed in the working tree or HANDOFF/);
  const waits = fs.readFileSync(path.join(f.dir, 'waits.log'), 'utf8').trim().split('\n').length;
  assert.ok(waits >= 3, `asked only after the save was seen (${waits} looks)`);

  // "keep waiting": the stall clocks restart and the same observation is not asked again
  runner(p.root, f, 'answer', '--id', q.waiting, '--choice', 'writer is alive, keep waiting');
  f.queue([{ name: 'ready', write: { ...W('ready_for_review'), ...preview } }, { name: 'approved', write: R('approved', 'APPROVED') }, commitStep('S01')]);
  const after = runner(p.root, f, 'start', '--once', { env: { PRODUCER_RUNNER_STALL_MS: '600000' } }).out;
  assert.equal(after.find((o) => o.merged)?.commit, lastCommit(f));
  assert.match(log(p.root), /writer term_1 is alive \(answered\): the stall clocks restart, terminal kept/);
});

test('a busy writer that is not retrying and keeps saving is never asked', () => {
  const p = single();
  const f = fakes();
  f.screens(screen('term_1', SPINNER));
  f.queue([...[1, 2, 3].flatMap((i) => busy(1, { write: { [`assets/scripts/F${i}.ts`]: `export const f = ${i};\n` } })),
    { name: 'ready', write: { ...W('ready_for_review'), ...preview } }, { name: 'approved', write: R('approved', 'APPROVED') }, commitStep('S01')]);
  const out = runner(p.root, f, 'start', '--once', { env: { PRODUCER_RUNNER_STALL_MS: '1' } }).out;
  assert.equal(out.find((o) => o.merged)?.commit, lastCommit(f));
  assert.equal(out.some((o) => o.kind === 'lane_stalled'), false);
});

test('autopilot compacts a writer that keeps retrying requests, never one that is only quiet', () => {
  const p = single('  autopilot: retry_once\n');
  const f = fakes();
  f.screens(screen('term_1', RETRYING));
  f.queue(busy(3));
  const out = runner(p.root, f, 'start', '--once', { env: { ORCA_WAIT_RETRY_STALL_MS: '0' } }).out;
  assert.deepEqual(out.find((o) => o.autopilot), { autopilot: 'q1', kind: 'lane_stalled', choice: COMPACT });
  assert.ok(keystream(f.dir).some((k) => k.interrupt && k.to === 'term_1'));

  const r = single('  autopilot: retry_once\n');
  const g = fakes();
  g.screens(screen('term_1', SPINNER));
  g.queue(busy(3));
  const quiet = runner(r.root, g, 'start', '--once', { env: { PRODUCER_RUNNER_STALL_MS: '1' } }).out;
  assert.equal(quiet.at(-1).kind, 'lane_stalled');
  assert.equal(quiet.some((o) => o.autopilot), false, 'busy without retries waits for a human');
  assert.equal(keystream(g.dir).some((k) => k.interrupt), false);
});
