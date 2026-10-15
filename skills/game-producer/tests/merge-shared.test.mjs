import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { resolveShared, unionJson, clashingRows, sharedFiles } from '../scripts/lib/merge.mjs';

// Phase 2 M2 (docs/plans/2026-10-15-runner-parallel-phase2): two lanes both append to FOLLOWUPS.md, the smoke ledger,
// a cleanup log. A merge whose conflicts are all in such files is resolved; anything else still asks.
const g = (cwd, ...a) => spawnSync('git', ['-C', cwd, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { encoding: 'utf8' });
const FU = (rows) => `# FOLLOWUPS\n\n| # | date | item | status |\n|---|---|---|---|\n${rows.map((r) => `| ${r} | 2026-10-15 | item ${r} | open |`).join('\n')}\n`;

/** main + branch `lane` diverging from one base; returns the repo after a conflicting `git merge lane`. */
function diverged(base, main, lane) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-shared-'));
  g(d, 'init', '-q', '-b', 'main');
  const put = (files) => { for (const [f, t] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), t); } g(d, 'add', '-A'); };
  put(base); g(d, 'commit', '-qm', 'base');
  g(d, 'checkout', '-qb', 'lane'); put(lane); g(d, 'commit', '-qm', 'lane');
  g(d, 'checkout', '-q', 'main'); put(main); g(d, 'commit', '-qm', 'main');
  const m = g(d, 'merge', '--no-ff', '--no-edit', 'lane');
  return { d, merged: m.status === 0 };
}

test('both lanes appended to FOLLOWUPS.md, the ledger and a cleanup log: resolved, every row and key kept', () => {
  const ledger = (o) => `${JSON.stringify(o, null, 2)}\n`;
  const { d, merged } = diverged(
    { 'FOLLOWUPS.md': FU([90, 91]), 'scripts/smoke/known-red.json': ledger({ a: { followup: '#1' } }), 'docs/cleanup/v1.1-removals.md': '# removals\n- x\n', 'src/a.ts': 'a\n' },
    { 'FOLLOWUPS.md': FU([90, 91, 92]), 'scripts/smoke/known-red.json': ledger({ a: { followup: '#1' }, b: { followup: '#2' } }), 'docs/cleanup/v1.1-removals.md': '# removals\n- x\n- main\n' },
    { 'FOLLOWUPS.md': FU([90, 91, 93]), 'scripts/smoke/known-red.json': ledger({ a: { followup: '#1' }, c: { followup: '#3' } }), 'docs/cleanup/v1.1-removals.md': '# removals\n- x\n- lane\n', 'src/a.ts': 'a\n// lane\n' },
  );
  assert.equal(merged, false, 'git itself conflicts');
  const r = resolveShared(d, sharedFiles({ milestones: {} }));
  assert.deepEqual(r, { ok: true, files: ['FOLLOWUPS.md', 'docs/cleanup/v1.1-removals.md', 'scripts/smoke/known-red.json'] });
  assert.equal(g(d, 'commit', '--no-edit').status, 0);
  const fu = fs.readFileSync(path.join(d, 'FOLLOWUPS.md'), 'utf8');
  for (const n of [90, 91, 92, 93]) assert.match(fu, new RegExp(`\\| ${n} \\|`));
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(d, 'scripts/smoke/known-red.json'), 'utf8'))).sort(), ['a', 'b', 'c']);
  assert.match(fs.readFileSync(path.join(d, 'docs/cleanup/v1.1-removals.md'), 'utf8'), /- main\n[\s\S]*- lane|- lane\n[\s\S]*- main/);
  assert.equal(fs.readFileSync(path.join(d, 'src/a.ts'), 'utf8'), 'a\n// lane\n', 'the non-conflicting code change merged as usual');
});

test('both lanes took the same followup number, or a conflict outside the shared files: not resolved, with the reason', () => {
  let { d } = diverged({ 'FOLLOWUPS.md': FU([90]) }, { 'FOLLOWUPS.md': FU([90, 93]) }, { 'FOLLOWUPS.md': FU([90, 93]).replace('item 93', 'other 93') });
  assert.deepEqual(resolveShared(d, sharedFiles({})), { ok: false, reason: 'FOLLOWUPS.md: both sides added numbered row(s) #93 — renumber one side' });
  ({ d } = diverged({ 'FOLLOWUPS.md': FU([90]), 'AGENT_NOTES.md': 'x\n' }, { 'FOLLOWUPS.md': FU([90, 91]), 'AGENT_NOTES.md': 'main\n' }, { 'FOLLOWUPS.md': FU([90, 92]), 'AGENT_NOTES.md': 'lane\n' }));
  assert.deepEqual(resolveShared(d, sharedFiles({})), { ok: false, reason: 'conflicts outside the shared files: AGENT_NOTES.md' });
  // a project's own shared glob
  ({ d } = diverged({ 'docs/log.md': '# log\n' }, { 'docs/log.md': '# log\n- a\n' }, { 'docs/log.md': '# log\n- b\n' }));
  assert.equal(resolveShared(d, sharedFiles({ milestones: {} })).ok, false);
  assert.equal(resolveShared(d, sharedFiles({ milestones: { shared_append: ['docs/*.md'] } })).ok, true);
});

test('unionJson: union of keys against the base; the same key changed both ways is not guessed', () => {
  const j = (o) => JSON.stringify(o);
  assert.deepEqual(JSON.parse(unionJson(j({ a: 1 }), j({ a: 1, b: 2 }), j({ a: 1, c: 3 })).text), { a: 1, b: 2, c: 3 });
  assert.deepEqual(JSON.parse(unionJson(j({ a: 1 }), j({ a: 1 }), j({ a: 9 })).text), { a: 9 }, 'only theirs changed it');
  assert.deepEqual(JSON.parse(unionJson(j({ a: 1, b: 2 }), j({ a: 1 }), j({ a: 1, b: 2 })).text), { a: 1 }, 'ours removed, theirs untouched');
  assert.deepEqual(JSON.parse(unionJson(j({ a: 1, b: 2 }), j({ a: 1, b: 2 }), j({ a: 1 })).text), { a: 1 }, 'theirs removed, ours untouched');
  assert.equal(unionJson(j({ a: 1 }), j({ a: 2 }), j({ a: 3 })).error, 'both sides changed "a"');
  assert.equal(unionJson('', j({ a: 1 }), j({ a: 2 })).error, 'both sides changed "a"');
  assert.match(unionJson(j({}), '[1]', j({})).error, /not a JSON object/);
});

test('clashingRows: a row id the union holds twice that ours held once', () => {
  assert.deepEqual(clashingRows(FU([1, 2, 2, 3]), FU([1, 2])), ['2']);
  assert.deepEqual(clashingRows(FU([1, 2, 3]), FU([1, 2])), []);
  assert.deepEqual(clashingRows('| #7 | a |\n| #7 | b |\n', '| #7 | a |\n'), ['7']);
});
