#!/usr/bin/env node
// Deterministic Unity YAML extractor for slice studies. Serialized presentation data (hierarchy, RectTransform,
// ParticleSystem, renderers, materials, clips, controllers, uGUI fields) survives IL2CPP stubbing, so the agent
// cites these extracts instead of reading 100k-line prefabs by eye.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const TOOL_VERSION = 1;
export const LEGEND = {
  curve: '[time, value, inSlope, outSlope]; "Infinity" slopes = stepped key',
  minMaxCurve: '{const} | {curve, mult} | {minCurve, maxCurve, mult} | {min, max}',
  minMaxGradient: '{color} | {gradient} | {min, max} (two colors or two gradients) | {randomColor}',
  gradient: '{mode, colors: [[t, r, g, b]], alphas: [[t, a]]}, t in 0..1',
  particle: 'ParticleSystem angles (startRotation*, rotation modules) are radians; sizes/speeds are in the emitter scalingMode space (0 hierarchy, 1 local, 2 shape)',
  transform: 'p=localPosition q=localRotation(x,y,z,w) e=Unity euler deg (ZXY) s=localScale; defaults omitted; raw Unity left-handed values',
  noFields: 'MonoBehaviour with no serialized fields in this rip (e.g. base-APK scene without typetree): values are UNKNOWN, never defaults',
  ref: 'asset path relative to --root, "#<fileID>" suffix for sub-assets, "local:<Class>:<node path>" for same-file objects',
};

const CLASS = {
  1: 'GameObject', 4: 'Transform', 20: 'Camera', 21: 'Material', 23: 'MeshRenderer', 33: 'MeshFilter', 54: 'Rigidbody',
  74: 'AnimationClip', 82: 'AudioSource', 91: 'AnimatorController', 95: 'Animator', 96: 'TrailRenderer', 104: 'RenderSettings',
  108: 'Light', 111: 'Animation', 114: 'MonoBehaviour', 120: 'LineRenderer', 137: 'SkinnedMeshRenderer', 198: 'ParticleSystem',
  199: 'ParticleSystemRenderer', 206: 'BlendTree', 212: 'SpriteRenderer', 222: 'CanvasRenderer', 223: 'Canvas',
  224: 'RectTransform', 225: 'CanvasGroup', 1001: 'PrefabInstance', 1101: 'AnimatorStateTransition', 1102: 'AnimatorState',
  1107: 'AnimatorStateMachine',
};
const MAIN_FILE_IDS = new Set([2100000, 2800000, 4300000, 4800000, 7400000, 8300000, 9100000, 11400000, 11500000, 12800000, 21300000, 100100000]);
const DROP = new Set(['serializedVersion', 'm_ObjectHideFlags', 'm_CorrespondingSourceObject', 'm_PrefabInstance', 'm_PrefabAsset',
  'm_GameObject', 'm_EditorHideFlags', 'm_EditorClassIdentifier', 'm_PreInfinity', 'm_PostInfinity', 'm_RotationOrder']);
const PS_MODULES = ['ShapeModule', 'EmissionModule', 'SizeModule', 'RotationModule', 'ColorModule', 'UVModule', 'VelocityModule',
  'InheritVelocityModule', 'LifetimeByEmitterSpeedModule', 'ForceModule', 'ExternalForcesModule', 'ClampVelocityModule',
  'NoiseModule', 'SizeBySpeedModule', 'RotationBySpeedModule', 'ColorBySpeedModule', 'CollisionModule', 'TriggerModule',
  'SubModule', 'LightsModule', 'TrailModule', 'CustomDataModule'];

// ---------- YAML subset (Unity text serialization) ----------

const isSeqItem = t => t === '-' || t.startsWith('- ');
function splitKey(t) {
  if (/^[[{]/.test(t)) return null;
  const q = t.match(/^'((?:[^']|'')*)':(?:\s+(.*))?$/) ?? t.match(/^"((?:[^"\\]|\\.)*)":(?:\s+(.*))?$/);
  if (q) return { key: q[1], rest: q[2] ?? '' };
  const m = t.match(/^([^\s'"][^:]*?):(?:\s+(.*))?$/);
  return m ? { key: m[1], rest: m[2] ?? '' } : null;
}

export function toScalar(s, key) {
  if (key === 'guid') return s;
  if (/^-?(0|[1-9]\d*)$/.test(s)) { const n = Number(s); return Number.isSafeInteger(n) ? n : s; }
  if (s.length <= 24 && /^-?(\d+\.\d*|\.\d+|\d+)([eE][-+]?\d+)?$/.test(s)) return Number(s);
  return s;
}

function parseFlow(s) {
  let i = 0;
  const ws = () => { while (i < s.length && /\s/.test(s[i])) i++; };
  const quoted = () => {
    const q = s[i++]; let out = '';
    while (i < s.length) {
      if (q === "'" && s[i] === "'" && s[i + 1] === "'") { out += "'"; i += 2; continue; }
      if (q === '"' && s[i] === '\\') { out += unescape(s[i + 1]); i += 2; continue; }
      if (s[i] === q) { i++; break; }
      out += s[i++];
    }
    return out;
  };
  const val = key => {
    ws();
    if (s[i] === '{') {
      i++; const o = {};
      for (;;) {
        ws(); if (s[i] === '}') { i++; return o; }
        let k = ''; if (s[i] === "'" || s[i] === '"') k = quoted(); else { while (i < s.length && s[i] !== ':' && s[i] !== '}') k += s[i++]; k = k.trim(); }
        ws(); if (s[i] === ':') i++;
        o[k] = val(k); ws();
        if (s[i] === ',') { i++; continue; }
        if (s[i] === '}') i++;
        return o;
      }
    }
    if (s[i] === '[') {
      i++; const a = [];
      for (;;) {
        ws(); if (s[i] === ']') { i++; return a; }
        a.push(val()); ws();
        if (s[i] === ',') { i++; continue; }
        if (s[i] === ']') i++;
        return a;
      }
    }
    if (s[i] === "'" || s[i] === '"') return quoted();
    let t = ''; while (i < s.length && !',}]'.includes(s[i])) t += s[i++];
    t = t.trim();
    return t === '' ? null : toScalar(t, key);
  };
  return val();
}
const unescape = c => ({ n: '\n', t: '\t', r: '\r', '0': '\0', '"': '"', '\\': '\\', '/': '/', ' ': ' ' }[c] ?? c);
const balance = s => { let d = 0, q = null; for (const c of s) { if (q) { if (c === q) q = null; } else if (c === "'" || c === '"') q = c; else if ('{['.includes(c)) d++; else if ('}]'.includes(c)) d--; } return d; };

class YamlParser {
  constructor(text) {
    this.l = [];
    for (const raw of text.split(/\r?\n/)) {
      const t = raw.trimStart();
      if (!t || t.startsWith('#') || t.startsWith('%') || t === '---') continue;
      this.l.push({ indent: raw.length - t.length, text: t.trimEnd() });
    }
    this.i = 0;
  }
  parse() { return this.l.length ? this.block() : null; }
  block() { const ln = this.l[this.i]; return isSeqItem(ln.text) ? this.seq(ln.indent) : this.map(ln.indent); }
  map(indent) {
    const o = {};
    while (this.i < this.l.length) {
      const ln = this.l[this.i];
      if (ln.indent !== indent || isSeqItem(ln.text)) break;
      const kv = splitKey(ln.text);
      this.i++;
      if (!kv) continue;
      o[kv.key] = kv.rest === '' ? this.nested(indent) : this.value(kv.rest, indent, kv.key);
    }
    return o;
  }
  nested(indent) {
    const nx = this.l[this.i];
    if (!nx) return null;
    if (nx.indent > indent) return this.block();
    if (nx.indent === indent && isSeqItem(nx.text)) return this.seq(indent);
    return null;
  }
  seq(indent) {
    const a = [];
    while (this.i < this.l.length) {
      const ln = this.l[this.i];
      if (ln.indent !== indent || !isSeqItem(ln.text)) break;
      const rest = ln.text === '-' ? '' : ln.text.slice(2).trimStart();
      if (rest === '') { this.i++; const nx = this.l[this.i]; a.push(nx && nx.indent > indent ? this.block() : null); continue; }
      if (splitKey(rest)) {
        const inner = indent + (ln.text.length - rest.length);
        this.l[this.i] = { indent: inner, text: rest };
        a.push(this.map(inner));
        continue;
      }
      this.i++;
      a.push(this.value(rest, indent));
    }
    return a;
  }
  more(indent) { const nx = this.l[this.i]; return nx && nx.indent > indent; }
  value(rest, indent, key) {
    if (rest[0] === '{' || rest[0] === '[') {
      let s = rest;
      while (balance(s) > 0 && this.i < this.l.length) s += ' ' + this.l[this.i++].text;
      return parseFlow(s);
    }
    if (rest[0] === "'" || rest[0] === '"') {
      let s = rest;
      const closed = x => rest[0] === "'" ? /^'(?:[^']|'')*'$/.test(x) : /^"(?:[^"\\]|\\.)*"$/.test(x);
      while (!closed(s) && this.i < this.l.length) {
        const nx = this.l[this.i++].text;
        s = rest[0] === '"' && /(^|[^\\])(\\\\)*\\$/.test(s) ? s.slice(0, -1) + nx : s + ' ' + nx;
      }
      return parseFlow(s);
    }
    if (rest === '|' || rest === '>' || /^[|>][-+]?$/.test(rest)) {
      const out = []; while (this.more(indent)) out.push(this.l[this.i++].text);
      return out.join(rest[0] === '|' ? '\n' : ' ');
    }
    let s = rest;
    while (this.more(indent)) s += ' ' + this.l[this.i++].text;
    return toScalar(s, key);
  }
}
export const parseYaml = text => new YamlParser(text).parse();

export function parseUnityYaml(text) {
  const re = /^--- !u!(-?\d+) &(-?\d+)( stripped)?.*$/gm;
  const marks = []; let m;
  while ((m = re.exec(text))) marks.push({ classId: Number(m[1]), fileId: m[2], stripped: !!m[3], start: m.index, bodyStart: re.lastIndex });
  if (!marks.length) {
    const body = parseYaml(text) ?? {};
    const className = Object.keys(body)[0];
    return className ? [{ classId: null, fileId: '0', stripped: false, className, body: body[className] ?? {} }] : [];
  }
  return marks.map((mk, k) => {
    const parsed = parseYaml(text.slice(mk.bodyStart, k + 1 < marks.length ? marks[k + 1].start : text.length)) ?? {};
    const className = Object.keys(parsed)[0] ?? CLASS[mk.classId] ?? `Class${mk.classId}`;
    return { ...mk, className, body: parsed[className] ?? {} };
  });
}

// ---------- GUID index ----------

export function buildGuidIndex(root) {
  const map = new Map();
  const walk = dir => {
    let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith('.meta')) {
        const head = fs.readFileSync(full, 'utf8').slice(0, 200).match(/^guid:\s*([0-9a-f]{32})/m);
        if (head) map.set(head[1], path.relative(root, full.slice(0, -5)).split(path.sep).join('/'));
      }
    }
  };
  for (const top of ['Assets', 'Packages']) walk(path.join(root, top));
  return map;
}

// ---------- compaction ----------

const round = v => (Number.isInteger(v) ? v : Math.round(v * 1e5) / 1e5);
const refId = r => (r && typeof r === 'object' && 'fileID' in r ? String(r.fileID) : null);
const isNullRef = r => refId(r) === '0' && !r.guid;

function curve(v, ctx) {
  return (v.m_Curve ?? []).map(k => [round(k.time), compact(k.value, ctx), compact(k.inSlope, ctx), compact(k.outSlope, ctx)]);
}
function gradient(v) {
  const nc = v.m_NumColorKeys ?? 2, na = v.m_NumAlphaKeys ?? 2;
  const colors = [], alphas = [];
  for (let k = 0; k < nc; k++) { const c = v[`key${k}`] ?? {}; colors.push([round((v[`ctime${k}`] ?? 0) / 65535), round(c.r), round(c.g), round(c.b)]); }
  for (let k = 0; k < na; k++) alphas.push([round((v[`atime${k}`] ?? 0) / 65535), round((v[`key${k}`] ?? {}).a)]);
  return { mode: ['blend', 'fixed', 'perceptual'][v.m_Mode] ?? v.m_Mode, colors, alphas };
}
function minMaxCurve(v, ctx) {
  switch (v.minMaxState) {
    case 0: return { const: round(v.scalar) };
    case 1: return { curve: curve(v.maxCurve ?? {}, ctx), mult: round(v.scalar) };
    case 2: return { minCurve: curve(v.minCurve ?? {}, ctx), maxCurve: curve(v.maxCurve ?? {}, ctx), mult: round(v.scalar) };
    case 3: return { min: round(v.minScalar), max: round(v.scalar) };
    default: return { raw: v.minMaxState };
  }
}
function minMaxGradient(v, ctx) {
  switch (v.minMaxState) {
    case 0: return { color: compact(v.maxColor, ctx) };
    case 1: return { gradient: gradient(v.maxGradient ?? {}) };
    case 2: return { min: compact(v.minColor, ctx), max: compact(v.maxColor, ctx) };
    case 3: return { min: gradient(v.minGradient ?? {}), max: gradient(v.maxGradient ?? {}) };
    case 4: return { randomColor: gradient(v.maxGradient ?? {}) };
    default: return { raw: v.minMaxState };
  }
}

export function compact(v, ctx) {
  if (Array.isArray(v)) {
    const lim = ctx.maxArray;
    const out = v.slice(0, lim).map(x => compact(x, ctx));
    if (v.length > lim) out.push(`…+${v.length - lim} more`);
    return out;
  }
  if (v && typeof v === 'object') {
    if ('fileID' in v) return ctx.ref(v);
    if ('minMaxState' in v && ('scalar' in v || 'minScalar' in v)) return minMaxCurve(v, ctx);
    if ('minMaxState' in v && ('maxColor' in v || 'maxGradient' in v)) return minMaxGradient(v, ctx);
    if ('key0' in v && 'ctime0' in v) return gradient(v);
    if (Array.isArray(v.m_Curve)) return curve(v, ctx);
    const out = {};
    for (const [k, x] of Object.entries(v)) if (!DROP.has(k)) out[k] = compact(x, ctx);
    return out;
  }
  if (typeof v === 'number') return round(v);
  if (typeof v === 'string' && v.length > ctx.maxString) return `${v.slice(0, ctx.maxString)}…(${v.length} chars)`;
  return v;
}

const pick = (body, keys, ctx) => {
  const o = {};
  for (const k of keys) if (body[k] !== undefined) o[k.replace(/^m_/, '').replace(/^[A-Z]/, c => c.toLowerCase())] = compact(body[k], ctx);
  return o;
};

function euler(q) {
  const { x, y, z, w } = q, deg = r => round((r * 180) / Math.PI);
  const sx = Math.max(-1, Math.min(1, 2 * (w * x - y * z)));
  return { x: deg(Math.asin(sx)), y: deg(Math.atan2(2 * (w * y + x * z), 1 - 2 * (x * x + y * y))), z: deg(Math.atan2(2 * (w * z + x * y), 1 - 2 * (x * x + z * z))) };
}
const same = (a, b) => a && Object.keys(b).every(k => Math.abs((a[k] ?? 0) - b[k]) < 1e-6);

function transformSummary(b, ctx) {
  const t = {};
  if (b.m_LocalPosition && !same(b.m_LocalPosition, { x: 0, y: 0, z: 0 })) t.p = compact(b.m_LocalPosition, ctx);
  if (b.m_LocalRotation && !same(b.m_LocalRotation, { x: 0, y: 0, z: 0, w: 1 })) { t.q = compact(b.m_LocalRotation, ctx); t.e = euler(b.m_LocalRotation); }
  if (b.m_LocalScale && !same(b.m_LocalScale, { x: 1, y: 1, z: 1 })) t.s = compact(b.m_LocalScale, ctx);
  if (b.m_AnchorMin) Object.assign(t, pick(b, ['m_AnchorMin', 'm_AnchorMax', 'm_AnchoredPosition', 'm_SizeDelta', 'm_Pivot'], ctx));
  return t;
}

// ---------- per-class summarizers ----------

const RENDER_MODE = ['billboard', 'stretched', 'horizontal', 'vertical', 'mesh', 'none'];
const SHAPE = ['sphere', 'sphereShell', 'hemisphere', 'hemisphereShell', 'cone', 'box', 'mesh', 'coneShell', 'coneVolume', 'coneVolumeShell',
  'circle', 'circleEdge', 'singleSidedEdge', 'meshRenderer', 'skinnedMeshRenderer', 'boxShell', 'boxEdge', 'donut', 'rectangle', 'sprite', 'spriteRenderer'];
const RENDERER_KEYS = ['m_Enabled', 'm_Materials', 'm_CastShadows', 'm_ReceiveShadows', 'm_SortingLayerID', 'm_SortingLayer', 'm_SortingOrder'];
const SUMMARIZE = {
  Camera: (b, c) => pick(b, ['m_ClearFlags', 'm_BackGroundColor', 'm_projectionMatrixMode', 'orthographic', 'orthographic size', 'field of view',
    'near clip plane', 'far clip plane', 'm_Depth', 'm_CullingMask', 'm_NormalizedViewPortRect', 'm_TargetTexture', 'm_Enabled'], c),
  Light: (b, c) => pick(b, ['m_Enabled', 'm_Type', 'm_Color', 'm_Intensity', 'm_Range', 'm_SpotAngle', 'm_InnerSpotAngle', 'm_Shadows',
    'm_CullingMask', 'm_RenderMode', 'm_Lightmapping', 'm_BounceIntensity', 'm_ColorTemperature', 'm_UseColorTemperature'], c),
  MeshFilter: (b, c) => pick(b, ['m_Mesh'], c),
  MeshRenderer: (b, c) => pick(b, RENDERER_KEYS, c),
  SkinnedMeshRenderer: (b, c) => ({ ...pick(b, [...RENDERER_KEYS, 'm_Mesh', 'm_RootBone', 'm_Quality', 'm_UpdateWhenOffscreen'], c), bones: (b.m_Bones ?? []).length }),
  SpriteRenderer: (b, c) => pick(b, [...RENDERER_KEYS, 'm_Sprite', 'm_Color', 'm_FlipX', 'm_FlipY', 'm_DrawMode', 'm_Size', 'm_MaskInteraction', 'm_SpriteSortPoint'], c),
  TrailRenderer: (b, c) => pick(b, [...RENDERER_KEYS, 'm_Time', 'm_MinVertexDistance', 'm_Autodestruct', 'm_Emitting', 'm_Parameters'], c),
  LineRenderer: (b, c) => pick(b, [...RENDERER_KEYS, 'm_Positions', 'm_Parameters', 'm_UseWorldSpace', 'm_Loop'], c),
  ParticleSystemRenderer: (b, c) => ({
    renderMode: RENDER_MODE[b.m_RenderMode] ?? b.m_RenderMode,
    ...pick(b, [...RENDERER_KEYS, 'm_SortMode', 'm_SortingFudge', 'm_MinParticleSize', 'm_MaxParticleSize', 'm_CameraVelocityScale',
      'm_VelocityScale', 'm_LengthScale', 'm_RenderAlignment', 'm_Pivot', 'm_Flip', 'm_UseCustomVertexStreams', 'm_VertexStreams',
      'm_Mesh', 'm_MaskInteraction', 'm_AllowRoll', 'm_FreeformStretching', 'm_RotateWithStretchDirection'], c),
  }),
  ParticleSystem: (b, c) => {
    const main = pick(b, ['lengthInSec', 'looping', 'prewarm', 'playOnAwake', 'simulationSpeed', 'useUnscaledTime', 'startDelay',
      'moveWithTransform', 'scalingMode', 'stopAction', 'cullingMode', 'ringBufferMode', 'autoRandomSeed', 'randomSeed'], c);
    main.initial = compact(b.InitialModule ?? {}, c);
    const modules = {};
    for (const k of PS_MODULES) if (b[k]?.enabled === 1) { const { enabled, ...rest } = b[k]; modules[k.replace(/Module$/, '')] = compact(rest, c); }
    if (modules.Shape) modules.Shape = { shape: SHAPE[b.ShapeModule.type] ?? b.ShapeModule.type, ...modules.Shape };
    return { main, modules };
  },
  Animator: (b, c) => pick(b, ['m_Enabled', 'm_Controller', 'm_Avatar', 'm_ApplyRootMotion', 'm_UpdateMode', 'm_CullingMode'], c),
  Animation: (b, c) => pick(b, ['m_Enabled', 'm_Animation', 'm_Animations', 'm_WrapMode', 'm_PlayAutomatically', 'm_AnimatePhysics', 'm_CullingType'], c),
  AudioSource: (b, c) => pick(b, ['m_Enabled', 'm_audioClip', 'm_PlayOnAwake', 'm_Volume', 'm_Pitch', 'Loop', 'Mute', 'Priority', 'DopplerLevel', 'MinDistance', 'MaxDistance'], c),
  Canvas: (b, c) => pick(b, ['m_Enabled', 'm_RenderMode', 'm_Camera', 'm_PlaneDistance', 'm_PixelPerfect', 'm_OverrideSorting', 'm_SortingLayerID', 'm_SortingOrder', 'm_TargetDisplay'], c),
  CanvasGroup: (b, c) => pick(b, ['m_Enabled', 'm_Alpha', 'm_Interactable', 'm_BlocksRaycasts', 'm_IgnoreParentGroups'], c),
  CanvasRenderer: () => null,
};
const MB_SKIP = new Set(['m_Enabled', 'm_Script', 'm_Name']);

// ---------- context ----------

function makeContext({ root, guids, docs, opts, names }) {
  const byId = new Map(docs.map(d => [d.fileId, d]));
  const ctx = { maxArray: opts.full ? Infinity : opts.maxArray ?? 24, maxString: opts.full ? Infinity : opts.maxString ?? 300, byId };
  ctx.assetPath = (guid, fileID) => {
    const p = guids.get(guid);
    if (!p) return `guid:${guid}${fileID ? `#${fileID}` : ''}`;
    return MAIN_FILE_IDS.has(Number(fileID)) ? p : `${p}#${fileID}`;
  };
  ctx.ref = r => {
    if (isNullRef(r)) return null;
    if (r.guid) {
      if (/^0{16}[ef]0{15}$/.test(r.guid)) return `builtin:${r.guid[16] === 'e' ? 'default' : 'extra'}#${r.fileID}`;
      return ctx.assetPath(r.guid, r.fileID);
    }
    const d = byId.get(String(r.fileID));
    if (!d) return `local:#${r.fileID}`;
    return `local:${names.label(d)}`;
  };
  ctx.scriptName = r => {
    if (!r?.guid) return null;
    const p = guids.get(r.guid);
    return p ? path.basename(p).replace(/\.cs$/, '') : `guid:${r.guid}`;
  };
  return ctx;
}

function summarizeComponent(d, ctx) {
  if (d.className === 'MonoBehaviour') {
    const script = ctx.scriptName(d.body.m_Script);
    const fields = {};
    for (const [k, v] of Object.entries(d.body)) if (!DROP.has(k) && !MB_SKIP.has(k)) fields[k] = compact(v, ctx);
    const out = { c: `MB:${script ?? '?'}`, id: d.fileId };
    if (d.body.m_Enabled === 0) out.enabled = false;
    if (d.body.m_Script?.guid) out.script = ctx.assetPath(d.body.m_Script.guid, d.body.m_Script.fileID);
    if (Object.keys(fields).length) out.fields = fields;
    else out.noFields = true;
    return out;
  }
  const fn = SUMMARIZE[d.className];
  const body = fn ? fn(d.body, ctx) : compact(Object.fromEntries(Object.entries(d.body).filter(([k]) => !DROP.has(k))), ctx);
  return body === null ? { c: d.className, id: d.fileId } : { c: d.className, id: d.fileId, ...body };
}

// ---------- hierarchy files (.prefab / .unity) ----------

function hierarchy(docs, ctx, names, opts) {
  const xforms = docs.filter(d => d.className === 'Transform' || d.className === 'RectTransform');
  const gos = new Map(docs.filter(d => d.className === 'GameObject').map(d => [d.fileId, d]));
  const pis = docs.filter(d => d.className === 'PrefabInstance');
  const childrenOf = new Map();
  const push = (k, v) => { if (!childrenOf.has(k)) childrenOf.set(k, []); childrenOf.get(k).push(v); };
  for (const x of xforms) if (!x.stripped) push(refId(x.body.m_Father) ?? '0', { kind: 'xf', id: x.fileId });
  const strippedByPi = new Map();
  for (const x of xforms) if (x.stripped) {
    const pi = refId(x.body.m_PrefabInstance);
    if (!strippedByPi.has(pi)) strippedByPi.set(pi, []);
    strippedByPi.get(pi).push(x.fileId);
  }
  for (const pi of pis) push(refId(pi.body.m_Modification?.m_TransformParent) ?? '0', { kind: 'pi', id: pi.fileId });
  const order = parentId => {
    const kids = childrenOf.get(parentId) ?? [];
    const listed = (ctx.byId.get(parentId)?.body.m_Children ?? []).map(refId);
    const rank = k => { const ids = k.kind === 'pi' ? strippedByPi.get(k.id) ?? [] : [k.id]; const r = Math.min(...ids.map(i => listed.indexOf(i)).filter(i => i >= 0)); return Number.isFinite(r) ? r : 1e9; };
    return [...kids].sort((a, b) => rank(a) - rank(b));
  };

  const build = (k, parentPath, depth) => {
    if (k.kind === 'pi') {
      const pi = ctx.byId.get(k.id);
      const mods = pi.body.m_Modification?.m_Modifications ?? [];
      const nameMod = mods.find(m => m.propertyPath === 'm_Name');
      const src = pi.body.m_SourcePrefab;
      const name = nameMod?.value ?? path.basename(ctx.assetPath(src?.guid, src?.fileID)).replace(/\.prefab.*$/, '');
      const p = parentPath ? `${parentPath}/${name}` : name;
      const node = { name, id: k.id, path: p, prefab: ctx.ref(src), overrides: compact(mods.map(m => ({ target: m.target, prop: m.propertyPath, value: m.value, ref: isNullRef(m.objectReference) ? undefined : m.objectReference })), ctx) };
      const removed = pi.body.m_Modification?.m_RemovedComponents ?? [];
      if (removed.length) node.removedComponents = compact(removed, ctx);
      const kids = (strippedByPi.get(k.id) ?? []).flatMap(order);
      if (kids.length) node.children = kids.map(c => build(c, p, depth + 1));
      return node;
    }
    const x = ctx.byId.get(k.id);
    const go = gos.get(refId(x.body.m_GameObject));
    const name = go?.body.m_Name ?? `#${k.id}`;
    const p = parentPath ? `${parentPath}/${name}` : name;
    const node = { name, id: go?.fileId ?? k.id, path: p };
    if (go?.body.m_IsActive === 0) node.active = false;
    if (go && go.body.m_Layer) node.layer = go.body.m_Layer;
    if (go && go.body.m_TagString && go.body.m_TagString !== 'Untagged') node.tag = go.body.m_TagString;
    const t = transformSummary(x.body, ctx);
    if (Object.keys(t).length) node[x.className === 'RectTransform' ? 'rect' : 'xf'] = t;
    const comps = (go?.body.m_Component ?? []).map(e => refId(Object.values(e ?? {})[0])).map(id => ctx.byId.get(id)).filter(d => d && d.fileId !== x.fileId);
    if (comps.length) node.components = comps.map(d => summarizeComponent(d, ctx));
    const kids = order(k.id);
    if (kids.length) node.children = kids.map(c => build(c, p, depth + 1));
    return node;
  };
  return order('0').map(k => build(k, '', 0));
}

function makeNames(docs) {
  const byId = new Map(docs.map(d => [d.fileId, d]));
  const paths = new Map();
  const goPath = goId => {
    if (paths.has(goId)) return paths.get(goId);
    const go = byId.get(goId);
    const xf = (go?.body.m_Component ?? []).map(e => byId.get(refId(Object.values(e ?? {})[0]))).find(d => d && /Transform$/.test(d.className));
    const father = xf && byId.get(refId(xf.body.m_Father));
    const parent = father ? goPath(refId(father.body.m_GameObject)) : '';
    const p = (parent ? `${parent}/` : '') + (go?.body.m_Name ?? `#${goId}`);
    paths.set(goId, p);
    return p;
  };
  return {
    label(d) {
      if (d.className === 'GameObject') return `GameObject:${goPath(d.fileId)}`;
      const go = refId(d.body.m_GameObject);
      if (go && go !== '0') return `${d.className}:${goPath(go)}`;
      return d.body.m_Name ? `${d.className}:${d.body.m_Name}` : `${d.className}#${d.fileId}`;
    },
  };
}

// ---------- asset files (.mat / .anim / .controller / .asset / .playable) ----------

function shaderName(root, p) {
  if (!p || !p.endsWith('.shader')) return null;
  try { return fs.readFileSync(path.join(root, p), 'utf8').slice(0, 400).match(/Shader\s+"([^"]+)"/)?.[1] ?? null; } catch { return null; }
}

export function summarizeMaterial(b, ctx, root) {
  const props = b.m_SavedProperties ?? {};
  const asMap = v => (Array.isArray(v) ? Object.assign({}, ...v.map(e => e ?? {})) : v ?? {});
  const tex = {};
  for (const [k, t] of Object.entries(asMap(props.m_TexEnvs))) {
    const r = ctx.ref(t?.m_Texture ?? { fileID: 0 });
    if (!r) continue;
    tex[k] = { tex: r };
    if (t.m_Scale && !same(t.m_Scale, { x: 1, y: 1 })) tex[k].scale = compact(t.m_Scale, ctx);
    if (t.m_Offset && !same(t.m_Offset, { x: 0, y: 0 })) tex[k].offset = compact(t.m_Offset, ctx);
  }
  const shader = ctx.ref(b.m_Shader ?? { fileID: 0 });
  const keywords = [...(b.m_ValidKeywords ?? []), ...(b.m_InvalidKeywords ?? []), ...String(b.m_ShaderKeywords ?? '').split(/\s+/).filter(Boolean)];
  return {
    name: b.m_Name, shader, shaderName: shaderName(root, shader), keywords: [...new Set(keywords)],
    renderQueue: b.m_CustomRenderQueue, tags: compact(b.stringTagMap ?? {}, ctx), textures: tex,
    floats: compact(asMap(props.m_Floats), ctx), ints: compact(asMap(props.m_Ints), ctx), colors: compact(asMap(props.m_Colors), ctx),
  };
}

const CURVE_GROUPS = [['m_RotationCurves', 'rotation'], ['m_CompressedRotationCurves', 'rotationCompressed'], ['m_EulerCurves', 'euler'],
  ['m_PositionCurves', 'position'], ['m_ScaleCurves', 'scale'], ['m_FloatCurves', 'float'], ['m_PPtrCurves', 'pptr']];
function summarizeClip(b, ctx) {
  const s = b.m_AnimationClipSettings ?? {};
  const curves = [];
  for (const [key, type] of CURVE_GROUPS) for (const c of b[key] ?? []) {
    const e = { type, path: c.path ?? '' };
    if (c.attribute) e.attribute = c.attribute;
    if (c.classID !== undefined) e.class = CLASS[c.classID] ?? c.classID;
    if (c.script && !isNullRef(c.script)) e.script = ctx.scriptName(c.script);
    e.keys = type === 'pptr' ? (c.curve ?? []).map(k => [round(k.time), ctx.ref(k.value)]) : curve(c.curve ?? {}, { ...ctx, maxArray: Infinity });
    curves.push(e);
  }
  return {
    name: b.m_Name, legacy: b.m_Legacy === 1, sampleRate: b.m_SampleRate, wrapMode: b.m_WrapMode,
    start: round(s.m_StartTime ?? 0), stop: round(s.m_StopTime ?? 0), lastKey: Math.max(0, ...curves.flatMap(c => c.keys.map(k => k[0]))),
    loop: s.m_LoopTime === 1, curves, events: compact(b.m_Events ?? [], ctx),
  };
}

const PARAM_TYPE = { 1: 'float', 3: 'int', 4: 'bool', 9: 'trigger' };
const COND = { 1: c => c.m_ConditionEvent, 2: c => `!${c.m_ConditionEvent}`, 3: c => `${c.m_ConditionEvent}>${c.m_EventTreshold}`,
  4: c => `${c.m_ConditionEvent}<${c.m_EventTreshold}`, 6: c => `${c.m_ConditionEvent}==${c.m_EventTreshold}`, 7: c => `${c.m_ConditionEvent}!=${c.m_EventTreshold}` };
function summarizeController(doc, ctx) {
  const get = r => ctx.byId.get(refId(r));
  const nameOf = r => get(r)?.body.m_Name ?? null;
  const motion = r => {
    const d = get(r);
    if (d?.className === 'BlendTree') return { blendTree: { name: d.body.m_Name, param: d.body.m_BlendParameter, paramY: d.body.m_BlendParameterY, type: d.body.m_BlendType,
      children: (d.body.m_Childs ?? []).map(ch => ({ motion: motion(ch.m_Motion), threshold: round(ch.m_Threshold ?? 0), timeScale: round(ch.m_TimeScale ?? 1) })) } };
    return ctx.ref(r ?? { fileID: 0 });
  };
  const transition = r => {
    const t = get(r)?.body ?? {};
    const out = { to: t.m_IsExit ? 'Exit' : nameOf(t.m_DstState) ?? nameOf(t.m_DstStateMachine), conditions: (t.m_Conditions ?? []).map(c => (COND[c.m_ConditionMode] ?? (x => `${x.m_ConditionEvent}?${x.m_ConditionMode}`))(c)),
      duration: round(t.m_TransitionDuration ?? 0), fixed: t.m_HasFixedDuration === 1 };
    if (t.m_HasExitTime) out.exitTime = round(t.m_ExitTime);
    if (t.m_TransitionOffset) out.offset = round(t.m_TransitionOffset);
    if (t.m_InterruptionSource) out.interruption = t.m_InterruptionSource;
    return out;
  };
  const machine = r => {
    const sm = get(r)?.body ?? {};
    return {
      name: sm.m_Name, defaultState: nameOf(sm.m_DefaultState),
      states: (sm.m_ChildStates ?? []).map(cs => {
        const st = get(cs.m_State)?.body ?? {};
        const o = { name: st.m_Name, motion: motion(st.m_Motion), speed: round(st.m_Speed ?? 1) };
        if (st.m_Tag) o.tag = st.m_Tag;
        if (st.m_SpeedParameterActive) o.speedParam = st.m_SpeedParameter;
        const tr = (st.m_Transitions ?? []).map(transition);
        if (tr.length) o.transitions = tr;
        return o;
      }),
      anyState: (sm.m_AnyStateTransitions ?? []).map(transition),
      entry: (sm.m_EntryTransitions ?? []).map(r2 => ({ to: nameOf(get(r2)?.body.m_DstState) })),
      subMachines: (sm.m_ChildStateMachines ?? []).map(c => machine(c.m_StateMachine)),
    };
  };
  const b = doc.body;
  return {
    name: b.m_Name,
    params: (b.m_AnimatorParameters ?? []).map(p => ({ name: p.m_Name, type: PARAM_TYPE[p.m_Type] ?? p.m_Type, default: p.m_Type === 1 ? p.m_DefaultFloat : p.m_Type === 3 ? p.m_DefaultInt : p.m_DefaultBool })),
    layers: (b.m_AnimatorLayers ?? []).map(l => ({ name: l.m_Name, weight: l.m_DefaultWeight, blending: l.m_BlendingMode === 1 ? 'additive' : 'override', mask: ctx.ref(l.m_Mask ?? { fileID: 0 }), ...machine(l.m_StateMachine) })),
  };
}

function assetDocs(docs, ctx, root) {
  const controllerParts = new Set(['AnimatorStateMachine', 'AnimatorState', 'AnimatorStateTransition', 'AnimatorTransition', 'BlendTree']);
  const hasController = docs.some(d => d.className === 'AnimatorController');
  return docs.filter(d => !(hasController && controllerParts.has(d.className))).map(d => {
    const head = { c: d.className === 'MonoBehaviour' ? `MB:${ctx.scriptName(d.body.m_Script) ?? '?'}` : d.className, id: d.fileId };
    if (d.className === 'Material') return { ...head, ...summarizeMaterial(d.body, ctx, root) };
    if (d.className === 'AnimationClip') return { ...head, ...summarizeClip(d.body, ctx) };
    if (d.className === 'AnimatorController') return { ...head, ...summarizeController(d, ctx) };
    return { ...head, ...compact(Object.fromEntries(Object.entries(d.body).filter(([k]) => !DROP.has(k) && k !== 'm_Script')), ctx) };
  });
}

// ---------- selection ----------

function selectNodes(tree, needle) {
  const hits = [];
  if (needle.startsWith('#')) {
    const w = n => { if (n.id === needle.slice(1)) hits.push(n); else (n.children ?? []).forEach(w); };
    tree.forEach(w);
    return hits;
  }
  const exact = n => n.path === needle;
  const walk = n => { if (exact(n) || (!tree.some(exact) && n.path.includes(needle))) { hits.push(n); return; } (n.children ?? []).forEach(walk); };
  const anyExact = n => exact(n) || (n.children ?? []).some(anyExact);
  if (tree.some(anyExact)) { const w = n => { if (exact(n)) hits.push(n); else (n.children ?? []).forEach(w); }; tree.forEach(w); return hits; }
  tree.forEach(walk);
  return hits;
}
const countDesc = n => (n.children ?? []).reduce((s, c) => s + 1 + countDesc(c), 0);
function clip(n, depth, max) {
  if (!n.children) return n;
  if (depth >= max) { const { children, ...rest } = n; return { ...rest, truncatedDescendants: countDesc(n) }; }
  return { ...n, children: n.children.map(c => clip(c, depth + 1, max)) };
}
const matchesOnly = (c, only) => only.some(o => c.c === o || c.c === `MB:${o}` || (o === 'MonoBehaviour' && c.c.startsWith('MB:')));
function flatten(tree, only) {
  const out = [];
  const walk = n => {
    for (const c of n.components ?? []) if (matchesOnly(c, only)) out.push({ node: n.path, nodeId: n.id, ...(n.active === false ? { active: false } : {}), ...c });
    if (only.includes('Transform') && (n.xf || n.rect)) out.push({ node: n.path, nodeId: n.id, c: n.rect ? 'RectTransform' : 'Transform', ...(n.rect ?? n.xf) });
    (n.children ?? []).forEach(walk);
  };
  tree.forEach(walk);
  return out;
}

// ---------- presentation index ----------

const INDEX_EXT = { prefab: 'prefabs', unity: 'scenes', anim: 'clips', controller: 'controllers', overrideController: 'controllers', mat: 'materials', playable: 'playables' };
const INDEX_SKIP = new Set(['GameObject', 'Transform', 'CanvasRenderer', 'MonoBehaviour']);
const top = (m, n) => Object.fromEntries(Object.entries(m).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, n));

// Where presentation lives: per directory (and per file with --under) counts of component classes and MonoBehaviour
// scripts, read from document headers only. Slice authors use it to point rip_study topics at source dirs.
export function presentationIndex(root, { under = 'Assets', depth = 5, files: withFiles = false, guids } = {}) {
  root = path.resolve(root);
  guids ??= buildGuidIndex(root);
  const dirs = {}, fileRows = [];
  const walk = dir => {
    let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { walk(full); continue; }
      const kind = INDEX_EXT[path.extname(e.name).slice(1)];
      if (!kind) continue;
      const rel = path.relative(root, full).split(path.sep).join('/');
      const key = path.posix.dirname(rel).split('/').slice(0, depth).join('/');
      const d = dirs[key] ??= { prefabs: 0, scenes: 0, clips: 0, controllers: 0, materials: 0, playables: 0, classes: {}, scripts: {} };
      d[kind]++;
      if (kind !== 'prefabs' && kind !== 'scenes') continue;
      const text = fs.readFileSync(full, 'utf8');
      const classes = {}, scripts = {};
      for (const m of text.matchAll(/^--- !u!\d+ &\S+.*\n(\w+):/gm)) if (!INDEX_SKIP.has(m[1])) classes[m[1]] = (classes[m[1]] ?? 0) + 1;
      for (const m of text.matchAll(/^  m_Script: \{fileID: -?\d+, guid: ([0-9a-f]{32})/gm)) {
        const name = guids.has(m[1]) ? path.basename(guids.get(m[1])).replace(/\.cs$/, '') : `guid:${m[1]}`;
        scripts[name] = (scripts[name] ?? 0) + 1;
      }
      for (const [k, v] of Object.entries(classes)) d.classes[k] = (d.classes[k] ?? 0) + v;
      for (const [k, v] of Object.entries(scripts)) d.scripts[k] = (d.scripts[k] ?? 0) + v;
      if (withFiles) fileRows.push({ path: rel, bytes: Buffer.byteLength(text), classes: top(classes, 40), scripts: top(scripts, 12) });
    }
  };
  walk(path.join(root, under));
  const weight = d => d.prefabs + d.scenes + d.clips + d.controllers;
  const out = {
    under, depth,
    dirs: Object.fromEntries(Object.entries(dirs).sort((a, b) => weight(b[1]) - weight(a[1]) || a[0].localeCompare(b[0]))
      .map(([k, d]) => [k, { ...d, classes: top(d.classes, 40), scripts: top(d.scripts, 15) }])),
  };
  if (withFiles) out.files = fileRows.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}

// ---------- entry ----------

export const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex');
// Per-process: one CLI call extracts one file; long-lived callers passing a changed tree use opts.guids.
const guidCache = new Map();

export function extractUnity(opts) {
  const root = path.resolve(opts.root);
  const abs = path.isAbsolute(opts.file) ? opts.file : path.join(root, opts.file);
  const rel = path.relative(root, abs).split(path.sep).join('/');
  if (rel.startsWith('..')) throw new Error(`--file must be inside --root: ${opts.file}`);
  const buf = fs.readFileSync(abs);
  const docs = parseUnityYaml(buf.toString('utf8'));
  if (!guidCache.has(root)) guidCache.set(root, opts.guids ?? buildGuidIndex(root));
  const guids = guidCache.get(root);
  const names = makeNames(docs);
  const ctx = makeContext({ root, guids, docs, opts, names });
  const classes = {};
  for (const d of docs) classes[d.className] = (classes[d.className] ?? 0) + 1;
  const result = {
    tool: 'extract-unity', toolVersion: TOOL_VERSION, root, file: rel, fileSha256: sha256(buf),
    args: Object.fromEntries(Object.entries({ only: opts.only, node: opts.node, maxDepth: opts.maxDepth, full: opts.full || undefined, summary: opts.summary || undefined }).filter(([, v]) => v !== undefined)),
    classes, legend: LEGEND,
  };
  const isHierarchy = docs.some(d => d.className === 'GameObject' || d.className === 'PrefabInstance');
  if (isHierarchy) {
    let tree = hierarchy(docs, ctx, names, opts);
    const settings = docs.find(d => d.className === 'RenderSettings');
    if (settings) result.renderSettings = compact(Object.fromEntries(Object.entries(settings.body).filter(([k]) => !DROP.has(k))), ctx);
    if (opts.node) { tree = selectNodes(tree, opts.node); if (!tree.length) throw new Error(`--node matched nothing: ${opts.node}`); }
    if (opts.only?.length) result.components = flatten(tree, opts.only);
    else result.tree = opts.maxDepth !== undefined ? tree.map(n => clip(n, 0, opts.maxDepth)) : tree;
  } else {
    result.docs = assetDocs(docs, ctx, root);
    if (opts.only?.length) result.docs = result.docs.filter(d => matchesOnly(d, opts.only));
  }
  const used = new Set();
  const scan = v => { if (typeof v === 'string') { if (v.endsWith('.mat')) used.add(v); } else if (v && typeof v === 'object') Object.values(v).forEach(scan); };
  scan([result.tree, result.components, result.docs]);
  if (opts.materials !== false && used.size) {
    result.materials = {};
    for (const m of [...used].sort()) {
      try {
        const mbuf = fs.readFileSync(path.join(root, m)), mdocs = parseUnityYaml(mbuf.toString('utf8'));
        const md = mdocs.find(d => d.className === 'Material');
        const mctx = makeContext({ root, guids, docs: mdocs, opts, names: makeNames(mdocs) });
        // sha256 lets a slice study cite the .mat through this extract.
        result.materials[m] = md ? { sha256: sha256(mbuf), ...summarizeMaterial(md.body, mctx, root) } : { error: 'no Material doc' };
      } catch (e) { result.materials[m] = { error: e.code ?? e.message }; }
    }
  }
  return result;
}

// Pretty JSON that keeps short objects/arrays (vectors, colors, curve keys) on one line.
export function stringify(v, indent = '') {
  const flat = JSON.stringify(v);
  if (flat === undefined || flat.length <= 100 || v === null || typeof v !== 'object') return flat;
  const pad = `${indent} `;
  if (Array.isArray(v)) return `[\n${v.map(x => pad + (stringify(x, pad) ?? 'null')).join(',\n')}\n${indent}]`;
  const entries = Object.entries(v).filter(([, x]) => x !== undefined);
  return `{\n${entries.map(([k, x]) => `${pad}${JSON.stringify(k)}: ${stringify(x, pad)}`).join(',\n')}\n${indent}}`;
}

export function renderSummary(result) {
  const lines = [`# ${result.file}  sha256=${result.fileSha256.slice(0, 12)}  ${Object.entries(result.classes).map(([k, v]) => `${k}:${v}`).join(' ')}`];
  const walk = (n, d) => {
    const comps = (n.components ?? []).map(c => c.c).join(', ');
    lines.push(`${'  '.repeat(d)}${n.name}${n.prefab ? ` <prefab ${n.prefab}>` : ''}${n.active === false ? ' (inactive)' : ''} #${n.id}${comps ? `  [${comps}]` : ''}${n.truncatedDescendants ? `  …${n.truncatedDescendants} more` : ''}`);
    (n.children ?? []).forEach(c => walk(c, d + 1));
  };
  (result.tree ?? []).forEach(n => walk(n, 0));
  for (const d of result.docs ?? []) lines.push(`${d.c} #${d.id} ${d.name ?? ''}`);
  for (const c of result.components ?? []) lines.push(`${c.node} #${c.nodeId}  ${c.c}`);
  return lines.join('\n');
}

function parseArgs(argv) {
  const o = { materials: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], next = () => argv[++i];
    if (a === '--root') o.root = next();
    else if (a === '--file') o.file = next();
    else if (a === '--only') o.only = next().split(',').map(s => s.trim()).filter(Boolean);
    else if (a === '--node') o.node = next();
    else if (a === '--max-depth') o.maxDepth = Number(next());
    else if (a === '--max-array') o.maxArray = Number(next());
    else if (a === '--max-string') o.maxString = Number(next());
    else if (a === '--full') o.full = true;
    else if (a === '--summary') o.summary = true;
    else if (a === '--no-materials') o.materials = false;
    else if (a === '--out') o.out = next();
    else if (a === '--index') o.index = true;
    else if (a === '--under') o.under = next();
    else if (a === '--depth') o.depth = Number(next());
    else throw new Error(`unknown argument ${a}`);
  }
  if (!o.root || (!o.file && !o.index)) throw new Error([
    'usage: extract-unity.mjs --root <ExportedProject> --file <asset> [--summary] [--only A,B] [--node <path|#id>] [--max-depth N] [--max-array N] [--full] [--no-materials] [--out <json>]',
    '       extract-unity.mjs --root <ExportedProject> --index [--under <dir>] [--depth N] [--out <json>]   (--under adds per-file rows)'].join('\n'));
  return o;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const o = parseArgs(process.argv.slice(2));
    const result = o.index
      ? { tool: 'extract-unity', toolVersion: TOOL_VERSION, root: path.resolve(o.root), index: presentationIndex(o.root, { under: o.under, depth: o.depth, files: !!o.under }) }
      : extractUnity(o);
    const text = o.summary && !o.index ? renderSummary(result) : stringify(result);
    if (o.out) {
      fs.mkdirSync(path.dirname(path.resolve(o.out)), { recursive: true });
      fs.writeFileSync(o.out, `${text}\n`);
      console.log(JSON.stringify({ out: o.out, bytes: Buffer.byteLength(text) + 1, sha256: sha256(`${text}\n`), ...(result.file ? { source: result.file, sourceSha256: result.fileSha256 } : {}) }));
    } else console.log(text);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
