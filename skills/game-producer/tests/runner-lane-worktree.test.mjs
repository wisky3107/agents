import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { NOTES, POLICY, project, fakes, runner, evRel, ev, sliceState, approvedEvidence, commitStep, clearControl } from './harness.mjs';

// Phase 2 M1 (docs/plans/2026-10-15-runner-parallel-phase2): with release.lane_worktree on, a single lane gets its own
// worktree from the slice's base commit; writer, static gate, reviewer and commit happen there; the merge takes the
// fleet path (merge --no-ff into the base branch, evidence back to main, worktree removed, main verified).
process.env.PRODUCER_RUNNER_CURSOR = 'on';
const H = evRel('S01', 'HANDOFF.json');
const W = (status, extra = {}) => ({ [H]: { role: 'writer', status, detail: 'd', sha: null, ...extra } });
const R = (status, verdict) => ({ [H]: { role: 'reviewer', status }, ...approvedEvidence('S01', verdict) });
const VERIFIED = { name: 'verified', write: { [evRel('S01', 'verify-main.json')]: { status: 'verified', detail: 'smoke green' } } };
const lines = (dir, f) => (fs.existsSync(path.join(dir, f)) ? fs.readFileSync(path.join(dir, f), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const git = (cwd, ...a) => spawnSync('git', ['-C', cwd, ...a], { encoding: 'utf8' });
const log = (root) => fs.readFileSync(ev(root, 'S01', 'producer-log.md'), 'utf8');
const CLOSE = `#!/bin/bash
echo "close $1" >> "$FAKE_DIR/editor.log"
if [ -f "$FAKE_DIR/editor-up" ]; then grep -vxF "$1" "$FAKE_DIR/editor-up" > "$FAKE_DIR/editor-up.tmp"; mv "$FAKE_DIR/editor-up.tmp" "$FAKE_DIR/editor-up"; fi
exit 0
`;
const OPEN = `#!/bin/bash
echo "open $1" >> "$FAKE_DIR/editor.log"
echo "$1" >> "$FAKE_DIR/editor-up"
`;
const PROBE = `import fs from 'node:fs';
import path from 'node:path';
const f = path.join(process.env.FAKE_DIR, 'editor-up');
const up = fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\\n') : [];
const here = fs.realpathSync(process.cwd());
const reachable = up.includes(here);
console.log(JSON.stringify({ funplay: { url: 'http://127.0.0.1:1/', reachable, servedProject: reachable ? path.basename(here) : null, parity: reachable ? true : null } }, null, 2));
`;
function laneProject() {
  const p = project({
    notes: NOTES(POLICY, '{}', '  lane_worktree: true\n'), slices: { S01: { needs: false } },
    files: { '.gitignore': '/.cursor/evidence/\n', 'scripts/close-editor.sh': CLOSE, 'scripts/open-editor.sh': OPEN,
      '.cursor/skills/vibe-game-director/scripts/probe.mjs': PROBE, 'funplay-cocos-mcp.config.json': '{"port": 1}' },
  });
  for (const f of ['scripts/close-editor.sh', 'scripts/open-editor.sh']) fs.chmodSync(path.join(p.root, f), 0o755);
  git(p.root, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qam', 'exec bits');
  return p;
}

test('lane_worktree: the single lane works in its own worktree and merges like a fleet lane', () => {
  const p = laneProject();
  const f = fakes();
  const base = git(p.root, 'rev-parse', 'HEAD').stdout.trim();
  const preview = (wt) => ({ [evRel('S01', 'preview-startup.json')]: { projectPath: wt, previewUrl: 'http://127.0.0.1:7466/', status: 'ready' } });
  const wtPath = `${p.root}-wt-S01-x`;
  f.queue([
    { name: 'ready', wt: 'S01', write: { ...W('ready_for_review'), ...preview(wtPath) } },
    { name: 'approved', wt: 'S01', write: R('approved', 'APPROVED') },
    { ...commitStep('S01'), wt: 'S01' },
    VERIFIED,
  ]);
  const out = runner(p.root, f, 'start', '--once').out;
  assert.ok(out.find((o) => o.merged), JSON.stringify(out.slice(-3)));

  const created = lines(f.dir, 'wtcreate.log');
  assert.deepEqual(created.map((c) => [c.name, c.base, c.setup]), [['S01-x', base, 'run']], 'one worktree, from the slice base, with the setup hook');
  const spawns = f.spawns();
  assert.equal(spawns[0].path, wtPath, 'the writer works in the worktree');
  assert.equal(spawns[1].path, wtPath, 'and so does the reviewer');
  assert.ok(fs.readFileSync(path.join(f.dir, 'wait-mcp.log'), 'utf8').includes(wtPath), 'its MCP awaited before the writer');
  // the slice commit came from the worktree branch and is in main now; the worktree is gone, the branch kept
  assert.equal(git(p.root, 'merge-base', '--is-ancestor', fs.readFileSync(path.join(f.dir, 'last-commit'), 'utf8').trim(), 'HEAD').status, 0);
  assert.equal(fs.existsSync(wtPath), false);
  assert.equal(git(p.root, 'rev-parse', '--verify', '--quiet', 'S01-x').status, 0);
  // evidence came back to main; runner state never left it
  assert.ok(fs.existsSync(ev(p.root, 'S01', 'evidence', 'review.md')));
  const s = sliceState(p.root, 'S01');
  assert.equal(s.lane_checkout, wtPath);
  assert.equal(s.phase, 'done');
  assert.match(log(p.root), /lane worktree .*S01-x created from/);
  assert.match(log(p.root), /merge journal started \(single, commit \w+, worktree .*S01-x, branch S01-x\)/);
});

test('lane_worktree off (default): no worktree, the lane stays in main', () => {
  const p = project({ slices: { S01: { needs: false } } });
  const f = fakes();
  const preview = { [evRel('S01', 'preview-startup.json')]: { projectPath: '/p', previewUrl: 'http://127.0.0.1:7461/', status: 'ready' } };
  f.queue([{ name: 'ready', write: { ...W('ready_for_review'), ...preview } }, { name: 'approved', write: R('approved', 'APPROVED') }, commitStep('S01')]);
  const out = runner(p.root, f, 'start', '--once').out;
  assert.ok(out.find((o) => o.merged));
  assert.deepEqual(lines(f.dir, 'wtcreate.log'), []);
  assert.equal(f.spawns()[0].path, p.root);
});

test('a worktree that cannot be created is a question; "run this slice in main" goes on in main', () => {
  const p = project({ notes: NOTES(POLICY, '{}', '  lane_worktree: true\n'), slices: { S01: { needs: false } } });
  const f = fakes();
  fs.writeFileSync(path.join(f.dir, 'worktree-create-fail'), '1');
  const q = runner(p.root, f, 'start', '--once').out.at(-1);
  assert.equal(q.kind, 'worktree_failed');
  assert.deepEqual(q.options, ['retry', 'run this slice in main', 'mark blocked', 'stop']);
  assert.equal(f.spawns().length, 0, 'no writer before the lane has a checkout');
  runner(p.root, f, 'answer', '--id', q.waiting, '--choice', 'run this slice in main');
  const preview = { [evRel('S01', 'preview-startup.json')]: { projectPath: '/p', previewUrl: 'http://127.0.0.1:7461/', status: 'ready' } };
  f.queue([{ name: 'ready', write: { ...W('ready_for_review'), ...preview } }, { name: 'approved', write: R('approved', 'APPROVED') }, commitStep('S01')]);
  const out = runner(p.root, f, 'start', '--once').out;
  assert.ok(out.find((o) => o.merged));
  assert.equal(f.spawns()[0].path, p.root);
  assert.equal(sliceState(p.root, 'S01').lane_in_main, true);
});

test('a worktree left by a killed runner is adopted, never created twice', () => {
  const p = laneProject();
  const f = fakes();
  f.queue([]);
  runner(p.root, f, 'start', '--once');
  const wt = sliceState(p.root, 'S01').lane_checkout;
  assert.equal(lines(f.dir, 'wtcreate.log').length, 1);
  // a kill right after the create, before lane_checkout was recorded
  const file = ev(p.root, 'S01', 'producer-state.json');
  const s = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, JSON.stringify({ ...s, lane_checkout: null, phase: 'spawn-worktree', writer: null, worktree_spawning: new Date().toISOString() }));
  clearControl(p.root);
  f.queue([]);
  runner(p.root, f, 'start', '--once');
  assert.equal(lines(f.dir, 'wtcreate.log').length, 1, 'not created twice');
  assert.equal(sliceState(p.root, 'S01').lane_checkout, wt);
  assert.match(log(p.root), /lane worktree .*S01-x adopted/);
});

test('M2: main and the lane both appended to FOLLOWUPS.md — the worktree merge unions it, no question', () => {
  const FU = (rows) => `# FOLLOWUPS\n\n| # | item |\n|---|---|\n${rows.map((r) => `| ${r} | item ${r} |`).join('\n')}\n`;
  const p = laneProject();
  fs.writeFileSync(path.join(p.root, 'FOLLOWUPS.md'), FU([90]));
  git(p.root, '-c', 'user.email=t@t', '-c', 'user.name=t', 'add', 'FOLLOWUPS.md');
  git(p.root, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'followups');
  const f = fakes();
  const wtPath = `${p.root}-wt-S01-x`;
  const preview = { [evRel('S01', 'preview-startup.json')]: { projectPath: wtPath, previewUrl: 'http://127.0.0.1:7466/', status: 'ready' } };
  f.queue([
    { name: 'main moves', mainCommit: { files: { 'FOLLOWUPS.md': FU([90, 91]) }, message: 'chore: followup 91 from another lane' } },
    { name: 'ready', wt: 'S01', write: { ...W('ready_for_review'), ...preview, 'FOLLOWUPS.md': FU([90, 92]) } },
    { name: 'approved', wt: 'S01', write: R('approved', 'APPROVED') },
    { ...commitStep('S01'), wt: 'S01', commit: { ...commitStep('S01').commit, add: true } },
    VERIFIED,
  ]);
  const out = runner(p.root, f, 'start', '--once').out;
  assert.ok(out.find((o) => o.merged), JSON.stringify(out.slice(-2)));
  const fu = fs.readFileSync(path.join(p.root, 'FOLLOWUPS.md'), 'utf8');
  assert.match(fu, /\| 91 \|/);
  assert.match(fu, /\| 92 \|/);
  assert.match(log(p.root), /merge: conflicts only in shared file\(s\) FOLLOWUPS\.md: merged both sides/);
});
