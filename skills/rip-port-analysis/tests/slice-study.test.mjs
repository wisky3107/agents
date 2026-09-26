import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { validateSliceStudy, studyTopicErrors, SLICE_STUDY } from '../scripts/validate-rip-port.mjs';
import { writeStudy, saveStudy, TOPICS, PRESENTATION as P } from './fixture.mjs';
function fixture(t) {
  const p=fs.mkdtempSync(path.join(os.tmpdir(),'rip-study-test-'));
  t.after(()=>fs.rmSync(p,{recursive:true,force:true}));
  return {p,...writeStudy(p)};
}
const check=(s,o={})=>validateSliceStudy(s.p,'reference/demo/rip-port','S05',{topics:TOPICS,...o});
const codes=(s,o)=>check(s,o).errors.map(e=>e.code);
test('a reviewed study pinned to parent, slice and extracts passes; analyzed needs the flag',t=>{
  const s=fixture(t), r=check(s);
  assert.deepEqual(r.errors,[]); assert.equal(r.parentHash,s.hash); assert.equal(r.studyPath,'reference/demo/rip-port/slices/S05');
  s.study.status='analyzed'; saveStudy(s);
  assert.deepEqual(codes(s),['rip_study_unreviewed']); assert.equal(check(s,{allowAnalyzed:true}).ok,true);
});
test('parent re-analysis, slice amendment and source edits stale the study',t=>{
  const s=fixture(t);
  s.manifest.unknowns=['new']; fs.writeFileSync(path.join(s.root,'RIP_PORT_MANIFEST.json'),JSON.stringify(s.manifest));
  assert.deepEqual(codes(s),['rip_study_parent_stale']);
  const s2=fixture(t); fs.appendFileSync(path.join(s2.p,s2.sliceFile),'amended\n');
  assert.deepEqual(codes(s2),['rip_study_slice_stale']);
  const s3=fixture(t); fs.appendFileSync(path.join(s3.up,P.mat),'\n');
  assert.deepEqual(codes(s3),['rip_study_evidence_stale']);
});
test('Unity YAML needs an untouched extract of the cited file',t=>{
  const s=fixture(t), e=s.study.evidence[0];
  delete e.extract; saveStudy(s); assert.deepEqual(codes(s),['rip_study_extract_missing']);
  const s2=fixture(t); fs.appendFileSync(path.join(s2.dir,s2.study.evidence[0].extract),' ');
  assert.deepEqual(codes(s2),['rip_study_extract_stale','rip_study_extract_stale']);
  const s3=fixture(t); s3.study.evidence[0]={...s3.study.evidence[0],path:P.shop,sha256:s3.study.evidence[1].sha256}; saveStudy(s3);
  assert.ok(codes(s3).includes('rip_study_extract_mismatch'));
});
test('dispositions: adopt needs evidence labels, adapt a deviation, exclude a reason',t=>{
  const s=fixture(t); s.study.claims[0].label='UNKNOWN'; delete s.study.claims[1].deviation;
  s.study.claims.push({id:'RP-S05-003',label:'UNKNOWN',summary:'Open timing',evidence:[],disposition:'exclude'}); s.report+='RP-S05-003\n'; saveStudy(s);
  assert.deepEqual(codes(s),['rip_study_disposition','rip_study_disposition','rip_study_disposition']);
  s.study.claims[2].disposition='copy'; saveStudy(s); assert.ok(check(s).errors.some(e=>e.code==='rip_study_disposition'&&/RP-S05-003/.test(e.message)));
});
test('claims cite study or parent evidence and refine parent claims only',t=>{
  const s=fixture(t); s.study.claims[0].evidence=['E-001']; saveStudy(s); assert.equal(check(s).ok,true);
  s.study.claims[0].evidence=['E-S05-009']; s.study.claims[1].refines=['RP-999']; saveStudy(s);
  assert.deepEqual(codes(s),['rip_study_claim_citation','rip_study_seed_only','rip_study_refines']);
});
test('slice topics must all be answered and derived topics cannot pose as slice topics',t=>{
  const s=fixture(t);
  assert.deepEqual(codes(s,{topics:[...TOPICS,{id:'board-camera',kind:'camera',questions:['FOV?']}]}),['rip_study_topic_uncovered']);
  assert.deepEqual(codes(s,{topics:null}),['rip_study_topic_unknown']);
  s.study.topics[0].claims=[]; saveStudy(s); assert.ok(codes(s).includes('rip_study_topic_claims'));
});
test('the report cites every claim and topic and no unknown RP IDs',t=>{
  const s=fixture(t); s.report='# S05\nlockbox-open-vfx RP-S05-001 RP-S05-077\n'; saveStudy(s);
  assert.deepEqual(codes(s),['rip_study_unknown_claim','rip_study_unused_claim','rip_study_topic_unreported']);
  fs.appendFileSync(path.join(s.dir,'RIP_SLICE_STUDY.md'),'edit'); assert.ok(codes(s).includes('rip_study_report_stale'));
});
test('topic shape: kebab ids, known kinds, questions and relative source dirs',()=>{
  assert.deepEqual(studyTopicErrors(TOPICS),[]); assert.deepEqual(studyTopicErrors([]),[]);
  assert.deepEqual(studyTopicErrors({}),['rip_study must be a list of topics']);
  assert.equal(studyTopicErrors([{id:'Bad Id',kind:'vfx',questions:['q']},{id:'a',kind:'shader',questions:[]},{id:'a',kind:'vfx',questions:['q']},{id:'b',kind:'layout',questions:['q'],source_dirs:['/abs','Assets/../x']}]).length,5);
});
test('CLI reads slice topics and skips slices that opt out',t=>{
  const s=fixture(t), bin=new URL('../scripts/validate-rip-port.mjs',import.meta.url).pathname;
  const run=()=>{ try { return JSON.parse(execFileSync(process.execPath,[bin,s.p,'demo','--slice','S05'],{encoding:'utf8'})); } catch(e) { return JSON.parse(e.stdout); } };
  assert.equal(run().ok,true);
  fs.writeFileSync(path.join(s.p,s.sliceFile),'---\nid: S05\nrip_study: []\n---\n');
  assert.equal(run().skipped,'slice declares rip_study: []');
  fs.rmSync(path.join(s.dir,SLICE_STUDY));
  fs.writeFileSync(path.join(s.p,s.sliceFile),'---\nid: S05\n---\n');
  assert.deepEqual(run().errors.map(e=>e.code),['rip_study_missing']);
});
