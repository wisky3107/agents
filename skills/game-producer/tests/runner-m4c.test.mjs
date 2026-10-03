import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadProject, editSliceNote } from '../scripts/lib/project.mjs';
import { harvestNote } from '../scripts/lib/merge.mjs';
import { NOTES, POLICY, project, fakes, runner, runnerChild, until, evRel, ev, sliceState } from './harness.mjs';

// Merge journal (plan M4c) on a real git repo with a real slice worktree; the Editor scripts, the
// probe, wait-mcp, `orca worktree rm` and the verifier lane are fakes.
const g = (cwd, ...a) => spawnSync('git', ['-C', cwd, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { encoding: 'utf8' });
const write = (root, rel, body, mode) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), typeof body === 'string' ? body : JSON.stringify(body), mode ? { mode } : undefined);
};
// close-editor.sh drops the checkout from editor-up unless editor-stuck exists; open-editor.sh adds it back
// editor-stuck lists the checkouts whose Creator ignores the close
const CLOSE = `#!/bin/bash
echo "close $1" >> "$FAKE_DIR/editor.log"
[ -f "$FAKE_DIR/close-sleep" ] && { touch "$FAKE_DIR/close-started"; sleep 1.5; }
if [ -f "$FAKE_DIR/editor-stuck" ] && grep -qxF "$1" "$FAKE_DIR/editor-stuck"; then exit 0; fi
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
const VERIFIED = { name: 'verified', write: { [evRel('S01', 'verify-main.json')]: { status: 'verified', detail: 'smoke green' } } };

function fleet({ notes = NOTES(POLICY, '{S01: in_progress}'), funplay = true } = {}) {
  const p = project({ notes, slices: { S01: { needs: false, size: 'L' } } });
  const f = fakes();
  const root = p.root;
  write(root, '.gitignore', '/.cursor/evidence/\n');
  write(root, 'scripts/close-editor.sh', CLOSE, 0o755);
  write(root, 'scripts/open-editor.sh', OPEN, 0o755);
  write(root, '.cursor/skills/vibe-game-director/scripts/probe.mjs', PROBE);
  if (funplay) write(root, 'funplay-cocos-mcp.config.json', '{"port": 1}');
  write(root, 'src/a.ts', 'export const a = 1;\n');
  g(root, 'add', '-A');
  g(root, 'commit', '-qm', 'chore: template bits');
  const wt = path.join(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'runner-wt-'))), 'S01-feature');
  g(root, 'worktree', 'add', '-q', '-b', 'S01-feature', wt);
  write(wt, 'src/b.ts', 'export const b = 2;\n');
  g(wt, 'add', '-A');
  g(wt, 'commit', '-qm', 'feat(S01): b');
  const sha = g(wt, 'rev-parse', 'HEAD').stdout.trim();
  // the fleet's evidence in the worktree: ignored by git, so the slice commit lacks it → rsync
  const evw = (file, body) => write(wt, evRel('S01', file), body);
  evw('HANDOFF.json', { role: 'coordinator', status: 'committed', sha, detail: 'APPROVED fix_rounds=1 budget_bump=650→700' });
  evw('review.md', 'F1 …\nbudget_bump: 650→700\n\nAPPROVED\n');
  evw('runtime-state.json', { status: 'verified' });
  evw('final-report.md', 'x');
  evw('stats.json', {});
  evw('integration-notes.md', 'budget_bump: 650→700 (two more levels)\n');
  evw('preview.png', 'PNG');
  evw('learning-candidates.json', [{ id: 'c1', kind: 'successful_pattern', topic: 't', context: { engine: '3.8' }, finding: 'f', reuse_value: 'r', existing_recipe: null, evidence: ['review.md'], limitations: [] }]);
  // runner state: the fleet lane committed, the merge journal is next
  fs.mkdirSync(ev(root, 'S01'), { recursive: true });
  const base = g(root, 'symbolic-ref', '--short', 'HEAD').stdout.trim();
  fs.writeFileSync(ev(root, 'S01', 'producer-state.json'), JSON.stringify({ phase: 'merge', lane: 'fleet', commit_sha: sha, worktree: wt, coordinator: 'term_c', run: 'run_1', base_branch: base }));
  fs.writeFileSync(path.join(root, '.cursor', 'producer-runner.json'), JSON.stringify({ slice: 'S01', step: 'lane', questions: [] }));
  fs.writeFileSync(path.join(f.dir, 'editor-up'), `${wt}\n${root}\n`); // both Creators open
  return { p, f, root, wt, sha, base };
}
const journal = (root) => JSON.parse(fs.readFileSync(ev(root, 'S01', 'merge-journal.json'), 'utf8'));
/** SIGKILL a process and every descendant (closing a terminal kills the whole tree). */
function killTree(pid) {
  for (const c of spawnSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' }).stdout.trim().split('\n').filter(Boolean)) killTree(Number(c));
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    /* gone */
  }
}
const runnerFile = (root) => JSON.parse(fs.readFileSync(path.join(root, '.cursor', 'producer-runner.json'), 'utf8'));
const lessonCount = (root) => fs.readFileSync(path.join(root, '.cursor', 'evidence', 'lessons.jsonl'), 'utf8').trim().split('\n').length;
const merges = (root) => g(root, 'rev-list', '--merges', 'HEAD').stdout.trim().split('\n').filter(Boolean).length;
const editorLog = (f) => (fs.existsSync(path.join(f.dir, 'editor.log')) ? fs.readFileSync(path.join(f.dir, 'editor.log'), 'utf8').trim().split('\n') : []);

test('fleet merge journal: harvest → evidence → close both Editors → merge --no-ff → worktree rm → reopen → verify → record', async () => {
  const { f, root, wt, sha } = fleet();
  f.queue([VERIFIED]);
  const out = runner(root, f, 'start', '--once').out;
  assert.deepEqual(out.find((o) => o.merged), { merged: 'S01', commit: sha });
  assert.match(out.at(-1).done, /S01 is merged/);
  // merge: one --no-ff merge commit on main's branch, the worktree removed, its branch kept
  assert.equal(merges(root), 1);
  assert.equal(g(root, 'merge-base', '--is-ancestor', sha, 'HEAD').status, 0);
  assert.equal(fs.existsSync(wt), false);
  assert.equal(g(root, 'rev-parse', '--verify', '--quiet', 'S01-feature').status, 0);
  // evidence came over before the rm, without PNGs
  const evMain = path.join(root, evRel('S01', ''));
  assert.ok(['review.md', 'HANDOFF.json', 'stats.json', 'learning-candidates.json'].every((x) => fs.existsSync(path.join(evMain, x))));
  assert.equal(fs.existsSync(path.join(evMain, 'preview.png')), false);
  // both Editors closed before the merge, main reopened after it; wait-mcp once
  await until(path.join(f.dir, 'editor.log'));
  for (let i = 0; i < 40 && !editorLog(f).includes(`open ${root}`); i++) await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(editorLog(f), [`close ${wt}`, `close ${root}`, `open ${root}`]);
  assert.equal(fs.readFileSync(path.join(f.dir, 'wait-mcp.log'), 'utf8').trim(), root);
  // the verifier lane: one spawn on main with the fixed prompt, closed at its verdict
  const sp = f.spawns();
  assert.deepEqual(sp.map((s) => [s.role, s.slice, s.agent]), [['worker', 'S01', 'claude --model sonnet --effort high']]);
  assert.match(sp[0].title, /^verify-runner-proj-\w+-S01$/);
  assert.match(sp[0].prompt, new RegExp(`right after slice S01 \\(branch S01-feature,\\s+commit ${sha}\\)`));
  assert.doesNotMatch(sp[0].prompt, /<(?!ISO>)(?:[A-Z][A-Z_|]*|Sxx)>/);
  assert.deepEqual(f.closes(), [sp[0].handle, 'term_c']);
  // record: release cache, the one Notes line, lessons once
  const proj = loadProject(root);
  assert.deepEqual([proj.release.slices.S01, proj.release.current_slice], ['merged', '']);
  assert.match(proj.notesText, new RegExp(`\\n- S01 fleet merged fix_rounds=1 bump=650→700 commit=${sha.slice(0, 7)} merged=y -\\n`));
  const lessons = fs.readFileSync(path.join(root, '.cursor', 'evidence', 'lessons.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(lessons.map((r) => r.event), ['fix_round', 'budget_bump', 'recipe_candidate']);
  assert.equal(lessons[1].ratio, 1.077);
  assert.deepEqual([lessons[2].candidate_id, lessons[2].evidence], [`${path.basename(root)}/T-S01/c1`, ['.cursor/evidence/tasks/T-S01/evidence/review.md']]);
  assert.deepEqual(Object.keys(journal(root).steps), ['harvest', 'close_editors', 'merge', 'evidence', 'worktree_rm', 'reopen', 'verify', 'record', 'notes_commit']);
  // the runner commits its bookkeeping (M6): here AGENT_NOTES.md only — this project ignores its evidence
  assert.equal(g(root, 'log', '-1', '--format=%s').stdout.trim(), 'chore(producer): record S01 merge — notes, evidence');
  assert.deepEqual(g(root, 'show', '--name-only', '--format=', 'HEAD').stdout.trim().split('\n'), ['AGENT_NOTES.md']);
  assert.equal(g(root, 'status', '--porcelain', '--', 'AGENT_NOTES.md').stdout, '');
  // a rerun changes nothing
  const head = g(root, 'rev-parse', 'HEAD').stdout.trim();
  runner(root, f, 'start', '--once');
  assert.equal(g(root, 'rev-parse', 'HEAD').stdout.trim(), head);
  assert.equal(merges(root), 1);
  assert.equal(fs.readFileSync(path.join(root, '.cursor', 'evidence', 'lessons.jsonl'), 'utf8').trim().split('\n').length, 3);
});

test('no merge while an Editor cannot be confirmed closed; a conflict is aborted and asked', () => {
  const { f, root, sha } = fleet();
  fs.writeFileSync(path.join(f.dir, 'editor-stuck'), `${root}\n`); // only main's Creator ignores the close
  const a = runner(root, f, 'start', '--once').out.at(-1);
  assert.deepEqual([a.waiting, a.kind], ['q1', 'editors_open']);
  assert.match(runnerFile(root).questions[0].text, /closed on main: it is still running/);
  assert.equal(merges(root), 0);
  fs.rmSync(path.join(f.dir, 'editor-stuck'));
  // main moved on meanwhile with a conflicting b.ts
  write(root, 'src/b.ts', 'export const b = 99;\n');
  g(root, 'add', 'src/b.ts');
  g(root, 'commit', '-qm', 'fix: b on main');
  runner(root, f, 'answer', '--id', 'q1', '--choice', 'closed by hand, check again');
  const b = runner(root, f, 'start', '--once').out.at(-1);
  assert.deepEqual([b.waiting, b.kind], ['q2', 'merge_conflict']);
  assert.equal(fs.existsSync(path.join(root, '.git', 'MERGE_HEAD')), false); // aborted, nothing half-merged
  g(root, 'merge', '--no-ff', '-X', 'theirs', '--no-edit', 'S01-feature');
  runner(root, f, 'answer', '--id', 'q2', '--choice', 'resolved by hand, continue');
  f.queue([VERIFIED]);
  const c = runner(root, f, 'start', '--once').out;
  assert.deepEqual(c.find((o) => o.merged), { merged: 'S01', commit: sha });
  assert.equal(merges(root), 1);
  assert.equal(journal(root).steps.merge.conflict, true);
  assert.match(fs.readFileSync(path.join(root, '.cursor', 'evidence', 'lessons.jsonl'), 'utf8'), /"event":"merge_conflict"/);
});

test('an untracked file the merge would overwrite is stashed (reported when different); a dirty worktree is kept', () => {
  const { f, root, wt } = fleet();
  write(root, 'src/b.ts', 'export const b = "stray";\n'); // untracked on main, differs from the slice
  write(wt, 'notes-left-behind.txt', 'wip'); // untracked in the worktree: not removable
  f.queue([VERIFIED]);
  runner(root, f, 'start', '--once');
  assert.equal(merges(root), 1);
  assert.equal(fs.readFileSync(path.join(root, 'src/b.ts'), 'utf8'), 'export const b = 2;\n');
  const dir = journal(root).stash_dir;
  assert.match(dir, /^\/tmp\/S01-stash\//);
  assert.equal(fs.readFileSync(path.join(dir, 'src', 'b.ts'), 'utf8'), 'export const b = "stray";\n');
  fs.rmSync(dir, { recursive: true });
  assert.equal(fs.existsSync(wt), true);
  assert.equal(journal(root).steps.worktree_rm.kept, 'dirty');
  assert.match(loadProject(root).notesText, /merged=y worktree kept: dirty; stash differs: src\/b\.ts\n/);
});

test('a failed memory harvest keeps the worktree; wait-mcp failure and a manual verify are questions', () => {
  const { f, root, wt } = fleet();
  fs.writeFileSync(path.join(f.dir, 'no-orca-memory'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  fs.writeFileSync(path.join(f.dir, 'wait-mcp-exit'), '3');
  const a = runner(root, f, 'start', '--once').out.at(-1);
  assert.deepEqual([a.waiting, a.kind], ['q1', 'reopen_failed']);
  assert.equal(merges(root), 1);
  assert.equal(fs.existsSync(wt), true);
  assert.equal(journal(root).steps.worktree_rm.kept, 'harvest_failed');
  fs.rmSync(path.join(f.dir, 'wait-mcp-exit'));
  runner(root, f, 'answer', '--id', 'q1', '--choice', 'editor opened by hand, check again');
  f.queue([{ name: 'manual', write: { [evRel('S01', 'verify-main.json')]: { status: 'manual_required', detail: 'preview needs a device' } } }]);
  const b = runner(root, f, 'start', '--once').out.at(-1);
  assert.deepEqual([b.waiting, b.kind], ['q2', 'verify_manual']);
  assert.equal(loadProject(root).release.slices.S01, 'in_progress'); // not recorded merged before main is verified
  runner(root, f, 'answer', '--id', 'q2', '--choice', 'verified by hand, record');
  const c = runner(root, f, 'start', '--once').out;
  assert.ok(c.find((o) => o.merged));
  assert.match(loadProject(root).notesText, /merged=y worktree kept: harvest_failed; memory harvest failed\n/);
});

test('a harvest that exits 0 but printed off is not recorded as archived (lego-stack S08)', () => {
  const { f, root, wt } = fleet();
  const line = JSON.stringify({ stage: 'harvest', status: 'off', inject: false, reason: 'project not in trusted config', unregistered: root });
  fs.writeFileSync(path.join(f.dir, 'no-orca-memory'), `#!/bin/sh\necho '${line}'\n`, { mode: 0o755 });
  f.queue([VERIFIED]);
  assert.ok(runner(root, f, 'start', '--once').out.find((o) => o.merged));
  const h = journal(root).steps.harvest;
  assert.deepEqual([h.status, h.failed, h.memory], [0, false, 'off']);
  assert.equal(h.note, `off: ${root} is not registered with orca-memory`);
  assert.equal(fs.existsSync(wt), false, 'off is not a failure: the worktree still goes');
  assert.match(fs.readFileSync(ev(root, 'S01', 'producer-log.md'), 'utf8'), /runner: memory harvest: off: .* is not registered/);
});

test('harvestNote: reads the hook status line, not only the exit code', () => {
  assert.equal(harvestNote({ status: 1, memory: null }), 'failed: the worktree will be kept');
  assert.equal(harvestNote({ status: 0, memory: 'harvested' }), 'archived');
  assert.equal(harvestNote({ status: 0, memory: 'off', reason: 'memory mode off' }), 'off: memory mode off');
  assert.equal(harvestNote({ status: 0, memory: 'nothing', reason: 'no candidates, review, handoff or referenced image' }), 'nothing archived: no candidates, review, handoff or referenced image');
  assert.equal(harvestNote({ status: 0, memory: null }), 'exit 0, no status line');
});

test('auto_merge=false: the director merges and owns the finish; no Funplay → verify is the human\'s', () => {
  const notes = NOTES(POLICY.replace('auto_merge=true', 'auto_merge=false'), '{S01: in_progress}').replace('auto_merge: true', 'auto_merge: false');
  const { f, root, wt, sha } = fleet({ notes });
  const a = runner(root, f, 'start', '--once').out.at(-1);
  assert.deepEqual([a.waiting, a.kind], ['q1', 'merge_by_director']);
  assert.deepEqual(editorLog(f), []); // the runner touched no Editor
  runner(root, f, 'answer', '--id', 'q1', '--choice', 'merged by director, record');
  assert.equal(runner(root, f, 'start', '--once').out.at(-1).kind, 'merge_by_director'); // not merged yet: asked again
  g(root, 'merge', '--no-ff', '--no-edit', 'S01-feature');
  runner(root, f, 'answer', '--id', 'q2', '--choice', 'merged by director, record');
  runner(root, f, 'start', '--once');
  assert.equal(fs.existsSync(wt), true);
  assert.deepEqual([journal(root).steps.worktree_rm.skipped, f.spawns().length], [true, 0]);
  assert.match(loadProject(root).notesText, new RegExp(`- S01 fleet merged fix_rounds=1 bump=650→700 commit=${sha.slice(0, 7)} merged=y -`));

  const n = fleet({ funplay: false });
  const b = runner(n.root, n.f, 'start', '--once').out.at(-1);
  assert.deepEqual([b.waiting, b.kind], ['q1', 'verify_manual']);
  assert.equal(n.f.spawns().length, 0);
});

test('kill during worktree rm: the restart neither merges twice nor loses the journal', async () => {
  const { f, root, wt, sha } = fleet();
  fs.writeFileSync(path.join(f.dir, 'worktree-rm-sleep'), '1500');
  f.queue([VERIFIED]);
  const child = runnerChild(root, f, 'start', '--once');
  await until(path.join(f.dir, 'rm.log'));
  child.kill('SIGKILL');
  await new Promise((r) => child.on('exit', r));
  // the orphaned `orca worktree rm` finishes on its own, as the real one would
  for (let i = 0; i < 100 && !fs.readFileSync(path.join(f.dir, 'rm.log'), 'utf8').includes('"done"'); i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(merges(root), 1);
  assert.equal(journal(root).steps.worktree_rm, undefined);
  fs.rmSync(path.join(f.dir, 'worktree-rm-sleep'));
  const out = runner(root, f, 'start', '--once').out;
  assert.deepEqual(out.find((o) => o.merged), { merged: 'S01', commit: sha });
  assert.equal(merges(root), 1);
  assert.equal(fs.existsSync(wt), false);
  assert.match(journal(root).steps.worktree_rm.note, /already gone/);
});

test('a failed merge leaves no MERGE_HEAD; a retry closes the Editors again (Orca may have reopened main)', () => {
  const { f, root, sha } = fleet();
  const hook = path.join(root, '.git', 'hooks', 'pre-merge-commit');
  fs.writeFileSync(hook, '#!/bin/sh\necho "lint failed" >&2\nexit 1\n', { mode: 0o755 });
  const a = runner(root, f, 'start', '--once').out.at(-1);
  assert.deepEqual([a.waiting, a.kind], ['q1', 'merge_blocked']);
  assert.equal(fs.existsSync(path.join(root, '.git', 'MERGE_HEAD')), false);
  assert.match(runnerFile(root).questions[0].text, /both Editors are closed/);
  fs.rmSync(hook);
  fs.appendFileSync(path.join(f.dir, 'editor-up'), `${root}\n`); // the Editor tab came back meanwhile
  runner(root, f, 'answer', '--id', 'q1', '--choice', 'cleaned by hand, retry');
  f.queue([VERIFIED]);
  runner(root, f, 'start', '--once');
  assert.equal(merges(root), 1);
  assert.equal(editorLog(f).filter((l) => l === `close ${root}`).length, 2);
  assert.equal(g(root, 'merge-base', '--is-ancestor', sha, 'HEAD').status, 0);
});

test('never merge into a branch the slice did not start from; a detached worktree is not "merged" and not removed', () => {
  const { f, root, base } = fleet();
  g(root, 'checkout', '-q', '-b', 'feat/other');
  const a = runner(root, f, 'start', '--once').out.at(-1);
  assert.deepEqual([a.kind, a.options], ['main_branch', ['merge into feat/other', 'checked out, retry', 'mark blocked', 'stop']]);
  assert.equal(merges(root), 0);
  g(root, 'checkout', '-q', base);
  runner(root, f, 'answer', '--id', 'q1', '--choice', 'checked out, retry');
  f.queue([VERIFIED]);
  runner(root, f, 'start', '--once');
  assert.deepEqual([merges(root), g(root, 'symbolic-ref', '--short', 'HEAD').stdout.trim()], [1, base]);

  // the director may choose the branch main is on; a detached main is asked first
  const o = fleet();
  g(o.root, 'checkout', '-q', '--detach');
  assert.equal(runner(o.root, o.f, 'start', '--once').out.at(-1).kind, 'main_detached');
  g(o.root, 'checkout', '-q', '-b', 'release/1.1');
  runner(o.root, o.f, 'answer', '--id', 'q1', '--choice', 'checked out, retry');
  assert.equal(runner(o.root, o.f, 'start', '--once').out.at(-1).kind, 'main_branch');
  runner(o.root, o.f, 'answer', '--id', 'q2', '--choice', 'merge into release/1.1');
  o.f.queue([VERIFIED]);
  runner(o.root, o.f, 'start', '--once');
  assert.deepEqual([merges(o.root), journal(o.root).steps.merge.into], [1, 'release/1.1']);

  const d = fleet();
  g(d.wt, 'checkout', '-q', '--detach');
  const b = runner(d.root, d.f, 'start', '--once').out.at(-1);
  assert.equal(b.kind, 'merge_source_missing');
  assert.match(runnerFile(d.root).questions[0].text, /detached HEAD/);
  assert.deepEqual([merges(d.root), fs.existsSync(d.wt)], [0, true]);
  assert.equal(g(d.wt, 'rev-parse', 'HEAD').stdout.trim(), d.sha); // the commit is still reachable
});

test('a failed worktree rm is recorded, not fatal; a single-lane sha that is not on main is asked', () => {
  const { f, root, wt } = fleet();
  fs.writeFileSync(path.join(f.dir, 'worktree-rm-fail'), '1');
  f.queue([VERIFIED]);
  assert.ok(runner(root, f, 'start', '--once').out.find((o) => o.merged));
  assert.equal(fs.existsSync(wt), true);
  assert.match(loadProject(root).notesText, /merged=y worktree kept: rm failed: worktree_archive_hook_failed\n/);

  const p = project({ notes: NOTES(POLICY, '{S01: in_progress}'), slices: { S01: { needs: false } } });
  const h = fakes();
  fs.mkdirSync(ev(p.root, 'S01'), { recursive: true });
  fs.writeFileSync(ev(p.root, 'S01', 'producer-state.json'), JSON.stringify({ phase: 'merge', lane: 'single', commit_sha: '0123456789abcdef0123456789abcdef01234567', writer: 'term_w' }));
  const a = runner(p.root, h, 'start', '--once').out.at(-1);
  assert.deepEqual([a.waiting, a.kind], ['q1', 'commit_not_on_main']);
  assert.equal(loadProject(p.root).release.slices.S01, 'in_progress');
});

test('record is idempotent on replay; the Notes rewrite keeps `$&` literal and replaces a legacy `- S02:` line', () => {
  const { f, root, sha } = fleet();
  f.queue([VERIFIED]);
  runner(root, f, 'start', '--once');
  const lines = lessonCount(root);
  // replay record after a kill: clear its step and the done phase
  const j = journal(root);
  delete j.steps.record;
  fs.writeFileSync(ev(root, 'S01', 'merge-journal.json'), JSON.stringify(j));
  fs.writeFileSync(ev(root, 'S01', 'producer-state.json'), JSON.stringify({ ...sliceState(root, 'S01'), phase: 'merge' }));
  runner(root, f, 'start', '--once');
  assert.equal(lessonCount(root), lines);
  assert.equal(loadProject(root).notesText.match(/^- S01 /gm).length, 1);
  assert.match(loadProject(root).notesText, new RegExp(`- S01 fleet merged fix_rounds=1 bump=650→700 commit=${sha.slice(0, 7)}`));

  const text = '## Notes — game-producer\n\n- policy: x\n- S02: in progress since 09-20\n\n## Notes — other\n';
  const out = editSliceNote(text, 'S02', '- S02 single merged stash differs: docs/$&x.md').text;
  assert.equal(out, '## Notes — game-producer\n\n- policy: x\n- S02 single merged stash differs: docs/$&x.md\n\n## Notes — other\n');
});

// PLAN §6: a kill inside each long-running merge step; the restart finishes with one merge and one record
for (const [step, arm, started, finished] of [
  ['harvest', (f) => fs.writeFileSync(path.join(f.dir, 'no-orca-memory'), `#!/bin/sh\ntouch "${f.dir}/harvest-started"; sleep 1.5; touch "${f.dir}/harvest-done"\n`, { mode: 0o755 }), 'harvest-started', 'harvest-done'],
  ['close_editors', (f) => fs.writeFileSync(path.join(f.dir, 'close-sleep'), '1'), 'close-started', null],
  ['merge', (f, root) => fs.writeFileSync(path.join(root, '.git', 'hooks', 'pre-merge-commit'), `#!/bin/sh\ntouch "${f.dir}/merge-started"; sleep 1.5\n`, { mode: 0o755 }), 'merge-started', null],
  ['reopen', (f) => fs.writeFileSync(path.join(f.dir, 'bootstrap-sleep-wait'), '1'), 'wait-mcp.log', null],
  ['verify', (f) => f.queue([{ name: 'verifier busy', sleepMs: 1500 }, VERIFIED]), 'waits.log', null],
]) {
  test(`kill during ${step}: the restart merges once and records once`, async () => {
    const { f, root, wt, sha } = fleet();
    arm(f, root);
    if (step !== 'verify') f.queue([VERIFIED]);
    const child = runnerChild(root, f, 'start', '--once');
    await until(path.join(f.dir, started));
    child.kill('SIGKILL');
    await new Promise((r) => child.on('exit', r));
    // orphans (the harvest launcher, git, a sleeping fake) finish on their own, as real ones would
    await new Promise((r) => setTimeout(r, 2200));
    if (finished) await until(path.join(f.dir, finished));
    for (const x of ['close-sleep', 'bootstrap-sleep-wait']) fs.rmSync(path.join(f.dir, x), { force: true });
    fs.rmSync(path.join(root, '.git', 'hooks', 'pre-merge-commit'), { force: true });
    fs.rmSync(path.join(root, '.cursor', 'producer.control'), { force: true });
    if (!f.left().length && !fs.existsSync(path.join(root, evRel('S01', 'verify-main.json')))) f.queue([VERIFIED]);
    let out = runner(root, f, 'start', '--once').out;
    if (!out.find((o) => o.merged) && out.at(-1).stopped) {
      fs.rmSync(path.join(root, '.cursor', 'producer.control'), { force: true });
      f.queue([VERIFIED]);
      out = runner(root, f, 'start', '--once').out;
    }
    assert.deepEqual(out.find((o) => o.merged), { merged: 'S01', commit: sha }, JSON.stringify(out));
    assert.equal(merges(root), 1);
    assert.equal(fs.existsSync(wt), false);
    assert.equal(lessonCount(root), 3);
    assert.equal(f.spawns().length, 1); // one verifier
  });
}

test("a merge someone else left in progress in main is never aborted by the runner", () => {
  const { f, root } = fleet();
  write(root, 'src/b.ts', 'export const b = 99;\n');
  g(root, 'add', 'src/b.ts');
  g(root, 'commit', '-qm', 'fix: b on main');
  g(root, 'merge', '--no-ff', '--no-edit', 'S01-feature'); // conflicts: the director starts resolving
  write(root, 'src/b.ts', 'export const b = "resolved by hand";\n');
  const a = runner(root, f, 'start', '--once').out.at(-1);
  assert.equal(a.kind, 'merge_blocked');
  assert.match(runnerFile(root).questions[0].text, /merge in progress .* that the runner did not start/);
  assert.equal(fs.existsSync(path.join(root, '.git', 'MERGE_HEAD')), true);
  assert.equal(fs.readFileSync(path.join(root, 'src/b.ts'), 'utf8'), 'export const b = "resolved by hand";\n');
  assert.deepEqual(editorLog(f), []); // and no Editor was closed for it
});

test('kill the whole tree while git is merging: the restart undoes its own half merge and merges once', async () => {
  const { f, root, sha } = fleet();
  fs.writeFileSync(path.join(root, '.git', 'hooks', 'pre-merge-commit'), `#!/bin/sh\ntouch "${f.dir}/merge-started"; sleep 5\n`, { mode: 0o755 });
  f.queue([VERIFIED]);
  const child = runnerChild(root, f, 'start', '--once');
  await until(path.join(f.dir, 'merge-started'));
  killTree(child.pid);
  await new Promise((r) => (child.exitCode !== null || child.signalCode ? r() : child.on('exit', r)));
  // git died inside the hook: no merge commit, no MERGE_HEAD, the merge result staged in the index
  assert.equal(merges(root), 0);
  assert.notEqual(g(root, 'diff', '--cached', '--quiet').status, 0);
  fs.rmSync(path.join(root, '.git', 'hooks', 'pre-merge-commit'));
  const out = runner(root, f, 'start', '--once').out;
  assert.deepEqual(out.find((o) => o.merged), { merged: 'S01', commit: sha });
  assert.deepEqual([merges(root), fs.existsSync(path.join(root, '.git', 'MERGE_HEAD'))], [1, false]);
  assert.match(fs.readFileSync(ev(root, 'S01', 'producer-log.md'), 'utf8'), /undid the staged result of an interrupted merge/);
});

test('kill during the evidence copy: the restart copies again and removes the worktree only after', async () => {
  const { f, root, wt, sha } = fleet();
  const real = spawnSync('which', ['rsync'], { encoding: 'utf8' }).stdout.trim();
  fs.writeFileSync(path.join(f.dir, 'rsync'), `#!/bin/sh\n[ -f "${f.dir}/rsync-sleep" ] && { touch "${f.dir}/rsync-started"; sleep 1.5; }\nexec ${real} "$@"\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(f.dir, 'rsync-sleep'), '1');
  f.queue([VERIFIED]);
  const child = runnerChild(root, f, 'start', '--once');
  await until(path.join(f.dir, 'rsync-started'));
  killTree(child.pid);
  await new Promise((r) => (child.exitCode !== null || child.signalCode ? r() : child.on('exit', r)));
  assert.equal(fs.existsSync(wt), true);
  fs.rmSync(path.join(f.dir, 'rsync-sleep'));
  const out = runner(root, f, 'start', '--once').out;
  assert.deepEqual(out.find((o) => o.merged), { merged: 'S01', commit: sha });
  assert.ok(fs.existsSync(path.join(root, evRel('S01', 'review.md'))));
  assert.deepEqual([merges(root), fs.existsSync(wt)], [1, false]);
});

test('after a runner conflict, the director resolving the same merge by hand is never aborted', () => {
  const { f, root, sha } = fleet();
  write(root, 'src/b.ts', 'export const b = 99;\n');
  g(root, 'add', 'src/b.ts');
  g(root, 'commit', '-qm', 'fix: b on main');
  assert.equal(runner(root, f, 'start', '--once').out.at(-1).kind, 'merge_conflict');
  // the director merges the same branch, resolves and stages it, and answers before committing
  g(root, 'merge', '--no-ff', '--no-edit', 'S01-feature');
  write(root, 'src/b.ts', 'export const b = "resolved";\n');
  g(root, 'add', 'src/b.ts');
  runner(root, f, 'answer', '--id', 'q1', '--choice', 'resolved by hand, continue');
  const b = runner(root, f, 'start', '--once').out.at(-1);
  assert.equal(b.kind, 'merge_blocked');
  assert.match(runnerFile(root).questions[1].text, /that the runner did not start/);
  assert.equal(fs.existsSync(path.join(root, '.git', 'MERGE_HEAD')), true);
  assert.equal(fs.readFileSync(path.join(root, 'src/b.ts'), 'utf8'), 'export const b = "resolved";\n');
  g(root, 'commit', '--no-edit', '-q');
  runner(root, f, 'answer', '--id', 'q2', '--choice', 'cleaned by hand, retry');
  f.queue([VERIFIED]);
  const c = runner(root, f, 'start', '--once').out;
  assert.deepEqual(c.find((o) => o.merged), { merged: 'S01', commit: sha });
  assert.equal(fs.readFileSync(path.join(root, 'src/b.ts'), 'utf8'), 'export const b = "resolved";\n');
  assert.equal(journal(root).steps.merge.conflict, true);
});

test('the merge verifier runs on the director\'s Cursor substitute, never on a Cursor that cannot log in', () => {
  const notes = NOTES(POLICY, '{S01: in_progress}').replace('  writer_agent: claude --model sonnet --effort high\n', '  writer_agent: cursor --model auto\n');
  const { f, root } = fleet({ notes });
  fs.writeFileSync(path.join(root, '.cursor', 'producer-runner.json'), JSON.stringify({ slice: 'S01', step: 'lane', questions: [], cursor_substitute: 'claude --model sonnet --effort high' }));
  f.queue([VERIFIED]);
  const out = runner(root, f, 'start', '--once', { env: { PRODUCER_RUNNER_CURSOR: 'off' } }).out;
  assert.ok(out.find((o) => o.merged));
  assert.deepEqual(f.spawns().map((s) => [s.title.split('-')[0], s.agent]), [['verify', 'claude --model sonnet --effort high']]);
});
