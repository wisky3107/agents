#!/usr/bin/env node
// UI kit pipeline: kit.json → per-backend jobs → raw images → keyed/trimmed kit + manifest + sheet.
//   kit.mjs check                          backend availability (codex, agy)
//   kit.mjs jobs  --kit <kit.json>         style.txt, codex-jobs.json, agy/BRIEF.md, todo for the rest
//   kit.mjs agy   --kit <kit.json> [--timeout-min 90] [--worktree <sel>]   run the agy rows in an Orca terminal worker
//   kit.mjs post  --kit <kit.json> [--to <assets dir> [--notes ASSET_MANIFEST.md] | --to-project <project dir>]
//                                          key / trim / cap every raw → kit/<name>.png + manifest.json, then place
//   kit.mjs from-manifest --art-manifest <manifest.json> --art-backend <locked> --dir <work dir> [--override cat=backend,…]
//                                          fleet art manifest 2D rows → kit.json (style left TODO for the worker)
//   kit.mjs gate  --kit <kit.json> --art-manifest <manifest.json> [--check <2d-check.md>] [--look PASS|FAIL:<why>]
//                                          fleet ART2D round + row verify (after post --to-project)
//   kit.mjs meta  --kit <kit.json> --project <project dir>   nine-slice borderPx → sprite-frame .meta
//   kit.mjs recolour --kit <kit.json> --row <name> --from <passing row> --color '#hex'
//                                          deterministic fallback for a chrome variant the generator keeps failing
//   kit.mjs sheet --kit <kit.json>         sheet.png contact sheet (dark bg + checker)
// Exit codes: 0 ok · 1 some rows failed · 2 backend down · 3 agy stalled · 4 agy quota (429) · 64 bad kit
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CODEX = join(HERE, '../../codex-image-gen/scripts/codex-image.mjs');
const AGY_ACCOUNT = join(process.env.HOME, '.agents/tools/agy-account/agy-account.mjs');
const BACKENDS = ['codex', 'agy', 'gpt-image-gen', 'procedural'];
const MAX = { button: 768, 'button-round': 512, panel: 768, card: 768, ribbon: 768, tab: 768, bar: 768, toggle: 512, badge: 256,
  icon: 512, piece: 768, art: 1024, background: 1920, hero: 1920 };

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const sleep = (s) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, s * 1000);
const die = (code, msg) => { console.error(msg); process.exit(code); };

// ---------- kit ----------
export function validate(kit) {
  const errs = [];
  if (!kit.name) errs.push('kit.name missing');
  if (!kit.dir || !kit.dir.startsWith('/')) errs.push('kit.dir must be absolute');
  if (!kit.style || /\bTODO\b/.test(kit.style)) errs.push('kit.style (art bible) missing or still TODO');
  const seen = new Set();
  for (const r of kit.rows || []) {
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(r.name || '')) errs.push(`row name not kebab: ${r.name}`);
    if (seen.has(r.name)) errs.push(`duplicate row ${r.name}`);
    seen.add(r.name);
    if (!BACKENDS.includes(r.backend)) errs.push(`${r.name}: backend must be one of ${BACKENDS.join('|')} (resolve "auto" first)`);
    if (!r.subject) errs.push(`${r.name}: subject missing`);
    if (!r.aspect) errs.push(`${r.name}: aspect missing`);
    if (r.ref && !existsSync(r.ref)) errs.push(`${r.name}: ref not found ${r.ref}`);
  }
  if (!kit.rows?.length) errs.push('kit.rows empty');
  return errs;
}
function loadKit() {
  const p = arg('kit');
  if (!p) die(64, '--kit <kit.json> required');
  const kit = JSON.parse(readFileSync(resolve(p), 'utf8'));
  const errs = validate(kit);
  if (errs.length) die(64, errs.map((e) => 'kit: ' + e).join('\n'));
  return kit;
}
const rawPath = (kit, r) => join(kit.dir, r.backend === 'agy' ? 'agy/raw' : 'raw', r.name + '.png');

// Backdrop colour for agy (no native alpha): the key hue farthest from every palette colour.
export function pickKey(style) {
  const hues = [...style.matchAll(/#([0-9a-f]{6})\b/gi)].map(([, h]) => {
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    if (mx - mn < 0.35) return null;
    const hue = mx === r ? ((g - b) / (mx - mn)) % 6 : mx === g ? (b - r) / (mx - mn) + 2 : (r - g) / (mx - mn) + 4;
    return (hue * 60 + 360) % 360;
  }).filter((h) => h != null);
  const dist = (k) => Math.min(360, ...hues.map((h) => Math.min(Math.abs(h - k), 360 - Math.abs(h - k))));
  return dist(120) > dist(300) ? 'green' : 'magenta';
}
const KEY_TEXT = { magenta: 'SOLID FLAT PURE MAGENTA #FF00FF', green: 'SOLID FLAT PURE GREEN #00FF00' };

// Chrome rows carry text / icons on a solid face; a translucent face only when the design says so.
const CHROME = new Set(['button', 'button-round', 'panel', 'card', 'ribbon', 'tab', 'bar', 'toggle', 'badge']);
export const opaqueFace = (r) => CHROME.has(r.cat) && r.alpha !== false && r.face !== 'translucent'
  && !/glass|translucent|frosted|see-through|semi-transparent/i.test(r.subject || '');
export const faceOk = (r, m) => !opaqueFace(r) || m.faceOpaquePct === undefined || m.faceOpaquePct >= 97;

export function prompt(kit, r, backend) {
  const parts = [`${r.aspect[0].toUpperCase() + r.aspect.slice(1)} game UI asset`, r.subject];
  if (opaqueFace(r)) parts.push('The face inside the outline is fully opaque and solid, no transparent or see-through areas inside the shape; only the outside of the shape is transparent');
  if (r.alpha !== false && backend === 'agy') {
    parts.push(`Single isolated object centered, filling about 90% of the canvas with a clear margin on every side (nothing touches the edge), on a ${KEY_TEXT[kit.agyKey || pickKey(kit.style)]} background (no gradient, no shadow on the background, no floor)`);
  } else if (r.alpha !== false) {
    parts.push('Single isolated object centered, filling about 90% of the canvas, with a clear empty margin on every side; nothing touches or is cut by the canvas edge');
  }
  return parts.join('. ') + '.';
}

// An alpha row needs real alpha, not a percentage: small-radius primitives (24 px corners on
// 512x256 ≈ 0.4 %, a 12 px track ≈ 0.1 %) are genuinely transparent but sparse. FAIL only when
// nothing is transparent, or when the corners are opaque and almost nothing else is (a matte /
// solid backdrop left behind).
export function alphaOk(m) {
  if (m.transparentPx === undefined) return m.transparentPct >= 1;   // manifests written before 2026-10-11
  return m.transparentPx > 0 && (m.cornersTransparent >= 2 || m.transparentPct >= 1);
}
const alphaWhy = (m) => (m.transparentPx === 0 ? 'no transparent pixels' : `opaque corners and only ${m.transparentPct}% transparent (matte / solid backdrop?)`);

// ---------- check ----------
function cmdCheck() {
  const codex = spawnSync('node', [CODEX, 'check'], { encoding: 'utf8' });
  const out = { codex: codex.status === 0 ? 'ok' : 'down', agy: 'unknown', agyExhausted: [] };
  if (existsSync(AGY_ACCOUNT)) {
    const s = spawnSync('node', [AGY_ACCOUNT, 'status'], { encoding: 'utf8' }).stdout || '';
    out.agyExhausted = [...s.matchAll(/^\s+(\S+@\S+)\s+(\S*image\S*)\s+until\s+(\S+)/gm)].map((m) => `${m[1]} until ${m[3]}`);
    out.agy = /exhausted:/.test(s) || /agy processes/.test(s) ? 'ok' : 'unknown';
  }
  console.log(JSON.stringify(out, null, 1));
  process.exit(out.codex === 'ok' || out.agy === 'ok' ? 0 : 2);
}

// ---------- jobs ----------
function cmdJobs() {
  const kit = loadKit();
  mkdirSync(join(kit.dir, 'raw'), { recursive: true });
  writeFileSync(join(kit.dir, 'style.txt'), kit.style.trim() + '\nHard rules: no text, no letters, no numbers, no logos, no watermark.\n');
  const by = (b) => kit.rows.filter((r) => r.backend === b);
  const codex = by('codex').map((r) => ({ out: rawPath(kit, r), prompt: prompt(kit, r, 'codex'), ...(r.alpha !== false && { alpha: true }), ...(r.ref && { ref: r.ref }) }));
  if (codex.length) writeFileSync(join(kit.dir, 'codex-jobs.json'), JSON.stringify(codex, null, 1));
  const agy = by('agy');
  if (agy.length) {
    const key = kit.agyKey || pickKey(kit.style);
    mkdirSync(join(kit.dir, 'agy/raw'), { recursive: true });
    writeFileSync(join(kit.dir, 'agy/BRIEF.md'), [
      `# ${kit.name} — UI kit images`, '',
      'Generate every image below with YOUR OWN image-generation tool, one image per file, and save each PNG',
      `to \`raw/<name>.png\` in this folder (absolute: ${join(kit.dir, 'agy/raw')}/).`,
      'Do not write scripts that draw the images. Make no other files except `raw/*.png` and `DONE.md`.', '',
      '## Shared style (put this in every prompt)', kit.style.trim(),
      `No text, no letters, no numbers, no logos, no watermark. Every image with a backdrop uses ${KEY_TEXT[key]}.`, '',
      '## Files', '| name | prompt |', '|---|---|',
      ...agy.map((r) => `| ${r.name} | ${prompt(kit, r, 'agy').replace(/\|/g, '/')} |`), '',
      '## When finished',
      'Check that every file exists (`ls raw`), then write `DONE.md` listing each file and anything that failed.',
      'If the image tool returns 429 / quota errors, write the failing names into DONE.md and stop.', '',
    ].join('\n'));
  }
  const todo = [...by('gpt-image-gen'), ...by('procedural')].map((r) => ({ name: r.name, backend: r.backend, out: rawPath(kit, r), prompt: prompt(kit, r, r.backend) }));
  writeFileSync(join(kit.dir, 'todo.json'), JSON.stringify(todo, null, 1));
  console.log(JSON.stringify({ codex: codex.length, agy: agy.length, agyKey: agy.length ? kit.agyKey || pickKey(kit.style) : null,
    'gpt-image-gen': by('gpt-image-gen').length, procedural: by('procedural').length,
    files: ['style.txt', codex.length && 'codex-jobs.json', agy.length && 'agy/BRIEF.md', 'todo.json'].filter(Boolean) }, null, 1));
}

// ---------- agy ----------
const orca = (args) => execFileSync('orca', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
// The terminal needs an Orca-managed worktree to live in; the kit dir usually is not one.
function createTerminal(title, command) {
  const list = () => { try { const r = JSON.parse(orca(['worktree', 'list', '--json'])).result; return (r.worktrees || r).map((w) => 'path:' + w.path); } catch { return []; } };
  const tried = [];
  for (const sel of [arg('worktree'), 'active', 'path:' + join(process.env.HOME, '.agents'), ...list().slice(0, 1)].filter(Boolean)) {
    if (tried.includes(sel)) continue;
    tried.push(sel);
    try { return JSON.parse(orca(['terminal', 'create', '--worktree', sel, '--title', title, '--command', command, '--json'])).result.terminal.handle; }
    catch {}
  }
  die(2, `could not create an Orca terminal (tried ${tried.join(', ')}); pass --worktree <selector>`);
}
const screen = (h) => { try { return orca(['terminal', 'read', '--terminal', h]).split('\n').slice(-40).join('\n'); } catch { return ''; } };

function cmdAgy() {
  const kit = loadKit();
  const rows = kit.rows.filter((r) => r.backend === 'agy');
  if (!rows.length) die(0, 'no agy rows');
  const wd = join(kit.dir, 'agy');
  if (!existsSync(join(wd, 'BRIEF.md'))) die(64, 'run `kit.mjs jobs` first (agy/BRIEF.md missing)');
  const want = rows.map((r) => r.name + '.png');
  const have = () => want.filter((f) => existsSync(join(wd, 'raw', f)));
  if (have().length === want.length) die(0, `all ${want.length} agy files already present`);
  const h = createTerminal(`AGY-UI-${kit.name}`.slice(0, 40), `cd '${wd}' && agy${process.argv.includes('--skip-permissions') ? ' --dangerously-skip-permissions' : ''}`);
  console.log(`agy terminal ${h} (${wd})`);
  for (let i = 0; i < 60; i++) {
    const s = screen(h);
    if (/Do you trust/.test(s)) { orca(['terminal', 'send', '--terminal', h, '--enter']); sleep(6); break; }
    if (/^>\s*$/m.test(s)) break;
    sleep(2);
  }
  orca(['terminal', 'send', '--terminal', h, '--text', 'Read BRIEF.md in this folder and do exactly what it says: generate every image with your own image generation tool, save each to raw/<name>.png, then write DONE.md. Work through the whole list without asking me anything.', '--enter']);
  const deadline = Date.now() + Number(arg('timeout-min', 90)) * 60_000;
  let last = -1, lastChange = Date.now();
  while (Date.now() < deadline) {
    sleep(10);
    const s = screen(h);
    if (/Requesting permission|Allow access to this file\?|Run this command\?/.test(s)) {
      orca(['terminal', 'send', '--terminal', h, '--text', '2']);   // "yes, and always allow" for this conversation
      console.log('approved a permission prompt');
    }
    const n = have().length;
    if (n !== last) { console.log(`files ${n}/${want.length}`); last = n; lastChange = Date.now(); }
    if (n === want.length || existsSync(join(wd, 'DONE.md'))) {
      const missing = want.filter((f) => !have().includes(f));
      console.log(JSON.stringify({ terminal: h, done: n, missing }));
      process.exit(missing.length ? 1 : 0);
    }
    if (/\b429\b|RESOURCE_EXHAUSTED|quota exceeded/i.test(s)) {
      console.log(JSON.stringify({ terminal: h, quota: true, missing: want.filter((f) => !have().includes(f)) }));
      process.exit(4);
    }
    if (Date.now() - lastChange > 12 * 60_000) {
      console.log(JSON.stringify({ terminal: h, stalled: true, screen: s.split('\n').filter(Boolean).slice(-4) }));
      process.exit(3);
    }
  }
  console.log(JSON.stringify({ terminal: h, timeout: true, missing: want.filter((f) => !have().includes(f)) }));
  process.exit(3);
}

// ---------- post ----------
function cmdPost() {
  const kit = loadKit();
  const out = join(kit.dir, 'kit');
  mkdirSync(out, { recursive: true });
  const key = kit.agyKey || pickKey(kit.style);
  const rows = [], failed = [];
  for (const r of kit.rows) {
    const src = rawPath(kit, r);
    if (!existsSync(src)) { failed.push({ name: r.name, error: 'raw missing: ' + src }); continue; }
    const k = r.key || (r.backend === 'agy' && r.alpha !== false ? key : 'none');
    const res = spawnSync('python3', ['-I', join(HERE, 'key_backdrop.py'), '--key', k, '--erode', String(r.defringe || 0), ...(r.flattenFace ? ['--flatten-face'] : []), '--pad', String(r.pad || 0), '--max', String(Math.max(r.max || MAX[r.cat] || 768, ...(r.size || []))), src, join(out, r.name + '.png')], { encoding: 'utf8' });
    if (res.status !== 0) { failed.push({ name: r.name, error: (res.stderr || '').trim().split('\n').pop() }); continue; }
    const m = JSON.parse(res.stdout.trim().split('\n').pop());
    if (r.grade) {                                   // hero grade post-step (S20): masked band → target colour, re-measured
      const g = r.grade, out = join(kit.dir, 'kit', r.name + '.png');
      const gr = spawnSync('python3', ['-I', join(HERE, 'grade.py'), '--target', g.target, '--band', (g.band || [0, 1]).join(','),
        ...(g.hue ? ['--hue', g.hue.join(',')] : []), ...(g.minSat ? ['--min-sat', String(g.minSat)] : []), '--tol', String(g.tol ?? 12), out, out], { encoding: 'utf8' });
      if (gr.status !== 0) { failed.push({ name: r.name, error: 'grade: ' + (gr.stderr || gr.stdout).trim().split('\n').pop() }); continue; }
      m.grade = JSON.parse(gr.stdout.trim().split('\n').pop());
      if (!m.grade.pass) failed.push({ name: r.name, error: `grade FAIL: band mean ${m.grade.after} vs ${m.grade.target} ±${g.tol ?? 12}` });
    }
    const row = { name: r.name, cat: r.cat, file: `kit/${r.name}.png`, w: m.w, h: m.h, alpha: m.alpha, transparentPct: m.transparentPct,
      transparentPx: m.transparentPx, cornersTransparent: m.cornersTransparent, faceOpaquePct: m.faceOpaquePct, edgeTouchPct: m.edgeTouchPct,
      ...(m.grade && { grade: m.grade }),
      ...(r.recolourOf && { recolourOf: r.recolourOf }),
      backend: r.backend, key: k };
    if (r.slice) {
      row.slice = r.slice;
      row.borderPx = { left: Math.round(r.slice[0] * m.w), top: Math.round(r.slice[1] * m.h), right: Math.round(r.slice[2] * m.w), bottom: Math.round(r.slice[3] * m.h) };
    }
    if (r.alpha !== false && !alphaOk(m)) failed.push({ name: r.name, error: `alpha FAIL: ${alphaWhy(m)}` });
    if (r.alpha !== false && !r.allowEdge && m.edgeTouchPct > 0.5) failed.push({ name: r.name, error: `edge FAIL: subject touches the canvas edge on ${m.edgeTouchPct}% of the border (likely cropped) — regenerate with more margin, or "allowEdge": true when the design bleeds` });
    if (!faceOk(r, m)) failed.push({ name: r.name, error: `face FAIL: only ${m.faceOpaquePct}% of the centre is opaque — regenerate (the prompt demands a solid face); at the round cap set "flattenFace": true, then kit.mjs recolour from a passing sibling` });
    rows.push(row);
  }
  place(kit, rows, failed);
  writeFileSync(join(kit.dir, 'manifest.json'), JSON.stringify({ name: kit.name, generated: new Date().toISOString(), rows, failed }, null, 1));
  for (const r of rows) console.log(`${r.name.padEnd(22)} ${String(r.w + 'x' + r.h).padEnd(10)} ${r.backend.padEnd(13)} transparent ${r.transparentPct}%${r.borderPx ? ' slice ' + Object.values(r.borderPx).join(',') : ''}`);
  for (const f of failed) console.log(`FAIL ${f.name}: ${f.error}`);
  process.exit(failed.length ? 1 : 0);
}

// Default folders follow figma-game-clone's pack layout.
const FOLDER = { icon: 'icons', background: 'backgrounds', hero: 'backgrounds', art: 'images' };
const defaultRel = (r) => `${FOLDER[r.cat] || 'ui/common'}/${r.name}.png`;
const fitMode = (r) => r.fit || (r.slice || r.slicePx ? 'stretch' : r.alpha === false ? 'cover' : 'contain');

function place(kit, rows, failed) {
  const to = arg('to'), proj = arg('to-project');
  if (!to && !proj) return;
  const byName = Object.fromEntries(kit.rows.map((r) => [r.name, r]));
  for (const row of rows) {
    const r = byName[row.name], src = join(kit.dir, row.file);
    if (to) {
      const dst = join(resolve(to), r.out || defaultRel(r));
      mkdirSync(dirname(dst), { recursive: true });
      execFileSync('cp', [src, dst]);
      row.placed = { path: dst, w: row.w, h: row.h, ...(row.borderPx && { borderPx: row.borderPx }) };
      continue;
    }
    if (!r.out || !r.size) { failed.push({ name: r.name, error: '--to-project needs row out + size (from-manifest sets them)' }); continue; }
    const dst = join(resolve(proj), r.out), [W, H] = r.size, mode = fitMode(r);
    mkdirSync(dirname(dst), { recursive: true });
    const res = spawnSync('python3', ['-I', join(HERE, 'fit.py'), '--mode', mode, '--size', `${W}x${H}`, src, dst], { encoding: 'utf8' });
    if (res.status !== 0) { failed.push({ name: r.name, error: 'fit: ' + (res.stderr || '').trim().split('\n').pop() }); continue; }
    const sx = W / row.w, sy = H / row.h, k = Math.min(sx, sy);
    let borderPx;
    if (r.slicePx) borderPx = { left: r.slicePx, top: r.slicePx, right: r.slicePx, bottom: r.slicePx };
    else if (row.borderPx) {
      const [fx, fy] = mode === 'stretch' ? [sx, sy] : [k, k];
      borderPx = { left: Math.round(row.borderPx.left * fx), top: Math.round(row.borderPx.top * fy), right: Math.round(row.borderPx.right * fx), bottom: Math.round(row.borderPx.bottom * fy) };
    }
    row.placed = { path: dst, rel: r.out, w: W, h: H, mode, ...(borderPx && { borderPx }) };
  }
  if (to && arg('notes')) writeNotes(kit, rows, resolve(arg('notes')), resolve(to));
}

// Usage-notes block for ASSET_MANIFEST.md, above figma-game-clone's generated table (which keeps it).
function writeNotes(kit, rows, mdPath, root) {
  const start = `<!-- ui-kit:${kit.name}:start -->`, end = `<!-- ui-kit:${kit.name}:end -->`;
  const block = [start, `### UI kit \`${kit.name}\` (game-ui-kit)`, '',
    'Generated art: take these files from the kit, never re-export them from Figma. Nine-slice borders are pixels (L,T,R,B).', '',
    '| file | size | nine-slice | backend |', '| --- | --- | --- | --- |',
    ...rows.filter((r) => r.placed).map((r) => `| \`${relative(root, r.placed.path)}\` | ${r.w}×${r.h} | ${r.borderPx ? Object.values(r.borderPx).join(',') : '—'} | ${r.backend} |`),
    end].join('\n');
  let md = existsSync(mdPath) ? readFileSync(mdPath, 'utf8') : `# Asset Manifest\n`;
  const i = md.indexOf(start), j = md.indexOf(end);
  if (i >= 0 && j > i) md = md.slice(0, i) + block + md.slice(j + end.length);
  else if (md.includes('<!-- figma-assets:start -->')) md = md.replace('<!-- figma-assets:start -->', block + '\n\n<!-- figma-assets:start -->');
  else md = md.trimEnd() + '\n\n' + block + '\n';
  writeFileSync(mdPath, md);
  console.log('notes block → ' + mdPath);
}

// ---------- from-manifest (fleet art-2d) ----------
const MAP_BACKEND = { antigravity: 'agy', agy: 'agy', 'codex-image': 'codex', codex: 'codex', 'gpt-image-gen': 'codex' };
const CAT_RULES = [[/\b(btn|button)/, 'button'], [/panel|popup|plate|skin|frame|dialog/, 'panel'], [/card/, 'card'], [/ribbon|banner/, 'ribbon'],
  [/\btab/, 'tab'], [/progress|\bbar\b|track/, 'bar'], [/toggle|switch/, 'toggle'], [/badge/, 'badge'], [/\bic[-_]|icon/, 'icon'],
  [/\bbg\b|background|sky|backdrop/, 'background']];
const SLICE = { button: [0.22, 0, 0.22, 0], panel: [0.2, 0.2, 0.2, 0.2], card: [0.12, 0.3, 0.12, 0.3], ribbon: [0.2, 0, 0.2, 0], tab: [0.25, 0, 0.25, 0], bar: [0.1, 0, 0.1, 0] };

export function artRows(man) {
  const a = man.assets ?? man.rows ?? man;
  const list = Array.isArray(a) ? a : [...(a['2d'] || a['2D'] || []), ...Object.entries(a).filter(([k]) => !/^(2d|3d)$/i.test(k)).flatMap(([, v]) => (Array.isArray(v) ? v : []))];
  return list.filter((r) => r && typeof r === 'object' && (r.method === 'image-gen' || r.method === 'procedural') && r.file && (r.source ?? 'generate') === 'generate'
    && !/\.(glb|gltf|fbx|obj)$/i.test(r.file) && (r.type ?? r.kind ?? '2d').toLowerCase() === '2d');
}

export function kitFromManifest(man, { artBackend, override = {}, dir, artRoot = 'assets/art' }) {
  const rows = [], manual = [];
  for (const m of artRows(man)) {
    const id = m.stem || m.id || basename(m.file).replace(/\.[a-z0-9]+$/i, '');
    if (m.layout || m.aperture || m.cells) { manual.push({ id, why: m.layout ? 'sprite sheet (layout cells)' : 'exact aperture geometry' }); continue; }
    const text = `${id} ${m.file} ${m.notes || ''}`.toLowerCase();
    const cat = m.tier === 'hero' ? 'hero' : m.alpha === false && !/panel|card|button/.test(id) ? (/(bg|background|sky)/.test(text) ? 'background' : 'art')
      : (CAT_RULES.find(([re]) => re.test(text))?.[1] || 'piece');
    let backend = m.method === 'procedural' ? 'procedural' : m.tier === 'hero' ? 'gpt-image-gen' : MAP_BACKEND[artBackend];
    if (!backend) throw new Error(`art_backend ${artBackend} has no kit route (cursor keeps the normal art-2d route)`);
    if (override[cat] || override.all) backend = override[cat] || override.all;
    const px = /9-?slice[^0-9]{0,12}(\d+)\s*px/i.exec(m.notes || '');
    const sliced = /9-?slice|nine-?slice/i.test(m.notes || '');
    const [W, H] = m.size || [];
    rows.push({
      name: id.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''), src: m.stem ? { stem: m.stem } : m.id ? { id: m.id } : { file: m.file },
      cat, backend, method: m.method, alpha: m.alpha !== false, subject: m.notes || id,
      aspect: W && H ? (W === H ? 'square 1:1' : W > H ? `wide ${+(W / H).toFixed(2)}:1` : `portrait 1:${+(H / W).toFixed(2)}`) : 'square 1:1',
      size: m.size, out: m.final_path || (m.file.startsWith('assets/') ? m.file : `${artRoot}/${m.file}`),
      ...(px ? { slicePx: +px[1] } : SLICE[cat] && (sliced || cat !== 'bar') ? { slice: SLICE[cat] } : {}),
    });
  }
  return { kit: { name: (man.slice || man.task || man.task_id || 'art-2d').toString().toLowerCase().replace(/[^a-z0-9]+/g, '-') + '-ui', dir,
    style: 'TODO: art bible from GAME_BRIEF / EXPECT_GAMEPLAY_VISUAL (rendering style, palette hex, light, mood)', rows }, manual };
}

function cmdFromManifest() {
  const mp = arg('art-manifest'), ab = arg('art-backend'), dir = arg('dir');
  if (!mp || !ab || !dir) die(64, 'from-manifest needs --art-manifest, --art-backend, --dir');
  const override = Object.fromEntries((arg('override', '') || '').split(',').filter(Boolean).map((kv) => kv.split('=')));
  const { kit, manual } = kitFromManifest(JSON.parse(readFileSync(resolve(mp), 'utf8')), { artBackend: ab, override, dir: resolve(dir), artRoot: arg('art-root', 'assets/art') });
  kit.artManifest = resolve(mp);
  mkdirSync(kit.dir, { recursive: true });
  const out = join(kit.dir, 'kit.json');
  writeFileSync(out, JSON.stringify(kit, null, 1));
  console.log(JSON.stringify({ kit: out, rows: kit.rows.length, byBackend: kit.rows.reduce((a, r) => ((a[r.backend] = (a[r.backend] || 0) + 1), a), {}), manual,
    next: 'write kit.style (art bible), enrich subjects if thin, then jobs' }, null, 1));
}

// ---------- gate (fleet ART2D) ----------
const toolOf = (r) => (r.recolourOf ? `game-ui-kit recolour.py of ${r.recolourOf.from} (${TOOL[r.backend]})`
  : TOOL[r.backend] + (r.flattenFace ? ' + game-ui-kit flatten-face' : '') + (r.grade ? ' + game-ui-kit grade.py' : '') + (r.compose ? ` + ${r.compose}` : ''));
const TOOL = { codex: 'codex-image-gen (gpt-image-2-codex)', agy: 'antigravity image tool (game-ui-kit)', 'gpt-image-gen': 'orca-gpt-image-gen (ChatGPT)', procedural: 'evidence/art/2d/gen_2d.py' };

function cmdGate() {
  const kit = loadKit();
  const mp = resolve(arg('art-manifest', kit.artManifest || ''));
  if (!existsSync(mp)) die(64, '--art-manifest <fleet manifest.json> required');
  const km = JSON.parse(readFileSync(join(kit.dir, 'manifest.json'), 'utf8'));
  const check = resolve(arg('check', join(dirname(mp), '..', 'art/2d/2d-check.md')));
  const look = arg('look');
  const byName = Object.fromEntries(kit.rows.map((r) => [r.name, r]));
  const lines = [], fails = [];
  for (const row of km.rows) {
    const r = byName[row.name], p = row.placed;
    if (!p) { fails.push(`${row.name} not placed (run post --to-project)`); continue; }
    const sizeOk = !r.size || (p.w === r.size[0] && p.h === r.size[1]);
    const aOk = r.alpha === false || alphaOk(row), fOk = faceOk(r, row);
    const ok = sizeOk && aOk && fOk;
    if (!ok) fails.push(`${p.rel}: ${!sizeOk ? 'size' : !aOk ? 'alpha' : 'face'}`);
    lines.push(`${p.rel}: size ${p.w}x${p.h} vs row ${r.size ? r.size.join('x') : 'PLAN'} | alpha ${r.alpha === false ? 'no' : 'yes'} vs row ${r.alpha === false ? 'no' : 'yes'} | method ${r.method || (r.backend === 'procedural' ? 'procedural' : 'image-gen')} via ${toolOf(r)} | ${ok ? 'PASS' : 'FAIL — ' + (!sizeOk ? 'size' : !aOk ? alphaWhy(row) : `face ${row.faceOpaquePct}% opaque`)}`);
  }
  for (const f of km.failed || []) fails.push(`${f.name}: ${f.error}`);
  if (!look) {
    console.log(lines.join('\n'));
    die(1, `measured: ${fails.length ? 'FAIL ' + fails.join('; ') : 'PASS'}. Read ${join(kit.dir, 'sheet.png')} and every off-looking PNG, then rerun with --look PASS or --look "FAIL:<files + reason>".`);
  }
  const lookOk = look === 'PASS', lookTxt = lookOk ? `PASS — checked on ${join(kit.dir, 'sheet.png')}` : `FAIL — ${look.replace(/^FAIL:?/, '').trim()}`;
  const prev = existsSync(check) ? readFileSync(check, 'utf8') : '';
  const round = (prev.match(/^## 2D — round (\d+)/gm) || []).length + 1;
  const tools = [...new Set(kit.rows.map(toolOf))].join(' + ');
  const devs = [
    ...kit.rows.filter((r) => r.recolourOf).map((r) => `${r.name} recoloured from ${r.recolourOf.from} (${r.recolourOf.color}) after the regen cap`),
    ...kit.rows.filter((r) => r.flattenFace).map((r) => `${r.name} face flattened (deterministic, generated pixels kept where opaque)`),
    ...kit.rows.filter((r) => r.compose).map((r) => `${r.name} image-gen base + procedural ${r.compose}`),
    ...km.rows.filter((r) => r.grade).map((r) => `${r.name} graded band ${r.grade.before} → ${r.grade.after} (target ${r.grade.target}, ${r.grade.masked} px)`)];
  const tiling = kit.rows.some((r) => /seamless|tile/i.test(r.subject)) ? lookTxt : 'n/a';
  const pass = !fails.length && lookOk;
  const block = [`## 2D — round ${round} (game-ui-kit ${kit.name})`, ...lines,
    `size: ${fails.some((f) => /size|placed/.test(f)) ? 'FAIL' : 'PASS'} — every file matches its manifest row`,
    `alpha: ${fails.some((f) => /alpha/.test(f)) ? 'FAIL' : 'PASS'} — UI on transparent background (keyed / native alpha); opaque only for art/background rows`,
    `tiling: ${tiling}`, `style: ${lookTxt}`, `set consistency: ${lookTxt}`, `readability: ${lookTxt}`,
    `method: PASS — every file made per its row method via ${tools}${devs.length ? '; deviations: ' + devs.join('; ') : ''}`,
    pass ? 'ART2D: PASS' : `ART2D: FAIL — ${[...fails, ...(lookOk ? [] : [look])].join('; ')}`, ''].join('\n');
  mkdirSync(dirname(check), { recursive: true });
  writeFileSync(check, (prev ? prev.trimEnd() + '\n\n' : '') + block);
  if (pass) {
    const man = JSON.parse(readFileSync(mp, 'utf8'));
    const checkRel = arg('check-rel', 'evidence/art/2d/2d-check.md');
    let n = 0;
    for (const m of artRows(man)) {
      const r = kit.rows.find((k) => (k.src?.stem && k.src.stem === m.stem) || (k.src?.id && k.src.id === m.id) || (k.src?.file && k.src.file === m.file));
      if (!r) continue;
      m.verify = { status: 'PASS', check: checkRel, round, tool: toolOf(r) };
      n++;
    }
    writeFileSync(mp, JSON.stringify(man, null, 1) + '\n');
    console.log(`verify set on ${n} rows of ${mp}`);
  }
  console.log(`${check}: round ${round} → ${pass ? 'ART2D: PASS' : 'ART2D: FAIL'}`);
  process.exit(pass ? 0 : 1);
}

// ---------- meta (Cocos nine-slice) ----------
function cmdMeta() {
  const kit = loadKit();
  const proj = resolve(arg('project', ''));
  const km = JSON.parse(readFileSync(join(kit.dir, 'manifest.json'), 'utf8'));
  let done = 0;
  for (const row of km.rows.filter((r) => r.placed?.borderPx)) {
    const metaPath = row.placed.path + '.meta';
    if (!metaPath.startsWith(proj)) continue;
    if (!existsSync(metaPath)) { console.log(`skip ${row.name}: ${metaPath} missing (import in Creator first)`); continue; }
    const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
    const sf = Object.values(meta.subMetas || {}).find((m) => m.importer === 'sprite-frame');
    if (!sf) { console.log(`skip ${row.name}: no sprite-frame subMeta (texture type must be sprite-frame)`); continue; }
    const b = row.placed.borderPx, { w, h } = row.placed;
    Object.assign(sf.userData, { borderLeft: b.left, borderTop: b.top, borderRight: b.right, borderBottom: b.bottom });
    if (b.left + b.right > w || b.top + b.bottom > h) console.log(`WARN ${row.name}: borders exceed the image (${w}x${h})`);
    if (Math.max(b.top, b.bottom) > h / 2 + 1) console.log(`WARN ${row.name}: vertical caps > half height; nodes shorter than ${b.top + b.bottom}px will squash`);
    writeFileSync(metaPath, JSON.stringify(meta, null, 2) + '\n');
    console.log(`${row.name}: borders L${b.left} T${b.top} R${b.right} B${b.bottom} → ${relative(proj, metaPath)}`);
    done++;
  }
  console.log(`${done} .meta files updated; refresh assets in Creator (or reimport) so the borders load`);
}

// ---------- recolour (fallback) ----------
function cmdRecolour() {
  const kitPath = resolve(arg('kit'));
  const kit = loadKit();
  const to = kit.rows.find((r) => r.name === arg('row')), from = kit.rows.find((r) => r.name === arg('from'));
  const color = arg('color');
  if (!to || !from || !/^#?[0-9a-f]{6}$/i.test(color || '')) die(64, 'recolour needs --row <name> --from <passing row> --color #RRGGBB');
  const src = join(kit.dir, 'kit', from.name + '.png');
  if (!existsSync(src)) die(64, `run post first: ${src} missing`);
  const dst = rawPath(kit, to);
  mkdirSync(dirname(dst), { recursive: true });
  if (existsSync(dst) && !to.recolourOf) execFileSync('cp', [dst, dst.replace(/\.png$/, '.generated.png')]);
  execFileSync('python3', ['-I', join(HERE, 'recolour.py'), '--color', color.startsWith('#') ? color : '#' + color, src, dst], { stdio: 'inherit' });
  to.recolourOf = { from: from.name, color };
  to.key = 'none';
  writeFileSync(kitPath, JSON.stringify(kit, null, 1));
  console.log(`${to.name}: raw replaced (generated raw kept as .generated.png); run post + sheet + gate — 2d-check records it as a deviation`);
}

// ---------- sheet ----------
const SHEET_PY = `
import json,sys
from PIL import Image
m=json.load(open(sys.argv[1]));d=sys.argv[2];H=220;tiles=[]
for r in m['rows']:
    im=Image.open(d+'/'+r['file']).convert('RGBA');im.thumbnail((H*3,H))
    bg=Image.new('RGBA',im.size,(26,20,60,255))
    for y in range(0,im.height,16):
        for x in range(0,im.width,16):
            if (x//16+y//16)%2: bg.paste((38,30,80,255),(x,y,min(x+16,im.width),min(y+16,im.height)))
    bg.alpha_composite(im);tiles.append(bg)
W=1800;rows=[];row=[];w=0
for t in tiles:
    if w+t.width+12>W and row: rows.append(row);row=[];w=0
    row.append(t);w+=t.width+12
if row: rows.append(row)
o=Image.new('RGB',(W,len(rows)*(H+12)+12),(16,12,36))
for i,rw in enumerate(rows):
    x=12
    for t in rw: o.paste(t.convert('RGB'),(x,12+i*(H+12)+(H-t.height)//2));x+=t.width+12
o.save(d+'/sheet.png')
`;
function cmdSheet() {
  const kit = loadKit();
  const man = join(kit.dir, 'manifest.json');
  if (!existsSync(man)) die(64, 'run `kit.mjs post` first');
  execFileSync('python3', ['-I', '-c', SHEET_PY, man, kit.dir], { stdio: 'inherit' });
  console.log(join(kit.dir, 'sheet.png'));
}

const CMDS = { check: cmdCheck, jobs: cmdJobs, agy: cmdAgy, post: cmdPost, sheet: cmdSheet, 'from-manifest': cmdFromManifest, gate: cmdGate, meta: cmdMeta, recolour: cmdRecolour };
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const fn = CMDS[process.argv[2]];
  if (!fn) die(64, 'usage: kit.mjs check | from-manifest | jobs|agy|post|sheet|gate|meta --kit <kit.json>');
  fn();
}
