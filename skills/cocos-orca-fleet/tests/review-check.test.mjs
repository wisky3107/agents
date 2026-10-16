import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { checkReview, verdictOf, fixRows } from '../scripts/review-check.mjs';

const SCRIPT = new URL('../scripts/review-check.mjs', import.meta.url).pathname;
const HEAD = '| ids | owner | scope paths | change | acceptance |\n|---|---|---|---|---|';
const review = (rows, verdict = 'CHANGES_REQUESTED', extra = '## escaped\nnone\n') =>
  `# Review\n\n## Findings\nF1 major …\n\n## fix_routing\n${HEAD}\n${rows.join('\n')}\n\n${extra}\n${verdict}\n`;
const codes = r => r.errors.map(e => e.code).sort();

test('verdict line: exact word, markup stripped, underscores kept', () => {
  assert.equal(verdictOf('x\n**CHANGES_REQUESTED**\n\n'), 'CHANGES_REQUESTED');
  assert.equal(verdictOf('x\n`APPROVED`'), 'APPROVED');
  assert.equal(verdictOf('APPROVED\nmore text'), null);
  assert.deepEqual(codes(checkReview('no verdict here')), ['verdict_line']);
});

test('fix_routing rows grouped by owner; infra-only and director rows routed apart', () => {
  const r = checkReview(review([
    '| F1,F3 | code | assets/scripts/forms/Spider.ts | flip 180° over 0.2 s | flip visible in capture |',
    '| F2 | scene | Canvas/Board | wire FX ref | ref non-null after reopen |',
    '| F4 | director | — | keep or drop paw coin | decision recorded |',
    '| F5 | followup | — | tidy names | — |',
  ]));
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.deepEqual(Object.keys(r.fix_groups), ['code', 'scene']);
  assert.deepEqual(r.fix_groups.code[0].ids, ['F1', 'F3']);
  assert.deepEqual([r.director.length, r.followups.length, r.infra_only], [1, 1, false]);
  const infra = checkReview(review(['| F1 | infra (preview tab frozen) | — | restart preview | preview answers 200 |', '| F2 | followup | — | x | — |']));
  assert.equal(infra.infra_only, true);
  assert.deepEqual(infra.fix_groups, {});
});

test('contract errors: missing table, bad ids, unknown or mixed owner, unclear without reason, incomplete row', () => {
  assert.deepEqual(codes(checkReview('# R\n\nCHANGES_REQUESTED\n')), ['fix_routing_missing']);
  const r = checkReview(review([
    '| F3-pump | code | a.ts | x | y |',
    '| F4 | code / director | a.ts | x | y |',
    '| F5 | writer | a.ts | x | y |',
    '| F6 | unclear | — | needs new path | — |',
    '| F7 | scene |  | wire | |',
    '| F8 | mesh | assets/Arts/truck.glb | remesh | wheels round |',
  ]));
  assert.deepEqual(codes(r), ['fix_routing_ids', 'fix_routing_incomplete', 'fix_routing_mixed_owner', 'fix_routing_owner', 'fix_routing_stem', 'fix_routing_unclear_reason']);
  assert.equal(checkReview(review(['| F8 | mesh (truck) | assets/Arts/truck.glb | remesh | wheels round |'])).fix_groups.mesh[0].reason, 'truck');
  assert.ok(checkReview(review(['| F1 | code | a.ts | x | y |'], 'APPROVED', '')).warnings.some(w => w.code === 'escaped_missing'));
});

test('older header names still parse (finding / action)', () => {
  const rows = fixRows('## fix_routing\n| finding | owner | action |\n|---|---|---|\n| F1 | code | rework check |\n');
  assert.deepEqual(rows.map(r => [r.ids, r.owner, r.change]), [[['F1'], 'code', 'rework check']]);
});

test('cli: code row outside the slice paths fails through --plan; inside passes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'review-check-'));
  fs.mkdirSync(path.join(root, 'slices')); fs.mkdirSync(path.join(root, 'docs/plans'), { recursive: true }); fs.mkdirSync(path.join(root, 'ev'));
  fs.writeFileSync(path.join(root, 'slices/S06-x.md'), '---\nid: S06\npaths: {code: ["assets/scripts/forms/**"], art: [], scene_objects: []}\n---\n');
  fs.writeFileSync(path.join(root, 'docs/plans/S06-x.md'), 'plan_source: "slices/S06-x.md"\n');
  const run = rows => {
    fs.writeFileSync(path.join(root, 'ev/review.md'), review(rows));
    const r = spawnSync(process.execPath, [SCRIPT, '--review', 'ev/review.md', '--project', root, '--plan', 'docs/plans/S06-x.md'], { encoding: 'utf8' });
    return { status: r.status, out: JSON.parse(r.stdout) };
  };
  assert.equal(run(['| F1 | code | assets/scripts/forms/Spider.ts | x | y |']).status, 0);
  const bad = run(['| F1 | code | assets/scripts/ui/Hud.ts | x | y |']);
  assert.equal(bad.status, 1);
  assert.deepEqual(codes(bad.out), ['fix_routing_outside_plan']);
});
