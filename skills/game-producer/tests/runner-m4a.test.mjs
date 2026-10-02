import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { editRelease, loadProject, sliceStatuses, nextSlice, preflight, gateDecides, parsePolicy } from '../scripts/lib/project.mjs';
import { NOTES, POLICY, project, fakes, runner, clearControl } from './harness.mjs';

// every CLI run goes through the fakes: `start` now dispatches lanes (M4b)
const fake = fakes();
const run = (root, ...args) => runner(root, fake, ...args);
function treeHash(root) {
  const h = crypto.createHash('sha256');
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name === '.git') continue;
      const p = path.join(d, e.name);
      h.update(p);
      if (e.isDirectory()) walk(p);
      else h.update(fs.readFileSync(p));
    }
  };
  walk(root);
  return h.digest('hex');
}

test('selection: DAG order, git merged wins over the cache, free-text mentions do not count', () => {
  const p = project();
  assert.deepEqual(nextSlice(loadProject(p.root)), { slice: 'S01', resume: false });
  p.commit('docs: S01 plan notes'); // a mention, not a merge
  assert.equal(nextSlice(loadProject(p.root)).slice, 'S01');
  p.commit('feat(S01): first slice');
  const proj = loadProject(p.root);
  assert.equal(sliceStatuses(proj).S01.source, 'git');
  assert.deepEqual(nextSlice(proj), { slice: 'S02', resume: false });
  p.commit("Merge branch 'S02-x'");
  assert.equal(nextSlice(loadProject(p.root)).slice, 'S03');
});

test('selection: an in-progress slice resumes before any stop; contract drift stops the runner', () => {
  const p = project({ notes: NOTES(POLICY, '{S01: merged, S02: in_progress}') });
  assert.deepEqual(nextSlice(loadProject(p.root)), { slice: 'S02', resume: true });
  const q = project({ notes: NOTES(POLICY, '{S01: merged, S09: in_progress}') });
  assert.match(nextSlice(loadProject(q.root)).reason, /S09 in progress but not in MILESTONES/);
  const r = project({ notes: NOTES(POLICY, '{S01: in_progress, S02: in_progress}') });
  assert.match(nextSlice(loadProject(r.root)).reason, /more than one slice in progress/);
  const done = project({ notes: NOTES(POLICY.replace('goal=end_to_end', 'goal=playable'), '{S01: merged}').replace('goal: end_to_end', 'goal: playable') });
  assert.equal(nextSlice(loadProject(done.root)).done, true);
});

test('preflight: director gate (explicit decisions only), policy conflict, contract depth, slice study, missing policy', () => {
  const p = project({ slices: { S01: { needs: false }, S02: { needs: true }, S03: { needs: true, study: true } } });
  const proj = loadProject(p.root);
  assert.deepEqual(preflight(proj, 'S02'), []); // "director gate: S02 GIVEN"
  assert.deepEqual(preflight(proj, 'S03').map((b) => b.code), ['director_gate', 'needs_slice_study']);
  // real policy wording (cc-tiki-smash, cc-lego-stack, cc-monopoly-go): a decision needs an explicit word
  const tiki = 'director gate: S01 R-01=A; S02 approved as written (rip-backed default_003/004 sequence); S03 approved 2026-09-23; S04–S08 gate when reached';
  assert.deepEqual(['S02', 'S03', 'S05', 'S08'].map((id) => gateDecides(tiki, id)), [true, true, false, false]);
  assert.equal(gateDecides('S08 gate gate_9b5d538c2c1d approved as written', 'S08'), true);
  assert.equal(gateDecides('S02=accept proposed city-detail tier progression', 'S02'), true);
  assert.equal(gateDecides('S05 NOT approved yet', 'S05'), false);
  assert.equal(gateDecides('S01 GIVEN GP-15; S02-S07 outside playable stop', 'S05'), false); // a range mention
  assert.equal(gateDecides('S02-S07 GIVEN', 'S05'), true); // a range with the decision word right after it
  assert.equal(gateDecides('S01 GIVEN', 'S10'), false);
  // the window stops at the next clause / slice id, and go/ok/yes are not decisions
  assert.equal(gateDecides('S04 will go through review; S05 approved', 'S04'), false);
  assert.equal(gateDecides('S04 TBD S05 approved', 'S04'), false);
  assert.equal(gateDecides('S09 on hold, go later', 'S09'), false);
  assert.equal(gateDecides('S04 TBD S05 approved', 'S05'), true);
  for (const t of ['S09 will be approved when reached', 'S09 to be approved by the director', 'S09 needs approved plan']) assert.equal(gateDecides(t, 'S09'), false, t);
  const nested = parsePolicy(`${NOTES(POLICY)}`.replace('(director gate: S02 GIVEN)', '(director gate: S02 GIVEN (rip-backed) S03 approved 2026-09-23)'));
  assert.equal(nested.directorGate, 'director gate: S02 GIVEN (rip-backed) S03 approved 2026-09-23');
  const c = project({ notes: NOTES(POLICY.replace('goal=end_to_end', 'goal=playable')) });
  assert.deepEqual(preflight(loadProject(c.root), 'S01').map((b) => b.code), ['policy_conflict']);
  const d = project({ notes: NOTES(POLICY).replace('contract_depth: full', 'contract_depth: playable') });
  assert.deepEqual(preflight(loadProject(d.root), 'S02').map((b) => b.code), ['contract_depth']);
  const e = project({ notes: NOTES('') });
  assert.equal(parsePolicy(fs.readFileSync(path.join(e.root, 'AGENT_NOTES.md'), 'utf8')), null);
  assert.deepEqual(preflight(loadProject(e.root), 'S01').map((b) => b.code), ['needs_policy']);
});

test('editRelease changes only the value bytes in flow, JSON-style and block maps', () => {
  const flow = NOTES(POLICY, '{S01: merged, S02: planned}');
  const out = editRelease(flow, { currentSlice: 'S02', slices: { S02: 'in_progress', S03: 'planned' } });
  const changed = (a, b) => a.split('\n').filter((l, i) => l !== b.split('\n')[i]);
  assert.deepEqual(changed(out, flow).map((l) => l.trim().split('#')[0].trim()),
    ['current_slice: "S02"', 'slices: {S01: merged, S02: in_progress, S03: planned}']);
  const json = editRelease(NOTES(POLICY, '{"S01":"merged"}'), { slices: { S02: 'in_progress' } });
  assert.match(json, /slices: \{"S01":"merged","S02":"in_progress"\}/);
  const empty = editRelease(NOTES(POLICY, '{}'), { slices: { S01: 'in_progress' } });
  assert.match(empty, /slices: \{S01: in_progress\}/);
  const block = NOTES(POLICY, '\n    S01: merged   # first\n    S02: planned');
  const b2 = editRelease(block, { slices: { S02: 'merged', S03: 'in_progress' } });
  assert.match(b2, /\n {4}S01: merged {3}# first\n {4}S02: merged {2,}# S01: planned[^\n]*\n {4}S03: in_progress\n```/);
  assert.throws(() => editRelease(NOTES(POLICY, '\n    S01:\n      status: merged'), { slices: { S01: 'blocked' } }), /not a plain status/);
});

test('CLI: dry-run writes nothing; start marks the slice and holds one lock; answers apply once', async () => {
  const p = project();
  const before = treeHash(p.root);
  assert.deepEqual(run(p.root, 'start', '--dry-run').out[0], {
    slice: 'S01', resume: false, lane: 'single', phase: null, blockers: [], open_questions: [], would: 'mark in_progress and spawn the single lane',
  });
  assert.equal(treeHash(p.root), before);
  fake.queue([]); // no lane activity: the fake stops the runner after the spawn
  const s = run(p.root, 'start', '--once').out.at(-1);
  assert.deepEqual([s.stopped, s.slice], ['control file says stop', 'S01']);
  const proj = loadProject(p.root);
  assert.deepEqual([proj.release.current_slice, proj.release.slices.S01], ['S01', 'in_progress']);
  assert.equal(fs.existsSync(path.join(p.root, '.cursor/producer.lock')), false); // released on exit
  assert.match(fs.readFileSync(path.join(p.root, '.git/info/exclude'), 'utf8'), /^\/\.cursor\/producer\*$/m);
  clearControl(p.root);
  // a live holder refuses a second runner; a dead one is taken over
  const holder = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 20000)']);
  fs.writeFileSync(path.join(p.root, '.cursor/producer.lock'), JSON.stringify({ pid: holder.pid, host: os.hostname() }));
  const refused = run(p.root, 'start', '--once');
  assert.equal(refused.status, 3);
  holder.kill();
  await new Promise((r) => holder.on('exit', r));
  fake.queue([]);
  assert.match(run(p.root, 'start', '--once').out[0].note, /took over the lock of dead pid/);
});

test('CLI: blocked → one question; answer validates the option and records once; control file stops', () => {
  const p = project({ slices: { S01: { needs: true } } });
  const first = run(p.root, 'start', '--once').out;
  assert.deepEqual([first[0].blocked, first[0].question, first.at(-1).waiting], ['director_gate', 'q1', 'q1']);
  assert.equal(run(p.root, 'start', '--once').out.at(-1).waiting, 'q1'); // same stop, same question
  assert.match(run(p.root, 'answer', '--id', 'q1', '--choice', 'maybe').out[0].error, /choice must be one of/);
  assert.equal(run(p.root, 'answer', '--id', 'q1', '--choice', 'stop').out[0].answer.choice, 'stop');
  assert.match(run(p.root, 'answer', '--id', 'q1', '--choice', 'stop').out[0].error, /already answered/);
  assert.match(run(p.root, 'start', '--once').out.at(-1).stopped, /human chose stop/);
  assert.match(run(p.root, 'start', '--once').out.at(-1).stopped, /control file says stop/);
  run(p.root, 'clear');
  assert.equal(fs.existsSync(path.join(p.root, '.cursor/producer.control')), false);
  run(p.root, 'pause');
  assert.match(run(p.root, 'start', '--once').out.at(-1).stopped, /pause/);
});
