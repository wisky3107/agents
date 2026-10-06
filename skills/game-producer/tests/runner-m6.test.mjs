import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { loadProject } from '../scripts/lib/project.mjs';
import { prompts, manualItems, FLEET_COMMIT_TEXT } from '../scripts/lib/lanes.mjs';
import { textNeed, parseReply, menu, answerProblem } from '../scripts/lib/answer.mjs';
import { NOTES, POLICY, RUNNER, project, fakes, runner, env, evRel, ev, sliceState, clearControl, approvedEvidence, commitStep, lastCommit } from './harness.mjs';
import { reviewFiles } from '../scripts/lib/state.mjs';

// Plan M6, after pilot 1: three ways to answer (terminal, dialog, `answer` menu), release.manual_required:
// defer, and the runner stops that pilot 1 showed were not the director's (stale review.md, a passing
// "terminal missing", a second gate asked before the coordinator acted, a fleet worktree kept as dirty,
// a commit typed by hand).
process.env.PRODUCER_RUNNER_CURSOR = 'on'; // in-process prompt builds: no real cursor-agent probe
const DIALOG = new URL('../scripts/answer-dialog.mjs', import.meta.url).pathname;
const H = evRel('S01', 'HANDOFF.json');
const W = (status, extra = {}) => ({ [H]: { role: 'writer', status, detail: 'd', sha: null, ...extra } });
const R = (status, verdict, runtime) => ({ [H]: { role: 'reviewer', status }, ...approvedEvidence('S01', verdict, runtime) });
const preview = (port) => ({ [evRel('S01', 'preview-startup.json')]: { projectPath: '/p', previewUrl: `http://127.0.0.1:${port}/`, status: 'ready' } });
const runnerFile = (root) => JSON.parse(fs.readFileSync(path.join(root, '.cursor', 'producer-runner.json'), 'utf8'));
const question = (root, id) => runnerFile(root).questions.find((q) => q.id === id);
const log = (root, id = 'S01') => fs.readFileSync(ev(root, id, 'producer-log.md'), 'utf8');
const exited = (child) => new Promise((r) => child.on('exit', (code) => r(code)));
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const GATE = { id: 'q1', key: 'S01:fleet_gate:g1', kind: 'fleet_gate', slice: 'S01', text: 'fleet gate g1: Approve PLAN?', options: ['approve', 'revise', 'stop'], ref: 'g1', answer: null };
const LANE = { id: 'q2', key: 'S01:lane_blocked', kind: 'lane_blocked', slice: 'S01', text: 'fleet HANDOFF blocked: which material?', options: ['send this answer to the lane', 'answered in the lane, continue', 'mark blocked', 'stop'], ref: null, answer: null };
const withQuestions = (qs) => {
  const p = project({ slices: { S01: { needs: false } } });
  fs.mkdirSync(path.join(p.root, '.cursor'), { recursive: true });
  fs.writeFileSync(path.join(p.root, '.cursor', 'producer-runner.json'), JSON.stringify({ slice: 'S01', step: 'blocked:x', questions: qs }));
  return p;
};
// a project whose first slice waits on the director gate (POLICY records only S02 GIVEN)
const gated = () => project({ slices: { S01: { needs: true } } });

// osascript stand-in: logs each run, sleeps on osa-sleep, prints osa-choice (choose) or osa-note (note), else "cancels"
const FAKE_OSA = `#!/usr/bin/env node
const fs = require('fs'), path = require('path');
const D = process.env.FAKE_DIR, a = process.argv.slice(2);
const script = a.filter((x, i) => a[i - 1] === '-e').join('\\n');
const args = a.filter((x, i) => x !== '-e' && a[i - 1] !== '-e');
const kind = script.includes('choose from list') ? 'choose' : 'note';
fs.appendFileSync(path.join(D, 'osa.log'), JSON.stringify({ kind, args }) + '\\n');
if (fs.existsSync(path.join(D, 'osa-sleep'))) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(fs.readFileSync(path.join(D, 'osa-sleep'), 'utf8')));
const reply = path.join(D, kind === 'choose' ? 'osa-choice' : 'osa-note');
if (!fs.existsSync(reply)) process.exit(1);
process.stdout.write(fs.readFileSync(reply, 'utf8') + '\\n');
`;
function osa(f, { choice, note, sleepMs } = {}) {
  const bin = path.join(f.dir, 'osascript-fake');
  fs.writeFileSync(bin, FAKE_OSA, { mode: 0o755 });
  for (const [file, v] of [['osa-choice', choice], ['osa-note', note], ['osa-sleep', sleepMs]]) {
    if (v === undefined) fs.rmSync(path.join(f.dir, file), { force: true });
    else fs.writeFileSync(path.join(f.dir, file), String(v));
  }
  return bin;
}
const osaRuns = (f) => (fs.existsSync(path.join(f.dir, 'osa.log')) ? fs.readFileSync(path.join(f.dir, 'osa.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
const dialog = (root, f, id, extraEnv = {}) =>
  spawnSync(process.execPath, [DIALOG, '--project', root, '--id', id], { encoding: 'utf8', timeout: 20000, env: { ...env(root, f), ...extraEnv } });

test('answer lib: which choices take a note, numbers with an inline note, the menu text', () => {
  assert.deepEqual([textNeed(GATE, 'approve'), textNeed(GATE, 'stop'), textNeed({ kind: 'fleet_gate' }, 'answer with --text')], ['optional', null, 'required']);
  assert.deepEqual([textNeed(LANE, 'send this answer to the lane'), textNeed(LANE, 'mark blocked')], ['required', null]);
  assert.equal(textNeed({ kind: 'spawn_unconfirmed' }, 'reattach the handle given in --text'), 'required');
  assert.deepEqual(parseReply(GATE, '2'), { choice: 'revise', text: '' });
  assert.deepEqual(parseReply(GATE, ' 1  only the test file '), { choice: 'approve', text: 'only the test file' });
  assert.deepEqual(parseReply(GATE, '1) yes'), { choice: 'approve', text: 'yes' });
  assert.match(parseReply(GATE, '4').error, /1 to 3/);
  assert.match(parseReply(GATE, 'approve').error, /number/);
  assert.match(menu(LANE), /^q2 · lane_blocked · S01\nfleet HANDOFF blocked: which material\?\n\n {2}1\) send this answer to the lane {2}\(needs a note\)\n {2}2\) answered in the lane, continue\n/);
  // the footer's example is a placeholder, not a note someone could copy as an instruction (S10 q21)
  assert.match(menu(LANE), /A note may follow the number \("2 <note>"\); it is passed on word for word\.$/);
  assert.equal(answerProblem(GATE, 'approve', ''), null);
  assert.match(answerProblem({ ...GATE, options: ['answer with --text', 'stop'] }, 'answer with --text', ' '), /needs the decision/);
  assert.match(answerProblem({ ...GATE, answer: { choice: 'approve' } }, 'revise'), /already answered \(approve\)/);
  assert.match(answerProblem(GATE, 'yes'), /choice must be one of: approve, revise, stop/);
});

test('answer CLI: flags record as before; no flags and no terminal → an error naming the menu; the menu picks question and option', () => {
  const p = withQuestions([GATE, LANE]);
  const f = fakes();
  assert.match(runner(p.root, f, 'answer').out[0].error, /numbered menu/);
  // two waiting: question 2, option 1 needs a note — an empty note is refused, then asked again
  const r = runner(p.root, f, 'answer', { env: { PRODUCER_RUNNER_TTY: '1' }, input: '2\n1\n\n1\nthe integrator makes the .mtl\n' });
  assert.deepEqual(r.out.at(-1).answer && { id: r.out.at(-1).id, ...r.out.at(-1).answer, at: null }, { id: 'q2', choice: 'send this answer to the lane', text: 'the integrator makes the .mtl', by: 'human', via: 'menu', at: null });
  assert.match(r.stderr, /question number: /);
  assert.match(r.stderr, /give the answer for the lane as the note/);
  // --id with no --choice: that question's menu; the note may follow the number
  const g = runner(p.root, f, 'answer', '--id', 'q1', { env: { PRODUCER_RUNNER_TTY: '1' }, input: '2 smaller boards\n' }).out.at(-1);
  assert.deepEqual([g.answer.choice, g.answer.text, g.answer.via], ['revise', 'smaller boards', 'menu']);
  assert.deepEqual(runner(p.root, f, 'answer', { env: { PRODUCER_RUNNER_TTY: '1' }, input: '' }).out.at(-1), { none: 'no question is waiting' });
  // the flags still work, and still refuse a second answer
  const q = withQuestions([GATE]);
  assert.deepEqual(runner(q.root, f, 'answer', '--id', 'q1', '--choice', 'approve', '--text', 'x').out[0].answer.by, 'human');
  assert.match(runner(q.root, f, 'answer', '--id', 'q1', '--choice', 'revise').out[0].error, /already answered/);
  // input that ends before an answer: an error, nothing recorded
  const e = withQuestions([GATE]);
  assert.match(runner(e.root, f, 'answer', { env: { PRODUCER_RUNNER_TTY: '1' }, input: 'x\n' }).out.at(-1).error, /input closed/);
  assert.equal(question(e.root, 'q1').answer, null);
});

test('runner terminal: the question with numbered options on stderr; a line typed before it is dropped; the number answers it', async (t) => {
  const p = gated();
  const f = fakes();
  const child = spawn(process.execPath, [RUNNER, 'start', '--project', p.root], { env: { ...env(p.root, f), PRODUCER_RUNNER_TTY: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => child.exitCode === null && child.kill('SIGKILL')); // a failed assertion must not leave the runner waiting
  let err = '';
  let out = '';
  child.stderr.on('data', (d) => (err += d));
  child.stdout.on('data', (d) => (out += d));
  child.stdin.write('3\n'); // typed ahead ("skip this slice"): must never answer q1
  for (let i = 0; i < 400 && !err.includes('q1 · director_gate · S01'); i++) await pause(25);
  // where the run stands first (project, slice, release), then the question and its options
  assert.match(err, new RegExp(`${path.basename(p.root)} · S01 x \\(planned\\)\nrelease: 0/1 merged\n\nq1 · director_gate · S01\n`));
  assert.match(err, /q1 · director_gate · S01\n.*\n\n {2}1\) S01 GIVEN — record it on the policy line\n {2}2\) decided, retry\n {2}3\) skip this slice\n {2}4\) stop/);
  await pause(700);
  assert.equal(question(p.root, 'q1').answer, null);
  child.stdin.write('7\n'); // out of range: told, not recorded
  child.stdin.write('4\n');
  const code = await exited(child);
  assert.equal(code, 0);
  assert.match(err, /type a number from 1 to 4/);
  assert.match(err, /recorded q1: stop/);
  assert.deepEqual([question(p.root, 'q1').answer.choice, question(p.root, 'q1').answer.via], ['stop', 'terminal']);
  assert.match(out, /"stopped":"the human chose stop"/);
  assert.equal(loadProject(p.root).release.slices.S01, undefined); // "skip this slice" never applied
});

test('runner terminal: a choice that needs a note asks for it; the answer reaches the lane', async (t) => {
  const p = project({ slices: { S01: { needs: false, size: 'L' } } });
  const f = fakes();
  f.queue([
    { name: 'run', runs: [{ id: 'run_1', coordinator_handle: 'term_1' }], write: { [H]: { role: 'coordinator', status: 'working' } } },
    { name: 'blocked', write: { [H]: { role: 'coordinator', status: 'blocked', detail: 'which material route?' } } },
  ]);
  const child = spawn(process.execPath, [RUNNER, 'start', '--project', p.root], { env: { ...env(p.root, f), PRODUCER_RUNNER_TTY: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => child.exitCode === null && child.kill('SIGKILL'));
  let err = '';
  child.stderr.on('data', (d) => (err += d));
  for (let i = 0; i < 400 && !err.includes('q1 · lane_blocked · S01'); i++) await pause(25);
  await pause(600);
  child.stdin.write('1\n');
  for (let i = 0; i < 200 && !err.includes('note for "send this answer to the lane": '); i++) await pause(25);
  child.stdin.write('the integrator makes the .mtl\n');
  await exited(child); // the queue runs out after the answer: the fake writes stop
  assert.deepEqual([question(p.root, 'q1').answer.choice, question(p.root, 'q1').answer.text], ['send this answer to the lane', 'the integrator makes the .mtl']);
  assert.match(f.sends().at(-1).text, /^Director's answer to your question: the integrator makes the \.mtl — continue the slice/);
});

test('dialog: choice + note go through the same answer path; Later and a cancelled required note record nothing', () => {
  const p = withQuestions([GATE, LANE]);
  const f = fakes();
  const bin = osa(f, { choice: 'approve', note: 'only the test file' });
  assert.equal(dialog(p.root, f, 'q1', { PRODUCER_RUNNER_OSASCRIPT: bin }).status, 0);
  const a = question(p.root, 'q1').answer;
  assert.deepEqual([a.choice, a.text, a.by, a.via], ['approve', 'only the test file', 'human', 'dialog']);
  const [choose, note] = osaRuns(f);
  assert.equal(choose.kind, 'choose');
  assert.deepEqual(choose.args.slice(2), ['approve', 'revise', 'stop']);
  assert.equal(choose.args[0], `producer-runner · ${path.basename(p.root)}`);
  assert.match(choose.args[1], new RegExp(`^${path.basename(p.root)} · S01 x \\(planned\\)\nrelease: 0/1 merged\n\nq1 · fleet_gate · S01\nfleet gate g1: Approve PLAN\\?`));
  assert.match(note.args[1], /^Note for "approve" \(optional, sent with the decision word for word; leave empty for none\):$/);
  // Later
  osa(f, { choice: '<<later>>' });
  dialog(p.root, f, 'q2', { PRODUCER_RUNNER_OSASCRIPT: bin });
  assert.equal(question(p.root, 'q2').answer, null);
  // a required note, cancelled
  osa(f, { choice: 'send this answer to the lane' });
  dialog(p.root, f, 'q2', { PRODUCER_RUNNER_OSASCRIPT: bin });
  assert.equal(question(p.root, 'q2').answer, null);
  assert.match(osaRuns(f).at(-1).args[1], /required/);
  // an already answered question opens no dialog
  const n = osaRuns(f).length;
  dialog(p.root, f, 'q1', { PRODUCER_RUNNER_OSASCRIPT: bin });
  assert.equal(osaRuns(f).length, n);
});

test('dialog: the whole question, then why the judge left it to the director; only a very long one is cut (S10 q21, 2026-10-04)', () => {
  const tail = 'Should this manifest path be added to S01, or should the worker restore it and keep only the listed .mtl/scene paths?';
  const text = `fleet gate g1: S01 scope field needing director decision: ${'the slice paths authorize one file but not the manifest. '.repeat(20)}${tail}`;
  const why = 'judge deferred: no contract sentence says whether to widen the path list, so this is a scope call for the director.';
  const p = withQuestions([{ ...GATE, text, judge: { at: '2026-10-04T14:28:30Z', defer: why } }, { ...LANE, text: 'y'.repeat(2500), judge: { at: '2026-10-04T14:28:30Z', defer: why } }]);
  const f = fakes();
  const bin = osa(f, { choice: '<<later>>' });
  dialog(p.root, f, 'q1', { PRODUCER_RUNNER_OSASCRIPT: bin });
  const shown = osaRuns(f)[0].args[1];
  assert.ok(text.length > 900 && shown.includes(`\nq1 · fleet_gate · S01\n${text}\n\n${why}`));
  assert.ok(shown.endsWith(why));
  dialog(p.root, f, 'q2', { PRODUCER_RUNNER_OSASCRIPT: bin });
  const cut = osaRuns(f)[1].args[1];
  assert.ok(cut.endsWith(`${'y'.repeat(1800)}… (the whole question: the runner terminal, or \`answer\` in a terminal)\n\n${why}`));
  assert.ok(!cut.includes('y'.repeat(1801)));
});

test('dialog: stop-after is not a halt (the runner keeps waiting); stop closes it without an answer', () => {
  const p = withQuestions([GATE]);
  const f = fakes();
  const bin = osa(f, { choice: 'approve', sleepMs: 1500 });
  fs.writeFileSync(path.join(p.root, '.cursor', 'producer.control'), 'stop-after S05\n');
  dialog(p.root, f, 'q1', { PRODUCER_RUNNER_OSASCRIPT: bin });
  assert.equal(question(p.root, 'q1').answer.choice, 'approve');
  const q = withQuestions([GATE]);
  fs.writeFileSync(path.join(q.root, '.cursor', 'producer.control'), 'stop\n');
  dialog(q.root, f, 'q1', { PRODUCER_RUNNER_OSASCRIPT: bin });
  assert.equal(question(q.root, 'q1').answer, null);
});

test('runner-file lock: concurrent writers lose nothing; a stale lock is broken after 10 s', async () => {
  const p = withQuestions([]);
  const state = new URL('../scripts/lib/state.mjs', import.meta.url).href;
  const writer = (n) => spawn(process.execPath, ['--input-type=module', '-e',
    `const st = await import(${JSON.stringify(state)}); for (let i = 0; i < 15; i++) st.ask(${JSON.stringify(p.root)}, { key: 'w${n}:' + i, kind: 'k', text: 't', options: ['a'] });`], { stdio: 'ignore' });
  const kids = Array.from({ length: 8 }, (_, n) => writer(n));
  assert.deepEqual(await Promise.all(kids.map(exited)), Array(8).fill(0));
  const qs = runnerFile(p.root).questions;
  assert.equal(qs.length, 120);
  assert.equal(new Set(qs.map((q) => q.id)).size, 120);
  assert.equal(fs.existsSync(path.join(p.root, '.cursor', 'producer-runner.json.lock')), false);
  // a writer killed inside the lock: the next one waits it out, then takes over
  const lock = path.join(p.root, '.cursor', 'producer-runner.json.lock');
  fs.mkdirSync(lock);
  fs.writeFileSync(path.join(lock, 'owner'), 'killed-writer');
  const old = (Date.now() - 11000) / 1000;
  fs.utimesSync(lock, old, old);
  const t0 = Date.now();
  assert.equal(await exited(writer(9)), 0);
  assert.ok(Date.now() - t0 < 8000, 'a stale lock is broken at once');
  assert.equal(runnerFile(p.root).questions.length, 135);
  assert.equal(fs.readdirSync(path.join(p.root, '.cursor')).filter((x) => x.includes('.lock')).length, 0);
});

test('dialog: answered another way while open → the dialog is closed and nothing is overwritten', async (t) => {
  const p = withQuestions([GATE]);
  const f = fakes();
  const bin = osa(f, { choice: 'revise', sleepMs: 8000 });
  const t0 = Date.now();
  const child = spawn(process.execPath, [DIALOG, '--project', p.root, '--id', 'q1'], { env: { ...env(p.root, f), PRODUCER_RUNNER_OSASCRIPT: bin }, stdio: 'ignore' });
  t.after(() => child.exitCode === null && child.kill('SIGKILL'));
  for (let i = 0; i < 200 && !osaRuns(f).length; i++) await pause(25);
  runner(p.root, f, 'answer', '--id', 'q1', '--choice', 'approve');
  await exited(child);
  assert.ok(Date.now() - t0 < 5000, 'closed, not waited out');
  assert.equal(question(p.root, 'q1').answer.choice, 'approve');
});

test('dialog after a restart: reopened when the helper is gone, not after "Later"', async (t) => {
  const p = gated();
  const f = fakes();
  const bin = osa(f, { choice: '<<later>>' });
  const start = () => {
    const c = spawn(process.execPath, [RUNNER, 'start', '--project', p.root], { env: { ...env(p.root, f), PRODUCER_RUNNER_DIALOG: '1', PRODUCER_RUNNER_OSASCRIPT: bin }, stdio: 'ignore' });
    t.after(() => c.exitCode === null && c.kill('SIGKILL'));
    return c;
  };
  let c = start();
  for (let i = 0; i < 400 && !(fs.existsSync(path.join(p.root, '.cursor', 'producer-runner.json')) && question(p.root, 'q1')?.dialog_done); i++) await pause(25);
  assert.equal(question(p.root, 'q1').dialog_done, 'later');
  c.kill('SIGKILL');
  await exited(c);
  c = start(); // closed with Later: no second dialog
  await pause(1500);
  assert.equal(osaRuns(f).filter((x) => x.kind === 'choose').length, 1);
  c.kill('SIGKILL');
  await exited(c);
  // a helper that died without an answer (pid gone, not Later): the next runner opens it again
  const r = JSON.parse(fs.readFileSync(path.join(p.root, '.cursor', 'producer-runner.json'), 'utf8'));
  delete r.questions[0].dialog_done;
  r.questions[0].dialog_pid = 2 ** 22 + 12345; // no such process
  fs.writeFileSync(path.join(p.root, '.cursor', 'producer-runner.json'), JSON.stringify(r));
  fs.rmSync(path.join(p.root, '.cursor', 'producer.lock'), { force: true });
  osa(f, { choice: 'stop' });
  const out = runner(p.root, f, 'start', { env: { PRODUCER_RUNNER_DIALOG: '1', PRODUCER_RUNNER_OSASCRIPT: bin } }).out;
  assert.match(out.at(-1).stopped, /the human chose stop/);
  assert.equal(osaRuns(f).filter((x) => x.kind === 'choose').length, 2);
});

test('the runner opens the dialog once per question; the dialog answer is applied like any other', () => {
  const p = gated();
  const f = fakes();
  const bin = osa(f, { choice: 'stop' });
  const r = runner(p.root, f, 'start', { env: { PRODUCER_RUNNER_DIALOG: '1', PRODUCER_RUNNER_OSASCRIPT: bin } });
  assert.deepEqual(r.out.at(-1), { stopped: 'the human chose stop', resume: 'producer-runner clear, then start' });
  assert.deepEqual([question(p.root, 'q1').answer.choice, question(p.root, 'q1').answer.via], ['stop', 'dialog']);
  assert.equal(osaRuns(f).filter((x) => x.kind === 'choose').length, 1);
  // PRODUCER_RUNNER_DIALOG=0 (the harness default): no dialog
  const q = gated();
  const g = fakes();
  osa(g, { choice: 'stop' });
  runner(q.root, g, 'start', '--once');
  assert.equal(osaRuns(g).length, 0);
});

test('director_gate: "S01 GIVEN — record it" writes the decision on the policy line and the slice starts; an older open question gets the new choice', async () => {
  const { editPolicyDecision, gateDecides } = await import('../scripts/lib/project.mjs');
  const policy = '- policy: goal=end_to_end auto_commit=true (director mandate: finish through S07; keep S02-S07 planned until targeted expansion)';
  const text = `${NOTES(policy)}\n`;
  const r = editPolicyDecision(text, 'S02', 'try it (first)\nthen S03 approved too, S04-S09 GIVEN, keep <TODO>', '2026-10-03', ['S02', 'S03', 'S04', 'S09']);
  assert.equal(r.changed, true);
  const line = r.text.split('\n').find((l) => l.startsWith('- policy:'));
  assert.equal(line, `${policy} (director gate: S02 GIVEN — try it first then slice 03 approved too, slice 04-slice 09 GIVEN, keep ‹TODO›; recorded by producer-runner 2026-10-03)`);
  assert.equal(gateDecides(line, 'S02'), true);
  for (const o of ['S03', 'S04', 'S07', 'S09']) assert.equal(gateDecides(line, o), false, `the note must not decide ${o}`);
  assert.doesNotMatch(line, /<[A-Z]/); // nothing for the lane prompt's fill() to reject
  assert.equal(r.text.replace(line, policy), text); // nothing else changes
  assert.equal(editPolicyDecision(r.text, 'S02').changed, false); // already decided
  // the runner: an older runner's question (no GIVEN choice) is refreshed in place
  const p = gated();
  const f = fakes();
  fs.mkdirSync(path.join(p.root, '.cursor'), { recursive: true });
  fs.writeFileSync(path.join(p.root, '.cursor', 'producer-runner.json'), JSON.stringify({ slice: 'S01', step: 'blocked:director_gate', questions: [
    { id: 'q1', key: 'S01:director_gate', kind: 'director_gate', slice: 'S01', text: 'Record the director decision for this slice in the policy line, then answer.', options: ['decided, retry', 'skip this slice', 'stop'], ref: null, answer: null } ] }));
  const a = runner(p.root, f, 'start', '--once').out.at(-1);
  assert.deepEqual([a.waiting, a.options], ['q1', ['S01 GIVEN — record it on the policy line', 'decided, retry', 'skip this slice', 'stop']]);
  assert.equal(runnerFile(p.root).questions.length, 1);
  assert.equal(question(p.root, 'q1').text, 'This slice waits for the director: approve it here (the runner writes "S01 GIVEN" on the policy line), or record your own decision on the policy line and retry.');
  runner(p.root, f, 'answer', '--id', 'q1', '--choice', 'S01 GIVEN — record it on the policy line', '--text', 'go ahead');
  runner(p.root, f, 'start', '--once');
  assert.match(loadProject(p.root).policy.raw, /\(director gate: S01 GIVEN — go ahead; recorded by producer-runner \d{4}-\d{2}-\d{2}\)$/);
  assert.match(log(p.root), /director decision recorded on the policy line \(human via answer --choice\): S01 GIVEN — go ahead/);
  assert.deepEqual(f.spawns().map((x) => [x.role, x.slice]), [['worker', 'S01']]); // the gate is passed: the writer starts
  assert.match(f.spawns()[0].prompt, /S01 GIVEN — go ahead/); // and its prompt carries the decision
});

test('single lane commit: the request says what to write; a lone commit without HANDOFF is taken; two are the director\'s pick', () => {
  const quiet = (id, message) => ({ name: `commit ${message}`, commit: { message, handoff: evRel(id, 'HANDOFF.json'), noHandoff: true } });
  const p = project({ slices: { S01: { needs: false } } });
  const f = fakes();
  f.queue([
    { name: 'ready', write: { ...W('ready_for_review'), ...preview(7461) } },
    { name: 'approved', write: R('approved', 'APPROVED') },
    quiet('S01', 'feat(S01): the slice'),
    { name: 'writer idle', result: 'idle' },
  ]);
  const out = runner(p.root, f, 'start', '--once').out;
  assert.match(f.sends()[0].text, /^approved — commit: run \/commit-guard on this checkout, then write \/.+\/T-S01\/evidence\/HANDOFF\.json with "status": "committed" and "sha": the full sha of that commit\.$/);
  assert.deepEqual(out.find((o) => o.merged), { merged: 'S01', commit: lastCommit(f) });
  assert.equal(sliceState(p.root, 'S01').commit_found, true);
  assert.match(log(p.root), /the writer committed \w{7} \("feat\(S01\): the slice"\) without writing HANDOFF committed: taking it as the slice commit/);
  // a lone commit that does not name the slice (a teammate's) is never taken: the director decides
  const t = project({ slices: { S01: { needs: false } } });
  const g1 = fakes();
  g1.queue([
    { name: 'ready', write: { ...W('ready_for_review'), ...preview(7461) } },
    { name: 'approved', write: R('approved', 'APPROVED') },
    quiet('S01', 'chore: teammate fixes the README'),
    { result: 'idle' }, { result: 'idle' }, { result: 'idle' },
  ]);
  const n = runner(t.root, g1, 'start', '--once').out.at(-1);
  assert.deepEqual([n.kind, n.options[0]], ['commit_stalled', 'the newest commit is the slice, continue']);
  assert.notEqual(sliceState(t.root, 'S01').phase, 'merge');
  // two commits since the request: not guessed — the director picks (or resends)
  const q = project({ slices: { S01: { needs: false } } });
  const g2 = fakes();
  g2.queue([
    { name: 'ready', write: { ...W('ready_for_review'), ...preview(7461) } },
    { name: 'approved', write: R('approved', 'APPROVED') },
    quiet('S01', 'wip: half'), quiet('S01', 'feat(player): the rest'),
    { result: 'idle' }, { result: 'idle' }, { result: 'idle' },
  ]);
  const a = runner(q.root, g2, 'start', '--once').out.at(-1);
  assert.deepEqual([a.kind, a.options], ['commit_stalled', ['the newest commit is the slice, continue', 'resend commit', 'mark blocked', 'stop']]);
  assert.match(question(q.root, 'q1').text, /commits on main since the request: \w{7} "wip: half", \w{7} "feat\(player\): the rest"/);
  runner(q.root, g2, 'answer', '--id', 'q1', '--choice', 'the newest commit is the slice, continue');
  const b = runner(q.root, g2, 'start', '--once').out;
  assert.deepEqual(b.find((o) => o.merged), { merged: 'S01', commit: lastCommit(g2) });
});

test('commit stalled: after "resend commit" a stall is asked again (pilot 2 waited in silence); autopilot resends once by itself', () => {
  const p = project({ slices: { S01: { needs: false } } });
  const f = fakes();
  const stall = [{ result: 'idle' }, { result: 'idle' }, { result: 'idle' }];
  f.queue([{ name: 'ready', write: { ...W('ready_for_review'), ...preview(7461) } }, { name: 'approved', write: R('approved', 'APPROVED') }, ...stall]);
  assert.equal(runner(p.root, f, 'start', '--once').out.at(-1).kind, 'commit_stalled');
  runner(p.root, f, 'answer', '--id', 'q1', '--choice', 'resend commit');
  f.queue(stall);
  const b = runner(p.root, f, 'start', '--once').out.at(-1);
  assert.deepEqual([b.waiting, b.kind], ['q2', 'commit_stalled']);
  assert.deepEqual(f.sends().map((x) => x.text.slice(0, 18)), ['approved — commit:', 'approved — commit:']);
  // autopilot: retry_once — the first stall is resent by the runner, the second waits for the director
  const q = project({ notes: NOTES(POLICY, '{}', '  autopilot: retry_once\n'), slices: { S01: { needs: false } } });
  const g2 = fakes();
  g2.queue([{ name: 'ready', write: { ...W('ready_for_review'), ...preview(7461) } }, { name: 'approved', write: R('approved', 'APPROVED') }, ...stall, ...stall]);
  const c = runner(q.root, g2, 'start', '--once').out;
  assert.deepEqual(c.find((o) => o.autopilot), { autopilot: 'q1', kind: 'commit_stalled', choice: 'resend commit' });
  assert.deepEqual([question(q.root, 'q1').answer.by, c.at(-1).waiting, c.at(-1).kind], ['autopilot', 'q2', 'commit_stalled']);
  assert.equal(g2.sends().length, 2);
  assert.match(log(q.root), /autopilot on q1 \(commit_stalled\): resend commit — within its limit for this slice/);
  // {item, reason} manual items read as text
  assert.deepEqual(manualItems({ manual_required: [{ item: 'V5 landscape screenshot', reason: 'state only' }, { check: 'GP-22' }] }), ['V5 landscape screenshot — state only', 'GP-22']);
});

test('single lane: a review-r1.md kept by the reviewer next to the fresh APPROVED review.md is no verdict_override (pilot S04)', () => {
  const p = project({ slices: { S01: { needs: false } } });
  const f = fakes();
  f.queue([
    { name: 'ready', write: { ...W('ready_for_review'), ...preview(7461) } },
    { name: 'changes', write: { ...R('changes_requested', 'CHANGES_REQUESTED'), [evRel('S01', 'review-r1.md')]: 'F1\n\nCHANGES_REQUESTED\n' } },
    { name: 'fixed', write: W('ready_for_review') },
    { name: 'approved', write: R('approved', 'APPROVED') },
    commitStep('S01'),
  ]);
  const out = runner(p.root, f, 'start', '--once').out;
  assert.deepEqual(out.find((o) => o.merged), { merged: 'S01', commit: lastCommit(f) });
  assert.equal(runnerFile(p.root).questions.filter((q) => q.kind === 'verdict_override').length, 0);
});

test('a lane that puts AGENT_NOTES.md back (cache says planned) does not get a second writer (pilot S07)', () => {
  const notes = NOTES(POLICY);
  const p = project({ notes, slices: { S01: { needs: false } } });
  const f = fakes();
  f.queue([{ name: 'writer works', write: W('working') }]);
  runner(p.root, f, 'start', '--once'); // the queue runs out: stopped while the writer works
  clearControl(p.root);
  assert.equal(loadProject(p.root).release.slices.S01, 'in_progress');
  fs.writeFileSync(path.join(p.root, 'AGENT_NOTES.md'), notes); // the writer "cleans up": committed text again
  assert.equal(loadProject(p.root).release.slices.S01, undefined);
  f.queue([{ name: 'still working', write: W('working', { detail: 'more' }) }]);
  runner(p.root, f, 'start', '--once');
  assert.equal(f.spawns().length, 1); // the same writer, never a second one
  assert.equal(sliceState(p.root, 'S01').phase, 'writer');
  assert.deepEqual([loadProject(p.root).release.slices.S01, loadProject(p.root).release.current_slice], ['in_progress', 'S01']);
  // dry-run says what start does (review round 9): resume, never "spawn the lane"
  fs.writeFileSync(path.join(p.root, 'AGENT_NOTES.md'), notes);
  clearControl(p.root);
  const dry = runner(p.root, f, 'start', '--dry-run').out.at(-1);
  assert.deepEqual([dry.resume, dry.would], [true, 'continue at writer']);
  assert.match(log(p.root), /release cache said planned while the runner is at writer \(AGENT_NOTES\.md put back by a lane\?\): rewritten in_progress, resuming/);
  assert.match(f.spawns()[0].prompt, /implementing slice S01/);
});

test('verdict race: HANDOFF says approved before review.md is rewritten — waited for, no question (pilot S07)', () => {
  const p = project({ slices: { S01: { needs: false } } });
  const f = fakes();
  f.queue([
    { name: 'ready', write: { ...W('ready_for_review'), ...preview(7461) } },
    // HANDOFF first, review.md still the earlier round's
    { name: 'handoff first', write: { ...R('approved', 'APPROVED'), [evRel('S01', 'review.md')]: 'F9 open\n\nCHANGES_REQUESTED\n' } },
    { name: 'review.md lands', result: 'idle', write: { [evRel('S01', 'review.md')]: 'F9 re-verified\n\nAPPROVED\n' } },
    commitStep('S01'),
  ]);
  const out = runner(p.root, f, 'start', '--once').out;
  assert.deepEqual(out.find((o) => o.merged), { merged: 'S01', commit: lastCommit(f) });
  assert.equal(runnerFile(p.root).questions.length, 0);
  // a review file that never agrees is still asked, after the extra looks
  const q = project({ slices: { S01: { needs: false } } });
  const g2 = fakes();
  g2.queue([
    { name: 'ready', write: { ...W('ready_for_review'), ...preview(7461) } },
    { name: 'disagree', write: R('approved', 'CHANGES_REQUESTED') },
    { result: 'idle' }, { result: 'idle' },
  ]);
  const a = runner(q.root, g2, 'start', '--once').out.at(-1);
  assert.deepEqual([a.waiting, a.kind], ['q1', 'verdict_mismatch']);
  assert.match(question(q.root, 'q1').text, /HANDOFF says approved but review\.md ends "CHANGES_REQUESTED" after 2 more looks/);
});

test('autopilot: unattended approves a gated slice itself and settles a verdict mismatch from the review file', () => {
  const notes = NOTES(POLICY, '{}', '  autopilot: unattended\n');
  // director_gate: the runner records "<Sxx> GIVEN" as autopilot's and starts the slice
  const p = project({ notes, slices: { S01: { needs: true } } });
  const f = fakes();
  f.queue([{ name: 'writer works', write: W('working') }]);
  const out = runner(p.root, f, 'start', '--once').out;
  assert.deepEqual(out.find((o) => o.autopilot), { autopilot: 'q1', kind: 'director_gate', choice: 'S01 GIVEN — record it on the policy line' });
  assert.match(loadProject(p.root).policy.raw, /\(director gate: S01 GIVEN — autopilot: unattended release\.autopilot; recorded by producer-runner \d{4}-\d{2}-\d{2}\)$/);
  assert.deepEqual(f.spawns().map((x) => x.slice), ['S01']);
  assert.equal(runnerFile(p.root).questions.filter((q) => !q.answer).length, 0);
  // HANDOFF says approved, the review file still says CHANGES_REQUESTED after the extra looks:
  // the file wins → a fix round, no question for the director
  const q = project({ notes, slices: { S01: { needs: false } } });
  const g2 = fakes();
  g2.queue([
    { name: 'ready', write: { ...W('ready_for_review'), ...preview(7461) } },
    { name: 'disagree', write: R('approved', 'CHANGES_REQUESTED') },
    { result: 'idle' }, { result: 'idle' },
  ]);
  const o2 = runner(q.root, g2, 'start', '--once').out;
  assert.deepEqual(o2.find((o) => o.autopilot), { autopilot: 'q1', kind: 'verdict_mismatch', choice: 'treat as changes_requested' });
  assert.match(g2.sends().at(-1).text, /^Fix round 1: apply exactly the rows/);
  // retry_once does neither: the gate waits for the director
  const r = project({ notes: NOTES(POLICY, '{}', '  autopilot: retry_once\n'), slices: { S01: { needs: true } } });
  assert.equal(runner(r.root, fakes(), 'start', '--once').out.at(-1).kind, 'director_gate');
  // a review file from an earlier round never speaks for this one (review round 11): the director decides
  const t = project({ notes, slices: { S01: { needs: false } } });
  const g3 = fakes();
  g3.queue([
    { name: 'an earlier round left review.md', write: { ...W('working'), [evRel('S01', 'review.md')]: 'F1\n\nCHANGES_REQUESTED\n' } },
    { name: 'ready', write: { ...W('ready_for_review'), ...preview(7461) } },
    { name: 'handoff only', write: { [H]: { role: 'reviewer', status: 'approved' } } },
    { result: 'idle' }, { result: 'idle' },
  ]);
  const o3 = runner(t.root, g3, 'start', '--once').out;
  assert.equal(o3.find((o) => o.autopilot), undefined);
  assert.deepEqual([o3.at(-1).waiting, o3.at(-1).kind], ['q1', 'verdict_mismatch']);
});

test('fleet, autopilot unattended: "keep waiting" on an odd status still leaves the stall rules (nudge, then the director)', () => {
  const p = project({ notes: NOTES(POLICY, '{}', '  autopilot: unattended\n'), slices: { S01: { needs: false, size: 'L' } } });
  const f = fakes();
  f.queue([
    { name: 'run', runs: [{ id: 'run_1', coordinator_handle: 'term_1' }], write: { [H]: { role: 'coordinator', status: 'working' } } },
    { name: 'odd status', write: { [H]: { role: 'coordinator', status: 'waiting_for_assets' } } },
    { name: 'idle 1', result: 'idle' }, { name: 'idle 2', result: 'idle' }, { name: 'idle 3', result: 'idle' },
  ]);
  const out = runner(p.root, f, 'start', '--once').out;
  assert.deepEqual(out.find((o) => o.autopilot), { autopilot: 'q1', kind: 'unknown_status', choice: 'treat as working, keep waiting' });
  assert.match(f.sends()[0].text, /^resume the cocos-orca-fleet Coordinator loop/); // the stall nudge still goes out
  assert.deepEqual([out.at(-1).waiting, out.at(-1).kind], ['q2', 'fleet_stall']);
});

test('manual_required: defer — APPROVED with only manual checks left merges, lists them, Notes and status show them', () => {
  const p = project({ notes: NOTES(POLICY, '{}', '  manual_required: defer\n'), slices: { S01: { needs: false } } });
  const f = fakes();
  f.queue([
    { name: 'ready', write: { ...W('ready_for_review'), ...preview(7461) } },
    { name: 'approved, manual left', write: R('approved', 'APPROVED', { status: 'verified', manual_required: ['fps >= 55 on the named device', 'GP-22 spot-check'] }) },
    commitStep('S01'),
  ]);
  const out = runner(p.root, f, 'start', '--once').out;
  assert.deepEqual(out.find((o) => o.merged), { merged: 'S01', commit: lastCommit(f) });
  const items = ['fps >= 55 on the named device', 'GP-22 spot-check'];
  assert.deepEqual(JSON.parse(fs.readFileSync(ev(p.root, 'S01', 'evidence', 'manual-deferred.json'), 'utf8')).items, items);
  assert.match(loadProject(p.root).notesText, /\n- S01 single merged fix_rounds=0 bump=none commit=\w{7} merged=y manual_deferred=2\n/);
  assert.match(log(p.root), /manual_required deferred \(2\): fps >= 55 on the named device \| GP-22 spot-check/);
  assert.deepEqual(runner(p.root, f, 'status').out[0].manual_deferred, { S01: items });
  assert.equal(JSON.parse(fs.readFileSync(ev(p.root, 'S01', 'evidence', 'manual-deferred.json'), 'utf8')).v, 2);
  // the list as deferred stays the list: a runtime-state or HANDOFF rewritten later does not shorten it
  fs.writeFileSync(ev(p.root, 'S01', 'evidence', 'runtime-state.json'), JSON.stringify({ status: 'verified', manual_required: ['only this one now'] }));
  assert.deepEqual(runner(p.root, f, 'status').out[0].manual_deferred, { S01: items });
  // a file an older runner wrote (no v; JSON strings, a lone marker line) is read from runtime-state again
  fs.writeFileSync(ev(p.root, 'S01', 'evidence', 'manual-deferred.json'), JSON.stringify({ slice: 'S01', items: ['status', '{"item":"x","reason":"y"}'] }));
  fs.writeFileSync(ev(p.root, 'S01', 'evidence', 'runtime-state.json'), JSON.stringify({ status: 'manual_required', manual_required: [{ item: 'V5 landscape', reason: 'state only' }] }));
  assert.deepEqual(runner(p.root, f, 'status').out[0].manual_deferred, { S01: ['V5 landscape — state only'] });
  // what the items read like from other runtime-state shapes
  assert.deepEqual(manualItems({ checks: [{ id: 'fps', result: 'manual_required' }] }), ['fps']);
  assert.deepEqual(manualItems({ manual_required: { device: 'fps', gp22: true } }), ['device: fps', 'gp22: true']);
  assert.deepEqual(manualItems({ status: 'manual_required', manual_required: false }), ['status: manual_required (no details)']);
  // the shapes pilot 3's reviewers wrote: a `status` marker never stands next to the real checks as a line
  assert.deepEqual(manualItems({ status: 'manual_required', manual_required: { reason: 'no audio in automation', items: ['iOS unlock', 'tab hide'] } }), ['iOS unlock', 'tab hide']);
  assert.deepEqual(manualItems({ status: 'manual_required', manual_required: ['V5 landscape', 'real notch'] }), ['V5 landscape', 'real notch']);
  assert.deepEqual(manualItems({ manual_required: { reason: 'device only' } }), ['device only']);
  assert.deepEqual(manualItems({ manual_required: true }), ['manual_required: true (no details)']);
  // runtime-state and HANDOFF together: listed once
  assert.deepEqual(manualItems({ status: 'manual_required', manual_required: ['GP-22'] }, { manual_required: ['GP-22', 'fps'] }), ['GP-22', 'fps']);
  // never lost (review round 9): a bare marker in a list, a named check next to a listed one, every list
  // key and every other pair of a manual_required object
  assert.deepEqual(manualItems({ checks: ['pass', 'manual_required'] }), ['checks[1]: manual_required (no details)']);
  assert.deepEqual(manualItems({ checks: [{ id: 'fps', result: 'manual_required' }], manual_required: ['GP-22'] }), ['fps', 'GP-22']);
  assert.deepEqual(manualItems({ manual_required: { reason: 'r', items: ['a'], pending: ['b'], extra_check: 'c', count: 3 } }), ['a', 'b', 'extra_check: c']);
  // a named document's own status is not a check (review round 10)
  assert.deepEqual(manualItems({ id: 'S03', status: 'manual_required', manual_required: ['iOS unlock'] }), ['iOS unlock']);
  assert.deepEqual(manualItems({ title: 'Runtime state', status: 'manual_required' }), ['status: manual_required (no details)']);
  // a reviewer's runtime-state keeps earlier rounds: the current top-level list is the answer (pilot S09)
  const s09 = { round: 3, manual_required: ['fps on device', 'notch on hardware'], round1: { manual_required: ['A-09-04 outline-only volume (blocked by F1)'] },
    round2_attempt1: { manual_required: ['rerun the whole review'], checks: [{ id: 'old', result: 'manual_required' }] }, checks: [{ id: 'fade', result: 'manual_required' }] };
  assert.deepEqual(manualItems(s09), ['fps on device', 'notch on hardware', 'fade']);
  // without a current top-level list, history is all there is: still walked, nothing lost
  assert.deepEqual(manualItems({ round1: { manual_required: ['only in round 1'] } }), ['only in round 1']);
  // review round 13: a word-like key is not history; a current list in HANDOFF makes runtime history stale
  assert.deepEqual(manualItems({ manual_required: ['a'], roundtrip_latency: { checks: [{ id: 'rt', result: 'manual_required' }] } }), ['a', 'rt']);
  assert.deepEqual(manualItems({ round1: { manual_required: ['old'] } }, { manual_required: ['h1'] }), ['h1']);
});

test('fleet: the newest review file is the verdict; defer never covers a review that is not APPROVED; the commit line names the runner', () => {
  const p = project({ notes: NOTES(POLICY, '{}', '  manual_required: defer\n'), slices: { S01: { needs: false, size: 'L' } } });
  const f = fakes();
  const evidence = { [evRel('S01', 'final-report.md')]: 'x', [evRel('S01', 'stats.json')]: {} };
  f.queue([
    { name: 'round 1', runs: [{ id: 'run_1', coordinator_handle: 'term_1' }], write: { [H]: { role: 'coordinator', status: 'working' }, [evRel('S01', 'review.md')]: 'F1\n\nCHANGES_REQUESTED\n' } },
    { name: 'round 3 offered', write: { ...evidence, [H]: { role: 'coordinator', status: 'offer_commit', manual_required: ['GP-22 spot-check'] }, [evRel('S01', 'review-r3.md')]: 'F2 waits for gate g1\n\nCHANGES_REQUESTED\n', [evRel('S01', 'runtime-state.json')]: { status: 'verified', manual_required: ['fps on the named device'] } } },
  ]);
  const a = runner(p.root, f, 'start', '--once').out.at(-1);
  assert.deepEqual([a.waiting, a.kind], ['q1', 'approval_evidence']);
  assert.match(question(p.root, 'q1').text, /review-r3\.md ends "CHANGES_REQUESTED", not APPROVED/);
  assert.equal(fs.existsSync(ev(p.root, 'S01', 'evidence', 'manual-deferred.json')), false);
  // the coordinator writes the final verdict as review.md (the newest file), naming gate g1 — but the
  // runner never sent a decision for g1: the CHANGES_REQUESTED round cannot be overridden on its say-so
  fs.writeFileSync(ev(p.root, 'S01', 'evidence', 'review.md'), 'F2 settled by the director (gate g1); no new review ran\n\nAPPROVED\n');
  runner(p.root, f, 'answer', '--id', 'q1', '--choice', 'evidence fixed, check again');
  const o = runner(p.root, f, 'start', '--once').out.at(-1);
  assert.deepEqual([o.waiting, o.kind, o.options], ['q2', 'verdict_override', ['treat as approved', 'evidence fixed, check again', 'mark blocked', 'stop']]);
  assert.match(question(p.root, 'q2').text, /review\.md ends APPROVED but the last review round \(review-r3\.md\) ended CHANGES_REQUESTED and review\.md names no gate decision the director sent \(none sent\)/);
  // once g1's decision went out through the runner, the same review.md passes
  fs.writeFileSync(ev(p.root, 'S01', 'producer-state.json'), JSON.stringify({ ...sliceState(p.root, 'S01'), relayed_gates: ['g1'] }));
  runner(p.root, f, 'answer', '--id', 'q2', '--choice', 'evidence fixed, check again');
  f.queue([{ name: 'committed', write: { [H]: { role: 'coordinator', status: 'committed', sha: 'f00d' } } }]);
  const b = runner(p.root, f, 'start', '--once').out.at(-1);
  assert.deepEqual(f.sends().at(-1), { to: 'term_1', text: FLEET_COMMIT_TEXT });
  assert.equal(FLEET_COMMIT_TEXT, 'approved — commit (producer: Step 2d passed)');
  assert.deepEqual([sliceState(p.root, 'S01').phase, b.kind], ['merge', 'merge_source_missing']);
  assert.deepEqual(sliceState(p.root, 'S01').manual_deferred, ['fps on the named device', 'GP-22 spot-check']);
});

test('fleet: defer still asks about missing evidence first; review rounds order by number, not mtime', () => {
  const p = project({ notes: NOTES(POLICY, '{}', '  manual_required: defer\n'), slices: { S01: { needs: false, size: 'L' } } });
  const f = fakes();
  f.queue([
    { name: 'run', runs: [{ id: 'run_1', coordinator_handle: 'term_1' }], write: { [H]: { role: 'coordinator', status: 'working' } } },
    { name: 'offered without stats', write: { [H]: { role: 'coordinator', status: 'offer_commit' }, [evRel('S01', 'review.md')]: 'F1\n\nAPPROVED\n', [evRel('S01', 'final-report.md')]: 'x', [evRel('S01', 'runtime-state.json')]: { status: 'manual_required' } } },
  ]);
  const a = runner(p.root, f, 'start', '--once').out.at(-1);
  assert.deepEqual([a.waiting, a.kind], ['q1', 'approval_evidence']);
  assert.match(question(p.root, 'q1').text, /evidence missing: stats\.json/);
  assert.equal(fs.existsSync(ev(p.root, 'S01', 'evidence', 'manual-deferred.json')), false);
  // rounds: r10 beats a later-touched r2; review.md wins only when written after the last round
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-files-'));
  const put = (f2, t) => {
    fs.writeFileSync(path.join(dir, f2), 'x\n');
    fs.utimesSync(path.join(dir, f2), t, t);
  };
  put('review-r10.md', 1000);
  put('review-r2.md', 3000);
  assert.deepEqual(reviewFiles(dir), { verdict: path.join(dir, 'review-r10.md'), lastRound: path.join(dir, 'review-r10.md') });
  put('review.md', 2000);
  assert.equal(reviewFiles(dir).verdict, path.join(dir, 'review.md'));
  put('review.md', 500);
  assert.equal(reviewFiles(dir).verdict, path.join(dir, 'review-r10.md'));
});

test('fleet: a coordinator terminal Orca shows as closed (orphaned) is missing at once', () => {
  const p = project({ slices: { S01: { needs: false, size: 'L' } } });
  const f = fakes();
  f.set('orphaned.json', ['term_1']);
  f.queue([
    { name: 'run', runs: [{ id: 'run_1', coordinator_handle: 'term_1' }], write: { [H]: { role: 'coordinator', status: 'working' } } },
    { name: 'gone', result: 'missing' },
  ]);
  const a = runner(p.root, f, 'start', '--once').out.at(-1);
  assert.deepEqual([a.waiting, a.kind], ['q1', 'coordinator_missing']);
  assert.doesNotMatch(question(p.root, 'q1').text, /times in a row/);
});

test('fleet: a stale `terminal wait` that terminal show disproves never reaches the human (orca-wait rechecks; pilots 5, 6)', () => {
  const p = project({ slices: { S01: { needs: false, size: 'L' } } });
  const f = fakes();
  f.queue([
    { name: 'run', runs: [{ id: 'run_1', coordinator_handle: 'term_1' }], write: { [H]: { role: 'coordinator', status: 'working' } } },
    ...Array.from({ length: 5 }, (_, i) => ({ name: `stale ${i + 1}`, result: 'missing' })),
    { name: 'still working', write: { [H]: { role: 'coordinator', status: 'working', detail: 'implement running' } } },
  ]);
  const a = runner(p.root, f, 'start', '--once');
  assert.equal(runnerFile(p.root).questions.length, 0); // was q1 coordinator_missing before the orca-wait recheck
  assert.match(a.out.at(-1).stopped || '', /control file says stop/); // the queue ran out: the fake writes stop
  assert.doesNotMatch(log(p.root), /orca-wait reported term_1 missing/);
  assert.equal(sliceState(p.root, 'S01').missing_rechecks || 0, 0);
  assert.match(fs.readFileSync(path.join(f.dir, 'calls.log'), 'utf8'), /terminal show --terminal term_1/); // orca-wait asked show
});

test('fleet: a terminal-missing that the runner\'s own terminal show disproves is waited on (logged); five in a row → the human', () => {
  // orca-wait now rechecks show itself; this keeps the runner's second line of defence covered with a stub
  const p = project({ slices: { S01: { needs: false, size: 'L' } } });
  const f = fakes();
  f.queue([{ name: 'run', runs: [{ id: 'run_1', coordinator_handle: 'term_1' }], write: { [H]: { role: 'coordinator', status: 'working' } } }]);
  runner(p.root, f, 'start', '--once');
  clearControl(p.root);
  const stub = path.join(f.dir, 'orca-wait-missing.mjs');
  fs.writeFileSync(stub, "console.log(JSON.stringify({ event: 'terminal-missing', handle: 'term_1', handle_changed: false, status: 'working', handoff_changed: false, idle_streak: 0, pending_gates: [], unread_to_run: 0, waited_ms: 1 }));\n");
  const b = runner(p.root, f, 'start', '--once', { env: { PRODUCER_RUNNER_ORCA_WAIT: stub } }).out.at(-1);
  assert.match(log(p.root), /orca-wait reported term_1 missing but terminal show finds it \(1\/5\): waiting on/);
  assert.deepEqual([b.waiting, b.kind], ['q1', 'coordinator_missing']);
  assert.match(question(p.root, 'q1').text, /reported it missing 5 times in a row although terminal show still finds it/);
});

test('fleet gate: the question carries the whole gate, every line, and the whole of the others (S10 q21, 2026-10-04)', () => {
  const p = project({ slices: { S01: { needs: false, size: 'L' } } });
  const f = fakes();
  const ask1 = 'S01 scope field needing director decision: the slice paths authorize assets/arts/x/models/brick.mtl, but do not list assets/arts/x/manifest.json. The art-manifest worker changed that manifest to add the Source=generate brick_material row.';
  const ask2 = 'Should this manifest path be added to S01, or should the worker restore it and keep only the listed .mtl/scene paths?';
  const other = `Second gate: ${'a long second question that goes on. '.repeat(12)}end of g2`;
  const g1 = { id: 'g1', status: 'pending', question: `${ask1}\n\n  - the manifest row: brick_material\r\n${ask2}`, options: '["add manifest path","restore and continue"]' };
  const g2 = { id: 'g2', status: 'pending', question: other, options: '["x"]' };
  f.queue([
    { name: 'run', runs: [{ id: 'run_1', coordinator_handle: 'term_1' }], write: { [H]: { role: 'coordinator', status: 'working' } } },
    { name: 'two gates', gates: [g1, g2] },
  ]);
  runner(p.root, f, 'start', '--once');
  assert.ok(ask1.length > 200 && other.length > 300);
  assert.equal(question(p.root, 'q1').text, `fleet gate g1 (also pending: g2): ${ask1} / - the manifest row: brick_material / ${ask2} | g2: ${other}`);
});

test('fleet gates: every pending gate in one question; the relay names the others; another gate is asked only after a settle', () => {
  const p = project({ slices: { S01: { needs: false, size: 'L' } } });
  const f = fakes();
  const g1 = { id: 'g1', status: 'pending', question: 'Draw-call metric for round 2?', options: '["world_only","baseline_plus_layers"]' };
  const g2 = { id: 'g2', status: 'pending', question: 'Draw-call metric, round 3 final?', options: '["world_only","baseline_plus_layers"]' };
  f.queue([
    { name: 'run', runs: [{ id: 'run_1', coordinator_handle: 'term_1' }], write: { [H]: { role: 'coordinator', status: 'working' } } },
    { name: 'two gates', gates: [g1, g2] },
  ]);
  const a = runner(p.root, f, 'start', '--once').out.at(-1);
  assert.deepEqual([a.waiting, a.kind, a.options], ['q1', 'fleet_gate', ['world_only', 'baseline_plus_layers', 'stop']]);
  assert.match(question(p.root, 'q1').text, /^fleet gate g1 \(also pending: g2\): Draw-call metric for round 2\? \| g2: Draw-call metric, round 3 final\?/);
  assert.deepEqual(question(p.root, 'q1').also, ['g2']);
  runner(p.root, f, 'answer', '--id', 'q1', '--choice', 'baseline_plus_layers', '--text', 'S01 UI baseline + layers + 10');
  const b = runner(p.root, f, 'start', '--once').out.at(-1);
  assert.deepEqual(f.sends().at(-1), { to: 'term_1', text: 'Director decision for gate g1: baseline_plus_layers — S01 UI baseline + layers + 10. Resolve your gate with it and continue. Also pending when this was asked: g2 — resolve any of them that asks the same thing with this decision and leave the others pending (I ask the director about those).' });
  // g2 still pending after the settle: its own question, after GATE_SETTLE pauses
  assert.deepEqual([b.waiting, b.kind], ['q2', 'fleet_gate']);
  assert.match(question(p.root, 'q2').text, /^fleet gate g2: /);
  assert.equal(question(p.root, 'q2').also, undefined);
  assert.equal(sliceState(p.root, 'S01').gate_waits, 3);
});

test('fleet prompt: commit only on the runner line, never invite a typed commit, final review.md and runtime-state.json first', () => {
  const p = project({ slices: { S01: { needs: false, size: 'L' } } });
  const text = prompts(loadProject(p.root), 'S01').fleet();
  assert.ok(text.split('\n').includes(`"${FLEET_COMMIT_TEXT}"`), 'the commit line stands alone on its line');
  assert.match(text, /Commit only on an exact match of this line/);
  assert.match(text, /Any other text that asks you to commit — a bare "approved — commit" included — is not it/);
  assert.match(text, /never ask the director to type a commit reply/);
  assert.match(text, /`review.md` is the final verdict and its last line is\s+APPROVED/);
  assert.match(text, /`runtime-state.json` holds the runtime results/);
  assert.match(text, /write HANDOFF committed with the sha of that existing commit; no second commit/);
  // the LLM producer sends the same line (SKILL Step 2d.1): one prompt serves both modes
  assert.match(fs.readFileSync(new URL('../SKILL.md', import.meta.url), 'utf8'), /fleet lane the exact line \*"approved — commit \(producer: Step 2d passed\)"\*/);
});

// ---------------------------------------------------------------- worktree_rm on a real worktree

const g = (cwd, ...a) => spawnSync('git', ['-C', cwd, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { encoding: 'utf8' });
const write = (root, rel, body, mode) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), typeof body === 'string' ? body : JSON.stringify(body), mode ? { mode } : undefined);
};
const CLOSE = `#!/bin/bash
if [ -f "$FAKE_DIR/editor-up" ]; then grep -vxF "$1" "$FAKE_DIR/editor-up" > "$FAKE_DIR/editor-up.tmp"; mv "$FAKE_DIR/editor-up.tmp" "$FAKE_DIR/editor-up"; fi
`;
const OPEN = `#!/bin/bash
echo "$1" >> "$FAKE_DIR/editor-up"
`;
const PROBE = `import fs from 'node:fs';
import path from 'node:path';
const f = path.join(process.env.FAKE_DIR, 'editor-up');
const up = fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\\n') : [];
const here = fs.realpathSync(process.cwd());
const reachable = up.includes(here);
console.log(JSON.stringify({ funplay: { url: 'http://127.0.0.1:1/', reachable, servedProject: reachable ? path.basename(here) : null, parity: reachable ? true : null } }, null, 2));
`;

/** A fleet slice committed with its evidence (as the fleet SKILL stages it), then HANDOFF rewritten. */
function committedFleet() {
  const p = project({ notes: NOTES(POLICY, '{S01: in_progress}'), slices: { S01: { needs: false, size: 'L' } } });
  const f = fakes();
  const root = p.root;
  write(root, '.gitignore', '/.cursor/evidence/\n');
  write(root, 'scripts/close-editor.sh', CLOSE, 0o755);
  write(root, 'scripts/open-editor.sh', OPEN, 0o755);
  write(root, '.cursor/skills/vibe-game-director/scripts/probe.mjs', PROBE);
  write(root, 'funplay-cocos-mcp.config.json', '{"port": 1}');
  g(root, 'add', '-A');
  g(root, 'commit', '-qm', 'chore: template bits');
  const wt = path.join(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'runner-wt-'))), 'S01-feature');
  g(root, 'worktree', 'add', '-q', '-b', 'S01-feature', wt);
  write(wt, 'src/b.ts', 'export const b = 2;\n');
  const evw = (file, body) => write(wt, evRel('S01', file), body);
  evw('HANDOFF.json', { role: 'coordinator', status: 'offer_commit' });
  evw('review.md', 'F1\n\nAPPROVED\n');
  evw('runtime-state.json', { status: 'verified' });
  evw('final-report.md', 'x');
  evw('stats.json', {});
  g(wt, 'add', '-A');
  g(wt, 'add', '-f', '.cursor/evidence/tasks/T-S01');
  g(wt, 'commit', '-qm', 'feat(S01): b');
  const sha = g(wt, 'rev-parse', 'HEAD').stdout.trim();
  evw('HANDOFF.json', { role: 'coordinator', status: 'committed', sha }); // after the commit: tracked and modified
  fs.mkdirSync(ev(root, 'S01'), { recursive: true });
  const base = g(root, 'symbolic-ref', '--short', 'HEAD').stdout.trim();
  fs.writeFileSync(ev(root, 'S01', 'producer-state.json'), JSON.stringify({ phase: 'merge', lane: 'fleet', commit_sha: sha, worktree: wt, coordinator: 'term_c', run: 'run_1', base_branch: base }));
  fs.writeFileSync(path.join(root, '.cursor', 'producer-runner.json'), JSON.stringify({ slice: 'S01', step: 'lane', questions: [] }));
  fs.writeFileSync(path.join(f.dir, 'editor-up'), `${wt}\n${root}\n`);
  return { f, root, wt, sha };
}
const VERIFIED = { name: 'verified', write: { [evRel('S01', 'verify-main.json')]: { status: 'verified', detail: 'smoke green' } } };
const journal = (root) => JSON.parse(fs.readFileSync(ev(root, 'S01', 'merge-journal.json'), 'utf8'));
const rmLog = (f) => fs.readFileSync(path.join(f.dir, 'rm.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

test('worktree_rm: only the slice evidence changed (HANDOFF rewritten after the commit) → copied to main, then removed with --force', () => {
  const { f, root, wt, sha } = committedFleet();
  f.queue([VERIFIED]);
  runner(root, f, 'start', '--once');
  assert.equal(journal(root).steps.worktree_rm.kept, undefined);
  assert.match(journal(root).steps.worktree_rm.note, /only its evidence files had changed, copied to main first/);
  assert.equal(fs.existsSync(wt), false);
  assert.equal(rmLog(f).at(-1).force, true);
  // main has the rewritten HANDOFF (the evidence step ran before the removal)
  assert.equal(JSON.parse(fs.readFileSync(ev(root, 'S01', 'evidence', 'HANDOFF.json'), 'utf8')).sha, sha);
  assert.match(loadProject(root).notesText, /\n- S01 fleet merged fix_rounds=\? bump=none commit=\w{7} merged=y -\n/);
});

test('worktree_rm: an evidence file written after the evidence step is copied before the removal; a changed PNG keeps the worktree', () => {
  const { f, root, wt, sha } = committedFleet();
  // the journal as a runner killed right after its evidence step left it, then a late write in the worktree
  const base = g(root, 'symbolic-ref', '--short', 'HEAD').stdout.trim();
  g(root, 'merge', '--no-ff', '-q', '-m', 'Merge S01', 'S01-feature');
  spawnSync('rsync', ['-a', '--exclude', '*.png', `${ev(wt, 'S01')}/`, `${ev(root, 'S01')}/`]);
  const at = new Date().toISOString();
  fs.writeFileSync(ev(root, 'S01', 'merge-journal.json'), JSON.stringify({ lane: 'fleet', sha, wt, branch: 'S01-feature', fix_rounds: null, bump: null, started: at, steps: {
    harvest: { status: 0, failed: false, note: 'archived', done_at: at }, close_editors: { note: 'both Creators closed', done_at: at },
    merge: { into: base, conflict: false, note: 'merged', done_at: at }, evidence: { note: 'rsync worktree → main (no PNGs)', done_at: at } } }));
  fs.writeFileSync(path.join(f.dir, 'editor-up'), '');
  write(wt, evRel('S01', 'late-note.md'), 'written after the copy\n');
  f.queue([VERIFIED]);
  runner(root, f, 'start', '--once');
  assert.equal(fs.existsSync(wt), false);
  assert.equal(fs.readFileSync(ev(root, 'S01', 'evidence', 'late-note.md'), 'utf8'), 'written after the copy\n');
  // a tracked PNG changed in the evidence dir: the copy skips PNGs, so --force would lose it
  const q = committedFleet();
  write(q.wt, evRel('S01', 'preview.png'), 'PNG v1');
  g(q.wt, 'add', '-f', evRel('S01', 'preview.png'));
  g(q.wt, 'commit', '-qm', 'evidence: preview');
  const sha2 = g(q.wt, 'rev-parse', 'HEAD').stdout.trim();
  fs.writeFileSync(ev(q.root, 'S01', 'producer-state.json'), JSON.stringify({ ...sliceState(q.root, 'S01'), commit_sha: sha2 }));
  write(q.wt, evRel('S01', 'preview.png'), 'PNG v2');
  q.f.queue([VERIFIED]);
  runner(q.root, q.f, 'start', '--once');
  assert.equal(journal(q.root).steps.worktree_rm.kept, 'dirty');
  assert.equal(fs.existsSync(q.wt), true);
});

test('bookkeeping commit: AGENT_NOTES.md and the tracked evidence only, by path — other changes and untracked files stay out', () => {
  const { f, root, sha } = committedFleet();
  // the director's own edit of a tracked file (staged ones block the merge itself) and an Editor's new
  // .meta must not ride along
  fs.appendFileSync(path.join(root, 'MILESTONES.md'), '\n<!-- director note -->\n');
  write(root, 'assets/new.json.meta', '{}');
  f.queue([VERIFIED]);
  runner(root, f, 'start', '--once');
  assert.equal(g(root, 'log', '-1', '--format=%s').stdout.trim(), 'chore(producer): record S01 merge — notes, evidence');
  const files = g(root, 'show', '--name-only', '--format=', 'HEAD').stdout.trim().split('\n').sort();
  // the fleet committed its evidence (tracked), then rewrote HANDOFF.json: the refreshed copy is committed
  assert.deepEqual(files, ['.cursor/evidence/tasks/T-S01/evidence/HANDOFF.json', 'AGENT_NOTES.md']);
  assert.equal(JSON.parse(g(root, 'show', `HEAD:${evRel('S01', 'HANDOFF.json')}`).stdout).sha, sha);
  assert.match(g(root, 'status', '--porcelain').stdout, /^ M MILESTONES\.md$/m); // still the director's, uncommitted
  assert.match(g(root, 'status', '--porcelain', '--untracked-files=all').stdout, /^\?\? assets\/new\.json\.meta$/m);
  assert.match(journal(root).steps.notes_commit.note, /committed 2 file\(s\)/);
  assert.match(fs.readFileSync(ev(root, 'S01', 'producer-log.md'), 'utf8'), /committed the bookkeeping on \S+ as \w{7}: /);
});

test('bookkeeping commit: a failing commit hook is logged and the slice still finishes', () => {
  const { f, root } = committedFleet();
  const hooks = path.join(root, '.git', 'hooks');
  fs.mkdirSync(hooks, { recursive: true });
  fs.writeFileSync(path.join(hooks, 'pre-commit'), '#!/bin/sh\necho "hook says no" >&2\nexit 1\n', { mode: 0o755 });
  f.queue([VERIFIED]);
  const out = runner(root, f, 'start', '--once').out;
  assert.ok(out.find((o) => o.merged));
  assert.equal(journal(root).steps.notes_commit.failed, true);
  assert.match(fs.readFileSync(ev(root, 'S01', 'producer-log.md'), 'utf8'), /bookkeeping commit failed \(left uncommitted for the director\): hook says no/);
  assert.match(g(root, 'status', '--porcelain', '--', 'AGENT_NOTES.md').stdout, /^ M AGENT_NOTES\.md/);
  assert.equal(sliceState(root, 'S01').phase, 'done');
  // a hook that hangs: stopped at the timeout with SIGTERM, so git leaves no index.lock behind
  const q = committedFleet();
  const qh = path.join(q.root, '.git', 'hooks');
  fs.mkdirSync(qh, { recursive: true });
  fs.writeFileSync(path.join(qh, 'pre-commit'), '#!/bin/sh\nsleep 5\n', { mode: 0o755 });
  q.f.queue([VERIFIED]);
  runner(q.root, q.f, 'start', '--once', { env: { PRODUCER_RUNNER_COMMIT_TIMEOUT_MS: '700' } });
  assert.match(journal(q.root).steps.notes_commit.note, /commit failed: git commit timed out after 0\.7 s/);
  assert.equal(fs.existsSync(path.join(q.root, '.git', 'index.lock')), false);
  assert.equal(sliceState(q.root, 'S01').phase, 'done');
});

test('bookkeeping commit: skipped with a note under auto_commit=false, and when a listed file has staged changes', () => {
  // single lane, auto_commit=false: the director approves the slice commit and keeps the bookkeeping
  const notes = NOTES(POLICY.replace('auto_commit=true', 'auto_commit=false')).replace('auto_commit: true', 'auto_commit: false');
  const p = project({ notes, slices: { S01: { needs: false } } });
  const f = fakes();
  f.queue([{ name: 'ready', write: { ...W('ready_for_review'), ...preview(7461) } }, { name: 'approved', write: R('approved', 'APPROVED') }]);
  assert.equal(runner(p.root, f, 'start', '--once').out.at(-1).kind, 'commit_approval');
  runner(p.root, f, 'answer', '--id', 'q1', '--choice', 'commit');
  f.queue([commitStep('S01')]);
  runner(p.root, f, 'start', '--once');
  assert.equal(sliceState(p.root, 'S01').phase, 'done');
  assert.match(journal(p.root).steps.notes_commit.note, /auto_commit=false auto_merge=true: bookkeeping left for the director/);
  assert.match(g(p.root, 'status', '--porcelain', '--', 'AGENT_NOTES.md').stdout, /^ M AGENT_NOTES\.md/);
  // fleet, resumed after its merge with a staged AGENT_NOTES.md edit (someone composing a commit)
  const { f: f2, root, sha } = committedFleet();
  const base = g(root, 'symbolic-ref', '--short', 'HEAD').stdout.trim();
  g(root, 'merge', '--no-ff', '-q', '-m', 'Merge S01', 'S01-feature');
  const at = new Date().toISOString();
  const done = (note) => ({ note, done_at: at });
  fs.writeFileSync(ev(root, 'S01', 'merge-journal.json'), JSON.stringify({ lane: 'fleet', sha, wt: null, branch: 'S01-feature', fix_rounds: null, bump: null, started: at, steps: {
    harvest: { status: 0, failed: false, ...done('archived') }, close_editors: done('closed'), merge: { into: base, conflict: false, ...done('merged') },
    evidence: done('copied'), worktree_rm: done('already gone'), reopen: done('up'), verify: { status: 'verified', ...done('ok') } } }));
  fs.appendFileSync(path.join(root, 'AGENT_NOTES.md'), '\n<!-- staged by the director -->\n');
  g(root, 'add', 'AGENT_NOTES.md');
  const head = g(root, 'rev-parse', 'HEAD').stdout.trim();
  runner(root, f2, 'start', '--once');
  assert.equal(g(root, 'rev-parse', 'HEAD').stdout.trim(), head);
  assert.match(journal(root).steps.notes_commit.note, /AGENT_NOTES\.md has staged changes: bookkeeping left uncommitted/);
  assert.equal(sliceState(root, 'S01').phase, 'done');
});

test('worktree_rm: evidence plus any other change keeps the worktree (no --force)', () => {
  const { f, root, wt } = committedFleet();
  write(wt, 'src/b.ts', 'export const b = 3; // not committed\n');
  f.queue([VERIFIED]);
  runner(root, f, 'start', '--once');
  assert.equal(journal(root).steps.worktree_rm.kept, 'dirty');
  assert.equal(fs.existsSync(wt), true);
  assert.equal(fs.existsSync(path.join(f.dir, 'rm.log')), false);
});
