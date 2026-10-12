#!/usr/bin/env node
// Flow spec → Figma screens, prototype links and flow arrows, through Orca's browser (Plugin API).
//   render.mjs screens [spec/02-home.mjs …] [--variant v2]   (re)build screens (default: every spec)
//   render.mjs links [--variant v2]                          reactions + arrows + board header
//   render.mjs upload <png|jpg …>                            images → "Image library · <flow>" (by file stem)
//   render.mjs board <out.png> [width] [--variant v2]        export the board (screens + arrows + header)
//   render.mjs shot "<frame name>" <out.png> [scale]
//   render.mjs view                                          zoom the viewport to fit
// Every command takes --flow <dir> (default: cwd), the folder holding flow.json, spec/, variants/.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ICONS } from './icons.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (k) => { const i = argv.indexOf('--' + k); if (i < 0) return undefined; const v = argv[i + 1]; argv.splice(i, 2); return v; };
const FLOW = resolve(opt('flow') || '.');
const VARIANT = opt('variant');
const cfg = JSON.parse(readFileSync(join(FLOW, 'flow.json'), 'utf8'));
const L = { W: 1080, H: 1920, GX: 640, GY: 760, bg: '#1A1446', ...cfg.layout };
const FONTS = cfg.fonts || [['Inter', 'Regular'], ['Inter', 'Medium'], ['Inter', 'SemiBold'], ['Inter', 'Bold']];
const LIBRARY = `Image library · ${cfg.name}`;

const { connectFigma } = await import(join(process.env.HOME, '.agents/skills/figma-game-clone/scripts/figma.mjs'));
let figmaEval;
const run = (args) => {
  figmaEval ||= connectFigma({ fileKey: cfg.fileKey }).eval;
  const js = readFileSync(join(HERE, 'page.js'), 'utf8')
    .replace('const A = __ARGS__;', () => 'const A = ' + JSON.stringify({ ...args, icons: ICONS, L, page: cfg.page, fonts: FONTS, library: LIBRARY }) + ';');
  return figmaEval(js);
};

const specFiles = () => readdirSync(join(FLOW, 'spec')).filter((f) => /^\d.*\.mjs$/.test(f)).sort().map((f) => join(FLOW, 'spec', f));
const load = (files) => Promise.all(files.map(async (f) => (await import(pathToFileURL(f).href)).default));
const variant = VARIANT ? await import(pathToFileURL(join(FLOW, 'variants', VARIANT + '.mjs')).href) : null;
const mapS = (list) => (variant ? list.map(variant.screen) : list);
const mapL = (list) => (variant ? list.map(variant.link) : list);
const suffix = VARIANT ? ' ' + VARIANT : '';

const [cmd, ...rest] = argv;
if (cmd === 'screens') {
  const files = rest.length ? rest.map((f) => resolve(FLOW, f)) : specFiles();
  console.log(run({ mode: 'screens', screens: mapS((await load(files)).flatMap((s) => s.screens)) }));
} else if (cmd === 'links') {
  const all = await load(specFiles());
  console.log(run({
    mode: 'links', suffix,
    screens: mapS(all.flatMap((s) => s.screens)), links: mapL(all.flatMap((s) => s.links || [])),
    flowName: `${cfg.title || cfg.name} flow${suffix}`,
    title: variant?.title || (cfg.title || cfg.name) + (VARIANT ? ` — ${VARIANT}` : ' — Flow views'),
    subtitle: cfg.subtitle || `${L.W}×${L.H} · click a hotspot in Present mode to follow the flow`,
  }));
} else if (cmd === 'upload') {
  for (const f of rest) console.log(run({ mode: 'upload', name: basename(f).replace(/\.[a-z]+$/i, ''), b64: readFileSync(resolve(f)).toString('base64') }));
} else if (cmd === 'board') {
  const names = mapS((await load(specFiles())).flatMap((s) => s.screens)).map((s) => s.name).concat(['Flow arrows' + suffix, 'Board header' + suffix]);
  writeFileSync(rest[0], Buffer.from(run({ mode: 'board', names, width: Number(rest[1] || 2400) }), 'base64'));
  console.log(rest[0]);
} else if (cmd === 'shot') {
  writeFileSync(rest[1], Buffer.from(run({ mode: 'shot', name: rest[0], scale: Number(rest[2] || 0.4) }), 'base64'));
  console.log(rest[1]);
} else if (cmd === 'view') {
  console.log(run({ mode: 'view' }));
} else {
  console.error('usage: render.mjs screens [files] | links | upload <files> | board <out> [w] | shot <name> <out> [scale] | view   [--flow dir] [--variant name]');
  process.exit(1);
}
