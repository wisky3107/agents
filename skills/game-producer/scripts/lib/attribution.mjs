/**
 * Which part of the workflow a lessons.jsonl cost row belongs to (plan
 * docs/plans/2026-10-02-workflow-effectiveness-tracking, S1). The runner writes these rows, so it
 * knows their source; tools/workflow-scorecard reads `system` as written instead of guessing it from
 * the cause text. Learning rows (recipe_candidate / recipe_reuse) carry no system.
 *   agent[:<role>] · orca · gateway · engine · brief · art[:<backend>] · ship · memory · other
 */
export const SYSTEMS = ['orca', 'gateway', 'agent', 'engine', 'brief', 'art', 'ship', 'memory', 'other'];

const LEARNING = new Set(['recipe_candidate', 'recipe_reuse']);

export function systemFor(row) {
  switch (row.event) {
    case 'fix_round': // a review sent the lane's work back; the runner does not know which owner
      return 'agent';
    case 'infra_blocked': // the reviewer's sandbox could not reach the preview, or the preview was down
      return /reviewer could not reach/.test(row.cause || '') ? 'agent:review' : 'engine';
    case 'respawn':
    case 'merge_conflict':
      return 'orca';
    case 'budget_bump':
    case 'director_gate':
      return 'brief';
    default:
      return 'other';
  }
}

/** The row with `system` filled in; rows that already carry one, and learning rows, are unchanged. */
export function withSystem(row) {
  if (!row?.event || LEARNING.has(row.event) || row.system) return row;
  return { ...row, system: systemFor(row) };
}
