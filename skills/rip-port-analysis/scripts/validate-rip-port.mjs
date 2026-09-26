#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
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
const KINDS = ['code','data','asset','prefab','scene','metadata','seed'];
const LABELS = ['OBSERVED','INFERRED','UNKNOWN','PORT_DECISION','SEED'];
function checkSourceFile(e, sources, fail, code) {
  try {
    const tree = e.tree || 'root', base = sources.get(e.source)?.[tree];
    if (!(tree in TREES) || !base) throw Error(`Unknown evidence tree ${tree}`);
    if (TREES[tree] && !TREES[tree].includes(e.kind)) fail(`${code}_tree`, `${e.id}: ${tree} evidence must be ${TREES[tree].join('/')}`);
    const file = within(base,e.path);
    if (!fs.statSync(file).isFile() || sha256(file) !== e.sha256) fail(`${code}_stale`, `${e.id}: ${e.path}`);
  } catch(e2) { fail(`${code}_missing`, `${e.id}: ${e2.message}`); }
}
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
    if (!KINDS.includes(e.kind)) fail('rip_evidence_kind', e.id);
    checkSourceFile(e, sources, fail, 'rip_evidence');
  }
  if (!list(m.claims).length) fail('rip_claims', 'No explicit claims or unknowns');
  for (const c of list(m.claims)) {
    if (!/^RP-\d+$/.test(c?.id || '') || claims.has(c.id) || !c.summary || !LABELS.includes(c.label)) { fail('rip_claim', 'Invalid/duplicate claim'); continue; }
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

// ---------- per-slice presentation studies (rip-port/slices/<Sxx>/) ----------

export const SLICE_STUDY = 'SLICE_STUDY_MANIFEST.json';
export const SLICE_REPORT = 'RIP_SLICE_STUDY.md';
export const STUDY_KINDS = ['environment','model','layout','vfx','animation','camera','audio','other'];
const DISPOSITIONS = ['adopt','adapt','reference','exclude'];
// Unity YAML is cited through a JSON extract from extract-unity.mjs, never read off a 100k-line file by eye.
const NEEDS_EXTRACT = /\.(prefab|unity|anim|controller|overrideController|playable|mat)$/;
const TOPIC_ID = /^[a-z0-9][a-z0-9-]*$/;
export const studyPathFor = (analysisPath, slice) => path.posix.join(analysisPath.replace(/\/$/, ''), 'slices', slice);
const text = x => typeof x === 'string' && x.trim() !== '';
// Shape of a slice's `rip_study` front-matter (game-brief contract); returns [message] per problem.
export function studyTopicErrors(topics) {
  if (!Array.isArray(topics)) return ['rip_study must be a list of topics'];
  const out = [], seen = new Set();
  for (const t of topics) {
    const id = t?.id;
    if (!TOPIC_ID.test(id || '') || seen.has(id)) { out.push(`Invalid/duplicate topic id ${id}`); continue; }
    seen.add(id);
    if (!STUDY_KINDS.includes(t.kind)) out.push(`${id}: kind must be ${STUDY_KINDS.join('|')}`);
    if (!list(t.questions).length || !t.questions.every(text)) out.push(`${id}: questions must be a non-empty list of strings`);
    if (t.source_dirs !== undefined && (!Array.isArray(t.source_dirs) || t.source_dirs.some(d => !text(d) || path.isAbsolute(d) || d.split('/').includes('..')))) out.push(`${id}: source_dirs are ExportedProject-relative directories`);
  }
  return out;
}
// topics: undefined = coverage unchecked; null = slice declares none (all derived); array = slice rip_study.
export function validateSliceStudy(project, analysisPath, slice, { allowAnalyzed = false, topics } = {}) {
  const errors = [], fail = (code, message) => errors.push({ code, message });
  const studyPath = studyPathFor(analysisPath || '', slice || '');
  const done = extra => ({ ok:errors.length === 0, slice, studyPath, errors, ...extra });
  if (!/^S\d+$/.test(slice || '')) { fail('rip_study_slice', 'Expected a slice id like S05'); return done(); }
  const parent = validateRipPort(project, analysisPath);
  for (const e of parent.errors) fail(e.code, `parent analysis: ${e.message}`);
  let dir, m, pm = {};
  try {
    dir = within(project, studyPath);
    m = JSON.parse(fs.readFileSync(path.join(dir, SLICE_STUDY), 'utf8'));
    if (!m || typeof m !== 'object' || Array.isArray(m)) throw Error('Expected manifest object');
  } catch(e) { fail('rip_study_missing', `${studyPath}: ${e.message}`); return done(); }
  try { pm = JSON.parse(fs.readFileSync(path.join(within(project, analysisPath), 'RIP_PORT_MANIFEST.json'), 'utf8')) || {}; } catch {}
  if (m.schemaVersion !== 1) fail('rip_study_schema', 'Expected schemaVersion=1');
  if (m.slice !== slice) fail('rip_study_slice', `Manifest is for ${m.slice}`);
  if (!(allowAnalyzed ? ['reviewed','analyzed'] : ['reviewed']).includes(m.status)) fail('rip_study_unreviewed', 'Coordinator must spot-check the study');
  if (!text(m.analystAgent)) fail('rip_study_agent', 'Record actual analyst launch spec');
  if (!parent.manifestHash || m.parent?.sha256 !== parent.manifestHash) fail('rip_study_parent_stale', 'Study must pin the current RIP_PORT_MANIFEST.json SHA-256');
  // The slice contract is the study's question list; a brief amendment makes the study stale.
  try {
    if (!new RegExp(`^slices/${slice}-[^/]+\\.md$`).test(m.sliceFile?.path || '')) throw Error(`sliceFile.path must be slices/${slice}-*.md`);
    if (sha256(within(project, m.sliceFile.path)) !== m.sliceFile.sha256) fail('rip_study_slice_stale', `${m.sliceFile.path} changed since the study`);
  } catch(e) { fail('rip_study_slice_file', e.message); }
  const sources = new Map(list(pm.sources).filter(s => s?.id).map(s => [s.id, s]));
  const parentEvidence = new Map(list(pm.evidence).filter(e => e?.id).map(e => [e.id, e]));
  const parentClaims = new Set(list(pm.claims).map(c => c?.id));
  const evidence = new Map(), claims = new Map();
  if (!list(m.evidence).length) fail('rip_study_evidence', 'No inspected source evidence');
  for (const e of list(m.evidence)) {
    if (!new RegExp(`^E-${slice}-\\d+$`).test(e?.id || '') || evidence.has(e.id) || !sources.has(e.source)) { fail('rip_study_evidence', `Invalid/duplicate evidence ID or source: ${e?.id}`); continue; }
    evidence.set(e.id, e);
    if (!KINDS.includes(e.kind)) fail('rip_study_evidence_kind', e.id);
    checkSourceFile(e, sources, fail, 'rip_study_evidence');
    if (!e.extract) { if (NEEDS_EXTRACT.test(e.path || '')) fail('rip_study_extract_missing', `${e.id}: cite ${e.path} through an extract-unity.mjs --out extract`); continue; }
    try {
      const file = within(dir, e.extract);
      if (sha256(file) !== e.extractSha256) fail('rip_study_extract_stale', `${e.id}: ${e.extract}`);
      const x = JSON.parse(fs.readFileSync(file, 'utf8'));
      const base = sources.get(e.source)[e.tree || 'root'];
      const cites = x.file === e.path ? x.fileSha256 === e.sha256 : x.materials?.[e.path]?.sha256 === e.sha256;
      if (x.tool !== 'extract-unity' || path.resolve(x.root || '') !== path.resolve(base || '') || !cites) fail('rip_study_extract_mismatch', `${e.id}: ${e.extract} is not an extract of ${e.source}:${e.path} at the cited SHA-256`);
    } catch(e2) { fail('rip_study_extract_missing', `${e.id}: ${e2.message}`); }
  }
  const kindOf = id => (evidence.get(id) || parentEvidence.get(id))?.kind;
  if (!list(m.claims).length) fail('rip_study_claims', 'No claims');
  for (const c of list(m.claims)) {
    if (!new RegExp(`^RP-${slice}-\\d+$`).test(c?.id || '') || claims.has(c.id) || !text(c.summary) || !LABELS.includes(c.label)) { fail('rip_study_claim', `Invalid/duplicate claim: ${c?.id}`); continue; }
    claims.set(c.id, c);
    if (!Array.isArray(c.evidence) || c.evidence.some(id => !kindOf(id))) fail('rip_study_claim_citation', c.id);
    if (['OBSERVED','INFERRED'].includes(c.label) && !list(c.evidence).some(id => kindOf(id) && kindOf(id) !== 'seed')) fail('rip_study_seed_only', c.id);
    if (c.refines !== undefined && (!Array.isArray(c.refines) || c.refines.some(id => !parentClaims.has(id)))) fail('rip_study_refines', `${c.id}: refines must list parent RP IDs`);
    if (!DISPOSITIONS.includes(c.disposition)) fail('rip_study_disposition', `${c.id}: disposition must be ${DISPOSITIONS.join('|')}`);
    else if (c.disposition === 'adopt' && !['OBSERVED','INFERRED'].includes(c.label)) fail('rip_study_disposition', `${c.id}: adopt needs OBSERVED/INFERRED evidence`);
    else if (['adopt','adapt'].includes(c.disposition) && !text(c.cocos)) fail('rip_study_disposition', `${c.id}: ${c.disposition} names the Cocos target in cocos`);
    else if (c.disposition === 'adapt' && !text(c.deviation)) fail('rip_study_disposition', `${c.id}: adapt states the deviation`);
    else if (c.disposition === 'exclude' && !text(c.reason)) fail('rip_study_disposition', `${c.id}: exclude needs a reason`);
  }
  const studied = new Map();
  if (!list(m.topics).length) fail('rip_study_topics', 'No topics');
  for (const t of list(m.topics)) {
    if (!TOPIC_ID.test(t?.id || '') || studied.has(t.id) || !STUDY_KINDS.includes(t.kind) || !['slice','derived'].includes(t.source)) { fail('rip_study_topic', `Invalid/duplicate topic: ${t?.id}`); continue; }
    studied.set(t.id, t);
    if (t.status === 'studied') { if (!list(t.claims).length || t.claims.some(id => !claims.has(id))) fail('rip_study_topic_claims', `${t.id}: studied needs existing RP-${slice} claims`); }
    else if (t.status === 'excluded') { if (!text(t.reason)) fail('rip_study_topic_claims', `${t.id}: excluded needs a reason`); }
    else fail('rip_study_topic', `${t.id}: status must be studied|excluded`);
  }
  if (topics !== undefined) {
    const asked = new Set(list(topics).map(t => t?.id));
    for (const id of asked) if (studied.get(id)?.source !== 'slice') fail('rip_study_topic_uncovered', `${id}: slice rip_study topic not studied/excluded`);
    for (const t of studied.values()) if (t.source === 'slice' && !asked.has(t.id)) fail('rip_study_topic_unknown', `${t.id}: not in the slice rip_study`);
  }
  if (!Array.isArray(m.unknowns)) fail('rip_study_unknowns', 'unknowns must be a list');
  try {
    if (!list(m.files).includes(SLICE_REPORT)) fail('rip_study_report_list', SLICE_REPORT);
    const p = within(dir, SLICE_REPORT), body = fs.readFileSync(p, 'utf8');
    if (!body.trim()) fail('rip_study_report_empty', SLICE_REPORT);
    if (sha256(p) !== m.reportHashes?.[SLICE_REPORT]) fail('rip_study_report_stale', SLICE_REPORT);
    for (const id of body.match(/\bRP-(?:S\d+-)?\d+\b/g) || []) if (!claims.has(id) && !parentClaims.has(id)) fail('rip_study_unknown_claim', id);
    for (const id of claims.keys()) if (!new RegExp(`\\b${id}\\b`).test(body)) fail('rip_study_unused_claim', id);
    for (const id of studied.keys()) if (!body.includes(id)) fail('rip_study_topic_unreported', id);
  } catch(e) { fail('rip_study_report_missing', `${SLICE_REPORT}: ${e.message}`); }
  return done({ status:m.status, parentHash:parent.manifestHash, manifestHash:sha256(path.join(dir, SLICE_STUDY)) });
}
// CLI helper: the slice's rip_study, parsed with game-brief's yaml dependency (its lib.mjs imports this file, so not that).
async function sliceTopics(project, slice) {
  const dir = path.join(project, 'slices'), file = fs.existsSync(dir) && fs.readdirSync(dir).find(f => f.startsWith(`${slice}-`) && f.endsWith('.md'));
  if (!file) return { error:`slices/${slice}-*.md not found` };
  let parse;
  try { ({ parse } = await import(pathToFileURL(createRequire(new URL('../../game-brief/package.json', import.meta.url)).resolve('yaml')).href)); }
  catch { return { warning:'game-brief yaml dependency unavailable: slice topic coverage unchecked' }; }
  const m = fs.readFileSync(path.join(dir, file), 'utf8').match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!m) return { error:`${file}: missing YAML front-matter` };
  try { const d = parse(m[1], { uniqueKeys:true }); return { topics:d && typeof d === 'object' && 'rip_study' in d ? d.rip_study : null }; }
  catch(e) { return { error:`${file}: ${e.message}` }; }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2), project = path.resolve(argv[0] || '.');
  const at = argv.indexOf('--analysis-path'), sl = argv.indexOf('--slice');
  const analysisPath = at >= 0 ? argv[at+1] : argv[1] && !argv[1].startsWith('--') ? `reference/${argv[1]}/rip-port` : '';
  const allowAnalyzed = argv.includes('--allow-analyzed');
  if (!analysisPath || (sl >= 0 && !argv[sl+1])) { console.error('usage: validate-rip-port.mjs <project> <slug> | --analysis-path <relative path> [--allow-analyzed] [--recheck-inventory] [--slice Sxx]'); process.exitCode=2; }
  else if (sl >= 0) {
    const slice = argv[sl+1], st = await sliceTopics(project, slice);
    const result = st.error ? { ok:false, slice, errors:[{ code:'rip_study_slice_file', message:st.error }] }
      : Array.isArray(st.topics) && !st.topics.length ? { ok:true, slice, skipped:'slice declares rip_study: []', errors:[] }
      : { ...validateSliceStudy(project, analysisPath, slice, { allowAnalyzed, topics:st.topics }), ...(st.warning ? { warning:st.warning } : {}) };
    console.log(JSON.stringify(result,null,2)); process.exitCode=result.ok?0:1;
  }
  else { const result=validateRipPort(project,analysisPath,{allowAnalyzed,recheckInventory:argv.includes('--recheck-inventory')}); console.log(JSON.stringify(result,null,2)); process.exitCode=result.ok?0:1; }
}
