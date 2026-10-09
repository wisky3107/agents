import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { menu, parseReply, submit, extraChoices, PILOT_CHOICE } from '../scripts/lib/answer.mjs';
import { RUNNER, project, fakes, env } from './harness.mjs';

// "resolve by pilot agent" (2026-10-09, the director): while the workflow-pilot skill has a pilot
// registered on the project, every way to answer offers handing the question to the pilot agent. The
// question stays open (marked pilot_handoff) until the pilot answers with `answer --by pilot`.
const DIALOG = new URL('../scripts/answer-dialog.mjs', import.meta.url).pathname;
const GATE = { id: 'q1', key: 'S01:fleet_gate:g1', kind: 'fleet_gate', slice: 'S01', text: 'fleet gate g1: Approve PLAN?', options: ['approve', 'revise', 'stop'], ref: 'g1', answer: null };
const runnerFile = (root) => JSON.parse(fs.readFileSync(path.join(root, '.cursor', 'producer-runner.json'), 'utf8'));
const question = (root, id) => runnerFile(root).questions.find((q) => q.id === id);
const withQuestions = (qs, extra = {}) => {
  const p = project({ slices: { S01: { needs: false } } });
  fs.mkdirSync(path.join(p.root, '.cursor'), { recursive: true });
  fs.writeFileSync(path.join(p.root, '.cursor', 'producer-runner.json'), JSON.stringify({ slice: 'S01', step: 'blocked:x', questions: qs, ...extra }));
  return p;
};
const cli = (root, f, ...args) => spawnSync(process.execPath, [RUNNER, ...args, '--project', root], { encoding: 'utf8', timeout: 20000, env: env(root, f) });
const lines = (out) => out.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));

test('answer lib: no pilot, no extra row; a pilot adds one numbered after the options, and handing leaves the question open', () => {
  const p = withQuestions([GATE]);
  assert.deepEqual(extraChoices(p.root, GATE), []);
  assert.throws(() => submit(p.root, 'q1', PILOT_CHOICE), /no pilot is registered/);
  assert.throws(() => submit(p.root, 'q1', 'approve', '', null, 'pilot'), /no pilot is registered/);

  const r = runnerFile(p.root);
  fs.writeFileSync(path.join(p.root, '.cursor', 'producer-runner.json'), JSON.stringify({ ...r, pilot: { n: 18 } }));
  const extras = extraChoices(p.root, GATE);
  assert.deepEqual(extras, [PILOT_CHOICE]);
  assert.match(menu(GATE, [], extras), / {2}3\) stop\n {2}4\) resolve by pilot agent\n/);
  assert.deepEqual(parseReply(GATE, '4 check the mock first', extras), { choice: PILOT_CHOICE, text: 'check the mock first' });
  assert.match(parseReply(GATE, '5', extras).error, /1 to 4/);

  submit(p.root, 'q1', PILOT_CHOICE, 'check the mock first', 'terminal');
  const q = question(p.root, 'q1');
  assert.equal(q.answer, null);
  assert.deepEqual([q.pilot_handoff.pilot, q.pilot_handoff.text, q.pilot_handoff.via], [18, 'check the mock first', 'terminal']);
  assert.deepEqual(extraChoices(p.root, q), [], 'handed once: no second row');
  assert.match(menu(q), /handed to the pilot agent .*; an answer here still wins/);
  assert.throws(() => submit(p.root, 'q1', PILOT_CHOICE), /already handed/);

  submit(p.root, 'q1', 'revise', 'smaller scope', null, 'pilot');
  assert.deepEqual([question(p.root, 'q1').answer.choice, question(p.root, 'q1').answer.by], ['revise', 'pilot']);
});

test('CLI: pilot --set / --clear, answer --choice "resolve by pilot agent", pilot-wait prints each handed question once', () => {
  const p = withQuestions([GATE, { ...GATE, id: 'q2', key: 'S01:fleet_gate:g2', ref: 'g2' }]);
  const f = fakes();
  assert.match(cli(p.root, f, 'pilot', '--set').stdout, /needs --n/);
  assert.deepEqual(lines(cli(p.root, f, 'pilot', '--set', '--n', '18').stdout)[0].pilot.n, 18);
  assert.equal(runnerFile(p.root).pilot.n, 18);
  assert.equal(cli(p.root, f, 'answer', '--id', 'q2', '--choice', PILOT_CHOICE, '--text', 'your call').status, 0);
  assert.deepEqual(lines(cli(p.root, f, 'pilot').stdout)[0].handed, ['q2']);

  const waited = spawnSync(process.execPath, [RUNNER, 'pilot-wait', '--timeout-ms', '300', '--project', p.root], { encoding: 'utf8', timeout: 20000, env: { ...env(p.root, f), PRODUCER_RUNNER_PILOT_POLL_MS: '50' } });
  const out = lines(waited.stdout);
  assert.deepEqual(out.map((x) => x.handed || x.pilot_wait), ['q2', 'timeout']);
  assert.equal(out[0].note, 'your call');
  assert.match(out[0].answer, /--id q2 --choice "<option>" --by pilot$/);

  assert.equal(cli(p.root, f, 'answer', '--id', 'q2', '--choice', 'approve', '--by', 'pilot').status, 0);
  assert.equal(question(p.root, 'q2').answer.by, 'pilot');
  assert.match(cli(p.root, f, 'answer', '--id', 'q1', '--choice', 'approve', '--by', 'robot').stdout, /--by is human or pilot/);
  // a question still handed when the pilot closes goes back to the director
  assert.equal(cli(p.root, f, 'pilot', '--set', '--n', '18').status, 0);
  assert.equal(cli(p.root, f, 'answer', '--id', 'q1', '--choice', PILOT_CHOICE).status, 0);
  assert.equal(question(p.root, 'q1').dialog_done, 'pilot');
  const cleared = lines(cli(p.root, f, 'pilot', '--clear').stdout)[0];
  assert.deepEqual([cleared.cleared.n, cleared.returned_to_director], [18, ['q1']]);
  assert.equal(runnerFile(p.root).pilot, null);
  assert.deepEqual([question(p.root, 'q1').pilot_handoff, question(p.root, 'q1').dialog_done], [undefined, undefined]);
  assert.match(cli(p.root, f, 'pilot', '--set', '--n', '0').stdout, /needs --n/);
});

test('dialog: the pilot row sits before "Show the whole question"; picking it hands the question and keeps the dialog closed', () => {
  const p = withQuestions([GATE], { pilot: { n: 18 } });
  const f = fakes();
  const bin = path.join(f.dir, 'osascript-fake');
  // choose → the pilot row, note → a hint
  fs.writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' "$@" >> ${JSON.stringify(path.join(f.dir, 'osa.log'))}\ncase "$*" in *"choose from list"*) echo "Resolve by pilot agent (pilot 18)";; *) echo "look at r2";; esac\n`, { mode: 0o755 });
  const r = spawnSync(process.execPath, [DIALOG, '--project', p.root, '--id', 'q1'], { encoding: 'utf8', timeout: 20000, env: { ...env(p.root, f), PRODUCER_RUNNER_OSASCRIPT: bin } });
  assert.equal(r.status, 0, r.stderr);
  const log = fs.readFileSync(path.join(f.dir, 'osa.log'), 'utf8');
  assert.match(log, /\nstop\nResolve by pilot agent \(pilot 18\)\nShow the whole question\n/);
  assert.match(log, /passed to the pilot agent word for word/);
  const q = question(p.root, 'q1');
  assert.equal(q.answer, null);
  assert.deepEqual([q.pilot_handoff.text, q.pilot_handoff.via, q.dialog_done], ['look at r2', 'dialog', 'pilot']);
});
