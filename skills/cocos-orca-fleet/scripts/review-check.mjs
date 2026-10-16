#!/usr/bin/env node
/**
 * Machine-readable review contract (plan 2026-10-16-fleet-script-coordinator M2). Reads a
 * review.md, checks the verdict line and the `## fix_routing` table, and groups the rows by owner
 * so a coordinator — LLM or the fleet driver — copies them instead of reading prose.
 *
 * Owner cell = one word from OWNERS, optionally followed by "(reason)". `infra` = the preview /
 * editor / runtime environment, not the work (integrator recovery, no fix round); `director` =
 * needs a director decision; `unclear` = a fix outside the PLAN paths; `followup` = minor, kept for later.
 *
 *   node review-check.mjs --review <evidence/review.md> [--project <root> --plan docs/plans/<x>.md]
 *
 * Prints one JSON object; exits 1 when `ok` is false. The reviewer runs it before worker_done.
 */
import path from 'node:path';
import { read, yaml, front, exists, args, run } from '../../game-brief/scripts/lib.mjs';
import { overlap } from '../../game-brief/scripts/validate-contracts.mjs';

export const OWNERS = ['code', 'scene', 'asset', 'concept', 'mesh', 'anim', 'infra', 'director', 'unclear', 'followup'];
export const VERDICTS = ['APPROVED', 'CHANGES_REQUESTED', 'INFRA_BLOCKED'];
// Owners whose rows become fix Tasks (one per owner group); the rest are routed elsewhere.
const FIX_OWNERS = ['code', 'scene', 'asset', 'concept', 'mesh', 'anim'];

const strip = s => s.replace(/[`*]/g, '').trim();
const cells = line => line.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());

/** Last non-empty line without markup (same reading as the runner's `lastLine`). */
export function verdictOf(text) {
  const line = text.split('\n').map(strip).filter(Boolean).at(-1) ?? '';
  return VERDICTS.includes(line) ? line : null;
}

/** The `## fix_routing` table → rows, or null when there is no such section. */
export function fixRows(text) {
  const m = text.match(/^##\s+fix_routing\b[^\n]*\n([\s\S]*?)(?=^##\s|(?![\s\S]))/m);
  if (!m) return null;
  const lines = m[1].split('\n').filter(l => l.trim().startsWith('|'));
  if (lines.length < 2) return [];
  const head = cells(lines[0]).map(c => strip(c).toLowerCase());
  const col = (...names) => head.findIndex(h => names.some(n => h.startsWith(n)));
  const at = { ids: col('ids', 'finding', 'id'), owner: col('owner'), scope: col('scope', 'paths'), change: col('change', 'action', 'fix'), acceptance: col('acceptance') };
  return lines.slice(2).map(l => cells(l)).filter(c => c.some(Boolean)).map(c => {
    const rawOwner = strip(c[at.owner] ?? '');
    const word = rawOwner.toLowerCase().match(/^[a-z]+/)?.[0] ?? '';
    return {
      ids: strip(c[at.ids] ?? '').split(/[,\s]+/).filter(Boolean),
      owner: word, owner_raw: rawOwner,
      reason: rawOwner.match(/\((.*)\)\s*$/)?.[1] ?? null,
      scope: (c[at.scope] ?? '').split(/[,;]\s*|\s+·\s+/).map(strip).filter(Boolean),
      change: c[at.change] ?? '', acceptance: c[at.acceptance] ?? '',
    };
  });
}

/** Slice code/art paths through a pointer PLAN, for the "scope inside the PLAN" check. */
function slicePaths(root, planRel) {
  const plan = yaml(read(path.join(root, planRel)), planRel);
  const s = front(read(path.join(root, plan.plan_source)), plan.plan_source);
  return { code: [...(s.paths?.code ?? []), ...(s.paths?.art ?? [])], scene: s.paths?.scene_objects ?? [] };
}

export function checkReview(text, { paths = null } = {}) {
  const errors = [], warnings = [];
  const fail = (code, message) => errors.push({ code, message });
  const verdict = verdictOf(text);
  if (!verdict) fail('verdict_line', `last line must be exactly one of ${VERDICTS.join(' | ')}`);
  const rows = fixRows(text);
  if (verdict === 'CHANGES_REQUESTED' && !rows?.length) fail('fix_routing_missing', 'CHANGES_REQUESTED needs a `## fix_routing` table with at least one row');
  for (const r of rows ?? []) {
    const id = r.ids.join(',') || '?';
    if (!r.ids.length || r.ids.some(x => !/^F\d+$/.test(x))) fail('fix_routing_ids', `${id}: ids must be F<n>[,F<n>]`);
    if (!OWNERS.includes(r.owner)) fail('fix_routing_owner', `${id}: owner "${r.owner_raw}" — use one of ${OWNERS.join(' | ')}, optionally "(reason)"`);
    else if (/[/&+]|\band\b/.test(r.owner_raw.replace(/\(.*\)\s*$/, ''))) fail('fix_routing_mixed_owner', `${id}: one owner per row ("${r.owner_raw}")`);
    if (r.owner === 'unclear' && !r.reason) fail('fix_routing_unclear_reason', `${id}: unclear needs "(reason)"`);
    if (['concept', 'mesh', 'anim'].includes(r.owner) && !/^[\w-]+$/.test(r.reason ?? '')) fail('fix_routing_stem', `${id}: ${r.owner} row names its stem: "${r.owner} (<stem>)"`);
    if (FIX_OWNERS.includes(r.owner) && (!r.scope.length || !r.acceptance.trim())) fail('fix_routing_incomplete', `${id}: ${r.owner} row needs scope paths and acceptance`);
    if (paths && r.owner === 'code') for (const p of r.scope) if (!paths.code.some(a => overlap(a, p))) fail('fix_routing_outside_plan', `${id}: ${p} is outside the slice paths (owner unclear with a reason)`);
  }
  if (!/^##\s+escaped\b/m.test(text)) warnings.push({ code: 'escaped_missing', message: 'no `## escaped` section before the verdict' });
  const group = o => (rows ?? []).filter(r => r.owner === o);
  const active = (rows ?? []).filter(r => r.owner !== 'followup');
  const groups = Object.fromEntries(FIX_OWNERS.map(o => [o, group(o)]).filter(([, g]) => g.length));
  return {
    ok: errors.length === 0, errors, warnings, verdict,
    fix_groups: groups,
    infra_only: active.length > 0 && active.every(r => r.owner === 'infra'),
    infra: group('infra'), director: group('director'), unclear: group('unclear'), followups: group('followup'),
  };
}

function main() {
  const a = args();
  if (!a.review) throw new Error('usage: review-check.mjs --review <review.md> [--project <root> --plan <plan>]');
  const root = path.resolve(a.project ?? '.');
  const file = path.resolve(root, a.review);
  if (!exists(file)) throw new Error(`no review file ${a.review}`);
  return checkReview(read(file), { paths: a.plan ? slicePaths(root, a.plan) : null });
}

if (process.argv[1] === new URL(import.meta.url).pathname) run(main);
