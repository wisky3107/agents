import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { analysisPathFor, validateRipPort, sha256 } from '../scripts/validate-rip-port.mjs';
import { resolveSource } from '../scripts/inventory-rip.mjs';
import { writeBundle, writeInventory } from './fixture.mjs';
function fixture(t) {
  const p=fs.mkdtempSync(path.join(os.tmpdir(),'rip-port-test-'));
  t.after(()=>fs.rmSync(p,{recursive:true,force:true}));
  return {p,...writeBundle(p)};
}
const check=p=>validateRipPort(p,'reference/demo/rip-port');
const save=f=>fs.writeFileSync(path.join(f.root,'RIP_PORT_MANIFEST.json'),JSON.stringify(f.manifest));
test('store+merged rip requires analysis without an explicit enabled flag',t=>{
  const f=fixture(t),ref='reference/demo'; fs.mkdirSync(path.join(f.p,ref,'rip')); fs.writeFileSync(path.join(f.p,ref,'rip/RIP_PACK.json'),'{}');
  assert.equal(analysisPathFor(f.p,{brief:{source:'store',reference_path:ref}}),`${ref}/rip-port`);
  assert.equal(analysisPathFor(f.p,{brief:{source:'idea'}}),null);
  assert.equal(check(f.p).ok,true);
});
test('analyst cannot bypass coordinator review',t=>{
  const f=fixture(t); f.manifest.status='analyzed';save(f);
  assert.equal(check(f.p).ok,false);
  assert.equal(validateRipPort(f.p,'reference/demo/rip-port',{allowAnalyzed:true}).ok,true);
});
test('source edits and report edits invalidate the bundle',t=>{
  const f=fixture(t);fs.appendFileSync(path.join(f.up,'Assets/Scripts/Game/Board.cs'),'// changed');
  assert.ok(check(f.p).errors.some(e=>e.code==='rip_evidence_stale'));
  fs.appendFileSync(path.join(f.root,'RIP_LOGIC_MAP.md'),'changed');
  assert.ok(check(f.p).errors.some(e=>e.code==='rip_report_stale'));
});
test('stubs cannot claim readable_logic and seeds cannot prove rules',t=>{
  const f=fixture(t);f.manifest.sources[0].codeAvailability='stubs';f.manifest.evidence[0].kind='seed';save(f);
  const codes=check(f.p).errors.map(e=>e.code);
  assert.ok(codes.includes('rip_false_coverage'));assert.ok(codes.includes('rip_seed_only'));
});
test('asset-only research passes only when the inventory has no scripts or serialized fields',t=>{
  const f=fixture(t);fs.rmSync(path.join(f.up,'Assets/Scripts'),{recursive:true});fs.rmSync(path.join(f.up,'Assets/Data'),{recursive:true});
  f.manifest.logicCoverage='assets_only';f.manifest.sources[0].codeAvailability='none';
  f.manifest.evidence[0]={id:'E-001',source:'main',tree:'primaryContent',path:'Assets/Mesh/Token.glb',sha256:sha256(path.join(f.pc,'Assets/Mesh/Token.glb')),kind:'asset'};
  f.manifest.claims[0].label='PORT_DECISION';f.manifest.unknowns=['Core body unavailable'];
  f.manifest.inventoryCoverage=[];writeInventory(f);save(f);
  assert.deepEqual(check(f.p).errors,[]);
});
test('multi-source request changes invalidate an old single-source report',t=>{
  const f=fixture(t);
  assert.equal(validateRipPort(f.p,'reference/demo/rip-port',{expectedSources:[...f.manifest.sources,{id:'other',root:f.source}]}).ok,false);
});
test('evidence traversal and unknown claim references fail',t=>{
  const f=fixture(t);f.manifest.evidence[0].path='../reference/demo/rip-port/RIP_LOGIC_MAP.md';
  f.manifest.claims[0].evidence=['E-missing'];save(f);
  const codes=check(f.p).errors.map(e=>e.code);
  assert.ok(codes.includes('rip_evidence_missing'));assert.ok(codes.includes('rip_claim_citation'));
});
test('schema v1 bundles are legacy and must be re-analyzed',t=>{
  const f=fixture(t);f.manifest.schemaVersion=1;save(f);
  assert.ok(check(f.p).errors.some(e=>e.code==='rip_schema_legacy'));
});
test('missing or edited inventory fails',t=>{
  const f=fixture(t);fs.appendFileSync(path.join(f.root,'RIP_INVENTORY.json'),' ');
  assert.ok(check(f.p).errors.some(e=>e.code==='rip_inventory_stale'));
  fs.rmSync(path.join(f.root,'RIP_INVENTORY.json'));
  assert.ok(check(f.p).errors.some(e=>e.code==='rip_inventory_missing'));
});
test('assets_only is rejected when stub scripts and serialized MonoBehaviours exist',t=>{
  const f=fixture(t);fs.writeFileSync(path.join(f.up,'Assets/Scripts/Game/Board.cs'),'// Dummy class\nclass Board {}\n');
  f.manifest.evidence[0].sha256=sha256(path.join(f.up,'Assets/Scripts/Game/Board.cs'));f.manifest.evidence[0].kind='data';
  f.manifest.claims[0].label='INFERRED';f.manifest.logicCoverage='assets_only';f.manifest.sources[0].codeAvailability='stubs';f.manifest.unknowns=['bodies'];
  writeInventory(f);save(f);
  assert.deepEqual(check(f.p).errors.map(e=>e.code),['rip_coverage_floor']);
  f.manifest.logicCoverage='partial';save(f);assert.equal(check(f.p).ok,true);
});
test('codeAvailability must match the inventory dummy count',t=>{
  const f=fixture(t);f.manifest.sources[0].codeAvailability='stubs';save(f);
  assert.ok(check(f.p).errors.some(e=>e.code==='rip_code_availability'));
});
test('every nonzero inventory category needs a mapped or excluded disposition',t=>{
  const f=fixture(t);f.manifest.inventoryCoverage=f.manifest.inventoryCoverage.filter(d=>d.category!=='glb');save(f);
  assert.ok(check(f.p).errors.some(e=>e.code==='rip_inventory_unmapped'&&/glb/.test(e.message)));
  f.manifest.inventoryCoverage.push({category:'glb',status:'excluded',reason:''});save(f);
  assert.ok(check(f.p).errors.some(e=>e.code==='rip_inventory_disposition'));
  f.manifest.inventoryCoverage.at(-1).reason='Port uses 2D sprites';save(f);assert.equal(check(f.p).ok,true);
});
test('IL2CPP metadata failure in assetripper.log requires codeRecovery',t=>{
  const f=fixture(t);fs.appendFileSync(f.log,"Could not initialize assembly manager. Switching to the 'Unknown' scripting backend.\n");writeInventory(f);save(f);
  assert.ok(check(f.p).errors.some(e=>e.code==='rip_code_recovery'));
  f.manifest.codeRecovery='Encrypted global-metadata.dat; dump with Il2CppDumper after runtime decrypt';save(f);assert.equal(check(f.p).ok,true);
});
test('PrimaryContent evidence is asset-only, output evidence is seed-only, root must be ExportedProject',t=>{
  const f=fixture(t);f.manifest.evidence.push({id:'E-002',source:'main',tree:'output',path:'levels/level_001.json',sha256:sha256(path.join(f.out,'levels/level_001.json')),kind:'data'});
  f.manifest.claims[0].evidence.push('E-002');save(f);
  assert.ok(check(f.p).errors.some(e=>e.code==='rip_evidence_tree'));
  f.manifest.evidence[1].kind='seed';f.manifest.sources[0].root=path.dirname(path.dirname(f.up));save(f);
  const codes=check(f.p).errors.map(e=>e.code);
  assert.ok(codes.includes('rip_source_root'));assert.ok(!codes.includes('rip_evidence_tree'));
});
test('recheck detects rip trees that changed after inventory',t=>{
  const f=fixture(t);fs.writeFileSync(path.join(f.pc,'Assets/Mesh/Dice.glb'),'glb');
  assert.equal(check(f.p).ok,true);
  assert.ok(validateRipPort(f.p,'reference/demo/rip-port',{recheckInventory:true}).errors.some(e=>e.code==='rip_inventory_drift'));
});
test('source resolution prefers output/manifest.json source_paths and never PrimaryContent as root',t=>{
  const f=fixture(t),dir=path.join(f.p,'fixture-rip');
  for (const input of [dir,path.join(dir,'output'),path.join(dir,'ripped'),f.up]) assert.equal(resolveSource(input).unityProject,f.up);
  assert.equal(resolveSource(path.join(dir,'output')).primaryContent,f.pc);
});
