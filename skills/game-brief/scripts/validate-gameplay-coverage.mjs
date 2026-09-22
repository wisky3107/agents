import path from 'node:path';
import { args, project, local, exists, read, ids, tables, notes, run } from './lib.mjs';
import { loadSlices } from './validate-contracts.mjs';

export function validate(p) {
  const n = notes(p), ref = n.brief?.reference_path || n.store_clone?.reference_path || '';
  const slug = path.basename(ref || p).replace(/^cc4?-/, '');
  const conventional = `reference/${slug}-brief/GAMEPLAY_NOTES.md`;
  const gp = n.brief?.gameplay_notes_path || (conventional && exists(local(p, conventional)) ? conventional : '');
  if (!gp) return { ok: true, skipped: true, errors: [], warnings: [] };
  const errors = [], warnings = [{ code: 'semantic_review_required', message: 'Check source text against the GP index and verify scenarios mean the requested behavior; string linkage alone cannot establish semantic coverage.' }];
  const fail = (code, message) => errors.push({ code, message });
  if (!exists(local(p, gp))) return { ok: false, errors: [{ code: 'notes_unreadable', file: gp }], warnings };
  const sourceRows = tables(read(local(p, gp))).flatMap(t => t.slice(2)).filter(r => /^GP-\d+$/.test(r[0]));
  const sourceIds = sourceRows.map(r => r[0]);
  if (!sourceIds.length) fail('missing_gp_index', 'Notes must have a Requirement index table');
  if (new Set(sourceIds).size !== sourceIds.length) fail('duplicate_gp_index', 'Duplicate source GP IDs');
  const how = exists(local(p, 'HOW_TO.md')) ? read(local(p, 'HOW_TO.md')) : '';
  const coverage = tables(how).filter(t => t[0].some(c => /decision/i.test(c)) && t[0].some(c => /acceptance|playtest/i.test(c)));
  const rows = coverage.flatMap(t => t.slice(2).filter(r => /^GP-\d+$/.test(r[0])).map(r => ({ id: r[0], row: r, header: t[0] })));
  let slices = [];
  try { slices = loadSlices(p); } catch (e) { fail('invalid_slice_yaml', e.message); }
  const counts = {};
  for (const id of sourceIds) {
    const matches = rows.filter(r => r.id === id);
    if (matches.length !== 1) { fail('gp_coverage_count', `${id}: expected one coverage row, found ${matches.length}`); continue; }
    const { row, header } = matches[0];
    const cell = re => row[header.findIndex(c => re.test(c))] || '';
    const decision = cell(/decision/i).match(/\b(included|deferred|excluded|unresolved|superseded)\b/i)?.[1]?.toLowerCase();
    if (!decision) { fail('gp_missing_decision', id); continue; }
    counts[decision] = (counts[decision] || 0) + 1;
    const owners = cell(/^slice/i).match(/\bS\d+\b/g) || [];
    if (['included','unresolved'].includes(decision)) {
      if (!owners.length) fail('gp_missing_slice', id);
      for (const owner of owners) {
        const s = slices.find(s => s.data.id === owner);
        if (!s) { fail('gp_unknown_slice', `${id}: ${owner}`); continue; }
        if (decision === 'included') {
          if (!ids(JSON.stringify([s.data.acceptance, s.data.playtest])).includes(id)) fail('gp_missing_scenario', `${id}: ${owner} must cite GP in acceptance/playtest`);
        } else if (!s.data.needs_director_ok || !ids(JSON.stringify(s.data.risks)).includes(id)) fail('gp_missing_gate', `${id}: risk and needs_director_ok required in ${owner}`);
      }
    }
    if (decision === 'included') {
      if (!cell(/contract/i) || !cell(/acceptance|playtest/i)) fail('gp_missing_pointers', `${id}: contract and scenario pointers required`);
      const outsideCoverage = how.split('\n').filter(l => !/^\s*\|\s*GP-\d+\s*\|/.test(l)).join('\n');
      const rulePointers = ids(cell(/contract/i), 'H');
      const existingRules = tables(outsideCoverage).flatMap(t=>t.slice(2)).map(r=>r[0].replace(/^H0*(\d+)$/,(_,n)=>`H-${n.padStart(2,'0')}`));
      if (!ids(outsideCoverage).includes(id) && !(rulePointers.length && rulePointers.every(h=>existingRules.includes(h)))) fail('gp_missing_rule', `${id}: HOW_TO needs a rule citation or resolvable H-row pointer outside coverage`);
      if (!exists(local(p, 'PLAYTEST.md')) || !ids(read(local(p, 'PLAYTEST.md'))).includes(id)) fail('gp_missing_playtest', `${id}: mirror scenario in PLAYTEST`);
    }
    if (['deferred','excluded'].includes(decision) && (!/FOLLOWUPS|NOT.in.v1/i.test(row.join(' ')) || cell(/decision/i).replace(decision,'').trim().length < 4)) fail('gp_missing_scope_reason', `${id}: reason and FOLLOWUPS/NOT-in-v1 pointer required`);
    if (decision === 'superseded' && !ids(row.slice(1).join(' ')).some(other => other !== id && sourceIds.includes(other))) fail('gp_missing_replacement', id);
  }
  for (const r of rows) if (!sourceIds.includes(r.id)) fail('orphan_gp_row', r.id);
  return { ok: errors.length === 0, errors, warnings, sourceIds, counts };
}
if (process.argv[1] === new URL(import.meta.url).pathname) run(() => validate(project(args())));
