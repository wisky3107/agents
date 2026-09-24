import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { parseDocument } from 'yaml';
import { analysisPathFor } from '../../rip-port-analysis/scripts/validate-rip-port.mjs';

export const ROOTS = ['GAME_BRIEF.md', 'HOW_TO.md', 'EXPECT_GAMEPLAY_VISUAL.md', 'ASSET_MANIFEST.md', 'SCOPE.md', 'ARCHITECTURE.md', 'FOLLOWUPS.md', 'PLAYTEST.md', 'CONTEXT.md', 'docs/adr/0001-tech-stack.md', 'MILESTONES.md', 'RELEASE_CHECKLIST.md'];
export const read = p => fs.readFileSync(p, 'utf8');
export const json = p => JSON.parse(read(p));
export const hash = s => crypto.createHash('sha256').update(s).digest('hex');
export const exists = p => fs.existsSync(p);
export function writeJson(p, value) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
  fs.renameSync(tmp, p);
}
export function args(argv = process.argv.slice(2)) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) out._.push(argv[i]);
    else {
      const k = argv[i].slice(2);
      out[k] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
    }
  }
  return out;
}
export function project(a) {
  if (typeof a.project !== 'string') throw Error('--project <absolute project path> is required');
  const p = fs.realpathSync(a.project);
  if (!exists(path.join(p, 'AGENT_NOTES.md'))) throw Error('Project must contain AGENT_NOTES.md');
  return p;
}
export function local(p, relative) {
  if (typeof relative !== 'string' || path.isAbsolute(relative)) throw Error(`Expected project-relative path: ${relative}`);
  const q = path.resolve(p, relative);
  if (!q.startsWith(p + path.sep)) throw Error(`Path escapes project: ${relative}`);
  let ancestor = q;
  while (!exists(ancestor)) ancestor = path.dirname(ancestor);
  const real = fs.realpathSync(ancestor), root = fs.realpathSync(p);
  if (real !== root && !real.startsWith(root + path.sep)) throw Error(`Symlink escapes project: ${relative}`);
  return q;
}
export function yaml(text, label) {
  const doc = parseDocument(text, { uniqueKeys: true });
  if (doc.errors.length) throw Error(`${label}: ${doc.errors.map(e => e.message).join('; ')}`);
  return doc.toJS({ maxAliasCount: 50 });
}
export function fence(text, label) {
  const m = text.match(/```ya?ml\s*\n([\s\S]*?)\n```/);
  if (!m) throw Error(`${label}: missing YAML fence`);
  return yaml(m[1], label);
}
export function front(text, label) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!m) throw Error(`${label}: missing YAML front-matter`);
  return yaml(m[1], label);
}
export function leadingYaml(text, label) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!m) throw Error(`${label}: missing leading YAML block`);
  return yaml(m[1], label);
}
export const notes = p => {
  const text = read(path.join(p, 'AGENT_NOTES.md'));
  return text.startsWith('---\n') || text.startsWith('---\r\n') ? leadingYaml(text, 'AGENT_NOTES.md') : fence(text, 'AGENT_NOTES.md');
};
export function files(p, dir) {
  const q = local(p, dir);
  return exists(q) ? fs.readdirSync(q, { withFileTypes: true }).filter(e => e.isFile()).map(e => `${dir}/${e.name}`).sort() : [];
}
export function contractPaths(p) {
  return [...ROOTS, ...files(p, 'slices').filter(f => f.endsWith('.md')), ...files(p, 'docs/mockups')];
}
export function fingerprints(p, paths = contractPaths(p)) {
  return Object.fromEntries(paths.filter(f => exists(local(p, f))).map(f => [f, hash(fs.readFileSync(local(p, f)))]));
}
export function reviewHash(p) {
  const n = notes(p), b = n.brief || {};
  const ref = (b.reference_path || n.store_clone?.reference_path || '').replace(/\/$/,'');
  const slug = path.basename(ref || p).replace(/^cc4?-/, '');
  const sourcePaths = [b.gameplay_notes_path || `reference/${slug}-brief/GAMEPLAY_NOTES.md`, `reference/${slug}-brief/IDEA.md`];
  const port = analysisPathFor(p,n);
  if (port) sourcePaths.push(...files(p,port.replace(/\/$/, '')).filter(f => /\/RIP_.*\.(md|json)$/.test(f)));
  return hash(JSON.stringify({ contracts: fingerprints(p), source: fingerprints(p,sourcePaths), policy: { depth:b.contract_depth || 'full', source:b.source, reference:ref, rip:b.rip_path || n.store_clone?.rip_path, orientation:b.orientation, goal:n.release?.goal } }));
}
export function tableRows(text) {
  return text.split('\n').filter(l => /^\s*\|/.test(l)).map(l => l.trim().slice(1, -1).split(/(?<!\\)\|/).map(c => c.trim()));
}
export function tables(text) {
  return text.split(/\n\s*\n/).map(tableRows).filter(rows => rows.length >= 2 && rows[1].every(c => /^:?-+:?$/.test(c)));
}
export function ids(s, prefix = 'GP') {
  const text = String(s), found = new Set((text.match(new RegExp(`\\b${prefix}-?\\d+\\b`, 'g')) || []).map(x => `${prefix}-${x.slice(prefix.length).replace(/^-/, '').padStart(2, '0')}`));
  for (const m of text.matchAll(new RegExp(`\\b${prefix}-?(\\d+)\\s*(?:\\.\\.|[–—])\\s*(?:${prefix}-?)?(\\d+)\\b`, 'g'))) {
    const first = Number(m[1]), last = Number(m[2]);
    if (last >= first && last - first <= 1000) for (let i = first; i <= last; i++) found.add(`${prefix}-${String(i).padStart(2,'0')}`);
  }
  return [...found];
}
export function run(fn) {
  Promise.resolve().then(fn).then(r => { if (r !== undefined) console.log(JSON.stringify(r, null, 2)); if (r?.ok === false) process.exitCode = 1; }).catch(e => {
    console.log(JSON.stringify({ ok: false, error: e.message })); process.exitCode = 2;
  });
}
