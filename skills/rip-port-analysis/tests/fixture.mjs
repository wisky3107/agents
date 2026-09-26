import fs from 'node:fs';
import path from 'node:path';
import { REPORTS, SLICE_STUDY, SLICE_REPORT, sha256, studyPathFor } from '../scripts/validate-rip-port.mjs';
import { INVENTORY, CATEGORIES, buildInventory } from '../scripts/inventory-rip.mjs';
import { extractUnity, stringify } from '../scripts/extract-unity.mjs';

// Mirrors an AssetRipper workdir: ripped/UnityProject/ExportedProject is the analysis root, PrimaryContent holds GLBs, output is SEED.
export function writeRip(dir) {
  const up=path.join(dir,'ripped/UnityProject/ExportedProject'), pc=path.join(dir,'ripped/PrimaryContent'), out=path.join(dir,'output');
  for (const d of [path.join(up,'Assets/Scripts/Game'),path.join(up,'Assets/Data'),path.join(up,'ProjectSettings'),path.join(pc,'Assets/Mesh'),path.join(out,'levels')]) fs.mkdirSync(d,{recursive:true});
  fs.writeFileSync(path.join(up,'ProjectSettings/ProjectVersion.txt'),'m_EditorVersion: 6000.0.0f1\n');
  fs.writeFileSync(path.join(up,'Assets/Scripts/Game/Board.cs'),'class Board { bool Won(int count) => count == 0; }\n');
  fs.writeFileSync(path.join(up,'Assets/Data/BoardConfig.asset'),'%YAML 1.1\n--- !u!114 &11400000\nMonoBehaviour:\n  m_Name: BoardConfig\n  m_EditorClassIdentifier: \n  tiles: 40\n');
  fs.writeFileSync(path.join(pc,'Assets/Mesh/Token.glb'),'glb');
  fs.writeFileSync(path.join(out,'levels/level_001.json'),'{"tiles":40}');
  fs.writeFileSync(path.join(out,'manifest.json'),JSON.stringify({source_paths:{ripped:path.join(dir,'ripped'),unity_project:up,primary_content:pc}}));
  fs.writeFileSync(path.join(dir,'assetripper.log'),'Unity version: 6000.0.0f1\n');
  return {up,pc,out,log:path.join(dir,'assetripper.log')};
}
// Rebuild the inventory, re-hash it, and map every nonzero category to RP-001 unless a disposition already exists.
export function writeInventory(f) {
  const inv=buildInventory({unityProject:f.up,primaryContent:f.pc,output:f.out,log:f.log}), p=path.join(f.root,INVENTORY);
  fs.writeFileSync(p,JSON.stringify({schemaVersion:1,sources:{main:{paths:{unityProject:f.up,primaryContent:f.pc,output:f.out,log:f.log},...inv}}}));
  f.manifest.inventory={path:INVENTORY,sha256:sha256(p)};
  const have=new Set(f.manifest.inventoryCoverage.map(d=>d.category));
  for (const c of CATEGORIES) if (inv.counts[c] && !have.has(c)) f.manifest.inventoryCoverage.push({category:c,status:'mapped',claims:['RP-001']});
  return inv;
}
export function writeBundle(project, analysisPath = 'reference/demo/rip-port') {
  const root=path.join(project,analysisPath); fs.mkdirSync(root,{recursive:true});
  const f={root,...writeRip(path.join(project,'fixture-rip'))}; f.source=f.up;
  const board='Assets/Scripts/Game/Board.cs';
  f.manifest={schemaVersion:2,status:'reviewed',analystAgent:'cursor --model auto',logicCoverage:'readable_logic',
    sources:[{id:'main',root:f.up,primaryContent:f.pc,output:f.out,codeAvailability:'readable'}],
    evidence:[{id:'E-001',source:'main',path:board,sha256:sha256(path.join(f.up,board)),kind:'code',symbol:'Board.Won'}],
    claims:[{id:'RP-001',label:'OBSERVED',summary:'Zero count wins',evidence:['E-001']}],
    inventoryCoverage:[],unknowns:[],files:REPORTS,reportHashes:{}};
  writeInventory(f);
  for(const file of REPORTS) { fs.writeFileSync(path.join(root,file),`# ${file}\nRP-001 OBSERVED E-001 main:Board.cs#Won; zero count wins.\n`); f.manifest.reportHashes[file]=sha256(path.join(root,file)); }
  fs.writeFileSync(path.join(root,'RIP_PORT_MANIFEST.json'),JSON.stringify(f.manifest));
  return {...f,hash:sha256(path.join(root,'RIP_PORT_MANIFEST.json'))};
}

// Minimal serialized presentation: FX prefab (particles + material + noFields MB), a UI prefab nesting it, a clip and a controller.
export const GUID = { script:'a'.repeat(32), mat:'b'.repeat(32), tex:'c'.repeat(32), fx:'d'.repeat(32), clip:'e'.repeat(32), ctrl:'1'.repeat(32), shop:'2'.repeat(32) };
const U = '%YAML 1.1\n%TAG !u! tag:unity3d.com,2011:\n';
const FX = `${U}--- !u!1 &100
GameObject:
  m_ObjectHideFlags: 0
  serializedVersion: 6
  m_Component:
  - component: {fileID: 101}
  - component: {fileID: 102}
  m_Layer: 5
  m_Name: FXOpen
  m_TagString: Untagged
  m_IsActive: 1
--- !u!4 &101
Transform:
  m_GameObject: {fileID: 100}
  m_LocalRotation: {x: 0, y: 0, z: 0, w: 1}
  m_LocalPosition: {x: 0, y: 1, z: 0}
  m_LocalScale: {x: 1, y: 1, z: 1}
  m_Children:
  - {fileID: 201}
  m_Father: {fileID: 0}
--- !u!114 &102
MonoBehaviour:
  m_GameObject: {fileID: 100}
  m_Enabled: 1
  m_Script: {fileID: 11500000, guid: ${GUID.script}, type: 3}
  m_Name: 
  m_EditorClassIdentifier: 
--- !u!1 &200
GameObject:
  m_Component:
  - component: {fileID: 201}
  - component: {fileID: 202}
  - component: {fileID: 203}
  m_Name: Glow
  m_IsActive: 0
--- !u!4 &201
Transform:
  m_GameObject: {fileID: 200}
  m_LocalRotation: {x: 0.7071068, y: 0, z: 0, w: 0.7071068}
  m_LocalPosition: {x: 0, y: 0, z: 0}
  m_LocalScale: {x: 2, y: 2, z: 2}
  m_Children: []
  m_Father: {fileID: 101}
--- !u!198 &202
ParticleSystem:
  m_GameObject: {fileID: 200}
  serializedVersion: 8
  lengthInSec: 0.5
  looping: 0
  playOnAwake: 1
  moveWithTransform: 0
  scalingMode: 1
  InitialModule:
    serializedVersion: 3
    startLifetime:
      serializedVersion: 2
      minMaxState: 0
      scalar: 0.2
      minScalar: 0.2
    startSize:
      serializedVersion: 2
      minMaxState: 3
      scalar: 12
      minScalar: 8
    startRotation:
      minMaxState: 0
      scalar: 1.5707964
    startColor:
      serializedVersion: 2
      minMaxState: 0
      minColor: {r: 1, g: 1, b: 1, a: 1}
      maxColor: {r: 1, g: 0.8, b: 0.2, a: 1}
  ShapeModule:
    enabled: 1
    type: 4
    angle: 25
    radius:
      value: 0.5
  EmissionModule:
    enabled: 1
    rateOverTime:
      minMaxState: 0
      scalar: 0
    m_Bursts:
    - serializedVersion: 2
      time: 0
      countCurve:
        minMaxState: 0
        scalar: 2
      cycleCount: 1
  SizeModule:
    enabled: 1
    curve:
      serializedVersion: 2
      minMaxState: 1
      scalar: 1
      maxCurve:
        serializedVersion: 2
        m_Curve:
        - serializedVersion: 3
          time: 0
          value: 0
          inSlope: 0
          outSlope: 2
        - serializedVersion: 3
          time: 1
          value: 1
          inSlope: 2
          outSlope: 0
        m_PreInfinity: 2
  ColorModule:
    enabled: 1
    gradient:
      serializedVersion: 2
      minMaxState: 1
      maxGradient:
        serializedVersion: 2
        key0: {r: 1, g: 1, b: 1, a: 1}
        key1: {r: 1, g: 0, b: 0, a: 0}
        ctime0: 0
        ctime1: 65535
        atime0: 0
        atime1: 65535
        m_Mode: 0
        m_NumColorKeys: 2
        m_NumAlphaKeys: 2
  NoiseModule:
    enabled: 0
    strength:
      minMaxState: 0
      scalar: 1
--- !u!199 &203
ParticleSystemRenderer:
  m_GameObject: {fileID: 200}
  m_Enabled: 1
  m_Materials:
  - {fileID: 2100000, guid: ${GUID.mat}, type: 2}
  m_SortingOrder: 3
  m_RenderMode: 0
`;
const MAT = `${U}--- !u!21 &2100000
Material:
  serializedVersion: 8
  m_Name: Glow
  m_Shader: {fileID: 200, guid: 0000000000000000f000000000000000, type: 0}
  m_ShaderKeywords: _ALPHAPREMULTIPLY_ON
  m_CustomRenderQueue: -1
  stringTagMap: {}
  m_SavedProperties:
    serializedVersion: 3
    m_TexEnvs:
    - _MainTex:
        m_Texture: {fileID: 2800000, guid: ${GUID.tex}, type: 3}
        m_Scale: {x: 1, y: 1}
        m_Offset: {x: 0, y: 0}
    m_Floats:
    - _InvFade: 1
    m_Colors:
    - _TintColor: {r: 1, g: 0.5, b: 0, a: 0.5}
`;
const SHOP = `${U}--- !u!1 &300
GameObject:
  m_Component:
  - component: {fileID: 301}
  - component: {fileID: 302}
  m_Name: Shop
  m_IsActive: 1
--- !u!224 &301
RectTransform:
  m_GameObject: {fileID: 300}
  m_LocalRotation: {x: 0, y: 0, z: 0, w: 1}
  m_LocalPosition: {x: 0, y: 0, z: 0}
  m_LocalScale: {x: 1, y: 1, z: 1}
  m_Children:
  - {fileID: 402}
  m_Father: {fileID: 0}
  m_AnchorMin: {x: 0, y: 0}
  m_AnchorMax: {x: 1, y: 1}
  m_AnchoredPosition: {x: 0, y: -20}
  m_SizeDelta: {x: -40, y: -40}
  m_Pivot: {x: 0.5, y: 0.5}
--- !u!114 &302
MonoBehaviour:
  m_GameObject: {fileID: 300}
  m_Enabled: 1
  m_Script: {fileID: 11500000, guid: ${GUID.script}, type: 3}
  m_Name: 
  m_EditorClassIdentifier: 
  columns: 3
  cellSize: {x: 217, y: 315}
--- !u!1001 &400
PrefabInstance:
  m_ObjectHideFlags: 0
  m_Modification:
    m_TransformParent: {fileID: 301}
    m_Modifications:
    - target: {fileID: 100, guid: ${GUID.fx}, type: 3}
      propertyPath: m_Name
      value: LockboxFX
      objectReference: {fileID: 0}
    - target: {fileID: 101, guid: ${GUID.fx}, type: 3}
      propertyPath: m_LocalPosition.y
      value: 3
      objectReference: {fileID: 0}
    m_RemovedComponents: []
  m_SourcePrefab: {fileID: 100100000, guid: ${GUID.fx}, type: 3}
--- !u!4 &402 stripped
Transform:
  m_CorrespondingSourceObject: {fileID: 101, guid: ${GUID.fx}, type: 3}
  m_PrefabInstance: {fileID: 400}
  m_PrefabAsset: {fileID: 0}
`;
const CLIP = `${U}--- !u!74 &7400000
AnimationClip:
  m_Name: Open
  m_Legacy: 0
  m_PositionCurves:
  - curve:
      serializedVersion: 2
      m_Curve:
      - serializedVersion: 3
        time: 0
        value: {x: 0, y: 0, z: 0}
        inSlope: {x: 0, y: 0, z: 0}
        outSlope: {x: 0, y: 0, z: 0}
      - serializedVersion: 3
        time: 0.25
        value: {x: 0, y: 1, z: 0}
        inSlope: {x: Infinity, y: Infinity, z: Infinity}
        outSlope: {x: 0, y: 0, z: 0}
    path: Lid
  m_SampleRate: 60
  m_WrapMode: 0
  m_AnimationClipSettings:
    m_StartTime: 0
    m_StopTime: 0.25
    m_LoopTime: 0
  m_Events: []
`;
const CTRL = `${U}--- !u!91 &9100000
AnimatorController:
  m_Name: Chest
  m_AnimatorParameters:
  - m_Name: open
    m_Type: 9
    m_DefaultFloat: 0
    m_DefaultInt: 0
    m_DefaultBool: 0
  - m_Name: speed
    m_Type: 1
    m_DefaultFloat: 1.5
    m_DefaultInt: 0
    m_DefaultBool: 0
  m_AnimatorLayers:
  - serializedVersion: 5
    m_Name: Base Layer
    m_StateMachine: {fileID: 110700000}
    m_Mask: {fileID: 0}
    m_BlendingMode: 0
    m_DefaultWeight: 0
--- !u!1107 &110700000
AnimatorStateMachine:
  m_Name: Base Layer
  m_ChildStates:
  - serializedVersion: 1
    m_State: {fileID: 110200000}
    m_Position: {x: 0, y: 0, z: 0}
  - serializedVersion: 1
    m_State: {fileID: 110200002}
    m_Position: {x: 0, y: 100, z: 0}
  m_ChildStateMachines: []
  m_AnyStateTransitions: []
  m_EntryTransitions: []
  m_DefaultState: {fileID: 110200000}
--- !u!1102 &110200000
AnimatorState:
  m_Name: Idle
  m_Speed: 1
  m_Transitions:
  - {fileID: 110100000}
  m_Motion: {fileID: 0}
--- !u!1102 &110200002
AnimatorState:
  m_Name: Open
  m_Speed: 1
  m_Transitions: []
  m_Motion: {fileID: 7400000, guid: ${GUID.clip}, type: 2}
--- !u!1101 &110100000
AnimatorStateTransition:
  m_Name: 
  m_Conditions:
  - m_ConditionMode: 1
    m_ConditionEvent: open
    m_EventTreshold: 0
  m_DstStateMachine: {fileID: 0}
  m_DstState: {fileID: 110200002}
  m_TransitionDuration: 0.1
  m_HasExitTime: 0
  m_HasFixedDuration: 1
  m_IsExit: 0
`;
export const PRESENTATION = { fx:'Assets/Fx/Open.prefab', mat:'Assets/Fx/Glow.mat', shop:'Assets/UI/Shop.prefab', clip:'Assets/Anim/Open.anim', ctrl:'Assets/Anim/Chest.controller' };
export function writePresentation(up) {
  const files = { 'Assets/Scripts/Game/FxDriver.cs':['public class FxDriver { public int columns; }\n',GUID.script], 'Assets/Fx/Glow.png':['png',GUID.tex],
    [PRESENTATION.fx]:[FX,GUID.fx], [PRESENTATION.mat]:[MAT,GUID.mat], [PRESENTATION.shop]:[SHOP,GUID.shop], [PRESENTATION.clip]:[CLIP,GUID.clip], [PRESENTATION.ctrl]:[CTRL,GUID.ctrl] };
  for (const [rel,[body,guid]] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(up,rel)),{recursive:true});
    fs.writeFileSync(path.join(up,rel),body); fs.writeFileSync(path.join(up,`${rel}.meta`),`fileFormatVersion: 2\nguid: ${guid}\n`);
  }
}

export const TOPICS = [{id:'lockbox-open-vfx',kind:'vfx',questions:['Burst, lifetime and blend of the open glow?'],source_dirs:['Assets/Fx']}];
// Parent bundle re-pinned over the presentation files, slice S05 asking TOPICS, and a reviewed study answering them.
export function writeStudy(project, analysisPath = 'reference/demo/rip-port') {
  const f=writeBundle(project,analysisPath); writePresentation(f.up); writeInventory(f);
  fs.writeFileSync(path.join(f.root,'RIP_PORT_MANIFEST.json'),JSON.stringify(f.manifest)); f.hash=sha256(path.join(f.root,'RIP_PORT_MANIFEST.json'));
  const dir=path.join(project,studyPathFor(analysisPath,'S05')), ext='extracts/lockbox-open-vfx-glow.json', sliceFile='slices/S05-lockbox.md';
  const x=extractUnity({root:f.up,file:PRESENTATION.fx,node:'FXOpen/Glow',only:['ParticleSystem','ParticleSystemRenderer']});
  fs.mkdirSync(path.join(dir,'extracts'),{recursive:true}); fs.writeFileSync(path.join(dir,ext),`${stringify(x)}\n`);
  fs.mkdirSync(path.join(project,'slices'),{recursive:true}); fs.writeFileSync(path.join(project,sliceFile),`---\nid: S05\nrip_study: ${JSON.stringify(TOPICS)}\n---\n`);
  const xh=sha256(path.join(dir,ext));
  const study={schemaVersion:1,slice:'S05',status:'reviewed',analystAgent:'cursor --model auto',
    parent:{path:'RIP_PORT_MANIFEST.json',sha256:f.hash},sliceFile:{path:sliceFile,sha256:sha256(path.join(project,sliceFile))},
    topics:[{id:'lockbox-open-vfx',kind:'vfx',source:'slice',status:'studied',claims:['RP-S05-001','RP-S05-002']},
      {id:'lockbox-open-sfx',kind:'audio',source:'derived',status:'excluded',reason:'S06 owns audio'}],
    evidence:[{id:'E-S05-001',source:'main',path:PRESENTATION.fx,sha256:x.fileSha256,kind:'prefab',symbol:'#200 Glow',extract:ext,extractSha256:xh},
      {id:'E-S05-002',source:'main',path:PRESENTATION.mat,sha256:x.materials[PRESENTATION.mat].sha256,kind:'asset',extract:ext,extractSha256:xh}],
    claims:[{id:'RP-S05-001',label:'OBSERVED',summary:'Glow bursts 2 particles, lifetime 0.2 s',evidence:['E-S05-001'],refines:['RP-001'],disposition:'adopt',cocos:'ParticleSystem burst 2, startLifetime 0.2'},
      {id:'RP-S05-002',label:'INFERRED',summary:'Additive tinted glow material',evidence:['E-S05-002'],disposition:'adapt',cocos:'builtin-particle additive',deviation:'builtin:extra#200 replaced by builtin-particle'}],
    unknowns:['FxDriver has no serialized fields: open trigger timing'],files:[SLICE_REPORT],reportHashes:{}};
  const s={...f,dir,study,sliceFile,report:'# S05 slice study\n## lockbox-open-vfx\nRP-S05-001 adopt; RP-S05-002 adapt (refines RP-001).\n## lockbox-open-sfx\nexcluded.\n'};
  saveStudy(s); return s;
}
// Rewrite report + manifest after a test mutates s.study or s.report.
export function saveStudy(s) {
  fs.writeFileSync(path.join(s.dir,SLICE_REPORT),s.report); s.study.reportHashes[SLICE_REPORT]=sha256(path.join(s.dir,SLICE_REPORT));
  fs.writeFileSync(path.join(s.dir,SLICE_STUDY),JSON.stringify(s.study));
}
