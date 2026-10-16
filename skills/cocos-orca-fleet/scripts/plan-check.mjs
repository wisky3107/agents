#!/usr/bin/env node
/**
 * Pointer PLAN for a fleet slice (SKILL Step 0.5 branch B) and the mechanical PLAN validation
 * (SKILL §PLAN validation), as a script instead of coordinator turns. The slice file IS the PLAN
 * (game-producer/reference/slice-to-plan.md): `write` materialises only the ≤20-line pointer,
 * `validate` reads every other key through `plan_source`. game-brief's validate-contracts already
 * checks slice shape project-wide; this adds what the fleet needs for one slice.
 *
 *   node plan-check.mjs write --project <root> --slice S06 --locks '<json>' [--forbidden '<json array>']
 *        [--rollback <sha>] [--lite true|false] [--budget-mode advisory|gate[:<pct>]] [--out <path>]
 *   node plan-check.mjs validate --project <root> --plan docs/plans/S06-spider-forest.md
 *
 * Both print one JSON object; validate exits 1 when `ok` is false.
 */
import fs from 'node:fs';
import path from 'node:path';
import { read, yaml, front, hash, exists, args, run } from '../../game-brief/scripts/lib.mjs';
import { feelIds } from '../../game-brief/scripts/validate-contracts.mjs';

export const LOCKS = ['scanner_agent', 'writer_agent', 'reviewer_agent', 'art_backend', 'mesh_backend', 'mesh_agent'];
const REQUIRED = ['task_id', 'task_size', 'plan_source', 'status', ...LOCKS, 'planner_agent', 'studio_available', 'lite', 'forbidden_changes', 'budget_mode', 'rollback_point'];
const BUDGET = ['files', 'lines', 'nodes', 'assets'];
const list = x => (Array.isArray(x) ? x : []);
const assetsOf = s => ['2d', '3d', 'vfx', 'audio'].flatMap(k => list(s.assets?.[k]));

export function sliceFile(root, id) {
  const dir = path.join(root, 'slices');
  const f = exists(dir) && fs.readdirSync(dir).find(n => n.startsWith(`${id}-`) && n.endsWith('.md'));
  if (!f) throw new Error(`no slice file for ${id} under slices/`);
  return `slices/${f}`;
}

/** SCOPE.md `budget_mode: gate|advisory` (missing → advisory). */
export function scopeBudgetMode(root) {
  const f = path.join(root, 'SCOPE.md');
  const m = exists(f) && read(f).match(/budget_mode\s*[:=]\s*`?(advisory|gate)\b/i);
  return m ? m[1].toLowerCase() : 'advisory';
}

/** The pointer PLAN text for one slice. Locks come resolved (producer or coordinator Step 0.2). */
export function pointerPlan({ root, id, locks, forbidden = [], rollback = null, lite = null, budgetMode = null }) {
  const rel = sliceFile(root, id), s = front(read(path.join(root, rel)), rel);
  const missing = LOCKS.filter(k => !locks?.[k]);
  if (missing.length) throw new Error(`locks missing: ${missing.join(', ')}`);
  const scopeOut = list(s.scope?.out);
  // The producer passes `advisory` or `gate:<pct>`; the PLAN keeps the mode and the pct apart.
  const [mode, pct] = String(budgetMode ?? scopeBudgetMode(root)).split(':');
  const plan = {
    task_id: `T-${s.id}`,
    task_size: s.size,
    plan_source: rel,
    status: 'pending',
    scanner_agent: locks.scanner_agent,
    planner_agent: 'slice',
    writer_agent: locks.writer_agent,
    reviewer_agent: locks.reviewer_agent,
    art_backend: locks.art_backend,
    mesh_backend: locks.mesh_backend,
    mesh_agent: locks.mesh_agent,
    studio_available: locks.studio_available ?? 'n/a',
    fallback_ok: locks.fallback_ok ?? 'n/a',
    lite: lite ?? assetsOf(s).length === 0,
    forbidden_changes: [...forbidden, ...(scopeOut.length ? [`slice.scope.out: ${scopeOut.join('; ')}`] : []), 'SCOPE.md durable out-of-scope (read SCOPE.md)'],
    budget_mode: mode,
    ...(mode === 'gate' ? { budget_auto_bump_pct: Number(pct ?? 15) } : {}),
    budget_bump: null,
    rollback_point: rollback ?? 'n/a',
  };
  // One `key: <JSON>` line per key: JSON is valid YAML, and the pointer stays one line per field.
  const text = Object.entries(plan).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join('\n') + '\n';
  return { file: `docs/plans/${path.basename(rel)}`, text, plan };
}

/** Mechanical validation of a pointer PLAN through its slice → { ok, errors, warnings }. */
export function validatePlan(root, planRel) {
  const errors = [], warnings = [];
  const fail = (code, message) => errors.push({ code, message });
  const warn = (code, message) => warnings.push({ code, message });
  let plan;
  try { plan = yaml(read(path.join(root, planRel)), planRel); } catch (e) { fail('plan_unreadable', e.message); return { ok: false, errors, warnings }; }
  if (!plan || typeof plan !== 'object') { fail('plan_unreadable', 'expected a YAML mapping'); return { ok: false, errors, warnings }; }
  for (const k of REQUIRED) if (plan[k] === undefined || plan[k] === '') fail('plan_missing_key', k);
  if (plan.task_size !== 'L') fail('plan_not_fleet', `task_size ${plan.task_size} (fleet needs L)`);
  if (!['advisory', 'gate'].includes(plan.budget_mode)) fail('plan_budget_mode', `budget_mode ${plan.budget_mode}`);
  if (!Array.isArray(plan.forbidden_changes)) fail('plan_forbidden_not_list', 'forbidden_changes must be a list');
  if (plan.studio_available === false && plan.fallback_ok === undefined) fail('plan_missing_key', 'fallback_ok (studio_available is false)');

  let s;
  try { s = front(read(path.join(root, plan.plan_source)), plan.plan_source); } catch (e) { fail('slice_unreadable', e.message); return { ok: false, errors, warnings }; }
  if (`T-${s.id}` !== plan.task_id) fail('slice_id_mismatch', `${plan.task_id} vs slice ${s.id}`);
  if (s.size !== plan.task_size) fail('slice_size_mismatch', `PLAN ${plan.task_size} vs slice ${s.size}`);
  const code = list(s.paths?.code), art = list(s.paths?.art);
  if (!code.length && !art.length) fail('slice_no_paths', 'paths.code and paths.art are both empty');
  const forbidden = list(plan.forbidden_changes).map(String);
  for (const p of [...code, ...art]) if (forbidden.includes(p)) fail('path_forbidden', `${p} is in forbidden_changes`);
  if (!list(s.acceptance).some(a => (typeof a === 'string' ? a : a?.text)?.trim())) fail('slice_no_acceptance', 'acceptance has no row with text');
  if (!list(s.runtime_checks).length) fail('slice_no_runtime_checks', 'runtime_checks is empty (add the row, or one saying why runtime cannot change)');
  for (const k of BUDGET) if (typeof s.change_budget?.[k] !== 'number') fail('slice_budget', `change_budget.${k} missing or not a number`);

  const expect = path.join(root, 'EXPECT_GAMEPLAY_VISUAL.md');
  if (exists(expect)) {
    const ids = feelIds(read(expect));
    for (const r of list(s.feel_rows)) if (!ids.has(String(r).toLowerCase())) fail('feel_row_unknown', `${r} is not in the EXPECT_GAMEPLAY_VISUAL.md feel table`);
  } else if (list(s.feel_rows).length) fail('feel_rows_without_expect', 'slice names feel_rows but EXPECT_GAMEPLAY_VISUAL.md is missing');

  const meshes = list(s.assets?.['3d']);
  if (meshes.length > 5 && plan.mesh_backend !== 'blender' && typeof s.change_budget?.tripo_credits !== 'number') warn('tripo_credits_unset', `${meshes.length} 3D stems and no change_budget.tripo_credits`);
  if (plan.lite === true && assetsOf(s).length) fail('lite_with_assets', `lite: true but the slice lists ${assetsOf(s).length} assets`);
  if (plan.lite === false && !assetsOf(s).length) warn('assets_empty_not_lite', 'no assets and lite: false (fine only when release.fleet_lite_when_no_assets is false)');

  for (const r of list(s.recipe_refs)) {
    const f = r?.path && path.resolve(root, r.path);
    if (!r?.id || !r?.revision || !r?.sha256 || !r?.path) { fail('recipe_ref_incomplete', JSON.stringify(r)); continue; }
    if (!exists(f)) { fail('recipe_ref_missing', `${r.id}: ${r.path}`); continue; }
    if (hash(read(f)) !== r.sha256) fail('recipe_ref_hash', `${r.id}: sha256 differs from ${r.path}`);
  }
  warn('semantic_review_required', 'acceptance phrased as observations and paths inside SCOPE.md are not checked mechanically');
  return { ok: errors.length === 0, errors, warnings };
}

function main() {
  const a = args();
  const [cmd] = process.argv.slice(2);
  const root = path.resolve(a.project ?? '.');
  if (cmd === 'write') {
    const parse = (v, d) => (v === undefined ? d : JSON.parse(v));
    const out = pointerPlan({ root, id: a.slice, locks: parse(a.locks, {}), forbidden: parse(a.forbidden, []), rollback: a.rollback ?? null,
      lite: a.lite === undefined ? null : a.lite === 'true', budgetMode: a['budget-mode'] ?? null });
    const file = a.out ?? out.file;
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), out.text);
    return { ok: true, file, plan: out.plan };
  }
  if (cmd === 'validate') return validatePlan(root, a.plan);
  throw new Error('usage: plan-check.mjs write --project <root> --slice <Sxx> --locks <json> [...] | validate --project <root> --plan <path>');
}

if (process.argv[1] === new URL(import.meta.url).pathname) run(main);
