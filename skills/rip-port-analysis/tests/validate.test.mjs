import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { analysisPathFor, validateRipPort } from '../scripts/validate-rip-port.mjs';
import { writeBundle } from './fixture.mjs';
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
  const f=fixture(t);fs.appendFileSync(path.join(f.source,'Board.cs'),'// changed');
  assert.ok(check(f.p).errors.some(e=>e.code==='rip_evidence_stale'));
  fs.appendFileSync(path.join(f.root,'RIP_LOGIC_MAP.md'),'changed');
  assert.ok(check(f.p).errors.some(e=>e.code==='rip_report_stale'));
});
test('stubs cannot claim readable_logic and seeds cannot prove rules',t=>{
  const f=fixture(t);f.manifest.sources[0].codeAvailability='stubs';f.manifest.evidence[0].kind='seed';save(f);
  const codes=check(f.p).errors.map(e=>e.code);
  assert.ok(codes.includes('rip_false_coverage'));assert.ok(codes.includes('rip_seed_only'));
});
test('partial and asset-only research can pass with explicit unknowns',t=>{
  const f=fixture(t);f.manifest.logicCoverage='assets_only';f.manifest.sources[0].codeAvailability='none';
  f.manifest.evidence[0].kind='data';f.manifest.unknowns=['Core body unavailable'];save(f);
  assert.equal(check(f.p).ok,true);
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
