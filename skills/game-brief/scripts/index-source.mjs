import fs from 'node:fs';
import path from 'node:path';
import { analysisPathFor, validateRipPort } from '../../rip-port-analysis/scripts/validate-rip-port.mjs';
import { args, project, local, exists, read, json, hash, notes, files, tableRows, ids, writeJson, run } from './lib.mjs';

function dimensions(file) {
  // Metadata only; meshes and complete image payloads are never decoded.
  const fd = fs.openSync(file, 'r');
  const b = Buffer.alloc(Math.min(fs.statSync(file).size, 131072));
  try { fs.readSync(fd, b, 0, b.length, 0); } finally { fs.closeSync(fd); }
  if (b.length >= 24 && b.subarray(1, 4).toString() === 'PNG') return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  if (b[0] === 255 && b[1] === 216) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 255) break;
      const marker = b[i + 1], len = b.readUInt16BE(i + 2);
      if ([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker)) return { width: b.readUInt16BE(i + 7), height: b.readUInt16BE(i + 5) };
      if (len < 2) break;
      i += len + 2;
    }
  }
  return { width: null, height: null };
}
function spread(a, n) {
  if (a.length <= n) return a;
  return Array.from({ length: n }, (_, i) => a[Math.round(i * (a.length - 1) / (n - 1))]);
}
function diverse(rows, n) {
  const used = new Set(), picked = [];
  for (const r of rows) if (!used.has(r.category)) { used.add(r.category); picked.push(r); if (picked.length === n) return picked; }
  return [...picked, ...rows.filter(r => !picked.includes(r))].slice(0, n);
}
function shape(x, prefix = '', result = new Set(), depth = 0) {
  if (depth > 8 || x === null || typeof x !== 'object') return [...result];
  if (Array.isArray(x)) { if (x.length) shape(x[0], `${prefix}[]`, result, depth + 1); }
  else for (const k of Object.keys(x)) { const key = prefix ? `${prefix}.${k}` : k; result.add(key); shape(x[k], key, result, depth + 1); }
  return [...result];
}
export function indexSource(p, a = {}) {
  const n = notes(p), brief = n.brief || {}, warnings = [];
  const port = analysisPathFor(p,n);
  if (port !== null) {
    const result = validateRipPort(p,port,{expectedSources:n.rip_port?.sources});
    if (!result.ok) throw Error(`Run rip-port-analysis before brief authoring: ${result.errors.map(e=>e.code).join(', ')}`);
  }
  const ref = (a.reference || brief.reference_path || n.store_clone?.reference_path || '').replace(/\/$/, '');
  const detectedRip = ref && exists(local(p, `${ref}/rip/RIP_PACK.json`)) ? `${ref}/rip` : '';
  const rip = (brief.rip_path || n.store_clone?.rip_path || detectedRip).replace(/\/$/, '');
  const source = brief.source || (ref ? 'media' : 'idea');
  if (!['idea','media','store'].includes(source)) throw Error(`Unknown source mode: ${source}`);
  const depth = a.depth || brief.contract_depth || 'full';
  if (!['full', 'playable'].includes(depth)) throw Error('depth must be full or playable');
  if (depth === 'playable' && n.release?.goal !== 'playable') throw Error('playable depth requires release.goal=playable');
  if (ref && !exists(local(p, ref))) throw Error(`Missing reference directory: ${ref}`);
  if (rip && !exists(local(p, rip))) throw Error(`Missing rip directory: ${rip}`);
  const touched = ['AGENT_NOTES.md'];
  const catalogs = [], counts = {};
  if (rip) for (const [name, dir] of [['images_ingame_catalog.json', 'images_ingame'], ['meshes_catalog.json', 'meshes']]) {
    const f = `${rip.replace(/\/$/, '')}/${name}`;
    if (!exists(local(p, f))) { warnings.push(`Missing catalog: ${f}; use targeted directory lookup`); continue; }
    touched.push(f);
    const c = json(local(p, f));
    if (!Array.isArray(c.entries)) throw Error(`Unsupported catalog entries: ${f}`);
    for (const e of c.entries) {
      counts[e.priority] = (counts[e.priority] || 0) + 1;
      if (!['P0', 'P1'].includes(e.priority)) continue;
      if (typeof e.file !== 'string' || path.basename(e.file) !== e.file) { warnings.push(`Unsupported catalog filename in ${f}`); continue; }
      const imported = dir === 'meshes' && ref && exists(local(p, `${ref}/models/${e.file}`)) ? `${ref}/models/${e.file}` : `${rip}/${dir}/${e.file}`;
      const normalized = path.posix.normalize(imported);
      const present = exists(local(p, normalized));
      if (!present) warnings.push(`Missing candidate: ${normalized}`);
      catalogs.push({ path: normalized, priority: e.priority, category: e.category || dir, maps_to: e.maps_to, how_to_use: e.how_to_use, exists: present, catalog: f });
    }
  }
  const media = ref ? [...files(p, ref.replace(/\/$/, '')), ...['iphone','ipad','video/frames'].flatMap(d => files(p, `${ref.replace(/\/$/, '')}/${d}`))].filter(f => /\.(png|jpe?g|webp)$/i.test(f)) : [];
  const chosenMedia = spread(media.filter(f => !/icon|poster/i.test(f)), 5);
  const sampleImages = diverse(catalogs.filter(c => c.exists && c.priority === 'P0' && /\.png$/i.test(c.path)), 3);
  const sampleMeshes = diverse(catalogs.filter(c => c.exists && c.priority === 'P0' && /\.glb$/i.test(c.path)), 3);
  const levels = rip ? files(p, `${rip.replace(/\/$/, '')}/levels`).filter(f => f.endsWith('.json')) : [];
  const productionLevels = levels.filter(f => !/test|debug|sandbox|^ad\d|autocannon/i.test(path.basename(f))).sort((a,b) => Number(!/default|level[_-]?0*1\b/i.test(a)) - Number(!/default|level[_-]?0*1\b/i.test(b)) || a.localeCompare(b, 'en', { numeric: true }));
  const selectedLevels = (productionLevels.length ? productionLevels : levels).slice(0, 3).map(f => { touched.push(f); return { path: f, keys: shape(json(local(p, f))), sampling: 'first production candidates; keys from first array element only; inspect file for decisions' }; });
  const configured = brief.gameplay_notes_path;
  const slug = a.slug || path.basename(ref || p).replace(/^cc4?-/, '');
  const conventional = `reference/${slug}-brief/GAMEPLAY_NOTES.md`;
  const gp = configured || (conventional && exists(local(p, conventional)) ? conventional : '');
  if (configured && !exists(local(p, configured))) throw Error(`Configured gameplay notes unreadable: ${configured}`);
  let requirements = [];
  if (gp) {
    touched.push(gp);
    const text = read(local(p, gp));
    requirements = tableRows(text).filter(r => /^GP-\d+$/.test(r[0])).map(r => ({ id: r[0], kind: r[1], sourcePassage: r[2], notes: r[3] }));
    if (!requirements.length && ids(text).length) warnings.push('GP IDs found but no supported Requirement index table; inspect manually');
  }
  const requiredReads = ref ? [`${ref}/manifest.json`, ...files(p,ref).filter(f => /\.(md|txt|pdf|docx)$/i.test(f)), ...(rip ? ['RIP_PACK.json','README.md','IMAGES_INGAME_GUIDE.md','MESHES_GUIDE.md','briefs/GAME_BRIEF.md','briefs/GAMEPLAY_BRIEF.md'].map(f => `${rip}/${f}`) : [])] : [`reference/${slug}-brief/IDEA.md`];
  if (port) requiredReads.push(...files(p,port.replace(/\/$/, '')).filter(f => /\/RIP_.*\.(md|json)$/.test(f)));
  if (source === 'idea' && !exists(local(p,requiredReads[0]))) throw Error(`Missing idea source: ${requiredReads[0]}; supply --slug when folder naming differs`);
  const inputPaths = [...new Set([...touched, ...media, ...requiredReads, ...catalogs.filter(c => c.exists).map(c => c.path)])];
  const fingerprint = hash(JSON.stringify(inputPaths.map(f => { const q = local(p, f); return exists(q) ? [f, fs.statSync(q).size, fs.statSync(q).mtimeMs, /\.(json|md)$/.test(f) ? hash(read(q)) : null] : [f, null]; })) + depth);
  const out = { schemaVersion: 1, source, contractDepth: depth, releaseGoal: n.release?.goal || 'end_to_end', referencePath: ref, ripPath: rip, orientation: brief.orientation || 'portrait 720x1280', inputFingerprint: fingerprint,
    requiredReads: requiredReads.filter(f => exists(local(p, f))), gameplayNotesPath: gp || null, requirements,
    media: chosenMedia.map(f => ({ path: f, ...dimensions(local(p, f)) })), sampleImages, sampleMeshes, levels: selectedLevels,
    counts: { media: media.length, levels: levels.length, catalogPriorities: counts, candidates: catalogs.length },
    candidatesPath: 'docs/brief-asset-candidates.json', warnings,
    researchPolicy: 'Inspect shortlist first. Full director source is mandatory. Extra reads need a decision-specific reason; catalog priority is not v1 scope or evidence of visual inspection.' };
  const target = local(p, 'docs/brief-input-index.json');
  const candidatePath = local(p,out.candidatesPath);
  const cached = exists(target) && json(target).inputFingerprint === fingerprint && exists(candidatePath) && hash(JSON.stringify(json(candidatePath))) === hash(JSON.stringify(catalogs));
  if (!a['dry-run'] && !cached) { writeJson(local(p, out.candidatesPath), catalogs); writeJson(target, out); }
  return { ok: true, cached, dryRun: !!a['dry-run'], index: out };
}
if (process.argv[1] === new URL(import.meta.url).pathname) run(() => { const a = args(); return indexSource(project(a), a); });
