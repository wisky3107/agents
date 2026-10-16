import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { project, fakes, runner, NOTES, POLICY, evRel, sliceState } from './harness.mjs';

// fleet.coordinator: script (plan 2026-10-16-fleet-script-coordinator M4): the runner is the Run's coordinator and
// fleet-driver.mjs runs the Task DAG. fleet-queue.json is the Run inbox, one step per `orchestration check`.
const FRONT = [
  'name: x', 'one_liner: x', 'player_outcome: x',
  'paths:\n  code: ["assets/scripts/**"]\n  art: []\n  scene_objects: []',
  'scope:\n  in: [x]\n  out: []',
  'acceptance:\n  - text: the cat jumps\n    evidence: capture',
  'feel_rows: []', 'runtime_checks: ["play level 1"]', 'playtest: []',
  'change_budget:\n  files: 5\n  lines: 300\n  nodes: 2\n  assets: 0', 'risks: []', 'release_items: []', 'depends_on: []', '',
].join('\n');
// the merge closes and reopens editors (runner-lane-worktree.test.mjs fakes)
const CLOSE = '#!/bin/bash\necho "close $1" >> "$FAKE_DIR/editor.log"\nexit 0\n';
const OPEN = '#!/bin/bash\necho "open $1" >> "$FAKE_DIR/editor.log"\necho "$1" >> "$FAKE_DIR/editor-up"\n';
const PROBE = `import fs from 'node:fs';
import path from 'node:path';
const f = path.join(process.env.FAKE_DIR, 'editor-up');
const up = fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\\n') : [];
const reachable = up.includes(fs.realpathSync(process.cwd()));
console.log(JSON.stringify({ funplay: { url: 'http://127.0.0.1:1/', reachable, servedProject: reachable ? path.basename(process.cwd()) : null, parity: reachable ? true : null } }));
`;
const scriptProject = (extra = {}) => {
  const p = project({
    notes: NOTES(POLICY, '{}', '', '  coordinator: script\n'),
    slices: { S01: { needs: false, size: 'L', front: FRONT, ...extra } },
    files: { '.gitignore': '/.cursor/evidence/\n', 'scripts/close-editor.sh': CLOSE, 'scripts/open-editor.sh': OPEN,
      '.cursor/skills/vibe-game-director/scripts/probe.mjs': PROBE, 'funplay-cocos-mcp.config.json': '{"port": 1}' },
  });
  for (const f of ['scripts/close-editor.sh', 'scripts/open-editor.sh']) fs.chmodSync(path.join(p.root, f), 0o755);
  spawnSync('git', ['-C', p.root, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qam', 'exec bits']);
  return p;
};
const VERIFIED = { name: 'verified', write: { [evRel('S01', 'verify-main.json')]: { status: 'verified', detail: 'smoke green' } } };
const fleetLog = (f) => fs.readFileSync(path.join(f.dir, 'fleet.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const inbox = (f, steps) => fs.writeFileSync(path.join(f.dir, 'fleet-queue.json'), JSON.stringify(steps));
const run = (root, f, env = {}) => {
  fs.rmSync(path.join(root, '.cursor', 'producer.control'), { force: true });
  const r = runner(root, f, 'start', '--once', { env: { PRODUCER_RUNNER_KEY_MS: '0', ...env } });
  if (process.env.DBG) console.error(JSON.stringify(r, null, 1));
  return r;
};
const questions = (root) => {
  try { return JSON.parse(fs.readFileSync(path.join(root, '.cursor', 'producer-runner.json'), 'utf8')).questions || []; } catch { return []; }
};
const APPROVED = { [evRel('S01', 'review.md')]: '# Review\n\n## escaped\nnone\n\nAPPROVED\n', [evRel('S01', 'runtime-state.json')]: { status: 'verified' } };

test('script lane (lite): worktree, pointer PLAN, own Run, implement → integrate on one terminal → review → accept → commit task → merge', () => {
  const p = scriptProject();
  const f = fakes();
  inbox(f, [
    { done: 'implement' },
    { done: 'integrate' },
    { wt: 'S01', write: APPROVED, done: 'review', body: 'APPROVED' },
    { wt: 'S01', write: { 'assets/scripts/cat.ts': 'export const jump = 1;\n' }, commit: { message: 'feat(S01): the cat jumps' }, done: 'commit' },
  ]);
  // --once: one inbox wait per runner call
  f.queue([VERIFIED]); // the post-merge verifier
  const phase = () => { try { return sliceState(p.root, 'S01').phase; } catch { return null; } };
  for (let i = 0; i < 14 && phase() !== 'done'; i++) run(p.root, f);
  const s = sliceState(p.root, 'S01');
  const wt = s.worktree;
  assert.match(wt, /-wt-S01-x$/, 'a feature worktree (removed again by the merge)');
  assert.equal(s.fleet_mode, 'script');
  assert.equal(s.coordinator, undefined, 'no coordinator LLM spawned');
  assert.equal(s.plan, 'docs/plans/S01-x.md');
  assert.match(fs.readFileSync(path.join(p.root, 'docs/plans/S01-x.md'), 'utf8'), /^task_id: "T-S01"/, 'the PLAN came to main with the slice commit');
  const log = fleetLog(f);
  const starts = log.filter((x) => x.op === 'worker-start');
  assert.deepEqual(starts.map((x) => x.title), ['T-S01:implement#1', 'T-S01:integrate#1', 'T-S01:review#1', 'T-S01:commit#1']);
  assert.deepEqual([starts[0].agent, starts[0].model, starts[0].worktree], ['claude', 'sonnet', `path:${wt}`]);
  assert.equal(starts[1].terminal, 'term_fw_2', 'integrate reuses the implement terminal');
  assert.deepEqual([starts[2].agent, starts[2].terminal], ['claude', null], 'a fresh reviewer');
  assert.equal(starts[3].terminal, 'term_fw_2', 'commit on the implement terminal');
  const ev = path.join(p.root, evRel('S01', '')); // evidence copied back to main by the merge
  assert.ok(fs.existsSync(path.join(ev, 'specs', 'implement-1.md')));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(ev, 'stats.json'), 'utf8')).review_rounds, 1);
  assert.match(fs.readFileSync(path.join(ev, 'final-report.md'), 'utf8'), /Coordinator: the producer runner \(script\)/);
  // committed in the worktree, then the merge journal took it to main
  assert.equal(phase(), 'done');
  assert.match(spawnSync('git', ['-C', p.root, 'log', '--oneline', '-5'], { encoding: 'utf8' }).stdout, /feat\(S01\): the cat jumps/);
  assert.ok(fs.existsSync(path.join(p.root, 'assets/scripts/cat.ts')));
  assert.ok(log.some((x) => x.op === 'release' && x.dispatch === 'ctx_f8'), 'the chain closed by releasing its last dispatch');
  assert.deepEqual(questions(p.root).map((q) => `${q.kind}: ${q.text}`), []);
});

test('script lane: a worker question becomes a runner question; the answer goes back with orchestration reply', () => {
  const p = scriptProject();
  const f = fakes();
  inbox(f, [{ question: { task: 'implement', text: 'Which jump height?' } }]);
  run(p.root, f);
  const q = questions(p.root)[0];
  assert.equal(q.kind, 'worker_question');
  assert.match(q.text, /implement: Which jump height\?/);
  assert.ok(q.ref.startsWith('drv:msg:'));
  const a = runner(p.root, f, 'answer', '--id', q.id, '--choice', 'answer with --text', '--text', '2 units');
  assert.equal(a.status, 0, a.stderr);
  inbox(f, []);
  run(p.root, f);
  assert.deepEqual(fleetLog(f).filter((x) => x.op === 'reply').map((x) => x.body), ['2 units']);
});

test('script lane: a failed worker-start asks (never relaunched blind); retry starts it once more', () => {
  const p = scriptProject();
  const f = fakes();
  fs.writeFileSync(path.join(f.dir, 'worker-start-fail'), '');
  inbox(f, [{}]);
  run(p.root, f);
  const q = questions(p.root)[0];
  assert.equal(q.kind, 'fleet_worker_start');
  assert.match(q.text, /agent-update-prompt/);
  runner(p.root, f, 'answer', '--id', q.id, '--choice', 'retry');
  inbox(f, [{}]);
  run(p.root, f);
  const log = fleetLog(f);
  assert.deepEqual(log.filter((x) => x.op.startsWith('worker-start')).map((x) => x.op), ['worker-start-failed', 'worker-start']);
  assert.equal(log.find((x) => x.op === 'worker-start').retryOf, 'ctx_failed', 'the replacement names the failed dispatch (else task_not_startable)');
  assert.ok(log.some((x) => x.op === 'release' && x.dispatch === 'ctx_failed'));
});

test('script lane: a restart resumes from fleet-driver.json — nothing created or started twice', () => {
  const p = scriptProject();
  const f = fakes();
  inbox(f, [{ done: 'implement' }]);
  run(p.root, f);
  inbox(f, [{}]);
  run(p.root, f);
  const log = fleetLog(f);
  assert.equal(log.filter((x) => x.op === 'run-create').length, 1);
  assert.deepEqual(log.filter((x) => x.op === 'task-create').map((x) => x.title), ['T-S01:implement#1', 'T-S01:integrate#1']);
  assert.equal(log.filter((x) => x.op === 'worker-start').length, 2);
});

test('script lane: a runner in another terminal binds the Run again (run-use) before it acts', () => {
  const p = scriptProject();
  const f = fakes();
  inbox(f, [{}]);
  run(p.root, f, { ORCA_TERMINAL_HANDLE: 'term_a' });
  inbox(f, [{}]);
  run(p.root, f, { ORCA_TERMINAL_HANDLE: 'term_b' });
  assert.deepEqual(fleetLog(f).filter((x) => x.op === 'run-use').map((x) => x.id), ['run_f1']);
  assert.equal(sliceState(p.root, 'S01').run_coordinator, 'term_b');
});

test('agent mode stays the default: no fleet.coordinator → coordinator LLM, no driver calls', () => {
  const p = project({ slices: { S01: { needs: false, size: 'L', front: FRONT } } });
  const f = fakes();
  f.queue([{ name: 'idle' }]);
  run(p.root, f);
  const s = sliceState(p.root, 'S01');
  assert.equal(s.fleet_mode, 'agent');
  assert.ok(s.coordinator, 'the coordinator LLM was spawned');
  assert.ok(!fs.existsSync(path.join(f.dir, 'fleet.log')));
});

test('script lane (full): scan → art-manifest ∥ implement; the manifest row from the slice assets makes art-2d; integrate waits for it', () => {
  const p = scriptProject({ assets: 'btn' });
  const f = fakes();
  inbox(f, [
    { done: 'scan' },
    { wt: 'S01', write: { 'assets/art/manifest.json': { '2d': [{ stem: 'btn', file: 'assets/art/btn.png', method: 'procedural' }] } }, done: 'art-manifest' },
    { done: 'implement' },
    { done: 'art-2d' },
  ]);
  for (let i = 0; i < 5; i++) run(p.root, f);
  const starts = fleetLog(f).filter((x) => x.op === 'worker-start');
  assert.deepEqual(starts.map((x) => x.title), ['T-S01:scan#1', 'T-S01:art-manifest#1', 'T-S01:implement#1', 'T-S01:art-2d#1', 'T-S01:integrate#1']);
  assert.deepEqual(starts.map((x) => x.agent), ['claude', 'cursor', 'claude', 'antigravity', null]);
  const ev = path.join(sliceState(p.root, 'S01').worktree, evRel('S01', 'specs'));
  assert.match(fs.readFileSync(path.join(ev, 'scan-1.md'), 'utf8'), /## work order/);
  assert.match(fs.readFileSync(path.join(ev, 'art-2d-1.md'), 'utf8'), /ROLE: writer \(assets\) — 2D textures\/sprites only/);
});

test('script lane: CHANGES_REQUESTED → the fix_routing rows become a fix task on the implement terminal, then a fresh review', () => {
  const p = scriptProject();
  const f = fakes();
  const CR = { [evRel('S01', 'review.md')]: '# Review\n\n## fix_routing\n| ids | owner | scope paths | change | acceptance |\n|---|---|---|---|---|\n| F1 | code | assets/scripts/cat.ts | jump 2 units | jump reads 2 |\n\n## escaped\nnone\n\nCHANGES_REQUESTED\n' };
  inbox(f, [{ done: 'implement' }, { done: 'integrate' }, { wt: 'S01', write: CR, done: 'review', outcome: 'failed', body: 'CHANGES_REQUESTED' }, { done: 'fix1-code' }]);
  for (let i = 0; i < 5; i++) run(p.root, f);
  const starts = fleetLog(f).filter((x) => x.op === 'worker-start');
  assert.deepEqual(starts.map((x) => x.title).slice(3), ['T-S01:fix1-code#1', 'T-S01:review-r2#1']);
  assert.equal(starts[3].terminal, 'term_fw_2');
  assert.equal(starts[4].terminal, null);
  const spec = fs.readFileSync(path.join(sliceState(p.root, 'S01').worktree, evRel('S01', 'specs/fix1-code-1.md')), 'utf8');
  assert.match(spec, /F1 · assets\/scripts\/cat\.ts · jump 2 units · jump reads 2/);
  assert.equal(questions(p.root).length, 0);
});

test('artDir: the folder the art roles own, from folders, globs or the files a slice lists', async () => {
  const { artDir } = await import('../scripts/lib/lanes.mjs');
  assert.equal(artDir(['assets/art/Textures/IslandFrame/frame-top.png', 'assets/art/Textures/IslandFrame/frame-bottom.png']), 'assets/art/Textures/IslandFrame');
  assert.equal(artDir(['assets/art/**']), 'assets/art');
  assert.equal(artDir(['assets/art/ui/*.png', 'assets/art/fx/']), 'assets/art');
  assert.equal(artDir([]), 'assets/art');
});
