import fs from 'node:fs';
import path from 'node:path';
import { REPORTS, sha256 } from '../scripts/validate-rip-port.mjs';
import { INVENTORY, CATEGORIES, buildInventory } from '../scripts/inventory-rip.mjs';

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
