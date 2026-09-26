#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { INVENTORY, CATEGORIES, buildInventory } from './inventory-rip.mjs';

export const REPORTS = [
  'RIP_LOGIC_MAP.md',
  'RIP_STATE_MACHINE.md',
  'RIP_LEVEL_SCHEMA.md',
  'RIP_ASSET_MAP.md',
  'RIP_PORT_GAPS.md',
];
export const sha256 = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const list = x => Array.isArray(x) ? x : [];
export function analysisPathFor(project, notes = {}) {
  const configured = notes.rip_port?.analysis_path || notes.brief?.rip_port_path;
  if (configured) return configured;
  const ref = notes.brief?.reference_path || notes.store_clone?.reference_path;
  const rip = notes.brief?.rip_path || notes.store_clone?.rip_path;
  const hasRip = rip || notes.store_clone?.rip_project_source || notes.rip_port?.enabled
    || list(notes.rip_port?.sources).length
    || (ref && fs.existsSync(path.join(project, ref, 'rip/RIP_PACK.json')));
  if (!hasRip) return null;
  if (ref) return `${ref.replace(/\/$/, '')}/rip-port`;
  if (rip) return path.posix.join(path.posix.dirname(rip.replace(/\/$/, '')), 'rip-port');
  return ''; // Required but no resolvable analysis path: fail closed.
}
function within(root, relative) {
  if (typeof relative !== 'string' || !relative || path.isAbsolute(relative)) throw Error('Expected relative file path');
  const base = fs.realpathSync(root), file = fs.realpathSync(path.resolve(root, relative));
  if (!file.startsWith(base + path.sep)) throw Error('Path escapes source root');
  return file;
}
// Evidence may cite the analysis tree (root = UnityProject/ExportedProject), PrimaryContent (GLB lookup only) or output (SEED only).
const TREES = { root: null, primaryContent: ['asset'], output: ['seed'] };
export function validateRipPort(project, analysisPath, { allowAnalyzed = false, expectedSources, recheckInventory = false } = {}) {
  const errors = [], fail = (code, message) => errors.push({ code, message });
  let root, m;
  try {
    root = within(project, analysisPath);
    m = JSON.parse(fs.readFileSync(path.join(root, 'RIP_PORT_MANIFEST.json'), 'utf8'));
    if (!m || typeof m !== 'object' || Array.isArray(m)) throw Error('Expected manifest object');
  } catch(e) { return { ok:false, errors:[{code:'rip_analysis_missing', message:e.message}] }; }
  if (m.schemaVersion === 1) fail('rip_schema_legacy', 'schemaVersion 1 predates RIP_INVENTORY coverage; re-run the analysis');
  else if (m.schemaVersion !== 2) fail('rip_schema', 'Expected schemaVersion=2');
  if (!(allowAnalyzed ? ['reviewed','analyzed'] : ['reviewed']).includes(m.status)) fail('rip_unreviewed', 'Coordinator must review the analysis');
  if (!['readable_logic','partial','assets_only'].includes(m.logicCoverage)) fail('rip_coverage', 'Unknown logicCoverage');
  const depth = m.analysisDepth ?? 'full';
  if (!['full','lightweight'].includes(depth)) fail('rip_depth', 'analysisDepth must be full or lightweight');
  if (!m.analystAgent || typeof m.analystAgent !== 'string') fail('rip_agent', 'Record actual analyst launch spec');
  if (!Array.isArray(m.unknowns) || (m.logicCoverage !== 'readable_logic' && !m.unknowns.length)) fail('rip_unknowns', 'Limited coverage must list missing behavior');
  const sources = new Map(), evidence = new Map(), claims = new Set();
  if (!list(m.sources).length) fail('rip_sources', 'At least one source required');
  for (const s of list(m.sources)) {
    if (typeof s?.id !== 'string' || !s.id || sources.has(s.id) || typeof s.root !== 'string' || !path.isAbsolute(s.root) || !['readable','stubs','none','mixed'].includes(s.codeAvailability)) { fail('rip_source', 'Invalid/duplicate source metadata'); continue; }
    sources.set(s.id,s);
    for (const t of Object.keys(TREES)) if (s[t] !== undefined && s[t] !== '' && (typeof s[t] !== 'string' || !path.isAbsolute(s[t]) || !fs.existsSync(s[t]) || !fs.statSync(s[t]).isDirectory())) fail('rip_source_missing', `${s.id}.${t}: ${s[t]}`);
    if (fs.existsSync(s.root) && !fs.existsSync(path.join(s.root, 'Assets')) && s.codeAvailability !== 'none') fail('rip_source_root', `${s.id}: root must be UnityProject/ExportedProject (has Assets/), not ripped/ or PrimaryContent`);
  }
  // Whole-tree inventory: hashed, one entry per source, drives coverage floor and category dispositions.
  let inv;
  try {
    const p = within(root, m.inventory?.path || INVENTORY);
    inv = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (sha256(p) !== m.inventory?.sha256) fail('rip_inventory_stale', 'Inventory hash differs from manifest');
  } catch(e) { fail('rip_inventory_missing', `Run scripts/inventory-rip.mjs: ${e.message}`); }
  const totals = Object.fromEntries(CATEGORIES.map(c => [c, 0]));
  if (inv) for (const [id, s] of sources) {
    const i = inv.sources?.[id];
    if (!i) { fail('rip_inventory_source', `No inventory for source ${id}`); continue; }
    if (path.resolve(i.paths?.unityProject || '') !== path.resolve(s.root)) fail('rip_inventory_source', `${id}: inventory unityProject differs from source root`);
    for (const c of CATEGORIES) totals[c] += i.counts?.[c] || 0;
    if (i.codeAvailability && i.codeAvailability !== s.codeAvailability) fail('rip_code_availability', `${id}: inventory says ${i.codeAvailability}, manifest says ${s.codeAvailability}`);
    if (i.metadataFailure && !(typeof m.codeRecovery === 'string' && m.codeRecovery.trim())) fail('rip_code_recovery', `${id}: assetripper.log shows IL2CPP metadata failure; record cause and recovery in codeRecovery`);
    if (recheckInventory) {
      const fresh = buildInventory(i.paths || {});
      for (const c of CATEGORIES) if ((fresh.counts[c] || 0) !== (i.counts?.[c] || 0)) fail('rip_inventory_drift', `${id}.${c}: ${i.counts?.[c]} recorded, ${fresh.counts[c]} now`);
    }
  }
  if (m.logicCoverage === 'assets_only' && (totals.scripts || totals.serializedData)) fail('rip_coverage_floor', `assets_only but inventory has ${totals.scripts} scripts and ${totals.serializedData} serialized MonoBehaviours; use partial`);
  if (expectedSources !== undefined) {
    if (!Array.isArray(expectedSources) || expectedSources.length !== sources.size) fail('rip_source_set', 'Analysis source list differs from requested sources');
    for (const s of list(expectedSources)) if (!sources.has(s?.id) || path.resolve(s.root || '.') !== path.resolve(sources.get(s.id).root)) fail('rip_source_set', `Source changed: ${s?.id}`);
  }
  if (depth === 'lightweight' && [...sources.values()].some(s => ['readable','mixed'].includes(s.codeAvailability))) fail('rip_depth_mismatch', 'Readable/mixed code requires analysisDepth=full');
  if (m.logicCoverage === 'readable_logic' && ![...sources.values()].some(s => ['readable','mixed'].includes(s.codeAvailability))) fail('rip_false_coverage', 'Readable logic requires inspected readable code');
  if (!list(m.evidence).length) fail('rip_evidence', 'No inspected source evidence');
  for (const e of list(m.evidence)) {
    if (!e?.id || evidence.has(e.id) || !sources.has(e.source)) { fail('rip_evidence', 'Invalid/duplicate evidence ID or source'); continue; }
    evidence.set(e.id,e);
    if (!['code','data','asset','prefab','scene','metadata','seed'].includes(e.kind)) fail('rip_evidence_kind', e.id);
    try {
      const tree = e.tree || 'root', base = sources.get(e.source)[tree];
      if (!(tree in TREES) || !base) throw Error(`Unknown evidence tree ${tree}`);
      if (TREES[tree] && !TREES[tree].includes(e.kind)) fail('rip_evidence_tree', `${e.id}: ${tree} evidence must be ${TREES[tree].join('/')}`);
      const file = within(base,e.path);
      if (!fs.statSync(file).isFile() || sha256(file) !== e.sha256) fail('rip_evidence_stale', `${e.id}: ${e.path}`);
    } catch(e2) { fail('rip_evidence_missing', `${e.id}: ${e2.message}`); }
  }
  if (!list(m.claims).length) fail('rip_claims', 'No explicit claims or unknowns');
  for (const c of list(m.claims)) {
    if (!/^RP-\d+$/.test(c?.id || '') || claims.has(c.id) || !c.summary || !['OBSERVED','INFERRED','UNKNOWN','PORT_DECISION','SEED'].includes(c.label)) { fail('rip_claim', 'Invalid/duplicate claim'); continue; }
    claims.add(c.id);
    if (!Array.isArray(c.evidence) || list(c.evidence).some(id => !evidence.has(id))) fail('rip_claim_citation', c.id);
    if (['OBSERVED','INFERRED'].includes(c.label) && !list(c.evidence).some(id => evidence.has(id) && evidence.get(id).kind !== 'seed')) fail('rip_seed_only', c.id);
  }
  const disposed = new Map();
  for (const d of list(m.inventoryCoverage)) {
    if (!CATEGORIES.includes(d?.category) || disposed.has(d.category) || !['mapped','excluded'].includes(d.status)) { fail('rip_inventory_disposition', `Invalid/duplicate: ${d?.category}`); continue; }
    disposed.set(d.category, d);
    if (d.status === 'mapped' && (!list(d.claims).length || list(d.claims).some(id => !claims.has(id)))) fail('rip_inventory_disposition', `${d.category}: mapped needs existing claim IDs`);
    if (d.status === 'excluded' && !(typeof d.reason === 'string' && d.reason.trim())) fail('rip_inventory_disposition', `${d.category}: excluded needs a reason`);
  }
  if (inv) for (const c of CATEGORIES) if (totals[c] && !disposed.has(c)) fail('rip_inventory_unmapped', `${c}: ${totals[c]} items in inventory, no mapped/excluded disposition`);
  const reportTexts = [];
  for (const file of REPORTS) {
    if (!list(m.files).includes(file)) fail('rip_report_list', file);
    try {
      const p = within(root,file), text = fs.readFileSync(p,'utf8'); reportTexts.push(text);
      if (!text.trim()) fail('rip_report_empty', file);
      if (sha256(p) !== m.reportHashes?.[file]) fail('rip_report_stale', file);
      if (!/RP-\d+|\bUNKNOWN\b/.test(text)) fail('rip_report_uncited', file);
      for (const id of text.match(/\bRP-\d+\b/g) || []) if (!claims.has(id)) fail('rip_unknown_claim', `${file}: ${id}`);
    } catch(e) { fail('rip_report_missing', `${file}: ${e.message}`); }
  }
  for (const id of claims) if (!reportTexts.some(t => new RegExp(`\\b${id}\\b`).test(t))) fail('rip_unused_claim', id);
  return { ok:errors.length === 0, analysisPath, logicCoverage:m.logicCoverage, analysisDepth:depth, manifestHash:sha256(path.join(root,'RIP_PORT_MANIFEST.json')), errors };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2), project = path.resolve(argv[0] || '.');
  const at = argv.indexOf('--analysis-path');
  const analysisPath = at >= 0 ? argv[at+1] : argv[1] && !argv[1].startsWith('--') ? `reference/${argv[1]}/rip-port` : '';
  if (!analysisPath) { console.error('usage: validate-rip-port.mjs <project> <slug> | --analysis-path <relative path> [--allow-analyzed] [--recheck-inventory]'); process.exitCode=2; }
  else { const result=validateRipPort(project,analysisPath,{allowAnalyzed:argv.includes('--allow-analyzed'),recheckInventory:argv.includes('--recheck-inventory')}); console.log(JSON.stringify(result,null,2)); process.exitCode=result.ok?0:1; }
}
