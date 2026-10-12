#!/usr/bin/env node
// Lay a finished kit (manifest.json) out on the open Figma file through Orca's browser (Plugin API).
//   figma-kit.mjs --manifest <dir>/manifest.json [--file-key <key>] [--x 0 --y -6000]
// Builds one top-level frame "UI Kit · <name>": a tile per row (image at preview size + label with
// size and nine-slice borders), and an "Image library · <name>" hidden frame whose rectangles hold
// each image at full size, named by row, so other scripts can reuse the image hashes by name.
// Re-running replaces both frames. One `orca eval` per image keeps every call under the argv limit.
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const manPath = resolve(arg('manifest', ''));
const man = JSON.parse(readFileSync(manPath, 'utf8'));
const dir = dirname(manPath);

// Figma tab plumbing lives in figma-game-clone's CLI (finds / opens the tab, waits for `figma`).
const { connectFigma } = await import(join(process.env.HOME, '.agents/skills/figma-game-clone/scripts/figma.mjs'));
const ev = connectFigma({ fileKey: arg('file-key') }).eval;

const LIB = 'Image library · ' + man.name, KIT = 'UI Kit · ' + man.name;
ev(`(async()=>{const pg=figma.currentPage;await pg.loadAsync();for(const n of pg.children.filter(n=>n.name===${JSON.stringify(LIB)}||n.name===${JSON.stringify(KIT)}))n.remove();
const f=figma.createFrame();f.name=${JSON.stringify(LIB)};f.x=-6000;f.resize(100,100);f.fills=[];f.visible=false;return 'ok'})()`);
for (const r of man.rows) {
  const b64 = readFileSync(join(dir, r.file)).toString('base64');
  if (b64.length > 900_000) { console.log(`skip ${r.name}: ${Math.round(b64.length / 1024)} KB base64 is over the eval limit`); continue; }
  ev(`(async()=>{const lib=figma.currentPage.children.find(n=>n.name===${JSON.stringify(LIB)});const img=figma.createImage(figma.base64Decode(${JSON.stringify(b64)}));
const r=figma.createRectangle();r.name=${JSON.stringify(r.name)};r.resize(${r.w},${r.h});r.fills=[{type:'IMAGE',imageHash:img.hash,scaleMode:'FILL'}];lib.appendChild(r);return 'ok'})()`);
  console.log('uploaded', r.name);
}
const rows = JSON.stringify(man.rows.map((r) => ({ name: r.name, w: r.w, h: r.h, b: r.borderPx ? Object.values(r.borderPx).join(',') : '', be: r.backend })));
console.log(ev(`(async()=>{const pg=figma.currentPage;await figma.loadFontAsync({family:'Inter',style:'Medium'});await figma.loadFontAsync({family:'Inter',style:'Bold'});
const lib=pg.children.find(n=>n.name===${JSON.stringify(LIB)});const hash=Object.fromEntries(lib.children.map(n=>[n.name,n.fills[0].imageHash]));
const kit=figma.createFrame();kit.name=${JSON.stringify(KIT)};kit.x=${Number(arg('x', 0))};kit.y=${Number(arg('y', -6000))};kit.fills=[{type:'SOLID',color:{r:.07,g:.05,b:.16}}];kit.cornerRadius=32;
const t=figma.createText();t.fontName={family:'Inter',style:'Bold'};t.characters=${JSON.stringify(KIT)};t.fontSize=56;t.fills=[{type:'SOLID',color:{r:1,g:1,b:1}}];t.x=48;t.y=40;kit.appendChild(t);
const CW=420,CH=360,COLS=6;let i=0;
for(const r of ${rows}){if(!hash[r.name])continue;const cx=48+(i%COLS)*(CW+24),cy=150+Math.floor(i/COLS)*(CH+24);i++;
 const cell=figma.createFrame();cell.name=r.name;cell.x=cx;cell.y=cy;cell.resize(CW,CH);cell.cornerRadius=20;cell.fills=[{type:'SOLID',color:{r:.12,g:.09,b:.26}}];kit.appendChild(cell);
 const k=Math.min((CW-40)/r.w,(CH-110)/r.h,1);const im=figma.createRectangle();im.name='image';im.resize(r.w*k,r.h*k);im.x=(CW-r.w*k)/2;im.y=20+(CH-110-r.h*k)/2;
 im.fills=[{type:'IMAGE',imageHash:hash[r.name],scaleMode:'FILL'}];cell.appendChild(im);
 const l=figma.createText();l.fontName={family:'Inter',style:'Medium'};l.fontSize=22;l.lineHeight={unit:'PERCENT',value:130};l.fills=[{type:'SOLID',color:{r:.85,g:.82,b:.95}}];
 l.characters=r.name+'\\n'+r.w+'×'+r.h+' · '+r.be+(r.b?'\\nslice '+r.b:'');l.x=20;l.y=CH-84;cell.appendChild(l);}
kit.resize(48*2+COLS*(CW+24)-24,150+Math.ceil(i/COLS)*(CH+24)+24);figma.viewport.scrollAndZoomIntoView([kit]);return 'kit frame: '+i+' tiles'})()`));
