import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { extractUnity, parseUnityYaml, presentationIndex, renderSummary, sha256 } from '../scripts/extract-unity.mjs';
import { writePresentation, PRESENTATION as P } from './fixture.mjs';
function root(t) {
  const r=fs.mkdtempSync(path.join(os.tmpdir(),'extract-unity-test-'));
  t.after(()=>fs.rmSync(r,{recursive:true,force:true}));
  writePresentation(r); return r;
}
const find=(n,name)=>n.name===name?n:(n.children??[]).map(c=>find(c,name)).find(Boolean);
test('documents keep class, fileID and stripped flags',t=>{
  const docs=parseUnityYaml(fs.readFileSync(path.join(root(t),P.shop),'utf8'));
  assert.deepEqual(docs.map(d=>[d.className,d.fileId,d.stripped]),[['GameObject','300',false],['RectTransform','301',false],['MonoBehaviour','302',false],['PrefabInstance','400',false],['Transform','402',true]]);
});
test('particle hierarchy decodes transforms, minMax values, modules, noFields and materials',t=>{
  const r=root(t), x=extractUnity({root:r,file:P.fx});
  assert.equal(x.fileSha256,sha256(fs.readFileSync(path.join(r,P.fx))));
  const fx=x.tree[0], glow=find(fx,'Glow');
  assert.equal(fx.layer,5); assert.deepEqual(fx.xf,{p:{x:0,y:1,z:0}});
  assert.deepEqual(fx.components,[{c:'MB:FxDriver',id:'102',script:'Assets/Scripts/Game/FxDriver.cs',noFields:true}]);
  assert.equal(glow.active,false); assert.equal(glow.path,'FXOpen/Glow'); assert.equal(glow.xf.e.x,90); assert.deepEqual(glow.xf.s,{x:2,y:2,z:2});
  const [ps,psr]=glow.components;
  assert.equal(ps.main.moveWithTransform,0); assert.equal(ps.main.scalingMode,1);
  assert.deepEqual(ps.main.initial.startLifetime,{const:0.2}); assert.deepEqual(ps.main.initial.startSize,{min:8,max:12});
  assert.deepEqual(ps.main.initial.startRotation,{const:1.5708}); assert.deepEqual(ps.main.initial.startColor,{color:{r:1,g:0.8,b:0.2,a:1}});
  assert.deepEqual(Object.keys(ps.modules),['Shape','Emission','Size','Color']);
  assert.equal(ps.modules.Shape.shape,'cone'); assert.deepEqual(ps.modules.Emission.m_Bursts[0].countCurve,{const:2});
  assert.deepEqual(ps.modules.Size.curve,{curve:[[0,0,0,2],[1,1,2,0]],mult:1});
  assert.deepEqual(ps.modules.Color.gradient,{gradient:{mode:'blend',colors:[[0,1,1,1],[1,1,0,0]],alphas:[[0,1],[1,0]]}});
  assert.equal(psr.renderMode,'billboard'); assert.deepEqual(psr.materials,[P.mat]); assert.equal(psr.sortingOrder,3);
  const m=x.materials[P.mat];
  assert.equal(m.sha256,sha256(fs.readFileSync(path.join(r,P.mat)))); assert.equal(m.shader,'builtin:extra#200');
  assert.deepEqual(m.textures,{_MainTex:{tex:'Assets/Fx/Glow.png'}}); assert.deepEqual(m.colors,{_TintColor:{r:1,g:0.5,b:0,a:0.5}});
  assert.deepEqual(m.keywords,['_ALPHAPREMULTIPLY_ON']);
});
test('rect transforms, MonoBehaviour fields and nested prefab instances',t=>{
  const shop=extractUnity({root:root(t),file:P.shop}).tree[0];
  assert.deepEqual(shop.rect,{anchorMin:{x:0,y:0},anchorMax:{x:1,y:1},anchoredPosition:{x:0,y:-20},sizeDelta:{x:-40,y:-40},pivot:{x:0.5,y:0.5}});
  assert.deepEqual(shop.components[0].fields,{columns:3,cellSize:{x:217,y:315}});
  const inst=shop.children[0];
  assert.equal(inst.name,'LockboxFX'); assert.equal(inst.path,'Shop/LockboxFX'); assert.equal(inst.prefab,P.fx);
  assert.deepEqual(JSON.parse(JSON.stringify(inst.overrides[1])),{target:`${P.fx}#101`,prop:'m_LocalPosition.y',value:3});
});
test('node and class selection, depth clipping and summary',t=>{
  const r=root(t);
  assert.deepEqual(extractUnity({root:r,file:P.fx,node:'#200'}).tree.map(n=>n.path),['FXOpen/Glow']);
  assert.throws(()=>extractUnity({root:r,file:P.fx,node:'Missing'}),/matched nothing/);
  const only=extractUnity({root:r,file:P.fx,only:['Transform','ParticleSystemRenderer'],materials:false});
  assert.deepEqual(only.components.map(c=>[c.node,c.c]),[['FXOpen','Transform'],['FXOpen/Glow','ParticleSystemRenderer'],['FXOpen/Glow','Transform']]);
  assert.equal(only.materials,undefined);
  const clipped=extractUnity({root:r,file:P.fx,maxDepth:0});
  assert.equal(clipped.tree[0].truncatedDescendants,1);
  assert.match(renderSummary(clipped),/FXOpen #100 {2}\[MB:FxDriver\] {2}…1 more/);
  assert.throws(()=>extractUnity({root:r,file:'../outside.prefab'}),/inside --root/);
});
test('clips keep stepped keys and controllers resolve states, conditions and motions',t=>{
  const r=root(t), clip=extractUnity({root:r,file:P.clip}).docs[0], ctrl=extractUnity({root:r,file:P.ctrl}).docs;
  assert.equal(clip.sampleRate,60); assert.equal(clip.stop,0.25); assert.equal(clip.loop,false); assert.equal(clip.lastKey,0.25);
  assert.deepEqual(clip.curves[0].keys[1],[0.25,{x:0,y:1,z:0},{x:'Infinity',y:'Infinity',z:'Infinity'},{x:0,y:0,z:0}]);
  assert.equal(ctrl.length,1);
  assert.deepEqual(ctrl[0].params,[{name:'open',type:'trigger',default:0},{name:'speed',type:'float',default:1.5}]);
  const layer=ctrl[0].layers[0];
  assert.equal(layer.defaultState,'Idle');
  assert.deepEqual(layer.states,[{name:'Idle',motion:null,speed:1,transitions:[{to:'Open',conditions:['open'],duration:0.1,fixed:true}]},{name:'Open',motion:P.clip,speed:1}]);
});
test('presentation index counts classes and scripts per directory',t=>{
  const r=root(t), idx=presentationIndex(r,{files:true});
  assert.equal(idx.dirs['Assets/Fx'].prefabs,1); assert.equal(idx.dirs['Assets/Fx'].materials,1);
  assert.deepEqual(idx.dirs['Assets/Fx'].classes,{ParticleSystem:1,ParticleSystemRenderer:1});
  assert.deepEqual(idx.dirs['Assets/UI'].scripts,{FxDriver:1}); assert.deepEqual(idx.dirs['Assets/Anim'],{prefabs:0,scenes:0,clips:1,controllers:1,materials:0,playables:0,classes:{},scripts:{}});
  assert.deepEqual(idx.files.map(f=>f.path),[P.fx,P.shop]);
});
test('CLI --out reports the extract and source hashes a study cites',t=>{
  const r=root(t), out=path.join(r,'x/glow.json');
  const res=JSON.parse(execFileSync(process.execPath,[new URL('../scripts/extract-unity.mjs',import.meta.url).pathname,'--root',r,'--file',P.fx,'--node','#200','--out',out],{encoding:'utf8'}));
  assert.equal(res.sha256,sha256(fs.readFileSync(out))); assert.equal(res.source,P.fx); assert.equal(res.sourceSha256,sha256(fs.readFileSync(path.join(r,P.fx))));
  assert.equal(JSON.parse(fs.readFileSync(out,'utf8')).file,P.fx);
});
