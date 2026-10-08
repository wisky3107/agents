#!/usr/bin/env node
// Figma → game reference pack, read through the Figma tab in Orca's embedded browser.
// The open Figma page exposes the Plugin API global `figma`; `orca eval` runs JS in that page,
// so no Figma token or plugin is needed. Per-game config: <game>/tools/figma/figma.json.
// `init` copies this file next to that config, so the game folder carries its own CLI.
//
//   figma.mjs init --url <figma url> --game <dir>      write figma.json + views.json, copy the CLI
//   figma.mjs open                                     find/open the Figma tab, fill fileName/rootNode
//   figma.mjs survey [--depth 4]                       tree + frame list + overview into assets/reference/
//   figma.mjs tree <view|nodeId> [depth]               layer tree (name, type, size, id)
//   figma.mjs views | views add <key> <nodeId> [--kind screen|part] [--desc "..."]
//   figma.mjs notes [--all] [--out FIGMA_NOTES.md]     text outside screen views, verbatim
//   figma.mjs images                                   image fills grouped by imageHash
//   figma.mjs sigs                                     unique layer signatures in screens (rename planning)
//   figma.mjs rename --plan <plan.json> [--apply] | rename --restore [backup.json]
//   figma.mjs fonts [--download]                       fonts used; fetch Google Fonts TTFs into assets/fonts
//   figma.mjs draft-jobs [--out <jobs.json>]           export jobs: raw per unique image + screen shots
//   figma.mjs export --jobs <jobs.json>                run export jobs into assets/ (log in assets/reference)
//   figma.mjs export <nodeId> <out.png> [--scale 1] [--hide-text] [--unclip] [--raw]
//   figma.mjs resize [--factor 1]                      shrink oversized exports to Figma display size × factor
//   figma.mjs shot <view|nodeId> <out.jpg> [--scale 0.5]
//   figma.mjs layout <view|nodeId> [--out file.json] | layout-all
//   figma.mjs manifest                                 assets/manifest.json + generated block in ASSET_MANIFEST.md
//   figma.mjs guide                                    FIGMA_GUIDE.md from the skill template
// Every command takes --game <dir> (default: the game folder this copy lives in).
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const ORCA = process.env.ORCA_CLI_COMMAND || 'orca';
const SKILL_GUIDE = join(dirname(SELF), '../reference/figma-guide-template.md');
const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const MD_START = '<!-- figma-assets:start -->';
const MD_END = '<!-- figma-assets:end -->';

// ---------- pure helpers (tested) ----------

export function parseFigmaUrl(url) {
  const m = String(url).match(/figma\.com\/(?:design|file|proto|board)\/([A-Za-z0-9]+)/);
  if (!m) throw new Error(`not a Figma file URL: ${url}`);
  const node = new URL(url).searchParams.get('node-id');
  return { fileKey: m[1], rootNode: node ? node.replace(/-/g, ':') : '' };
}

export const slugify = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

export function imageSize(buf) {
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i++; continue; }
      const marker = buf[i + 1];
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { w: buf.readUInt16BE(i + 7), h: buf.readUInt16BE(i + 5) };
      }
      i += 2 + buf.readUInt16BE(i + 2);
    }
  }
  return null;
}

export function extFor(b) {
  if (b[0] === 0x89 && b[1] === 0x50) return '.png';
  if (b[0] === 0xff && b[1] === 0xd8) return '.jpg';
  if (b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP') return '.webp';
  if (b.subarray(0, 3).toString() === 'GIF') return '.gif';
  return '.bin';
}

// rename plan: { "ids": { "1:23": "love-bar" }, "names": { "Rectangle 4847": "love-bar-fill" } }
export function validatePlan(plan) {
  const errors = [];
  for (const group of ['ids', 'names']) {
    for (const [k, v] of Object.entries(plan[group] || {})) {
      if (!KEBAB.test(v)) errors.push(`${group}["${k}"] = "${v}" is not kebab name-name`);
    }
  }
  if (!plan.ids && !plan.names) errors.push('plan needs "ids" and/or "names"');
  return errors;
}

const WEIGHTS = { thin: 100, hairline: 100, extralight: 200, ultralight: 200, light: 300, regular: 400, normal: 400,
  book: 400, medium: 500, semibold: 600, demibold: 600, bold: 700, extrabold: 800, ultrabold: 800, black: 900, heavy: 900 };

export function fontQuery(family, style) {
  const s = style.toLowerCase().replace(/[\s-]/g, '');
  const italic = s.includes('italic');
  const weight = WEIGHTS[s.replace('italic', '') || 'regular'] ?? 400;
  return { family, style, weight, italic, file: `${family.replace(/\s+/g, '')}-${style.replace(/\s+/g, '')}.ttf`,
    url: `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family).replace(/%20/g, '+')}:ital,wght@${italic ? 1 : 0},${weight}` };
}

export function replaceBlock(text, block) {
  const body = `${MD_START}\n${block}\n${MD_END}`;
  const i = text.indexOf(MD_START), j = text.indexOf(MD_END);
  if (i >= 0 && j > i) return text.slice(0, i) + body + text.slice(j + MD_END.length);
  return `${text.replace(/\s*$/, '')}\n\n${body}\n`;
}

export function buildManifest({ cfg, slug, files, previous = {} }) {
  return {
    ...previous,
    game: previous.game || cfg.fileName || slug,
    slug,
    source: { type: 'figma', file: cfg.fileName || '', fileKey: cfg.fileKey, url: cfg.url, rootNode: cfg.rootNode,
      extractedAt: new Date().toISOString().slice(0, 10) },
    ...(cfg.designResolution ? { designResolution: cfg.designResolution } : {}),
    files,
  };
}

export function manifestTable(files) {
  const rows = ['| Path | Size | Figma node | Mode |', '| --- | --- | --- | --- |'];
  for (const f of files) {
    rows.push(`| \`${f.path}\` | ${f.w ? `${f.w}×${f.h}` : `${Math.round(f.bytes / 1024)} KB`} | ${f.figmaNode ? `\`${f.figmaNode}\` ${f.figmaName || ''}` : '—'} | ${f.mode || '—'} |`);
  }
  return rows.join('\n');
}

// ---------- game folder + orca plumbing ----------

const argv = process.argv.slice(2);
const arg = (name, def) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : def; };
const flag = (name) => argv.includes(`--${name}`);
const positional = () => {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) { if (!['--all', '--apply', '--download', '--hide-text', '--unclip', '--raw', '--restore'].includes(argv[i])) i++; continue; }
    out.push(argv[i]);
  }
  return out;
};

function gameDir() {
  const g = arg('game');
  if (g) return resolve(g);
  if (existsSync(join(dirname(SELF), 'figma.json'))) return resolve(dirname(SELF), '../..');
  throw new Error('pass --game <games/<slug> folder> (or run the copy under <game>/tools/figma/)');
}
const cfgPath = (G) => join(G, 'tools/figma/figma.json');
const viewsPath = (G) => join(G, 'tools/figma/views.json');
const readJson = (p, def) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : def);
const writeJson = (p, o) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, `${JSON.stringify(o, null, 1)}\n`); };

function loadCfg(G) {
  const cfg = readJson(cfgPath(G));
  if (!cfg) throw new Error(`missing ${cfgPath(G)} — run init first`);
  return cfg;
}
const loadViews = (G) => readJson(viewsPath(G), { views: {} }).views;
const screenIds = (G) => Object.values(loadViews(G)).filter((v) => v.kind === 'screen').map((v) => v.node);

function orca(args) {
  const out = execFileSync(ORCA, [...args, '--json'], { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });
  const j = JSON.parse(out);
  if (!j.ok) throw new Error(JSON.stringify(j.error || j));
  return j.result;
}

function evalJs(page, expr) {
  return orca(['eval', '--page', page, '--expression', expr]).result;
}

function findPage(cfg) {
  const tabs = orca(['tab', 'list', '--worktree', 'all']).tabs || [];
  return tabs.find((t) => /figma\.com\/(design|file)\//.test(t.url) && t.url.includes(cfg.fileKey))?.browserPageId;
}

function ensurePage(cfg) {
  let page = findPage(cfg);
  if (!page) {
    orca(['tab', 'create', '--url', cfg.url]);
    page = findPage(cfg);
  }
  if (!page) throw new Error('could not open the Figma tab in Orca');
  for (let i = 0; i < 90; i++) {
    try {
      if (evalJs(page, "typeof figma !== 'undefined' && !!figma.root ? 'ready' : 'wait'") === 'ready') return page;
    } catch {}
    execFileSync('sleep', ['1']);
  }
  throw new Error('Figma tab not ready: log in to Figma in the Orca browser with an account that can view this file, then retry');
}

const resolveNode = (G, v) => loadViews(G)[v]?.node || v;
const J = (o) => JSON.stringify(o);

// ---------- JS that runs inside the Figma page ----------

const PRELUDE = `const root=await figma.getNodeByIdAsync(R);if(!root)throw new Error('node not found '+R);
let pg=root;while(pg&&pg.type!=='PAGE')pg=pg.parent;if(pg&&pg.loadAsync)await pg.loadAsync();`;

const TREE_JS = (id, depth) => `(async()=>{const R=${J(id)};${PRELUDE}
function w(n,d){let s='  '.repeat(d)+n.type+' "'+n.name+'" #'+n.id+('width' in n?' '+Math.round(n.width)+'x'+Math.round(n.height):'')+(n.visible===false?' [hidden]':'')+(n.type==='TEXT'?' «'+n.characters.slice(0,40).replace(/\\n/g,' ')+'»':'');
const o=[s];if('children' in n&&d<${depth}&&n.type!=='INSTANCE')for(const c of n.children)o.push(...w(c,d+1));return o;}
return w(root,0).join('\\n');})()`;

const INFO_JS = `(async()=>JSON.stringify({file:figma.root.name,currentPage:figma.currentPage.name,pageId:figma.currentPage.id,
pages:figma.root.children.map(p=>({name:p.name,id:p.id}))}))()`;

const FRAMES_JS = (id, depth) => `(async()=>{const R=${J(id)};${PRELUDE}
const o=[];function w(n,d){if(d>0&&['FRAME','SECTION','COMPONENT','COMPONENT_SET','GROUP'].includes(n.type))
o.push({id:n.id,type:n.type,name:n.name,d,w:Math.round(n.width),h:Math.round(n.height),kids:'children' in n?n.children.length:0});
if('children' in n&&d<${depth}&&n.type!=='INSTANCE')n.children.forEach(c=>w(c,d+1));}w(root,0);
return JSON.stringify({root:{id:root.id,name:root.name,type:root.type,w:Math.round(root.width||0),h:Math.round(root.height||0)},frames:o});})()`;

const NOTES_JS = (id, screens, all) => `(async()=>{const R=${J(id)};const S=new Set(${J(screens)});const ALL=${all};${PRELUDE}
const nodes=root.findAll(n=>n.type==='TEXT'||n.type==='STICKY'||n.type==='SHAPE_WITH_TEXT');const out=[];let last='';
for(const n of nodes){const anc=[];let c=n.parent,skip=false;while(c&&c.id!==root.id){if(S.has(c.id))skip=true;anc.unshift(c);c=c.parent;}
if(skip&&!ALL)continue;const g=anc.filter(a=>a.type!=='INSTANCE').slice(-3).map(a=>a.name+' #'+a.id).join(' / ')||root.name;
if(g!==last){out.push('');out.push('### '+g);last=g;}
const t=n.type==='TEXT'?n.characters:n.text.characters;out.push('- '+(n.visible===false?'[hidden] ':'')+t.replace(/\\n/g,' / ')+'  ⟨'+n.id+'⟩');}
return out.join('\\n');})()`;

const IMAGES_JS = (id, screens) => `(async()=>{const R=${J(id)};const S=new Set(${J(screens)});${PRELUDE}
const res=[];root.findAll(n=>{if('fills' in n&&Array.isArray(n.fills))for(const f of n.fills)if(f.type==='IMAGE'&&f.imageHash){
let p=n,path=[],inScreen=false,vis=n.visible;while(p&&p.id!==root.id){if(S.has(p.id))inScreen=true;if(p.visible===false)vis=false;path.unshift(p.name);p=p.parent;}
res.push({hash:f.imageHash,id:n.id,type:n.type,name:n.name,w:Math.round(n.width),h:Math.round(n.height),scaleMode:f.scaleMode,visible:vis&&f.visible!==false,inScreen,path:path.join(' > ')});}return false;});
return JSON.stringify(res);})()`;

const SIGS_JS = (ids) => `(async()=>{const seen={};function w(n,path){const key=path+' > '+n.type+':'+n.name;seen[key]=(seen[key]||0)+1;
if(n.type==='INSTANCE')return;if('children' in n)n.children.forEach(c=>w(c,path+' > '+n.name));}
for(const i of ${J(ids)}){const s=await figma.getNodeByIdAsync(i);if(s&&'children' in s)s.children.forEach(c=>w(c,s.name));}
return JSON.stringify(seen);})()`;

const NAMES_JS = (id) => `(async()=>{const R=${J(id)};${PRELUDE}const m={[root.id]:root.name};root.findAll(n=>{m[n.id]=n.name;return false});return JSON.stringify(m);})()`;

const RENAME_JS = (id, plan, apply, screens) => `(async()=>{const R=${J(id)};const P=${J(plan)};const APPLY=${apply};const S=new Set(${J(screens)});${PRELUDE}
const ids=P.ids||{},names=P.names||{};const changes=[],nonKebab=[];const re=/^[a-z0-9]+(-[a-z0-9]+)*$/;
function walk(n,inInst,inScr){inScr=inScr||S.has(n.id)||!S.size;const nn=ids[n.id]??(inInst?undefined:names[n.name]);
if(nn!==undefined&&nn!==n.name)changes.push([n,nn]);
else if(inScr&&!inInst&&nn===undefined&&!re.test(n.name)&&!(n.type==='TEXT'&&n.name===n.characters))nonKebab.push(n.type+':'+n.name+' #'+n.id);
if('children' in n)n.children.forEach(c=>walk(c,inInst||n.type==='INSTANCE',inScr));}
walk(root,false,false);let failed=[];
if(APPLY)for(const [n,nn] of changes){try{n.name=nn;}catch(e){failed.push(n.id+': '+e.message);if(failed.length>3)break;}}
const sum={};for(const [n,nn] of changes){const k=n.name+' -> '+nn;sum[k]=(sum[k]||0)+1;}
return JSON.stringify({applied:APPLY&&!failed.length,total:changes.length,failed,nonKebab:nonKebab.slice(0,300),nonKebabCount:nonKebab.length,
sample:APPLY?null:Object.entries(sum).slice(0,200).map(([k,v])=>v+'x '+k)});})()`;

const RESTORE_JS = (map) => `(async()=>{const M=${J(map)};let n=0,miss=0;for(const [id,name] of Object.entries(M)){const x=await figma.getNodeByIdAsync(id);if(!x){miss++;continue;}if(x.name!==name){x.name=name;n++;}}return JSON.stringify({restored:n,missing:miss});})()`;

const FONTS_JS = (id) => `(async()=>{const R=${J(id)};${PRELUDE}const s={};
root.findAll(n=>n.type==='TEXT').forEach(t=>{for(const seg of t.getStyledTextSegments(['fontName','fontSize'])){const k=seg.fontName.family+'|'+seg.fontName.style;s[k]=(s[k]||0)+1;}});
return JSON.stringify(s);})()`;

const EXPORT_JS = (j) => `(async()=>{const J=${J(j)};const n=await figma.getNodeByIdAsync(J.id);if(!n)throw new Error('node not found '+J.id);
const toB64=b=>{let s='';for(let i=0;i<b.length;i+=8192)s+=String.fromCharCode.apply(null,b.subarray(i,i+8192));return btoa(s);};
const hasImg=c=>'fills' in c&&Array.isArray(c.fills)&&c.fills.some(f=>f.type==='IMAGE'&&f.imageHash);
if(J.mode==='raw'){const t=hasImg(n)?n:('findOne' in n?n.findOne(hasImg):null);if(!t)throw new Error('no image fill under '+J.id);
const h=J.hash||t.fills.find(f=>f.type==='IMAGE'&&f.imageHash).imageHash;
return JSON.stringify({b64:toB64(await figma.getImageByHash(h).getBytesAsync()),hash:h,name:t.name,w:Math.round(t.width),h:Math.round(t.height)});}
const restore=[],unclip=[];const hide=c=>{if(c.visible){restore.push(c);c.visible=false;}};
if(J.hideTexts&&'findAll' in n)n.findAll(c=>c.type==='TEXT').forEach(hide);
for(const h of (J.hideIds||[])){const c=await figma.getNodeByIdAsync(h);if(c)hide(c);}
if(J.hideChildrenExcept&&'children' in n)n.children.forEach(c=>{if(!J.hideChildrenExcept.includes(c.name))hide(c);});
if(J.unclip){let p=n.parent;while(p&&p.type!=='PAGE'){if('clipsContent' in p&&p.clipsContent){unclip.push(p);p.clipsContent=false;}p=p.parent;}}
try{const b=await n.exportAsync({format:J.fmt||'PNG',constraint:{type:'SCALE',value:J.scale||1}});
return JSON.stringify({b64:toB64(b),name:n.name,w:Math.round(n.width),h:Math.round(n.height)});}
finally{restore.forEach(c=>c.visible=true);unclip.forEach(c=>c.clipsContent=true);}})()`;

const LAYOUT_JS = (id, screens) => `(async()=>{const R=${J(id)};const S=new Set(${J(screens)});${PRELUDE}
let scr=root;while(scr.parent&&!S.has(scr.id))scr=scr.parent;if(!S.has(scr.id))scr=root;
const RB=scr.absoluteBoundingBox;
const hex=c=>'#'+[c.r,c.g,c.b].map(v=>Math.round(v*255).toString(16).padStart(2,'0')).join('').toUpperCase();
const paints=ps=>Array.isArray(ps)?ps.filter(p=>p.visible!==false).map(p=>p.type==='SOLID'?{type:'solid',color:hex(p.color),opacity:+(p.opacity??1).toFixed(2)}:p.type.startsWith('GRADIENT')?{type:p.type.toLowerCase(),stops:p.gradientStops.map(s=>({pos:+s.position.toFixed(3),color:hex(s.color),a:+s.color.a.toFixed(2)}))}:{type:p.type.toLowerCase()}):'mixed';
function cc(box,parent){return {x:+(box.x+box.width/2-(parent.x+parent.width/2)).toFixed(1),y:+((parent.y+parent.height/2)-(box.y+box.height/2)).toFixed(1)};}
function node(n,parentBox){
  const box=n.absoluteBoundingBox,rb=n.absoluteRenderBounds||box;if(!box)return null;
  const o={name:n.name,id:n.id,type:n.type,visible:n.visible,size:{w:+box.width.toFixed(1),h:+box.height.toFixed(1)},
    figma:{x:+(box.x-RB.x).toFixed(1),y:+(box.y-RB.y).toFixed(1)},cc:cc(box,parentBox),ccScreen:cc(box,RB),
    spriteSize:{w:Math.round(rb.width),h:Math.round(rb.height)},spriteCcScreen:cc(rb,RB)};
  if(n.opacity!==undefined&&n.opacity!==1)o.opacity=+n.opacity.toFixed(2);
  if(n.rotation)o.rotation=+(-n.rotation).toFixed(1);
  if('cornerRadius' in n&&typeof n.cornerRadius==='number'&&n.cornerRadius)o.radius=n.cornerRadius;
  if('fills' in n){const f=paints(n.fills);if(f==='mixed'||f.length)o.fills=f;}
  if('strokes' in n&&n.strokes.length)o.strokes={paints:paints(n.strokes),weight:n.strokeWeight};
  if('effects' in n&&n.effects.length)o.effects=n.effects.filter(e=>e.visible).map(e=>({type:e.type.toLowerCase(),radius:e.radius,offset:e.offset,color:e.color&&hex(e.color)}));
  if(n.type==='TEXT'){const fn=n.fontName;o.text={characters:n.characters,font:fn===figma.mixed?'mixed':fn.family+' '+fn.style,size:n.fontSize===figma.mixed?'mixed':n.fontSize,
    align:n.textAlignHorizontal.toLowerCase(),valign:n.textAlignVertical.toLowerCase(),autoResize:n.textAutoResize,
    lineHeight:n.lineHeight===figma.mixed?'mixed':(n.lineHeight.unit==='AUTO'?'auto':n.lineHeight.value+(n.lineHeight.unit==='PERCENT'?'%':'')),
    letterSpacing:n.letterSpacing===figma.mixed?'mixed':n.letterSpacing.value+(n.letterSpacing.unit==='PERCENT'?'%':'')};}
  if('layoutMode' in n&&n.layoutMode&&n.layoutMode!=='NONE')o.autoLayout={mode:n.layoutMode.toLowerCase(),spacing:n.itemSpacing,padding:[n.paddingTop,n.paddingRight,n.paddingBottom,n.paddingLeft]};
  if(n.type==='INSTANCE'&&n.mainComponent)o.component=n.mainComponent.name;
  if('children' in n&&n.type!=='INSTANCE'&&n.type!=='BOOLEAN_OPERATION')o.children=n.children.map(c=>node(c,box)).filter(Boolean);
  if(n.type==='INSTANCE'){const ts=n.findAll(c=>c.type==='TEXT'&&c.visible);if(ts.length)o.texts=ts.map(t=>({characters:t.characters,font:t.fontName===figma.mixed?'mixed':t.fontName.family+' '+t.fontName.style,size:t.fontSize,color:paints(t.fills)[0]?.color}));}
  return o;}
return JSON.stringify({view:root.name,id:root.id,screen:scr.name,screenId:scr.id,screenSize:{w:RB.width,h:RB.height},
  coords:'cc = node centre vs parent centre (Cocos, anchor 0.5, y up). ccScreen = vs screen centre. figma = top-left vs screen (y down). sprite* = render bounds (incl. shadow/effects), matches exported PNGs.',
  root:node(root,root.parent&&root!==scr&&root.parent.absoluteBoundingBox?root.parent.absoluteBoundingBox:RB)});})()`;

// ---------- commands ----------

function cmdInit() {
  const G = gameDir();
  const url = arg('url');
  if (!url) throw new Error('init needs --url <figma url>');
  const { fileKey, rootNode } = parseFigmaUrl(url);
  const prev = readJson(cfgPath(G), {});
  const cfg = { ...prev, fileKey, url, rootNode: rootNode || prev.rootNode || '' };
  writeJson(cfgPath(G), cfg);
  if (!existsSync(viewsPath(G))) writeJson(viewsPath(G), { views: {} });
  const dest = join(G, 'tools/figma/figma.mjs');
  if (resolve(dest) !== SELF) copyFileSync(SELF, dest);
  console.log(J({ ok: true, game: G, config: cfg, cli: dest }));
}

function cmdOpen() {
  const G = gameDir();
  const cfg = loadCfg(G);
  const page = ensurePage(cfg);
  const info = JSON.parse(evalJs(page, INFO_JS));
  cfg.fileName = info.file;
  if (!cfg.rootNode) cfg.rootNode = info.pageId;
  writeJson(cfgPath(G), cfg);
  console.log(J({ page, ...info, rootNode: cfg.rootNode }));
  return page;
}

function cmdSurvey() {
  const G = gameDir();
  const cfg = loadCfg(G);
  const page = ensurePage(cfg);
  const ref = join(G, 'assets/reference');
  mkdirSync(ref, { recursive: true });
  const tree = evalJs(page, TREE_JS(cfg.rootNode, 40));
  writeFileSync(join(ref, 'figma-tree.txt'), tree);
  const frames = JSON.parse(evalJs(page, FRAMES_JS(cfg.rootNode, Number(arg('depth', 4)))));
  writeJson(join(ref, 'figma-frames.json'), frames);
  const r = frames.root;
  if (r.w && r.type !== 'PAGE') {
    const scale = Math.min(1, 2400 / Math.max(r.w, r.h));
    const b = JSON.parse(evalJs(page, EXPORT_JS({ id: cfg.rootNode, fmt: 'JPG', scale })));
    writeFileSync(join(ref, 'figma-overview.jpg'), Buffer.from(b.b64, 'base64'));
  }
  console.log(`root ${r.type} "${r.name}" #${r.id} ${r.w}x${r.h} — ${tree.split('\n').length} layers → assets/reference/figma-tree.txt`);
  for (const f of frames.frames) console.log(`${'  '.repeat(f.d - 1)}${f.type} "${f.name}" #${f.id} ${f.w}x${f.h} (${f.kids})`);
}

function cmdTree() {
  const G = gameDir();
  const [, target, depth] = positional();
  console.log(evalJs(ensurePage(loadCfg(G)), TREE_JS(resolveNode(G, target || loadCfg(G).rootNode), Number(depth || 4))));
}

function cmdViews() {
  const G = gameDir();
  const doc = readJson(viewsPath(G), { views: {} });
  const [, sub, key, node] = positional();
  if (sub === 'add') {
    if (!key || !node) throw new Error('views add <key> <nodeId>');
    if (!KEBAB.test(key)) throw new Error(`view key "${key}" must be kebab name-name`);
    doc.views[key] = { node: node.replace(/-/g, ':'), kind: arg('kind', 'screen'), desc: arg('desc', '') };
    writeJson(viewsPath(G), doc);
  }
  for (const [k, v] of Object.entries(doc.views)) console.log(`${k.padEnd(36)} ${v.node.padEnd(10)} ${v.kind.padEnd(7)} ${v.desc}`);
}

function cmdNotes() {
  const G = gameDir();
  const cfg = loadCfg(G);
  const screens = screenIds(G);
  if (!screens.length && !flag('all')) console.error('warn: views.json has no screens — UI text inside screens will be mixed into the notes');
  const body = evalJs(ensurePage(cfg), NOTES_JS(cfg.rootNode, screens, flag('all')));
  const out = resolve(G, arg('out', 'FIGMA_NOTES.md'));
  const head = `# ${cfg.fileName || basename(G)} — Figma notes (verbatim)\n\nExtracted from Figma \`${cfg.fileName || cfg.fileKey}\` (root \`${cfg.rootNode}\`) on ${new Date().toISOString().slice(0, 10)}. `
    + `${flag('all') ? 'All text layers.' : 'Text outside the screen views in tools/figma/views.json.'} Source evidence for GAME_BRIEF.md — do not edit by hand; re-run \`figma.mjs notes\`.\n`;
  writeFileSync(out, `${head}\n\`\`\`text${body}\n\`\`\`\n`);
  console.log(`wrote ${relative(G, out)} (${body.split('\n').filter((l) => l.startsWith('- ')).length} text layers)`);
}

function imagesOf(G, page) {
  const cfg = loadCfg(G);
  return JSON.parse(evalJs(page, IMAGES_JS(cfg.rootNode, screenIds(G))));
}

function cmdImages() {
  const G = gameDir();
  const list = imagesOf(G, ensurePage(loadCfg(G)));
  writeJson(join(G, 'assets/reference/figma-images.json'), list);
  const by = new Map();
  for (const x of list) by.set(x.hash, [...(by.get(x.hash) || []), x]);
  console.log(`${list.length} image fills, ${by.size} unique images → assets/reference/figma-images.json`);
  for (const [h, xs] of by) {
    const v = xs.find((x) => x.visible) || xs[0];
    console.log(`${h.slice(0, 10)} ×${xs.length} ${v.inScreen ? 'screen' : '      '} ${v.visible ? '' : '[hidden] '}#${v.id} ${v.w}x${v.h} ${v.path} > ${v.name}`);
  }
}

function cmdSigs() {
  const G = gameDir();
  const ids = screenIds(G);
  if (!ids.length) throw new Error('add screen views first (views add <key> <nodeId> --kind screen)');
  const seen = JSON.parse(evalJs(ensurePage(loadCfg(G)), SIGS_JS(ids)));
  const lines = Object.entries(seen).map(([k, v]) => `${String(v).padStart(4)}  ${k}`);
  writeFileSync(join(G, 'assets/reference/figma-sigs.txt'), `${lines.join('\n')}\n`);
  const bad = lines.filter((l) => !KEBAB.test(l.split(':').pop()));
  console.log(`${lines.length} signatures (${bad.length} non-kebab) → assets/reference/figma-sigs.txt`);
  console.log(bad.slice(0, 150).join('\n'));
}

function cmdRename() {
  const G = gameDir();
  const cfg = loadCfg(G);
  const page = ensurePage(cfg);
  const backupDir = join(G, 'assets/reference');
  if (flag('restore')) {
    const p = positional()[1] || join(backupDir, 'figma-names-backup.json');
    console.log(evalJs(page, RESTORE_JS(JSON.parse(readFileSync(p, 'utf8')))));
    return;
  }
  const planFile = arg('plan');
  if (!planFile) throw new Error('rename needs --plan <plan.json>');
  const plan = JSON.parse(readFileSync(planFile, 'utf8'));
  const errors = validatePlan(plan);
  if (errors.length) throw new Error(`bad plan:\n${errors.join('\n')}`);
  const apply = flag('apply');
  if (apply) {
    const names = JSON.parse(evalJs(page, NAMES_JS(cfg.rootNode)));
    const first = join(backupDir, 'figma-names-backup.json');
    const out = existsSync(first) ? join(backupDir, `figma-names-backup-${Date.now()}.json`) : first;
    writeJson(out, names);
    console.error(`backup of ${Object.keys(names).length} names → ${relative(G, out)}`);
  }
  const r = JSON.parse(evalJs(page, RENAME_JS(cfg.rootNode, plan, apply, screenIds(G))));
  if (apply && r.failed.length) r.hint = 'rename failed — the Figma account in Orca needs edit access; skip rename and name files in the export jobs instead';
  console.log(JSON.stringify(r, null, 1));
}

async function cmdFonts() {
  const G = gameDir();
  const used = JSON.parse(evalJs(ensurePage(loadCfg(G)), FONTS_JS(loadCfg(G).rootNode)));
  const rows = Object.entries(used).map(([k, n]) => { const [family, style] = k.split('|'); return { ...fontQuery(family, style), uses: n }; });
  if (!flag('download')) { for (const r of rows) console.log(`${r.family} ${r.style} (${r.uses} runs) → ${r.file}`); return; }
  const dir = join(G, 'assets/fonts');
  mkdirSync(dir, { recursive: true });
  const result = [];
  for (const r of rows) {
    let status = 'missing';
    try {
      // An old user agent makes Google Fonts serve one full TTF (no unicode-range subsets, so Vietnamese glyphs stay in).
      const css = await (await fetch(r.url, { headers: { 'User-Agent': 'Mozilla/4.0' } })).text();
      const ttf = css.match(/url\((https:[^)]+\.ttf)\)/)?.[1];
      if (ttf) {
        writeFileSync(join(dir, r.file), Buffer.from(await (await fetch(ttf)).arrayBuffer()));
        status = 'ok';
      }
    } catch (e) { status = `error ${e.message}`; }
    result.push({ font: `${r.family} ${r.style}`, file: `fonts/${r.file}`, status });
  }
  console.log(JSON.stringify(result, null, 1));
  if (result.some((x) => x.status !== 'ok')) console.error('not on Google Fonts → ask the director for the font files (assets/fonts/), never substitute silently');
}

function cmdDraftJobs() {
  const G = gameDir();
  const cfg = loadCfg(G);
  const page = ensurePage(cfg);
  const list = imagesOf(G, page);
  const views = loadViews(G);
  const hasScreens = Object.values(views).some((v) => v.kind === 'screen');
  const used = new Set(), jobs = [], seen = new Set();
  const uniq = (base) => { let n = base, i = 2; while (used.has(n)) n = `${base}-${i++}`; used.add(n); return n; };
  for (const x of list) {
    if (seen.has(x.hash) || (hasScreens && !x.inScreen) || !x.visible) continue;
    seen.add(x.hash);
    jobs.push({ id: x.id, hash: x.hash, out: `images/${uniq(slugify(x.name) || 'image')}.png`, mode: 'raw', note: `${x.w}x${x.h} ${x.path}` });
  }
  for (const [k, v] of Object.entries(views)) {
    if (v.kind === 'screen') jobs.push({ id: v.node, out: `reference/screens/${k}.jpg`, mode: 'node', fmt: 'JPG', scale: 0.5 });
  }
  const out = resolve(G, arg('out', 'tools/figma/export-jobs.json'));
  writeJson(out, jobs);
  console.log(`wrote ${relative(G, out)}: ${jobs.length} jobs (${seen.size} raw images, rest screen shots). Re-file images into ui/ pets/ backgrounds/…, add node jobs for vector UI (hideTexts for buttons/pills), then export --jobs.`);
}

function runJob(page, j, root) {
  const res = JSON.parse(evalJs(page, EXPORT_JS(j)));
  const data = Buffer.from(res.b64, 'base64');
  let out = join(root, j.out);
  if (j.mode === 'raw') out = out.replace(/\.[a-z0-9]+$/i, '') + extFor(data);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, data);
  return { file: relative(root, out), node: j.id, figmaName: res.name, mode: j.mode || 'node', bytes: data.length,
    ...(res.w ? { display: { w: res.w, h: res.h } } : {}), ...(res.hash ? { imageHash: res.hash } : {}) };
}

function cmdExport() {
  const G = gameDir();
  const page = ensurePage(loadCfg(G));
  const jobsFile = arg('jobs');
  if (!jobsFile) {
    const [, id, out] = positional();
    if (!id || !out) throw new Error('export <nodeId> <out.png> | export --jobs <jobs.json>');
    const j = { id: resolveNode(G, id), out: basename(out), mode: flag('raw') ? 'raw' : 'node', fmt: /\.jpe?g$/i.test(out) ? 'JPG' : 'PNG',
      scale: Number(arg('scale', 1)), hideTexts: flag('hide-text'), unclip: flag('unclip') };
    console.log('wrote', join(dirname(resolve(out)), runJob(page, j, dirname(resolve(out))).file));
    return;
  }
  const jobs = JSON.parse(readFileSync(jobsFile, 'utf8'));
  const root = join(G, 'assets');
  const logPath = join(root, 'reference/export-log.json');
  const log = new Map(readJson(logPath, []).map((e) => [e.file, e]));
  let fail = 0;
  for (const j of jobs) {
    try {
      const e = runJob(page, j, root);
      log.set(e.file, e);
      console.log('ok', e.file, e.bytes);
    } catch (err) { fail++; console.log('FAIL', j.out, String(err.message).slice(0, 300)); }
  }
  writeJson(logPath, [...log.values()]);
  console.log(`${jobs.length - fail}/${jobs.length} exported → assets/ (log assets/reference/export-log.json)`);
  if (fail) process.exitCode = 1;
}

// Raw bitmaps keep the designer's source resolution (often 4K for a 400 px slot); scale each
// down until it still covers its Figma display box × factor. macOS sips keeps the format.
function cmdResize() {
  const G = gameDir();
  const factor = Number(arg('factor', 1));
  const log = readJson(join(G, 'assets/reference/export-log.json'), []);
  let before = 0, after = 0, n = 0;
  for (const e of log) {
    const p = join(G, 'assets', e.file);
    if (e.file.startsWith('reference/') || !e.display || !existsSync(p)) continue;
    const size = imageSize(readFileSync(p));
    if (!size) continue;
    const scale = Math.max(e.display.w / size.w, e.display.h / size.h) * factor;
    if (scale >= 1 / 1.05) continue;
    const w = Math.ceil(size.w * scale), h = Math.ceil(size.h * scale);
    before += statSync(p).size;
    execFileSync('sips', ['-z', String(h), String(w), p], { stdio: 'ignore' });
    after += statSync(p).size;
    n++;
    console.log(`${e.file}: ${size.w}x${size.h} → ${w}x${h} (slot ${e.display.w}x${e.display.h})`);
  }
  console.log(`${n} images resized, ${(before / 1048576).toFixed(1)} MB → ${(after / 1048576).toFixed(1)} MB. Run manifest again.`);
}

function cmdShot() {
  const G = gameDir();
  const [, target, out] = positional();
  if (!target || !out) throw new Error('shot <view|nodeId> <out.jpg>');
  const page = ensurePage(loadCfg(G));
  const j = { id: resolveNode(G, target), out: basename(out), fmt: /\.png$/i.test(out) ? 'PNG' : 'JPG', scale: Number(arg('scale', 0.5)) };
  console.log('wrote', join(dirname(resolve(out)), runJob(page, j, dirname(resolve(out))).file));
}

function attachAssets(G, layout) {
  const files = readJson(join(G, 'assets/manifest.json'), { files: [] }).files || [];
  const byId = new Map(), byName = new Map();
  for (const f of files) {
    if (!f.figmaNode || f.path.startsWith('reference/')) continue;
    byId.set(f.figmaNode, f.path);
    if (f.figmaName && !byName.has(f.figmaName)) byName.set(f.figmaName, f.path);
  }
  const walk = (n) => { const a = byId.get(n.id) || byName.get(n.name); if (a) n.asset = `assets/${a}`; n.children?.forEach(walk); };
  walk(layout.root);
  return layout;
}

function cmdLayout(all) {
  const G = gameDir();
  const page = ensurePage(loadCfg(G));
  const screens = screenIds(G);
  const one = (target) => attachAssets(G, JSON.parse(evalJs(page, LAYOUT_JS(resolveNode(G, target), screens))));
  if (all) {
    const views = loadViews(G);
    if (!Object.keys(views).length) throw new Error('views.json is empty');
    for (const k of Object.keys(views)) {
      writeJson(join(G, 'data/layout', `${k}.json`), one(k));
      console.log(`wrote data/layout/${k}.json`);
    }
    return;
  }
  const target = positional()[1];
  if (!target) throw new Error('layout <view|nodeId>');
  const l = one(target);
  if (arg('out')) { writeJson(resolve(arg('out')), l); console.log('wrote', arg('out')); } else console.log(JSON.stringify(l, null, 1));
}

function listFiles(dir, base = dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (name.startsWith('.') || name === 'manifest.json') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...listFiles(p, base));
    else out.push(relative(base, p));
  }
  return out.sort();
}

function cmdManifest() {
  const G = gameDir();
  const cfg = loadCfg(G);
  const A = join(G, 'assets');
  const log = new Map(readJson(join(A, 'reference/export-log.json'), []).map((e) => [e.file, e]));
  const files = listFiles(A).filter((p) => !/^reference\/(export-log|figma-[a-z-]+)\.(json|txt)$/.test(p) && !/^reference\/figma-names-backup/.test(p)).map((p) => {
    const buf = readFileSync(join(A, p));
    const e = log.get(p) || {};
    return { path: p, kind: p.split('/')[0], ...(imageSize(buf) || {}), bytes: buf.length,
      ...(e.node ? { figmaNode: e.node, figmaName: e.figmaName, mode: e.mode } : {}), ...(e.imageHash ? { imageHash: e.imageHash } : {}) };
  });
  const prev = readJson(join(A, 'manifest.json'), {});
  writeJson(join(A, 'manifest.json'), buildManifest({ cfg, slug: basename(G), files, previous: prev }));
  const mdPath = join(G, 'ASSET_MANIFEST.md');
  const md = existsSync(mdPath) ? readFileSync(mdPath, 'utf8')
    : `# ${cfg.fileName || basename(G)} — Asset Manifest\n\nSource: Figma \`${cfg.fileName || cfg.fileKey}\` (${cfg.url}). Paths are relative to \`assets/\`. Usage notes (9-slice borders, which screen, fallback) go above the generated table.\n`;
  writeFileSync(mdPath, replaceBlock(md, manifestTable(files.filter((f) => !f.path.startsWith('reference/')))));
  console.log(`assets/manifest.json: ${files.length} files (${files.filter((f) => f.figmaNode).length} from Figma); ASSET_MANIFEST.md table refreshed`);
}

function cmdGuide() {
  const G = gameDir();
  const cfg = loadCfg(G);
  const views = loadViews(G);
  const table = ['| Key | Node | Kind | Notes |', '| --- | --- | --- | --- |',
    ...Object.entries(views).map(([k, v]) => `| \`${k}\` | \`${v.node}\` | ${v.kind} | ${v.desc || ''} |`)].join('\n');
  const res = cfg.designResolution ? `${cfg.designResolution.width}×${cfg.designResolution.height}` : 'see GAME_BRIEF.md';
  // The copy under <game>/tools/figma/ has no reference/ next to it; fall back to the installed skill.
  const tpl = existsSync(SKILL_GUIDE) ? SKILL_GUIDE : join(process.env.HOME, '.agents/skills/figma-game-clone/reference/figma-guide-template.md');
  const text = readFileSync(tpl, 'utf8')
    .replaceAll('{{GAME}}', cfg.fileName || basename(G)).replaceAll('{{FILE}}', cfg.fileName || '')
    .replaceAll('{{URL}}', cfg.url).replaceAll('{{FILE_KEY}}', cfg.fileKey).replaceAll('{{ROOT}}', cfg.rootNode)
    .replaceAll('{{RES}}', res).replaceAll('{{VIEWS}}', table);
  const out = join(G, 'FIGMA_GUIDE.md');
  const keep = existsSync(out) ? readFileSync(out, 'utf8').split('<!-- game-specific -->')[1] : undefined;
  writeFileSync(out, keep === undefined ? text : `${text.split('<!-- game-specific -->')[0]}<!-- game-specific -->${keep}`);
  console.log(`wrote FIGMA_GUIDE.md (${Object.keys(views).length} views)`);
}

const COMMANDS = {
  init: cmdInit, open: cmdOpen, survey: cmdSurvey, tree: cmdTree, views: cmdViews, notes: cmdNotes, images: cmdImages,
  sigs: cmdSigs, rename: cmdRename, fonts: cmdFonts, 'draft-jobs': cmdDraftJobs, export: cmdExport, resize: cmdResize, shot: cmdShot,
  layout: () => cmdLayout(false), 'layout-all': () => cmdLayout(true), manifest: cmdManifest, guide: cmdGuide,
};

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const fn = COMMANDS[positional()[0]];
  if (!fn) {
    console.log(readFileSync(SELF, 'utf8').split('\n').slice(1, 26).join('\n'));
  } else {
    Promise.resolve().then(fn).catch((e) => { console.error('error:', e.message); process.exit(1); });
  }
}
