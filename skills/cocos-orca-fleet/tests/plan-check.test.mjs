import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pointerPlan, validatePlan, scopeBudgetMode } from '../scripts/plan-check.mjs';

const SCRIPT = new URL('../scripts/plan-check.mjs', import.meta.url).pathname;
const LOCKS = { scanner_agent: 'claude --model sonnet', writer_agent: 'claude --model opus --effort high', reviewer_agent: 'cursor --model auto', art_backend: 'antigravity', mesh_backend: 'auto', mesh_agent: 'codex --model gpt-6.1-sol --effort high' };

function project({ slice = {}, expect = true, scope = 'budget_mode: gate\n', recipe = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-check-'));
  const s = {
    id: 'S06', name: 'spider-forest', size: 'L', paths: { code: ['assets/scripts/forms/**'], art: [], scene_objects: [] },
    scope: { in: ['spider'], out: ['rocket (S07)'] }, assets: { '2d': [], '3d': [], vfx: [], audio: [] },
    acceptance: [{ text: 'spider walks on the ceiling', evidence: 'capture' }], feel_rows: ['gravity_flip'],
    runtime_checks: ['play level 2181'], change_budget: { files: 10, lines: 600, nodes: 5, assets: 0 }, ...slice,
  };
  fs.mkdirSync(path.join(root, 'slices'));
  const yaml = Object.entries(s).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join('\n');
  fs.writeFileSync(path.join(root, 'slices/S06-spider-forest.md'), `---\n${yaml}\n---\n# S06\n`);
  if (expect) fs.writeFileSync(path.join(root, 'EXPECT_GAMEPLAY_VISUAL.md'), '# Expect\n\n## Feel table\n\n| id | feel |\n|---|---|\n| `gravity_flip` | 0.2 s flip |\n');
  if (scope !== null) fs.writeFileSync(path.join(root, 'SCOPE.md'), `# Scope\n${scope}`);
  if (recipe) fs.writeFileSync(path.join(root, recipe.path), recipe.body);
  return root;
}
const write = (root, opts = {}) => {
  const r = pointerPlan({ root, id: 'S06', locks: LOCKS, forbidden: ['AGENT_NOTES.md'], rollback: 'abc', ...opts });
  fs.mkdirSync(path.join(root, 'docs/plans'), { recursive: true });
  fs.writeFileSync(path.join(root, r.file), r.text);
  return r;
};
const codes = r => r.errors.map(e => e.code);

test('pointer PLAN: locks, lite from assets, budget_mode from SCOPE.md, scope.out folded into forbidden_changes', () => {
  const root = project();
  const r = write(root);
  assert.equal(r.file, 'docs/plans/S06-spider-forest.md');
  assert.ok(r.text.split('\n').filter(Boolean).length <= 20, 'pointer stays ≤ 20 lines');
  assert.equal(r.plan.lite, true);
  assert.deepEqual([r.plan.budget_mode, r.plan.budget_auto_bump_pct], ['gate', 15]);
  const g = pointerPlan({ root, id: 'S06', locks: LOCKS, budgetMode: 'gate:20' }).plan;
  assert.deepEqual([g.budget_mode, g.budget_auto_bump_pct], ['gate', 20]);
  assert.equal(pointerPlan({ root, id: 'S06', locks: LOCKS, budgetMode: 'advisory' }).plan.budget_auto_bump_pct, undefined);
  assert.deepEqual(r.plan.forbidden_changes, ['AGENT_NOTES.md', 'slice.scope.out: rocket (S07)', 'SCOPE.md durable out-of-scope (read SCOPE.md)']);
  const v = validatePlan(root, r.file);
  assert.deepEqual(codes(v), []);
  assert.equal(v.ok, true);
  assert.throws(() => pointerPlan({ root, id: 'S06', locks: { writer_agent: 'x' } }), /locks missing: scanner_agent/);
  assert.equal(scopeBudgetMode(project({ scope: null })), 'advisory');
});

test('validate: unknown feel row, empty runtime_checks, budget hole, forbidden path, lite with assets', () => {
  const root = project({ slice: { feel_rows: ['gravity_flip', 'wall_jump'], runtime_checks: [], change_budget: { files: 1, lines: 2, nodes: 3 },
    paths: { code: ['AGENT_NOTES.md'], art: [], scene_objects: [] }, assets: { '2d': [{ stem: 'web', p: 1 }], '3d': [], vfx: [], audio: [] } } });
  write(root, { lite: true });
  const v = validatePlan(root, 'docs/plans/S06-spider-forest.md');
  assert.equal(v.ok, false);
  for (const c of ['feel_row_unknown', 'slice_no_runtime_checks', 'slice_budget', 'path_forbidden', 'lite_with_assets']) assert.ok(codes(v).includes(c), c);
  assert.match(v.errors.find(e => e.code === 'feel_row_unknown').message, /wall_jump/);
});

test('validate: PLAN keys, size L, id match; slice must exist', () => {
  const root = project({ slice: { size: 'M' } });
  write(root);
  fs.writeFileSync(path.join(root, 'docs/plans/S06-spider-forest.md'),
    fs.readFileSync(path.join(root, 'docs/plans/S06-spider-forest.md'), 'utf8').replace(/^reviewer_agent.*\n/m, '').replace('"T-S06"', '"T-S07"'));
  const v = validatePlan(root, 'docs/plans/S06-spider-forest.md');
  for (const c of ['plan_missing_key', 'plan_not_fleet', 'slice_id_mismatch']) assert.ok(codes(v).includes(c), c);
  fs.writeFileSync(path.join(root, 'docs/plans/bad.md'), 'task_id: T-S06\nplan_source: slices/none.md\n');
  assert.ok(codes(validatePlan(root, 'docs/plans/bad.md')).includes('slice_unreadable'));
});

test('validate: recipe_refs hash checked; feel rows without EXPECT fail; many 3D stems warn on tripo_credits', () => {
  const body = '# recipe\n';
  const good = { id: 'r1', revision: 1, sha256: crypto.createHash('sha256').update(body).digest('hex'), path: 'r1.md' };
  const root = project({ recipe: { path: 'r1.md', body }, slice: { recipe_refs: [good, { ...good, id: 'r2', sha256: 'x'.repeat(64) }, { id: 'r3' }] } });
  write(root);
  const v = validatePlan(root, 'docs/plans/S06-spider-forest.md');
  assert.deepEqual(codes(v).sort(), ['recipe_ref_hash', 'recipe_ref_incomplete']);
  const three = Array.from({ length: 6 }, (_, i) => ({ stem: `m${i}`, p: 1 }));
  const r2 = project({ expect: false, slice: { assets: { '2d': [], '3d': three, vfx: [], audio: [] } } });
  write(r2);
  const v2 = validatePlan(r2, 'docs/plans/S06-spider-forest.md');
  assert.deepEqual(codes(v2), ['feel_rows_without_expect']);
  assert.ok(v2.warnings.some(w => w.code === 'tripo_credits_unset'));
});

test('cli: write then validate; validate exits 1 on errors', () => {
  const root = project();
  const w = spawnSync(process.execPath, [SCRIPT, 'write', '--project', root, '--slice', 'S06', '--locks', JSON.stringify(LOCKS), '--forbidden', '["x.md"]', '--rollback', 'abc'], { encoding: 'utf8' });
  assert.equal(w.status, 0, w.stdout + w.stderr);
  assert.equal(JSON.parse(w.stdout).file, 'docs/plans/S06-spider-forest.md');
  const ok = spawnSync(process.execPath, [SCRIPT, 'validate', '--project', root, '--plan', 'docs/plans/S06-spider-forest.md'], { encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stdout);
  fs.writeFileSync(path.join(root, 'slices/S06-spider-forest.md'), fs.readFileSync(path.join(root, 'slices/S06-spider-forest.md'), 'utf8').replace('"play level 2181"', ''));
  const bad = spawnSync(process.execPath, [SCRIPT, 'validate', '--project', root, '--plan', 'docs/plans/S06-spider-forest.md'], { encoding: 'utf8' });
  assert.equal(bad.status, 1);
});
