#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

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
export function validateRipPort(project, analysisPath, { allowAnalyzed = false, expectedSources } = {}) {
  const errors = [], fail = (code, message) => errors.push({ code, message });
  let root, m;
  try {
    root = within(project, analysisPath);
    m = JSON.parse(fs.readFileSync(path.join(root, 'RIP_PORT_MANIFEST.json'), 'utf8'));
    if (!m || typeof m !== 'object' || Array.isArray(m)) throw Error('Expected manifest object');
  } catch(e) { return { ok:false, errors:[{code:'rip_analysis_missing', message:e.message}] }; }
  if (m.schemaVersion !== 1) fail('rip_schema', 'Expected schemaVersion=1');
  if (!(allowAnalyzed ? ['reviewed','analyzed'] : ['reviewed']).includes(m.status)) fail('rip_unreviewed', 'Coordinator must review the analysis');
  if (!['readable_logic','partial','assets_only'].includes(m.logicCoverage)) fail('rip_coverage', 'Unknown logicCoverage');
  if (!m.analystAgent || typeof m.analystAgent !== 'string') fail('rip_agent', 'Record actual analyst launch spec');
  if (!Array.isArray(m.unknowns) || (m.logicCoverage !== 'readable_logic' && !m.unknowns.length)) fail('rip_unknowns', 'Limited coverage must list missing behavior');
  const sources = new Map(), evidence = new Map(), claims = new Set();
  if (!list(m.sources).length) fail('rip_sources', 'At least one source required');
  for (const s of list(m.sources)) {
    if (typeof s?.id !== 'string' || !s.id || sources.has(s.id) || typeof s.root !== 'string' || !path.isAbsolute(s.root) || !['readable','stubs','none','mixed'].includes(s.codeAvailability)) { fail('rip_source', 'Invalid/duplicate source metadata'); continue; }
    sources.set(s.id,s);
    if (!fs.existsSync(s.root) || !fs.statSync(s.root).isDirectory()) fail('rip_source_missing', s.root);
  }
  if (expectedSources !== undefined) {
    if (!Array.isArray(expectedSources) || expectedSources.length !== sources.size) fail('rip_source_set', 'Analysis source list differs from requested sources');
    for (const s of list(expectedSources)) if (!sources.has(s?.id) || path.resolve(s.root || '.') !== path.resolve(sources.get(s.id).root)) fail('rip_source_set', `Source changed: ${s?.id}`);
  }
  if (m.logicCoverage === 'readable_logic' && ![...sources.values()].some(s => ['readable','mixed'].includes(s.codeAvailability))) fail('rip_false_coverage', 'Readable logic requires inspected readable code');
  if (!list(m.evidence).length) fail('rip_evidence', 'No inspected source evidence');
  for (const e of list(m.evidence)) {
    if (!e?.id || evidence.has(e.id) || !sources.has(e.source)) { fail('rip_evidence', 'Invalid/duplicate evidence ID or source'); continue; }
    evidence.set(e.id,e);
    if (!['code','data','asset','prefab','scene','metadata','seed'].includes(e.kind)) fail('rip_evidence_kind', e.id);
    try {
      const file = within(sources.get(e.source).root,e.path);
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
  return { ok:errors.length === 0, analysisPath, logicCoverage:m.logicCoverage, manifestHash:sha256(path.join(root,'RIP_PORT_MANIFEST.json')), errors };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2), project = path.resolve(argv[0] || '.');
  const at = argv.indexOf('--analysis-path');
  const analysisPath = at >= 0 ? argv[at+1] : argv[1] && !argv[1].startsWith('--') ? `reference/${argv[1]}/rip-port` : '';
  if (!analysisPath) { console.error('usage: validate-rip-port.mjs <project> <slug> | --analysis-path <relative path> [--allow-analyzed]'); process.exitCode=2; }
  else { const result=validateRipPort(project,analysisPath,{allowAnalyzed:argv.includes('--allow-analyzed')}); console.log(JSON.stringify(result,null,2)); process.exitCode=result.ok?0:1; }
}
