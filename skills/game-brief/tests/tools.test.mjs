import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { indexSource } from '../scripts/index-source.mjs';
import { update, watch } from '../scripts/brief-progress.mjs';
import { validate, overlap } from '../scripts/validate-contracts.mjs';
import { validate as coverage } from '../scripts/validate-gameplay-coverage.mjs';
import { scaffold } from '../scripts/scaffold-contracts.mjs';
import { stringify } from 'yaml';
import { ROOTS, reviewHash, local, ids } from '../scripts/lib.mjs';
import { writeBundle } from '../../rip-port-analysis/tests/fixture.mjs';
import { sha256 } from '../../rip-port-analysis/scripts/validate-rip-port.mjs';

const put = (p,f,s) => { fs.mkdirSync(path.dirname(path.join(p,f)),{recursive:true}); fs.writeFileSync(path.join(p,f),s); };
function validProject() {
  const p = project();
  for(const f of ROOTS) if(f !== 'MILESTONES.md') put(p,f,`# ${f}\nAuthored content\n`);
  const m = {slices:['S01','S02'],dag:{S02:['S01']},parallel_ok:[],v1_slice:'S01',release_slice:'S02',stop_when:'RC pass'};
  put(p,'MILESTONES.md','```yaml\n'+stringify(m)+'```\n');
  for(const id of m.slices) {
    const s = {id,name:id==='S01'?'polished-playable':'release-polish',one_liner:'Clear board',size:'M',depends_on:m.dag[id]||[],unlocks:id==='S01'?['S02']:[],needs_director_ok:false,player_outcome:'Player clears the board',scope:{in:['clear'],out:['shop']},paths:{code:[`assets/${id}.ts`],art:[],scene_objects:[]},assets:{'2d':[],'3d':[],vfx:[],audio:[]},acceptance:[{text:'Tap clears board',evidence:'ASSUMPTION'}],feel_rows:[],runtime_checks:['no errors'],playtest:['tap then clear'],change_budget:{files:1,lines:100,nodes:1,assets:0,tripo_credits:0},risks:[],release_items:id==='S01'?['RC-01']:['RC-02']};
    put(p,`slices/${id}-slice.md`,'---\n'+stringify(s)+'---\n\n## Port evidence\nreference/demo/rip-port\n'+sha256(path.join(p,'reference/demo/rip-port/RIP_PORT_MANIFEST.json'))+'\nRP-001\n');
  }
  put(p,'RELEASE_CHECKLIST.md','| id | area | check | closed_by | how to verify |\n|---|---|---|---|---|\n| RC-01 | input | tap | S01 | tap |\n| RC-02 | ship | build | S02 | build |\n');
  put(p,'EXPECT_GAMEPLAY_VISUAL.md','# S01 visual target\n[screen](reference/demo/iphone/01.jpg)\n## Game feel / VFX table\n\n| ID / interaction | VFX |\n|---|---|\n| tap | ring |\n');
  put(p,'ASSET_MANIFEST.md','| Stem | Source | Priority | Path |\n|---|---|---|---|\n| impact | import | P0 | reference/demo/rip/images_ingame/Fx.png |\n');
  put(p,'SCOPE.md','budget_count: code_only\nbudget_mode: advisory\n');
  put(p,'HOW_TO.md','RP-001: port zero-count win behavior, S01 scenario.');
  put(p,'ARCHITECTURE.md','RP-001: Board.Won maps to WinEvaluator.');
  return p;
}

function project() {
  const p = fs.mkdtempSync(path.join(os.tmpdir(), 'game-brief-'));
  fs.mkdirSync(path.join(p, 'reference/demo/rip/levels'), { recursive: true });
  fs.mkdirSync(path.join(p, 'reference/demo/rip/images_ingame'), { recursive: true });
  fs.mkdirSync(path.join(p, 'reference/demo/models'), { recursive: true });
  fs.mkdirSync(path.join(p, 'reference/demo/iphone'), { recursive: true });
  fs.writeFileSync(path.join(p, 'AGENT_NOTES.md'), `---\nbrief:\n  source: store\n  reference_path: reference/demo\n  rip_path: reference/demo/rip\n  orientation: portrait 720x1280\nrelease:\n  goal: playable\n---\n`);
  fs.writeFileSync(path.join(p, 'reference/demo/rip/RIP_PACK.json'), '{}');
  fs.writeFileSync(path.join(p, 'reference/demo/rip/images_ingame_catalog.json'), JSON.stringify({ entries: [{ file: 'Fx.png', priority: 'P0', category: 'fx' }, { file: 'Old.png', priority: 'P3' }] }));
  fs.writeFileSync(path.join(p, 'reference/demo/rip/meshes_catalog.json'), JSON.stringify({ entries: [{ file: 'Prop.glb', priority: 'P0', category: 'prop' }] }));
  fs.writeFileSync(path.join(p, 'reference/demo/rip/images_ingame/Fx.png'), 'x');
  fs.writeFileSync(path.join(p, 'reference/demo/models/Prop.glb'), 'x');
  fs.writeFileSync(path.join(p, 'reference/demo/rip/levels/one.json'), JSON.stringify({ Tables: [{ Placements: [{ PropId: 'can' }] }] }));
  fs.writeFileSync(path.join(p, 'reference/demo/iphone/01.jpg'), 'x');
  writeBundle(p);
  return p;
}
test('index-source selects bounded candidates and records schema keys', () => {
  const p = project(), r = indexSource(p);
  assert.equal(r.ok, true); assert.equal(r.index.contractDepth, 'full');
  assert.equal(r.index.sampleMeshes[0].path, 'reference/demo/models/Prop.glb');
  assert.ok(r.index.levels[0].keys.some(k => k.includes('Tables')));
  assert.ok(fs.existsSync(path.join(p, 'docs/brief-input-index.json')));
});
test('store clone with rip cannot index or pass contracts without analysis, even with flag omitted',()=>{
  const p=validProject();
  fs.unlinkSync(path.join(p,'reference/demo/rip-port/RIP_PORT_MANIFEST.json'));
  assert.throws(()=>indexSource(p),/rip-port-analysis/);
  assert.ok(validate(p).errors.some(e=>e.code==='rip_analysis_missing'));
});
test('port source drift blocks contracts and unpinned slices are rejected',()=>{
  const p=validProject(),f='slices/S01-slice.md';
  put(p,f,fs.readFileSync(path.join(p,f),'utf8').replace(/\b[a-f0-9]{64}\b/,'old-pin'));
  assert.ok(validate(p).errors.some(e=>e.code==='rip_slice_unpinned'));
  fs.appendFileSync(path.join(p,'fixture-rip/ripped/UnityProject/ExportedProject/Assets/Scripts/Game/Board.cs'),'// source changed');
  assert.ok(validate(p).errors.some(e=>e.code==='rip_evidence_stale'));
});
test('forensic report changes invalidate brief review hash',()=>{
  const p=validProject(),before=reviewHash(p);
  fs.appendFileSync(path.join(p,'reference/demo/rip-port/RIP_PORT_GAPS.md'),'New unknown');
  assert.notEqual(reviewHash(p),before);
});
test('explicit custom rip path is preserved during port indexing',()=>{
  const p=project();
  fs.renameSync(path.join(p,'reference/demo/rip'),path.join(p,'reference/demo/custom-rip'));
  const notes=fs.readFileSync(path.join(p,'AGENT_NOTES.md'),'utf8');
  put(p,'AGENT_NOTES.md',notes.replace('rip_path: reference/demo/rip','rip_path: reference/demo/custom-rip'));
  assert.equal(indexSource(p).index.ripPath,'reference/demo/custom-rip');
});
test('merged slices retain historical analysis pins after a reviewed amendment',()=>{
  const p=validProject(),f='slices/S01-slice.md';
  put(p,f,fs.readFileSync(path.join(p,f),'utf8').replace(/\b[a-f0-9]{64}\b/,'historical-analysis-hash'));
  put(p,'AGENT_NOTES.md',fs.readFileSync(path.join(p,'AGENT_NOTES.md'),'utf8').replace('release:\n','release:\n  slices:\n    S01: merged\n'));
  assert.deepEqual(validate(p).errors,[]);
});
test('progress updates fingerprints and detects stale work', () => {
  const p = project(); indexSource(p);
  const start = Date.now(), id = update(p,{init:true},start).progress.runId;
  update(p,{'run-id':id,phase:'indexed'}, start);
  watch(p,{},start);
  update(p,{'run-id':id,phase:'indexed'}, start+11*60000);
  assert.equal(watch(p,{},start+11*60000).action,'nudge_first_contract');
  update(p,{'run-id':id,'ack-nudge':'write core'},start+11*60000);
  assert.equal(watch(p,{},start+12*60000).action,'wait_after_nudge');
  assert.equal(watch(p,{},start+19*60000).action,'recovery_candidate');
  put(p,'GAME_BRIEF.md','A real authored core loop');
  assert.equal(watch(p,{},start+20*60000).action,'continue');
  assert.throws(()=>update(p,{init:true}),/Unfinished/);
  assert.throws(()=>update(p,{'run-id':'stale',phase:'indexed'}),/stale/);
});
test('idea, media and rip indexing; cache invalidation and missing inputs',()=>{
  const p=project(); const r=indexSource(p); assert.equal(indexSource(p).cached,true);
  put(p,'reference/demo/rip/images_ingame_catalog.json',JSON.stringify({entries:[]}));
  assert.notEqual(indexSource(p).index.inputFingerprint,r.index.inputFingerprint);
  put(p,'AGENT_NOTES.md','```yaml\nbrief:\n  source: idea\nrelease:\n  goal: playable\n```\n');
  put(p,'reference/demo-brief/IDEA.md','Tap to clear');
  assert.equal(indexSource(p,{slug:'demo'}).index.source,'idea');
  assert.throws(()=>indexSource(p,{slug:'missing'}),/Missing idea/);
  put(p,'AGENT_NOTES.md','```yaml\nbrief:\n  source: media\n  reference_path: reference/demo\nrelease:\n  goal: playable\n```\n');
  assert.equal(indexSource(p).index.source,'media');
});
test('scaffolding preserves authored files and cannot pass the gate',()=>{
  const p=project(); put(p,'GAME_BRIEF.md','Do not overwrite');
  scaffold(p,{slices:6}); assert.equal(fs.readFileSync(path.join(p,'GAME_BRIEF.md'),'utf8'),'Do not overwrite');
  assert.ok(validate(p).errors.some(e=>e.code==='unfinished_scaffold'));
  assert.equal(scaffold(p,{slices:6}).written.length,0);
});
test('port slices pose rip_study topics; bad shapes and unknown source dirs fail',()=>{
  const p=validProject(),f='slices/S02-slice.md',text=fs.readFileSync(path.join(p,f),'utf8'),up=path.join(p,'fixture-rip/ripped/UnityProject/ExportedProject');
  put(p,'AGENT_NOTES.md',fs.readFileSync(path.join(p,'AGENT_NOTES.md'),'utf8').replace('release:\n',`rip_port:\n  sources:\n    - id: main\n      root: ${up}\n      unity_project: ${up}\nrelease:\n`));
  const topics=t=>put(p,f,text.replace('risks: []\n',`rip_study:\n${t}risks: []\n`));
  topics('  - id: open-vfx\n    kind: vfx\n    questions: [How is the open glow built?]\n    source_dirs: [Assets/Scripts]\n');
  assert.deepEqual(validate(p).errors,[]);
  topics('  - id: Open VFX\n    kind: shader\n    questions: []\n  - id: hud\n    kind: layout\n    questions: [Anchors?]\n    source_dirs: [Assets/UI]\n');
  assert.deepEqual(validate(p).errors.map(e=>e.code),['invalid_rip_study','rip_study_source_dir']);
  put(p,f,text.replace('risks: []\n','rip_study: []\nrisks: []\n')); assert.deepEqual(validate(p).errors,[]);
});
test('valid full contract passes, malformed YAML and DAG cycles fail',()=>{
  const p=validProject(); assert.deepEqual(validate(p).errors,[]);
  const f='MILESTONES.md'; put(p,f,'```yaml\nslices: [S01, S02]\nslices: [S01]\n```');
  assert.ok(validate(p).errors.some(e=>e.code==='invalid_yaml'));
  put(p,f,'```yaml\n'+stringify({slices:['S01','S02'],dag:{S01:['S02'],S02:['S01']},parallel_ok:[],v1_slice:'S01',release_slice:'S02',stop_when:'done'})+'```');
  assert.ok(validate(p).errors.some(e=>e.code==='dag_cycle'));
});
test('import paths and RC ownership are checked even when Source is not first',()=>{
  const p=validProject();
  put(p,'ASSET_MANIFEST.md','| Stem | Source | Priority | Path |\n|---|---|---|---|\n| impact | import | P0 | reference/demo/missing.png |\n');
  put(p,'RELEASE_CHECKLIST.md','| id | area | check | closed_by | how to verify |\n|---|---|---|---|---|\n| RC-01 | input | tap | S02 | tap |\n');
  const r=validate(p); assert.ok(r.errors.some(e=>e.code==='missing_import_path')); assert.ok(r.errors.some(e=>e.code==='uncovered_release_item'));
});
test('playable depth is opt-in and cannot run end_to_end',()=>{
  const p=validProject(); let n=fs.readFileSync(path.join(p,'AGENT_NOTES.md'),'utf8');
  put(p,'AGENT_NOTES.md',n.replace('brief:\n','brief:\n  contract_depth: playable\n'));
  assert.deepEqual(validate(p).dispatchableSlices,['S01']);
  put(p,'AGENT_NOTES.md',fs.readFileSync(path.join(p,'AGENT_NOTES.md'),'utf8').replace('goal: playable','goal: end_to_end'));
  assert.ok(validate(p).errors.some(e=>e.code==='depth_requires_expansion'));
});
test('GP coverage requires concrete links, not just a coverage row',()=>{
  const p=validProject();
  put(p,'reference/demo-brief/GAMEPLAY_NOTES.md','## Source text\nTap clears board\n\n## Requirement index\n| ID | Kind | Source passage | Notes |\n|---|---|---|---|\n| GP-01 | Requested change | Tap clears board | |\n');
  const row='| GP ID | Kind | Decision / reason | Contract section | Slice | Acceptance / playtest |\n|---|---|---|---|---|---|\n| GP-01 | Requested | included | HOW_TO rule | S01 | tap → clear |\n';
  put(p,'HOW_TO.md',row);
  assert.ok(coverage(p).errors.some(e=>e.code==='gp_missing_scenario'));
  put(p,'HOW_TO.md','Rule: tap clears board GIVEN (GAMEPLAY_NOTES GP-01)\n\n'+row);
  put(p,'PLAYTEST.md','GP-01: tap then verify clear');
  const f='slices/S01-slice.md'; put(p,f,fs.readFileSync(path.join(p,f),'utf8').replace('Tap clears board','Tap clears board GP-01'));
  assert.equal(coverage(p).ok,true);
});
test('done requires semantic review bound to current hashes; post-review edits stale it',()=>{
  const p=validProject(), id=update(p,{init:true}).progress.runId;
  assert.throws(()=>update(p,{'run-id':id,phase:'done'}),/review/);
  put(p,'docs/brief-review.json',JSON.stringify({runId:id,contractHash:reviewHash(p),visualTargetInspected:true,evidenceLabelsChecked:true,sourceCoverageChecked:true,gameplaySemanticsChecked:true}));
  assert.equal(update(p,{'run-id':id,phase:'done',review:'docs/brief-review.json'}).ok,true);
  assert.equal(watch(p).action,'done');
  put(p,'GAME_BRIEF.md','Changed scope'); assert.equal(watch(p).action,'gate_stale');
});
test('contracts_written refuses until both validators pass',()=>{
  const p=validProject(), id=update(p,{init:true}).progress.runId, f='slices/S01-slice.md', ok=fs.readFileSync(path.join(p,f),'utf8');
  put(p,f,ok.replace(/player_outcome:.*/,'player_outcome: ""'));
  const r=update(p,{'run-id':id,phase:'contracts_written'});
  assert.equal(r.ok,false); assert.ok(r.contracts.some(e=>e.code==='missing_player_outcome'));
  put(p,f,ok); assert.equal(update(p,{'run-id':id,phase:'contracts_written'}).progress.phase,'contracts_written');
});
test('wildcard and parent scene paths cannot be declared parallel',()=>{
  assert.equal(overlap('assets/ui/**','assets/ui/Fail.ts'),true);
  assert.equal(overlap('Canvas/HUD','Canvas/HUD/Score'),true);
  assert.equal(overlap('assets/A.ts','assets/B.ts'),false);
  assert.equal(overlap('assets/{ui,vfx}/**','assets/ui/Panel.ts'),true);
});
test('extra research requires a reason and drafts do not count as first contract',()=>{
  const p=project(), now=Date.now(), id=update(p,{init:true},now).progress.runId;
  assert.throws(()=>update(p,{'run-id':id,read:'rip/file'}),/reason/);
  indexSource(p); put(p,'GAME_BRIEF.md','BRIEF_DRAFT');
  assert.equal(watch(p,{},now+11*60000).action,'nudge_first_contract');
});
test('completion fails on stale source policy; producer state alone does not stale review',()=>{
  const p=validProject(), old=reviewHash(p);
  const n=fs.readFileSync(path.join(p,'AGENT_NOTES.md'),'utf8');
  put(p,'AGENT_NOTES.md',n.replace('goal: playable','goal: playable\n  current_slice: S01'));
  assert.equal(reviewHash(p),old);
  put(p,'AGENT_NOTES.md',n.replace('goal: playable','goal: end_to_end'));
  assert.notEqual(reviewHash(p),old);
});
test('unknown project paths and escaping symlink parents are rejected',()=>{
  const p=project(); assert.throws(()=>local(p,'../outside'),/escapes/);
  const outside=fs.mkdtempSync(path.join(os.tmpdir(),'gb-outside-'));
  fs.symlinkSync(outside,path.join(p,'docs'));
  assert.throws(()=>local(p,'docs/new.json'),/Symlink escapes/);
});
test('legacy GP spellings and bounded ranges normalize without dropping coverage',()=>{
  assert.deepEqual(ids('GP01..GP03'),['GP-01','GP-03','GP-02']);
  assert.deepEqual(ids('H10–12','H'),['H-10','H-11','H-12']);
  assert.ok(ids('GP-01–GP-18').includes('GP-15'));
});
test('slices need player_outcome, real unlocks edges and known feel rows',()=>{
  const p=validProject(),f='slices/S01-slice.md',t=fs.readFileSync(path.join(p,f),'utf8');
  put(p,f,t.replace("feel_rows: []","feel_rows:\n  - tap").replace('player_outcome: Player clears the board','player_outcome: ""'));
  let codes=validate(p).errors.map(e=>e.code);
  assert.ok(codes.includes('missing_player_outcome')); assert.ok(!codes.includes('unknown_feel_row'));
  put(p,f,t.replace("feel_rows: []","feel_rows:\n  - explode").replace(/unlocks:\n  - S02/,'unlocks:\n  - S03'));
  codes=validate(p).errors.map(e=>e.code);
  assert.ok(codes.includes('unknown_feel_row')); assert.ok(codes.includes('unlocks_mismatch'));
});
test('a slice may not perform deploy, tag or push; hand-off to the producer passes',()=>{
  const p=validProject(),f='slices/S02-slice.md',t=fs.readFileSync(path.join(p,f),'utf8');
  assert.ok(!validate(p).errors.some(e=>e.code==='slice_performs_ship'));
  const bad=x=>{put(p,f,t.replace('- clear','- '+x));return validate(p).errors.some(e=>e.code==='slice_performs_ship');};
  for(const x of ['preview deploy through the ship skill','create the v1.1.0 tag','git push origin main','run vercel --prod']) assert.ok(bad(x),x);
  for(const x of ['smoke suite tested on the deployed URL','no deploy in this slice (producer Step 3)']) assert.ok(!bad(x),x);
  const rcf='RELEASE_CHECKLIST.md',rc0=fs.readFileSync(path.join(p,rcf),'utf8');
  put(p,rcf,rc0+'| RC-20 | ship | deploy | producer Step 3 | ship skill |\n');
  assert.ok(!validate(p).errors.some(e=>e.code==='uncovered_release_item'));
  put(p,rcf,rc0+'| RC-20 | input | deploy | producer Step 3 | x |\n');
  assert.ok(validate(p).errors.some(e=>e.code==='uncovered_release_item'));
  put(p,rcf,rc0+'| RC-20 | ship | deploy | producer | x |\n');
  assert.ok(validate(p).errors.some(e=>e.code==='uncovered_release_item'));
  put(p,f,t.replace('- clear','- Ship handed to producer Step 3 (deploy and tag are director-gated)'));
  assert.ok(!validate(p).errors.some(e=>e.code==='slice_performs_ship'));
});
test('a later slice adding a screen needs its own visual target',()=>{
  const p=validProject(),m={slices:['S01','S02','S03'],dag:{S02:['S01'],S03:['S01','S02']},parallel_ok:[],v1_slice:'S01',release_slice:'S03',stop_when:'RC pass'};
  put(p,'MILESTONES.md','```yaml\n'+stringify(m)+'```\n');
  fs.renameSync(path.join(p,'slices/S02-slice.md'),path.join(p,'slices/S03-slice.md'));
  const s3=path.join(p,'slices/S03-slice.md'); put(p,'slices/S03-slice.md',fs.readFileSync(s3,'utf8').replace('id: S02','id: S03').replace(/depends_on:\n  - S01/,'depends_on:\n  - S01\n  - S02'));
  const s1=fs.readFileSync(path.join(p,'slices/S01-slice.md'),'utf8').replace(/unlocks:\n  - S02/,'unlocks: []');
  put(p,'slices/S01-slice.md',s1);
  put(p,'slices/S02-slice.md',s1.replace('id: S01','id: S02').replace('name: polished-playable','name: settings').replace('depends_on: []','depends_on:\n  - S01').replace('scene_objects: []','scene_objects:\n  - Canvas/Panels/Settings').replace('- RC-01','[]').replace('release_items:\n  []','release_items: []'));
  assert.ok(validate(p).errors.some(e=>e.code==='missing_screen_target'));
  put(p,'docs/mockups/S02-settings.svg','<svg/>');
  assert.ok(!validate(p).errors.some(e=>e.code==='missing_screen_target'));
});
test('with the ui-popup kit offered, a popup slice installs the kit and never uses Canvas popup nodes',()=>{
  const p=validProject(),f='slices/S01-slice.md',t=fs.readFileSync(path.join(p,f),'utf8');
  const codes=()=>validate(p).errors.map(e=>e.code);
  put(p,f,t.replace('scene_objects: []','scene_objects:\n  - assets/resources/prefab/ui/PopupResult.prefab'));
  assert.ok(!codes().includes('popup_kit_missing'), 'no kit rule without the overview offering the kit');
  put(p,'docs/flows/00-project-overview.md','Popups: the opt-in `ui-popup` kit.\n');
  assert.ok(codes().includes('popup_kit_missing'));
  put(p,f,t.replace('scene_objects: []','scene_objects:\n  - assets/resources/prefab/ui/PopupResult.prefab').replace('code:\n    - assets/S01.ts','code:\n    - assets/S01.ts\n    - assets/scripts/common/uiManager.ts'));
  assert.ok(!codes().includes('popup_kit_missing'));
  put(p,f,t.replace('scene_objects: []','scene_objects:\n  - Canvas/UI/PausePopup'));
  assert.ok(codes().includes('popup_outside_kit'));
  put(p,f,t.replace('scene_objects: []','scene_objects:\n  - Canvas/HUD/ScoreLabel\n  - assets/resources/prefab/ui/PopupResult.prefab'));
  put(p,'assets/scripts/common/uiManager.ts','// installed');
  const c=codes(); assert.ok(!c.includes('popup_kit_missing') && !c.includes('popup_outside_kit'));
});
test('contract validator catches missing root contracts', () => {
  const p = project(), r = validate(p);
  assert.equal(r.ok, false); assert.ok(r.errors.some(e => e.code === 'missing_root_contract'));
});
test('prepare renders every prompt block and refuses unfilled placeholders',async()=>{
  const { promptBlocks, fill, prepare } = await import('../scripts/prepare.mjs');
  const blocks = promptBlocks(fs.readFileSync(new URL('../reference/brief-prompt.md', import.meta.url),'utf8'));
  for (const k of ['main','SOURCE_BLOCK:store','SOURCE_BLOCK:media','SOURCE_BLOCK:idea','RIP_BLOCK','RIP_PORT_BLOCK','GAMEPLAY_NOTES_BLOCK','VIDEO_BLOCK']) assert.ok(blocks[k], k);
  assert.throws(()=>fill('a <SLUG>\n<RIP_BLOCK>',{RIP_BLOCK:null},{}),/SLUG/);
  assert.equal(fill('a <SLUG>\n<RIP_BLOCK>',{},{SLUG:'x'}),'a x');
  const p=fs.mkdtempSync(path.join(os.tmpdir(),'gb-prep-'));
  put(p,'AGENT_NOTES.md','---\nbootstrap:\n  creator_version: "3.8.8"\nbrief:\n  source: idea\n  reference_path: ""\n  orientation: landscape 1280x720\nrelease:\n  goal: playable\n---\n');
  put(p,`reference/${path.basename(p)}-brief/IDEA.md`,'# IDEA\nTap to clear');
  const r=prepare(fs.realpathSync(p),{});
  const prompt=fs.readFileSync(path.join(p,r.promptPath),'utf8');
  assert.match(prompt,/NEVER write OBSERVED/); assert.match(prompt,/Orient landscape, design res 1280x720/);
  assert.match(prompt,new RegExp(r.runId)); assert.doesNotMatch(prompt,/<[A-Z][A-Z_]+>/);
  for (const f of ['docs/slice-schema.md','docs/brief-workflow.md','docs/brief-input-index.json']) assert.ok(fs.existsSync(path.join(p,f)),f);
  assert.equal(prepare(fs.realpathSync(p),{}).runId,r.runId);   // rerun resumes, never resets
});
test('a video in the reference folder is indexed, warned until probed, and gets the video block',async()=>{
  const { prepare } = await import('../scripts/prepare.mjs');
  const p=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'gb-video-')));
  put(p,'AGENT_NOTES.md','---\nbootstrap:\n  creator_version: "3.8.8"\nbrief:\n  source: media\n  reference_path: reference/demo/\n  orientation: portrait 720x1280\n---\n');
  put(p,'reference/demo/01.jpg','x');
  put(p,'reference/demo/video/gameplay.mp4','x');
  put(p,'reference/demo/video/gameplay.source.json',JSON.stringify({url:'https://youtu.be/abc'}));
  let r=indexSource(p,{'dry-run':true});
  assert.deepEqual(r.index.videos.map(v=>[v.path,v.sourceUrl,v.probe]),[['reference/demo/video/gameplay.mp4','https://youtu.be/abc',null]]);
  assert.ok(r.index.warnings.some(w=>w.startsWith('Video not probed: reference/demo/video/gameplay.mp4')));
  const probe='reference/demo/video/probe/gameplay';
  for (const f of ['candidates.md','strips.md','overview/overview.md','track-F01/track.md']) put(p,`${probe}/${f}`,'# x\n');
  fs.mkdirSync(path.join(p,probe,'track-F02'));   // a failed run with no track.md is not listed
  r=indexSource(p,{'dry-run':true});
  assert.equal(r.index.videos[0].probe,probe); assert.deepEqual(r.index.videos[0].tracks,[`${probe}/track-F01/track.md`]);
  assert.ok(!r.index.warnings.some(w=>w.startsWith('Video not probed')));
  const out=prepare(p,{}), prompt=fs.readFileSync(path.join(p,out.promptPath),'utf8');
  assert.match(prompt,/reference\/demo\/video\/gameplay\.mp4 \(from https:\/\/youtu\.be\/abc\): reference\/demo\/video\/probe\/gameplay\/ \(overview\/, candidates\.md, strips\/, 1 track run\(s\)\)/);
  assert.match(prompt,/gameplay-video\/scripts\/video-probe\.mjs track <video>/); assert.doesNotMatch(prompt,/<[A-Z][A-Z_]+>/);
  assert.match(fs.readFileSync(path.join(p,'docs/video-evidence.md'),'utf8'),/^# video-probe guide/);
});
