import fs from 'node:fs';
import path from 'node:path';
import { REPORTS, sha256 } from '../scripts/validate-rip-port.mjs';

export function writeBundle(project, analysisPath = 'reference/demo/rip-port') {
  const root=path.join(project,analysisPath), source=path.join(project,'fixture-source');
  fs.mkdirSync(root,{recursive:true}); fs.mkdirSync(source,{recursive:true});
  fs.writeFileSync(path.join(source,'Board.cs'),'class Board { bool Won(int count) => count == 0; }\n');
  const m={schemaVersion:1,status:'reviewed',analystAgent:'cursor --model auto',logicCoverage:'readable_logic',
    sources:[{id:'main',root:source,codeAvailability:'readable'}],
    evidence:[{id:'E-001',source:'main',path:'Board.cs',sha256:sha256(path.join(source,'Board.cs')),kind:'code',symbol:'Board.Won'}],
    claims:[{id:'RP-001',label:'OBSERVED',summary:'Zero count wins',evidence:['E-001']}],
    unknowns:[],files:REPORTS,reportHashes:{}};
  for(const file of REPORTS) { fs.writeFileSync(path.join(root,file),`# ${file}\nRP-001 OBSERVED E-001 main:Board.cs#Won; zero count wins.\n`); m.reportHashes[file]=sha256(path.join(root,file)); }
  fs.writeFileSync(path.join(root,'RIP_PORT_MANIFEST.json'),JSON.stringify(m));
  return {root,source,manifest:m,hash:sha256(path.join(root,'RIP_PORT_MANIFEST.json'))};
}
