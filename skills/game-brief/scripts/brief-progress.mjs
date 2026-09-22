import crypto from 'node:crypto';
import { args, project, local, exists, read, json, writeJson, fingerprints, reviewHash, hash, run } from './lib.mjs';
import { validate as contracts } from './validate-contracts.mjs';
import { validate as coverage } from './validate-gameplay-coverage.mjs';

const phases = ['intake', 'indexed', 'evidence_ready', 'game_brief_written', 'contracts_written', 'gate_failed', 'done'];
const marker = p => local(p, 'docs/brief-progress.json');
const digest = x => hash(JSON.stringify(x));
const iso = n => new Date(n).toISOString();
const readState = p => { if (!exists(marker(p))) throw Error('No progress marker: use --init at launch'); return json(marker(p)); };
const assertRun = (s,a) => { if (!a['run-id'] || a['run-id'] !== s.runId) throw Error('Missing/stale --run-id; do not write into another brief run'); };
export function update(p, a = {}, now = Date.now()) {
  if (a.init) {
    if (exists(marker(p)) && json(marker(p)).phase !== 'done') throw Error('Unfinished brief exists; inspect/resume its run ID instead of resetting progress');
    const s = { schemaVersion: 1, runId: crypto.randomUUID(), phase: 'intake', startedAt: iso(now), updatedAt: iso(now), phaseTimes: { intake: iso(now) }, baseline: fingerprints(p), evidenceOpened: [], extraReads: [], filesWritten: [], blocker: null, nudges: [] };
    writeJson(marker(p), s); return { ok: true, progress: s };
  }
  const s = readState(p); assertRun(s,a);
  if (s.phase === 'done') throw Error('Run is complete; start a new run only for new authorized work');
  if (a.phase && !phases.includes(a.phase)) throw Error(`Unknown phase: ${a.phase}`);
  if (a.file) {
    if (!exists(local(p, a.file))) throw Error(`Authored file missing: ${a.file}`);
    s.filesWritten = [...new Set([...s.filesWritten, a.file])];
  }
  if (a.evidence) {
    if (!exists(local(p,a.evidence))) throw Error('Evidence file missing');
    s.evidenceOpened = [...new Set([...s.evidenceOpened, a.evidence])];
  }
  if (a.read) {
    if (!a.reason || typeof a.reason !== 'string') throw Error('--read requires --reason explaining the decision');
    if (!s.extraReads.some(x => x.path === a.read && x.reason === a.reason)) s.extraReads.push({ path: a.read, reason: a.reason });
  }
  if (a.phase === 'indexed' && !exists(local(p, 'docs/brief-input-index.json'))) throw Error('Generate input index before indexed phase');
  if (a.phase === 'game_brief_written' && !exists(local(p, 'GAME_BRIEF.md'))) throw Error('GAME_BRIEF.md missing');
  if (a.phase === 'done') {
    const c = contracts(p), g = coverage(p);
    if (!c.ok || !g.ok) return { ok: false, error: 'Mechanical gate failed', contracts: c, coverage: g };
    if (!a.review) throw Error('done requires --review <project-relative JSON> from coordinator semantic review');
    const r = json(local(p,a.review));
    for (const k of ['visualTargetInspected','evidenceLabelsChecked','sourceCoverageChecked','gameplaySemanticsChecked']) if (r[k] !== true) throw Error(`Semantic review missing ${k}`);
    if (r.runId !== s.runId || r.contractHash !== reviewHash(p)) throw Error('Semantic review refers to stale run/contracts/source policy');
    s.review = a.review; s.contractHash = r.contractHash; s.dispatchableSlices = c.dispatchableSlices;
  }
  if (a.phase) { s.phase = a.phase; s.phaseTimes[a.phase] ||= iso(now); }
  if (a.blocker !== undefined) s.blocker = a.blocker === 'clear' ? null : a.blocker;
  if (a['ack-nudge']) s.nudges.push({ at: iso(now), snapshot: snapshot(p, s), reason: String(a['ack-nudge']) });
  s.updatedAt = iso(now); writeJson(marker(p), s);
  return { ok: true, progress: s };
}
function snapshot(p,s) {
  return digest({ files: fingerprints(p), evidence: s.evidenceOpened, index: exists(local(p,'docs/brief-input-index.json')) ? json(local(p,'docs/brief-input-index.json')).inputFingerprint : null });
}
export function watch(p, a = {}, now = Date.now()) {
  const s = readState(p), current = fingerprints(p), snap = snapshot(p,s);
  const monitoring = local(p, 'docs/brief-watch.json');
  let w = exists(monitoring) ? json(monitoring) : null;
  if (!w || w.runId !== s.runId) w = { runId: s.runId, snapshot: snap, lastProgressAt: s.startedAt, firstContractAt: null };
  if (w.snapshot !== snap) { w.lastProgressAt = iso(now); w.snapshot = snap; }
  const changedFiles = Object.keys(current).filter(k => current[k] !== s.baseline[k]);
  if (changedFiles.includes('GAME_BRIEF.md') && !/BRIEF_DRAFT/.test(read(local(p,'GAME_BRIEF.md')))) w.firstContractAt ||= iso(now);
  const elapsed = (now - Date.parse(s.startedAt)) / 60000;
  const stagnant = (now - Date.parse(w.lastProgressAt)) / 60000;
  let action = 'continue';
  if (s.phase === 'done') action = s.contractHash === reviewHash(p) ? 'done' : 'gate_stale';
  else if (elapsed >= 5 && !exists(local(p,'docs/brief-input-index.json'))) action = 'nudge_index';
  else if (elapsed >= 10 && !w.firstContractAt) action = 'nudge_first_contract';
  else if (stagnant >= 8) action = 'nudge_progress';
  const last = s.nudges.at(-1);
  if (action.startsWith('nudge') && last?.snapshot === snap) {
    action = now - Date.parse(last.at) >= 8 * 60000 ? 'recovery_candidate' : 'wait_after_nudge';
  }
  writeJson(monitoring,w);
  return { ok: true, runId: s.runId, phase: s.phase, action, elapsedMinutes: +elapsed.toFixed(2), stagnantMinutes: +stagnant.toFixed(2), changedFiles, contractHash: reviewHash(p), metrics: { firstContractMinutes: w.firstContractAt ? (Date.parse(w.firstContractAt) - Date.parse(s.startedAt)) / 60000 : null, completionMinutes: s.phaseTimes.done ? (Date.parse(s.phaseTimes.done) - Date.parse(s.startedAt)) / 60000 : null, evidenceCount: s.evidenceOpened.length, extraReads: s.extraReads.length, nudges: s.nudges.length }, note: 'Advisory action only. Recovery requires verified cessation of the old writer and its background jobs before ownership transfer.' };
}
if (process.argv[1] === new URL(import.meta.url).pathname) run(() => { const a = args(), p = project(a); return a.watch ? watch(p,a) : update(p,a); });
