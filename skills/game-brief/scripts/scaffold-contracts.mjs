import fs from 'node:fs';
import path from 'node:path';
import { stringify } from 'yaml';
import { args, project, local, exists, ROOTS, json, run } from './lib.mjs';

export function scaffold(p, a = {}) {
  if (exists(local(p,'MILESTONES.md'))) return {ok:true,written:[],skipped:['existing release contract set'],note:'Targeted amendments only; never scaffold slices into an existing milestone plan.'};
  const count = Number(a.slices || 8);
  if (!Number.isInteger(count) || count < 2 || count > 30) throw Error('--slices must be 2..30 (usually 6..9)');
  const written = [], skipped = [];
  const put = (f,text) => { const target = local(p,f); if (exists(target)) { skipped.push(f); return; } fs.mkdirSync(path.dirname(target), {recursive:true}); fs.writeFileSync(target,text,{flag:'wx'}); written.push(f); };
  const ids = Array.from({length:count},(_,i)=>`S${String(i+1).padStart(2,'0')}`);
  for (const f of ROOTS) {
    let text = `# ${path.basename(f,'.md')}\n\nBRIEF_DRAFT: Author from inspected evidence and director requirements.\n`;
    if (f === 'MILESTONES.md') text += '\n```yaml\n' + stringify({slices:ids,dag:Object.fromEntries(ids.slice(1).map((id,i)=>[id,[ids[i]]])),parallel_ok:[],v1_slice:ids[0],release_slice:ids.at(-1),stop_when:'RELEASE_CHECKLIST.md all rows PASS'}) + '```\n';
    if (f === 'RELEASE_CHECKLIST.md') text += '\n| id | area | check | closed_by | how to verify |\n|---|---|---|---|---|\n';
    put(f,text);
  }
  for (const [i,id] of ids.entries()) {
    const name = i === count-1 ? 'release-polish' : i === 0 ? 'polished-playable' : `slice-${i+1}`;
    const value = {id,name,one_liner:'BRIEF_DRAFT',size:'L',depends_on:i?[ids[i-1]]:[],unlocks:i<count-1?[ids[i+1]]:[],needs_director_ok:true,recipe_refs:[],player_outcome:'BRIEF_DRAFT',scope:{in:[],out:[]},paths:{code:[],art:[],scene_objects:[]},assets:{'2d':[],'3d':[],vfx:[],audio:[]},acceptance:[],feel_rows:[],runtime_checks:[],playtest:[],change_budget:{files:0,lines:0,nodes:0,assets:0,tripo_credits:0},risks:[],release_items:[]};
    // Any existing same-ID slice wins, including a differently named authored file.
    const dir = local(p,'slices');
    if (exists(dir) && fs.readdirSync(dir).some(f=>f.startsWith(id+'-') && f.endsWith('.md'))) { skipped.push(`slices/${id}-*`); continue; }
    put(`slices/${id}-${name}.md`, '---\n'+stringify(value)+'---\n');
  }
  const index = local(p,'docs/brief-input-index.json');
  if (exists(index) && json(index).requirements.length) {
    const rows = json(index).requirements.map(r=>`| ${r.id} | ${r.kind || ''} | BRIEF_DRAFT | | | |`);
    put('docs/brief-coverage-draft.md', '# Coverage draft — move completed rows into HOW_TO\n\n| GP ID | Kind / source passage | Decision / reason | Contract section | Slice | Acceptance / playtest |\n|---|---|---|---|---|---|\n'+rows.join('\n')+'\n');
  }
  return {ok:true,written,skipped,note:'Draft skeletons are never gate-ready; no mechanics, decisions, or RC ownership are invented.'};
}
if (process.argv[1] === new URL(import.meta.url).pathname) run(()=>{const a=args();return scaffold(project(a),a);});
