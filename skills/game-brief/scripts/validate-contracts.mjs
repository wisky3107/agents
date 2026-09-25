import { args, project, local, exists, read, front, fence, ROOTS, tables, files, notes, run } from './lib.mjs';
import { analysisPathFor, validateRipPort } from '../../rip-port-analysis/scripts/validate-rip-port.mjs';

export function loadSlices(p) {
  return files(p, 'slices').filter(f => /^slices\/S\d+-.+\.md$/.test(f)).map(file => ({ file, text: read(local(p, file)), data: front(read(local(p, file)), file) }));
}
// Conservative wildcard overlap: ambiguous pairs must run serially or narrow their paths.
export function overlap(a, b) {
  a = a.replace(/\\/g, '/').replace(/\/$/, ''); b = b.replace(/\\/g, '/').replace(/\/$/, '');
  if (a === b || a.startsWith(b + '/') || b.startsWith(a + '/')) return true;
  const prefix = s => s.split(/[?*[{]/)[0];
  const x = prefix(a), y = prefix(b);
  return (x !== a || y !== b) && (x.startsWith(y) || y.startsWith(x));
}
const list = x => Array.isArray(x) ? x : [];
const IMAGE = /(?:reference|docs\/mockups)\/[^\s)`'"|<>,]+\.(?:png|jpe?g|svg|webp)/gi;
const SCREEN = /(?:Panel|Screen|Menu|Popup|Dialog|Overlay|Modal)s?(?:\/|$)/i;
// Feel-table IDs are the leading identifier of the first cell in tables under a "feel" heading.
export function feelIds(expect) {
  const out = new Set();
  for (const section of expect.split(/\n(?=#{1,6} )/)) {
    if (!/^#{1,6} [^\n]*feel/i.test(section)) continue;
    for (const t of tables(section)) for (const r of t.slice(2)) {
      const id = r[0].replace(/[`*]/g, '').trim().toLowerCase().match(/^[a-z0-9_]+/)?.[0];
      if (id) out.add(id);
    }
  }
  return out;
}
const done = (n, id) => { const st = n.release?.slices?.[id]; return ['merged','shipped'].includes(typeof st === 'string' ? st : st?.status); };
export function validate(p, options = {}) {
  const errors = [], warnings = [], texts = {};
  const fail = (code, file, message) => errors.push({ code, file, message });
  for (const f of ROOTS) {
    if (!exists(local(p, f)) || !read(local(p, f)).trim()) fail('missing_root_contract', f, 'Required non-empty contract');
    else texts[f] = read(local(p, f));
  }
  for (const [file,text] of Object.entries(texts)) if (/BRIEF_DRAFT|\[TODO\b/.test(text)) fail('unfinished_scaffold', file, 'Replace scaffold with evidence-backed content');
  let n, m, slices;
  try { n = notes(p); m = fence(texts['MILESTONES.md'] || '', 'MILESTONES.md'); slices = loadSlices(p); }
  catch (e) { fail('invalid_yaml', 'contracts', e.message); return { ok: false, errors, warnings }; }
  const portPath = analysisPathFor(p,n);
  if (portPath !== null) {
    const port = validateRipPort(p, portPath, { expectedSources:n.rip_port?.sources });
    for (const e of port.errors) fail(e.code, portPath || 'AGENT_NOTES.md', e.message);
    if (port.ok) {
      for (const f of ['HOW_TO.md','ARCHITECTURE.md']) if (!/\bRP-\d+\b/.test(texts[f] || '')) fail('rip_contract_unlinked',f,'Port contracts must cite RP claims');
      // Completed slices retain historical pins; new/amended work uses current analysis.
      for (const s of slices) {
        const state = n.release?.slices?.[s.data?.id];
        if (['merged','shipped'].includes(typeof state === 'string' ? state : state?.status)) continue;
        if (!s.text.includes(portPath.replace(/\/$/, '')) || !s.text.includes(port.manifestHash)) fail('rip_slice_unpinned',s.file,'Port evidence needs analysis path and current manifest SHA-256');
      }
    }
  }
  if (!m || typeof m !== 'object' || Array.isArray(m)) { fail('invalid_milestones', 'MILESTONES.md', 'Expected YAML mapping'); return { ok: false, errors, warnings }; }
  const depth = options.depth || n.brief?.contract_depth || 'full';
  if (!['full', 'playable'].includes(depth)) fail('invalid_depth', 'AGENT_NOTES.md', 'contract_depth must be full or playable');
  const planned = list(m.slices);
  if (!planned.length || planned.some(id => !/^S\d+$/.test(id)) || new Set(planned).size !== planned.length) fail('invalid_slice_ids', 'MILESTONES.md', 'Unique non-empty slice IDs required');
  const fullSlices = depth === 'full' ? planned : [m.v1_slice];
  if (depth === 'playable' && n.release?.goal !== 'playable') fail('depth_requires_expansion', 'AGENT_NOTES.md', 'Expand contracts and set contract_depth=full before end_to_end');
  for (const k of ['v1_slice', 'release_slice']) if (!planned.includes(m[k])) fail('invalid_milestone_pointer', 'MILESTONES.md', `${k} must name a slice`);
  if (planned.at(-1) !== m.release_slice || !m.stop_when) fail('invalid_release_order', 'MILESTONES.md', 'Release slice must be last and stop_when must be set');
  const byId = new Map();
  for (const s of slices) {
    if (/BRIEF_DRAFT|\bTODO\b/.test(s.text)) fail('unfinished_scaffold', s.file, 'Replace draft fields before gate');
    if (!s.data || typeof s.data !== 'object') { fail('invalid_slice', s.file, 'Expected YAML mapping'); continue; }
    if (byId.has(s.data.id)) fail('duplicate_slice_id', s.file, `Duplicate ${s.data.id}`);
    byId.set(s.data.id, s);
    if (!planned.includes(s.data.id)) fail('unlisted_slice', s.file, `${s.data.id} absent from milestones`);
    if (!s.file.startsWith(`slices/${s.data.id}-`)) fail('slice_filename_mismatch', s.file, 'Filename ID must match front-matter');
  }
  for (const id of planned) if (!byId.has(id)) fail('missing_slice', 'MILESTONES.md', `No file for ${id}`);
  const dag = m.dag;
  if (!dag || typeof dag !== 'object' || Array.isArray(dag)) fail('invalid_dag', 'MILESTONES.md', 'dag must be a mapping');
  for (const [id, deps] of Object.entries(dag || {})) if (!planned.includes(id) || !Array.isArray(deps) || deps.some(d => !planned.includes(d) || d === id)) fail('invalid_dependency', 'MILESTONES.md', `Invalid dependency for ${id}`);
  const visiting = new Set(), visited = new Set();
  const walk = id => { if (visiting.has(id)) { fail('dag_cycle', 'MILESTONES.md', `Cycle at ${id}`); return; } if (visited.has(id)) return; visiting.add(id); for (const d of list(dag?.[id])) walk(d); visiting.delete(id); visited.add(id); };
  planned.forEach(walk);
  const manifest = texts['ASSET_MANIFEST.md'] || '';
  const expectText = texts['EXPECT_GAMEPLAY_VISUAL.md'] || '', feel = feelIds(expectText);
  const unlockedBy = id => Object.entries(dag || {}).filter(([, deps]) => list(deps).includes(id)).map(([k]) => k).sort();
  const seenScenes = [];
  for (const id of planned) {
    const s = byId.get(id); if (!s?.data) continue;
    const x = s.data, scenes = list(x.paths?.scene_objects).filter(o => typeof o === 'string');
    // A later full slice that adds a screen needs its own visual target, like S01 does.
    if (fullSlices.includes(id) && id !== m.v1_slice && id !== m.release_slice && !done(n, id)) {
      const added = scenes.filter(o => SCREEN.test(o) && !seenScenes.some(q => overlap(o, q)));
      const refs = [...s.text.matchAll(IMAGE), ...expectText.split('\n').filter(l => new RegExp(`\\b${id}\\b`).test(l)).flatMap(l => [...l.matchAll(IMAGE)])].map(r => r[0]);
      const mock = files(p, 'docs/mockups').some(f => new RegExp(`^docs/mockups/${id}-`).test(f));
      if (added.length && !mock && !refs.some(f => exists(local(p, f)))) fail('missing_screen_target', s.file, `New screen ${added.join(', ')} needs an existing reference image or docs/mockups/${id}-*.svg cited in the slice or an EXPECT line naming ${id}`);
    }
    seenScenes.push(...scenes);
  }
  for (const [id, s] of byId) {
    const x = s.data;
    for (const k of ['id','name','one_liner','size','depends_on','unlocks','needs_director_ok','player_outcome','scope','paths','assets','acceptance','feel_rows','runtime_checks','playtest','change_budget','risks','release_items']) if (!(k in x)) fail('slice_missing_plan_field', s.file, `Missing ${k}`);
    if ('player_outcome' in x && (typeof x.player_outcome !== 'string' || !x.player_outcome.trim())) fail('missing_player_outcome', s.file, 'player_outcome maps to PLAN.user_visible_behavior and must be a non-empty string');
    // unlocks may omit dependents (e.g. release-polish) but must not claim edges the dag lacks.
    const extra = list(x.unlocks).filter(u => !unlockedBy(id).includes(u));
    if (!done(n, id) && (!Array.isArray(x.unlocks ?? []) || extra.length)) fail('unlocks_mismatch', s.file, `unlocks ${extra.join(', ')} do not depend on ${id} in MILESTONES.dag`);
    if (!done(n, id)) for (const r of list(x.feel_rows)) if (typeof r !== 'string' || !feel.has(r.toLowerCase())) fail('unknown_feel_row', s.file, `feel_rows ${r} is not a row ID of the EXPECT Game feel / VFX table`);
    if (!['S','M','L'].includes(x.size) || typeof x.needs_director_ok !== 'boolean') fail('invalid_slice_type', s.file, 'size and needs_director_ok types invalid');
    if (!x.name || !x.one_liner || !list(x.scope?.in).length || !list(x.acceptance).length) fail('missing_slice_outcome', s.file, 'Every slice, including an outline, needs a name, outcome, scope.in and acceptance');
    for (const k of ['depends_on','acceptance','feel_rows','runtime_checks','playtest','risks','release_items']) if (!Array.isArray(x[k])) fail('invalid_slice_list', s.file, `${k} must be a list`);
    for (const [k, keys] of Object.entries({ paths: ['code','art','scene_objects'], scope: ['in','out'], assets: ['2d','3d','vfx','audio'] })) for (const key of keys) if (!Array.isArray(x[k]?.[key])) fail('invalid_slice_group', s.file, `${k}.${key} must be a list`);
    if (JSON.stringify([...list(x.depends_on)].sort()) !== JSON.stringify([...list(dag?.[id])].sort())) fail('dependency_mismatch', s.file, 'depends_on disagrees with MILESTONES.dag');
    if (!x.change_budget || ['files','lines','nodes','assets','tripo_credits'].some(k => typeof x.change_budget[k] !== 'number' || !Number.isFinite(x.change_budget[k]) || x.change_budget[k] < 0)) fail('invalid_budget', s.file, 'Finite nonnegative budgets required');
    for (const row of list(x.acceptance)) if (!row?.text || !/^(OBSERVED|GIVEN|ASSUMPTION)\b/.test(row.evidence || '')) fail('invalid_acceptance_evidence', s.file, 'Acceptance needs text and evidence (SEED alone is insufficient)');
    if (list(x.acceptance).filter(r => /ASSUMPTION/.test(r?.evidence)).length >= 3 && !x.needs_director_ok) fail('assumptions_need_gate', s.file, 'Three or more ASSUMPTION rows require needs_director_ok');
    if (fullSlices.includes(id)) {
      for (const k of ['acceptance','runtime_checks','playtest']) if (!list(x[k]).length) fail('empty_full_slice', s.file, `${k} cannot be empty`);
      for (const group of Object.values(x.assets || {})) for (const asset of list(group)) if (!asset?.stem || !manifest.includes(asset.stem)) fail('missing_manifest_asset', s.file, `Asset ${asset?.stem} missing from ASSET_MANIFEST`);
    }
    if (x.name === 'release-polish' && id !== m.release_slice) fail('release_polish_pointer', s.file, 'release-polish must be release_slice');
  }
  if (byId.get(m.release_slice)?.data.name !== 'release-polish') fail('missing_release_polish', 'MILESTONES.md', 'Final slice must be named release-polish');
  if (!Array.isArray(m.parallel_ok)) fail('invalid_parallel_pairs', 'MILESTONES.md', 'parallel_ok must be a list');
  for (const pair of list(m.parallel_ok)) {
    if (!Array.isArray(pair) || pair.length !== 2 || pair[0] === pair[1] || pair.some(id => !byId.has(id) || id === m.release_slice)) { fail('invalid_parallel_pair', 'MILESTONES.md', JSON.stringify(pair)); continue; }
    for (const group of ['code','art','scene_objects']) {
      const a = list(byId.get(pair[0]).data.paths?.[group]), b = list(byId.get(pair[1]).data.paths?.[group]);
      if (a.some(x => b.some(y => typeof x === 'string' && typeof y === 'string' && overlap(x,y)))) fail('parallel_paths_overlap', 'MILESTONES.md', `${pair.join('/')} overlap in ${group}; use serial scheduling or precise paths`);
    }
  }
  const rc = tables(texts['RELEASE_CHECKLIST.md'] || '').flatMap(t => {
    const col = t[0].findIndex(c => /closed.by/i.test(c)); return col >= 0 ? t.slice(2).filter(r => /^RC-\d+$/.test(r[0])).map(r => ({ id: r[0], owner: r[col] })) : [];
  });
  if (!rc.length) fail('missing_release_rows', 'RELEASE_CHECKLIST.md', 'Expected RC rows with closed_by column');
  if (new Set(rc.map(r=>r.id)).size !== rc.length) fail('duplicate_release_item', 'RELEASE_CHECKLIST.md', 'RC IDs must be unique');
  for (const r of rc) if (!list(byId.get(r.owner)?.data.release_items).includes(r.id)) fail('uncovered_release_item', 'RELEASE_CHECKLIST.md', `${r.id} not owned by ${r.owner}`);
  for (const s of slices) for (const id of list(s.data?.release_items)) if (!rc.some(r => r.id === id)) fail('unknown_release_item', s.file, `${id} absent from checklist`);
  const expect = expectText;
  const targets = [...expect.matchAll(/(?:\]\(|`)((?:reference|docs\/mockups)\/[^)`\n]+\.(?:png|jpe?g|svg|webp))(?:\)|`)/gi)].map(m => m[1]);
  if (!targets.length || !targets.some(f => exists(local(p, f)))) fail('missing_visual_target', 'EXPECT_GAMEPLAY_VISUAL.md', 'Link an existing image/SVG; text alone is insufficient');
  if (!/game feel[^\n]*vfx/i.test(expect)) fail('missing_vfx_table', 'EXPECT_GAMEPLAY_VISUAL.md', 'Game feel / VFX table required');
  if (!/\bP0\b/.test(manifest) || !/vfx|particle|trail|impact/i.test(manifest)) fail('missing_vfx_assets', 'ASSET_MANIFEST.md', 'P0 VFX assets required');
  if (!/budget_count\s*:\s*code_only/.test(texts['SCOPE.md'] || '') || !/budget_mode\s*:\s*(advisory|gate)|budget_auto_bump_pct/.test(texts['SCOPE.md'] || '')) fail('missing_budget_policy', 'SCOPE.md', 'State code_only counting and budget_mode (advisory|gate)');
  const importRows = tables(manifest).flatMap(t => { const col = t[0].findIndex(c => /^source$/i.test(c)); return col >= 0 ? t.slice(2).filter(r => /\bimport\b/i.test(r[col])) : []; });
  if ((n.brief?.rip_path || n.store_clone?.rip_path) && !importRows.length) fail('missing_import_rows', 'ASSET_MANIFEST.md', 'Rip input requires Source=import rows');
  for (const row of importRows) {
    const paths = [...row.join(' ').matchAll(/reference\/[^\s|`)<>,]+\.(?:png|jpe?g|webp|glb|gltf|fbx|obj|ttf|otf|fnt|json|asset|prefab|anim|wav|mp3|ogg)\b/gi)].map(m => m[0]);
    if (!paths.length) fail('missing_import_path', 'ASSET_MANIFEST.md', `Import row needs an exact file: ${row[0]}`);
    for (const f of paths) if (!exists(local(p, f))) fail('missing_import_path', 'ASSET_MANIFEST.md', f);
  }
  if (n.brief?.source === 'idea') for (const [f,t] of [...Object.entries(texts), ...slices.map(s=>[s.file,s.text])]) if (/\bOBSERVED\s*\(/.test(t)) fail('idea_observed_evidence', f, 'Idea input cannot claim OBSERVED');
  warnings.push({ code: 'semantic_review_required', message: 'Mechanical checks do not prove visual inspection, scope/evidence correctness, GP source completeness, layout quality, or runtime behavior.' });
  return { ok: errors.length === 0, errors, warnings, contractDepth: depth, dispatchableSlices: fullSlices, slices: slices.length };
}
if (process.argv[1] === new URL(import.meta.url).pathname) run(() => validate(project(args()), args()));
