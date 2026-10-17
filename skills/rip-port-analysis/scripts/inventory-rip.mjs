#!/usr/bin/env node
// Deterministic whole-tree inventory of one rip source. The analyst reads this instead of sampling,
// and the validator requires every nonzero category to be mapped or explicitly excluded.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { presentationIndex } from './extract-unity.mjs';

export const INVENTORY = 'RIP_INVENTORY.json';
// Categories the manifest's inventoryCoverage must dispose of when their count is nonzero.
export const CATEGORIES = ['scripts','serializedData','prefabs','scenes','animation','textAssets','audio','fonts','textures','glb','outputLevels'];
const DUMMY = 'Dummy class';
const THIRD_PARTY = /^(Unity|UnityEngine|UnityEditor|System|Mono|Microsoft|Newtonsoft|TMPro|TextMeshPro|DOTween|DG\.|Cinemachine|com\.|Google|Firebase|Facebook|AppsFlyer|Adjust|Bugsnag|Sentry|Datadog|IronSource|AppLovin|MaxSdk|Zenject|UniRx|UniTask|Cysharp|Sirenix|Spine|Lean|Photon|PlayFab|Purchasing|Newtonsoft|protobuf|Google\.Protobuf|nunit|xunit|Assembly-CSharp-firstpass)/i;
const LOG_LINE = /Cpp2IL|Il2Cpp|scripting backend|metadata|assembly manager|Unity version|Exception|\[Error\]/i;
const METADATA_FAILURE = /magic number|corrupt metadata|Could not initialize assembly manager|Switching to the 'Unknown' scripting backend|LibCpp2ILInitializationException/i;
const cap = (a, n = 2000) => ({ items: a.slice(0, n), truncated: Math.max(0, a.length - n) });

function walk(dir) {
  if (!dir || !fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter(d => d.isFile() && !d.name.endsWith('.meta') && d.name !== '.DS_Store')
    .map(d => path.join(d.parentPath ?? d.path, d.name));
}
const ext = f => path.extname(f).slice(1).toLowerCase();
const count = (files, exts) => files.filter(f => exts.includes(ext(f))).length;
const bucket = (rel, depth) => path.dirname(rel).split(path.sep).slice(0, depth).join('/');
function groupCount(rels, depth) {
  const m = {};
  for (const r of rels) { const k = bucket(r, depth); m[k] = (m[k] || 0) + 1; }
  return Object.fromEntries(Object.entries(m).sort((a, b) => b[1] - a[1]));
}

// AssetRipper's IL2CPP export keeps signatures but replaces bodies with defaults: `{ }`,
// `return null;`, `x = default; return false;` (out params), `return Kind.None;`, `throw null;`.
// ILSpy also emits explicit-interface forwarders (`this.MoveNext();`, `return Ns_002EType_002Eget_Current();`).
const CONST = String.raw`(null|default(\([^()]*\))?|false|true|""|'.'|(\([\w.<>]+\))?-?[\d.]+[fdmlu]*|[A-Za-z_][\w.]*)`;
const TRIVIAL_STMT = new RegExp(String.raw`^(return(${CONST})?|thrownull|[\w.]+=${CONST}|this=default(\([^()]*\))?|(return)?this\.[\w.]+(\([^;]*\))?|(return)?\w*_002E\w*\(\))$`, 'i');
const TRIVIAL_EXPR = new RegExp(String.raw`^(${CONST}|thrownull)$`, 'i');
const trivialBody = b => b.split(';').every((st, i, all) => (i === all.length - 1 ? st === '' : TRIVIAL_STMT.test(st)));
// Classifies one .cs file: 'dummy' (Dummy class), 'stub' (every member body trivial), 'bodied'
// (at least one real body) or 'declarations' (no member bodies: enums, plain data types).
export function classifyScript(text) {
  if (text.includes(DUMMY)) return 'dummy';
  const src = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '').replace(/@?"(?:[^"\\\n]|\\.)*"/g, '""').replace(/'(?:[^'\\\n]|\\.)'/g, "'.'");
  const stack = []; let head = '', bodies = 0, real = 0;
  const body = []; // text of the member body currently open (stack depth of its start)
  for (const ch of src) {
    const top = stack[stack.length - 1];
    if (ch === '{') {
      const h = head.trim();
      let kind = 'inner';
      if (top !== 'member' && top !== 'inner') {
        if (/\b(class|struct|interface|enum|namespace|record)\b/.test(h)) kind = 'type';
        else if (/\)\s*(where\b[^{]*)?$|(^|\s)(get|set|add|remove|init)$|\)\s*:\s*(base|this)\s*\([^{]*\)$/.test(h)) kind = 'member';
        else kind = 'prop';
      }
      if (kind === 'member') body.push('');
      else if (body.length) body[body.length - 1] += ch;
      stack.push(kind); head = '';
    } else if (ch === '}') {
      const kind = stack.pop();
      if (kind === 'member') { bodies++; if (!trivialBody(body.pop().replace(/\s+/g, ''))) real++; }
      else if (body.length) body[body.length - 1] += ch;
      head = '';
    } else if (ch === ';' && top !== 'member' && top !== 'inner') {
      const m = head.match(/=>\s*([\s\S]+)$/);
      if (m && /\)\s*=>|^\s*[^=(]*=>/.test(head)) { bodies++; if (!TRIVIAL_EXPR.test(m[1].replace(/\s+/g, ''))) real++; }
      head = '';
    } else if (body.length) body[body.length - 1] += ch;
    else head += ch;
  }
  return real ? 'bodied' : bodies ? 'stub' : 'declarations';
}

// Unity YAML: class id of the first object, plus top-level custom fields after m_EditorClassIdentifier.
function readUnityAsset(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
  const classId = (text.match(/^--- !u!(\d+)/m) || [])[1] || 'binary';
  if (classId !== '114') return { classId, fields: [] };
  const after = text.split(/^  m_EditorClassIdentifier:.*$/m)[1] || '';
  const fields = [...after.matchAll(/^  ([A-Za-z_][\w]*):/gm)].map(m => m[1]);
  return { classId, fields };
}

function inventoryUnityProject(root) {
  const assets = path.join(root, 'Assets');
  const files = walk(assets), rel = f => path.relative(assets, f);
  const scriptsDir = path.join(assets, 'Scripts');
  const cs = files.filter(f => ext(f) === 'cs');
  const assemblies = {};
  for (const f of cs) {
    const r = path.relative(scriptsDir, f), asm = r.startsWith('..') ? '(outside Scripts)' : r.split(path.sep)[0];
    const a = assemblies[asm] ||= { files: 0, dummy: 0, stubs: 0, bodied: 0, tooling: 0 };
    a.files++;
    // AssetRipper adds its own editor patch scripts (real bodies); they are not game code.
    if (rel(f).split(path.sep).includes('AssetRipperPatches')) { a.tooling++; continue; }
    const kind = classifyScript(fs.readFileSync(f, 'utf8'));
    if (kind === 'dummy') a.dummy++; else if (kind === 'stub') a.stubs++; else if (kind === 'bodied') a.bodied++;
  }
  const byAsm = Object.entries(assemblies).sort((a, b) => b[1].files - a[1].files);
  const sum = k => byAsm.reduce((n, [, a]) => n + a[k], 0);
  const dummy = sum('dummy'), stubs = sum('stubs'), bodied = sum('bodied'), tooling = sum('tooling');
  const classIds = {}, withFields = [];
  for (const f of files.filter(f => ext(f) === 'asset')) {
    const a = readUnityAsset(f); if (!a) continue;
    classIds[a.classId] = (classIds[a.classId] || 0) + 1;
    if (a.fields.length) withFields.push({ path: rel(f), fields: a.fields.slice(0, 8) });
  }
  const textAssets = files.filter(f => ['txt','json','bytes','csv','xml','yaml','yml'].includes(ext(f)) && !rel(f).startsWith('Scripts'));
  let unityVersion = '';
  try { unityVersion = (fs.readFileSync(path.join(root, 'ProjectSettings/ProjectVersion.txt'), 'utf8').match(/m_EditorVersion:\s*(\S+)/) || [])[1] || ''; } catch {}
  return {
    root, unityVersion,
    scripts: {
      // stubs: empty-body files (AssetRipper IL2CPP export); declarations: no member bodies at all.
      total: cs.length, dummy, stubs, bodied, tooling, declarations: cs.length - dummy - stubs - bodied - tooling,
      assemblies: Object.fromEntries(byAsm),
      gameAssemblyCandidates: byAsm.filter(([n]) => !THIRD_PARTY.test(n)).slice(0, 20).map(([n, a]) => ({ name: n, ...a })),
    },
    serializedData: {
      assetFiles: Object.values(classIds).reduce((a, b) => a + b, 0), byUnityClassId: classIds,
      monoBehaviours: classIds['114'] || 0, withFields: withFields.length,
      withFieldsByDir: groupCount(withFields.map(w => w.path.split('/').join(path.sep)), 3),
      withFieldsFiles: cap(withFields),
    },
    prefabs: count(files, ['prefab']), scenes: files.filter(f => ext(f) === 'unity').map(rel),
    animation: { clips: count(files, ['anim']), controllers: count(files, ['controller','overridecontroller']), playables: count(files, ['playable']) },
    materials: count(files, ['mat']), shaders: count(files, ['shader']),
    textAssets: { count: textAssets.length, files: cap(textAssets.map(rel), 500) },
    audio: { count: count(files, ['wav','ogg','mp3','aif','aiff']), byDir: groupCount(files.filter(f => ['wav','ogg','mp3'].includes(ext(f))).map(rel), 3) },
    fonts: count(files, ['ttf','otf','fnt']), textures: count(files, ['png','jpg','jpeg','tga','exr','psd']),
    // Readable even when every script is a stub; slice studies drill in with extract-unity.mjs --index --under <dir>.
    presentationIndex: presentationIndex(root).dirs,
  };
}

function inventoryPrimaryContent(root) {
  const files = walk(root), rel = f => path.relative(root, f);
  const glb = files.filter(f => ['glb','gltf'].includes(ext(f)));
  return {
    root, glb: glb.length, glbByDir: groupCount(glb.map(rel), 4),
    textures: count(files, ['png','jpg','jpeg','tga']), json: count(files, ['json']),
    audio: count(files, ['wav','ogg','mp3']), fonts: count(files, ['ttf','otf','fnt']), cs: count(files, ['cs']),
  };
}

function inventoryOutput(root) {
  const files = walk(root);
  const levels = files.filter(f => path.relative(root, f).startsWith('levels' + path.sep));
  return { root, levels: levels.length, meshes: count(files.filter(f => path.relative(root, f).startsWith('meshes')), ['glb','gltf']), hasManifest: fs.existsSync(path.join(root, 'manifest.json')) };
}

// il2cpp-decompile output: C# declarations (cpp2il_cs) plus pseudo-C bodies (pseudo_c) of the
// decompiled assemblies. It recovers bodies the stub scripts lack; codeAvailability still
// describes the Unity tree only.
function inventoryDecompiled(root) {
  let m = {};
  try { m = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8')); } catch {}
  const declDir = path.join(root, 'cpp2il_cs/DiffableCs');
  const assemblies = fs.existsSync(declDir) ? fs.readdirSync(declDir).filter(n => fs.statSync(path.join(declDir, n)).isDirectory()) : [];
  return {
    root, abi: m.abi || '', unityVersion: m.unity_version || '', metadataVersion: m.metadata_version ?? null,
    declarationFiles: count(walk(declDir), ['cs']), declarationAssemblies: assemblies.length,
    pseudoCFiles: count(walk(path.join(root, 'pseudo_c')), ['c']), pseudoCFunctions: m.functions_decompiled || 0,
    decompiledAssemblies: m.decompiled_assemblies || [], vtableBase: m.vtable_base ?? null,
    ghidraProject: fs.existsSync(path.join(root, 'ghidra_project')),
  };
}
const isDecompiled = p => { try { return JSON.parse(fs.readFileSync(path.join(p, 'manifest.json'), 'utf8')).tool === 'il2cpp-decompile'; } catch { return false; } };

function readLog(file) {
  if (!file || !fs.existsSync(file)) return { path: file || '', lines: [], metadataFailure: false };
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(l => LOG_LINE.test(l)).slice(0, 40).map(l => l.slice(0, 300));
  return { path: file, lines, metadataFailure: lines.some(l => METADATA_FAILURE.test(l)) };
}

// Resolve UnityProject/ExportedProject, PrimaryContent and output from any accepted input.
export function resolveSource(input) {
  const abs = path.resolve(input), isDir = p => p && fs.existsSync(p) && fs.statSync(p).isDirectory();
  let workdir = abs, sp = {};
  const readManifest = dir => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')); } catch { return null; } };
  if (isDir(path.join(abs, 'Assets')) && isDir(path.join(abs, 'ProjectSettings'))) return { unityProject: abs, primaryContent: '', output: '', log: '', decompiled: '' };
  if (path.basename(abs) === 'ripped') workdir = path.dirname(abs);
  else if (readManifest(abs) && !isDir(path.join(abs, 'ripped'))) { sp = readManifest(abs).source_paths || {}; workdir = path.dirname(abs); }
  const ripped = sp.ripped || path.join(workdir, 'ripped');
  const unityProject = [sp.unity_project, path.join(ripped, 'UnityProject/ExportedProject'), path.join(ripped, 'UnityProject')].find(p => isDir(p) && isDir(path.join(p, 'Assets'))) || '';
  const primaryContent = [sp.primary_content, path.join(ripped, 'PrimaryContent')].find(isDir) || '';
  const output = [path.join(workdir, 'output'), readManifest(abs) ? abs : ''].find(p => isDir(p) && readManifest(p)) || '';
  const log = [path.join(workdir, 'assetripper.log')].find(p => fs.existsSync(p)) || '';
  const outSp = output ? readManifest(output)?.source_paths || {} : {};
  const decompiled = [sp.decompiled, outSp.decompiled, path.join(workdir, 'decompiled')].find(p => isDir(p) && isDecompiled(p)) || '';
  return { unityProject, primaryContent, output, log, decompiled };
}

export function buildInventory(paths) {
  const up = paths.unityProject ? inventoryUnityProject(paths.unityProject) : null;
  const pc = paths.primaryContent ? inventoryPrimaryContent(paths.primaryContent) : null;
  const out = paths.output ? inventoryOutput(paths.output) : null;
  const dec = paths.decompiled ? inventoryDecompiled(paths.decompiled) : null;
  const log = readLog(paths.log);
  const s = up?.scripts;
  // Bodies decide: no real body anywhere → stubs; declaration-only files (enums, data) are neutral.
  const codeAvailability = !s?.total ? 'none' : !s.bodied ? 'stubs' : (s.dummy + s.stubs) ? 'mixed' : 'readable';
  // Nonzero counts that the analysis must map or exclude. Content comes from UnityProject; GLB from PrimaryContent.
  const counts = {
    scripts: s?.total || 0, serializedData: up?.serializedData.withFields || 0, prefabs: up?.prefabs || 0,
    scenes: up?.scenes.length || 0, animation: (up?.animation.clips || 0) + (up?.animation.controllers || 0),
    textAssets: up?.textAssets.count || 0, audio: up?.audio.count || pc?.audio || 0,
    fonts: up?.fonts || pc?.fonts || 0, textures: up?.textures || pc?.textures || 0,
    glb: pc?.glb || 0, outputLevels: out?.levels || 0,
  };
  const floor = !up ? 'assets_only' : (s.bodied ? 'readable_logic_or_partial' : 'partial');
  // Readable bodies (Unity scripts or decompiled pseudo-C) earn the full forensic pass; stubs/none
  // only support structure, assets and unknowns.
  const decompiledLogic = (dec?.pseudoCFunctions || 0) > 0;
  const recommendedDepth = ['readable', 'mixed'].includes(codeAvailability) || decompiledLogic ? 'full' : 'lightweight';
  return { counts, codeAvailability, decompiledLogic, coverageFloor: decompiledLogic ? 'readable_logic_or_partial' : floor, recommendedDepth, metadataFailure: log.metadataFailure, unityProject: up, primaryContent: pc, output: out, decompiled: dec, log };
}

export const summarize = inv => ({ counts: inv.counts, codeAvailability: inv.codeAvailability, decompiledLogic: inv.decompiledLogic });

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2), opt = k => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  const outFile = opt('--out'), id = opt('--id') || 'main', input = opt('--source');
  if (!outFile || (!input && !opt('--unity-project'))) {
    console.error('usage: inventory-rip.mjs --out <analysis>/RIP_INVENTORY.json [--id main] (--source <workdir|output|ripped|ExportedProject> | --unity-project <dir> [--primary-content <dir>] [--output <dir>] [--log <file>] [--decompiled <dir>])');
    process.exitCode = 2;
  } else {
    const resolved = input ? resolveSource(input) : {};
    const paths = { unityProject: opt('--unity-project') ?? resolved.unityProject, primaryContent: opt('--primary-content') ?? resolved.primaryContent, output: opt('--output') ?? resolved.output, log: opt('--log') ?? resolved.log, decompiled: opt('--decompiled') ?? resolved.decompiled ?? '' };
    const inv = buildInventory(paths);
    let doc = { schemaVersion: 1, sources: {} };
    try { doc = JSON.parse(fs.readFileSync(outFile, 'utf8')); } catch {}
    doc.sources[id] = { paths, ...inv };
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, JSON.stringify(doc, null, 2) + '\n');
    console.log(JSON.stringify({ id, paths, ...summarize(inv), coverageFloor: inv.coverageFloor, recommendedDepth: inv.recommendedDepth, metadataFailure: inv.metadataFailure, sha256: crypto.createHash('sha256').update(fs.readFileSync(outFile)).digest('hex') }, null, 2));
  }
}
