import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseScreen, fingerprint, ANSWER_TEXT, ANSWER_DONE } from '../scripts/lib/coordq.mjs';
import { waitsOnDirector } from '../scripts/lib/lanes.mjs';
import { menu, textNeed, answerProblem } from '../scripts/lib/answer.mjs';
import { project, fakes, env, runner, evRel, ev, sliceState } from './harness.mjs';

// Two gaps from the 2026-10-04/05 fleet slices (codex coordinator): a question asked through codex's own
// panel (the runner never saw it, the lane waited an hour) and "pending a director decision" written into
// HANDOFF.json with no gate. All against the fake orca: screens.json holds one frame machine per terminal
// (a raw key moves it), keys.log / keystream.log record what was typed. Never a real Orca or agent.
process.env.PRODUCER_RUNNER_CURSOR = 'on';
const H = evRel('S01', 'HANDOFF.json');
const OPEN = '\x1b[1;2D';
const DOWN = '\x1b[B';
const MAIN = '\x1b[1;2C';
const ENTER = '\r';
const FIXED = [ANSWER_TEXT, ANSWER_DONE, 'stop'];
const FOLLOW = "Director's answer to your question: ";
const FOOT = '  enter submit   ctrl+] skip   shift+→ main prompt';
const FOOT2 = '  enter submit   ctrl+] skip   shift+← next question   shift+→ main prompt';
const closed = (n = 1) => ['• Waiting for user input (12s • esc to interrupt)', '', '  Queued follow-up inputs', `  ? ${n} question${n > 1 ? 's' : ''}`, '  shift+← to answer', '', '› '];
const GONE = ['• Continuing with the slice', '', '› '];
const choice = (question, labels, marked, { pos } = {}) => [
  '• earlier output', '', ...(pos ? [`  ${pos}`] : []), `  ${question}`,
  ...labels.map((l, i) => `${i === marked ? '  › ' : '    '}${i + 1}. ${l}`), '', pos ? FOOT2 : FOOT,
];
const free = (question) => ['• earlier output', '', `  ${question}`, '  Type your answer', '', FOOT];

const Q1 = 'A-10-14: At least 6 separable layer-0 bricks are missing; keep the literal rule or approve all of them?';
const LABELS = ['Keep literal rule; report at review', 'Approve all 5 layer-0 bricks', 'Other'];

/** closed → (shift+←) m0 → (↓) m1 … → (Enter) `after`; Enter on "Other" goes to `other` (typing = still the same panel). */
function choiceFrames(question, labels, { after = 'gone', other = 'gone', n = 1 } = {}) {
  const frames = { closed: { lines: closed(n), keys: { [OPEN]: 'm0' } }, gone: { lines: GONE } };
  labels.forEach((l, i) => {
    frames[`m${i}`] = { lines: choice(question, labels, i), keys: { [DOWN]: `m${Math.min(i + 1, labels.length - 1)}`, [ENTER]: /^other/i.test(l) ? other : after, [MAIN]: 'closed' } };
  });
  frames.typing = { lines: choice(question, labels, labels.length - 1), keys: { '*': 'typing', [ENTER]: 'gone', [MAIN]: 'closed' } };
  return frames;
}
const screens = (frames, at = 'closed') => ({ term_1: { at, frames } });

const fleet = () => project({ slices: { S01: { needs: false, size: 'L' } } });
const working = (detail = 'implementing') => ({ [H]: { role: 'coordinator', status: 'working', detail } });
const start = (map, detail) => ({ name: 'run created', runs: [{ id: 'run_1', coordinator_handle: 'term_1' }], write: working(detail), ...(map ? { screens: map } : {}) });
const tick = (n, detail = `tick ${n}`, extra = {}) => ({ name: `tick ${n}`, write: working(detail), ...extra });
const run = (root, f, ...args) => runner(root, f, ...args, { env: { PRODUCER_RUNNER_KEY_MS: '0' } });
const runnerFile = (root) => JSON.parse(fs.readFileSync(path.join(root, '.cursor', 'producer-runner.json'), 'utf8'));
const log = (root) => fs.readFileSync(ev(root, 'S01', 'producer-log.md'), 'utf8');
const typed = (f) => f.keys().map((k) => k.text);
const frame = (f) => JSON.parse(fs.readFileSync(path.join(f.dir, 'screens.json'), 'utf8')).term_1.at;

test('parseScreen: choice, free text, "1 of 2", wrapped question, descriptions, closed marker, nothing', () => {
  const c = parseScreen([
    '  A-10-14: At least 6 separable ... or approve ...?',
    '  › 1. Keep literal rule; report at review',
    '    2. Approve all 5 layer-0 bricks',
    '    3. Other',
    FOOT,
  ]);
  assert.deepEqual([c.state, c.ok, c.kind, c.question, c.options.map((o) => o.label), c.marked], ['open', true, 'choice', 'A-10-14: At least 6 separable ... or approve ...?', ['Keep literal rule; report at review', 'Approve all 5 layer-0 bricks', 'Other'], 0]);
  // the marker is whichever row carries it; "Other" stays in the list (the runner filters it from the choices)
  assert.equal(parseScreen(choice('Q?', ['a', 'b', 'Other'], 1)).marked, 1);
  // no marker at all → still parsed, but the runner cannot move it (never guesses)
  const bare = parseScreen(['  Q?', '    1. a', '    2. b', FOOT]);
  assert.deepEqual([bare.ok, bare.marked], [true, null]);

  const fr = parseScreen(free('Which backend should the 30 FAIL rows use?'));
  assert.deepEqual([fr.ok, fr.kind, fr.question, fr.options], [true, 'free', 'Which backend should the 30 FAIL rows use?', []]);

  const two = parseScreen(choice('Second thing?', ['yes', 'no', 'Other'], 0, { pos: '1 of 2' }));
  assert.deepEqual([two.ok, two.question, two.index, two.total], [true, 'Second thing?', 1, 2]);
  assert.deepEqual([parseScreen(['  Q?', '  1 of 2', '  Q2 text?', '  › 1. a', '    2. b', FOOT2]).index], [1]);
  // "2 of 2" between the question and its options
  const mid = parseScreen(['• earlier output', '', '  Second?', '  2 of 2', '  › 1. a', '    2. b', FOOT2]);
  assert.deepEqual([mid.question, mid.index, mid.total], ['Second?', 2, 2]);

  // a long question wraps onto several rows; the paragraph above it (after a blank row) is not part of it
  const wrapped = parseScreen(['• tool output earlier', '', '  First row of a long question that the', '  terminal wrapped onto a second row?', '  › 1. yes', '    2. no', FOOT]);
  assert.equal(wrapped.question, 'First row of a long question that the terminal wrapped onto a second row?');
  const described = parseScreen(['  Q?', '  › 1. Keep', '      the literal rule', '    2. Approve', '      all of them', FOOT]);
  assert.deepEqual(described.options, [{ label: 'Keep', desc: 'the literal rule' }, { label: 'Approve', desc: 'all of them' }]);

  assert.deepEqual([parseScreen(closed(1)).state, parseScreen(closed(2)).count], ['closed', 2]);
  assert.equal(parseScreen(['• ran the tests', '  4 questions to answer later', '› ']).state, 'none'); // not the marker
  assert.equal(parseScreen(GONE).state, 'none');
  // an open panel that is neither: unreadable, with the reason
  assert.deepEqual([parseScreen(['  something else', FOOT]).ok, parseScreen(['  Q?', '  1. a', '  2. a', FOOT]).error], [false, 'two options have the same label']);
});

test('choice panel: asked with the parsed options (never "Other"), the picked option is pressed with down + Enter, the panel is confirmed gone', () => {
  const p = fleet();
  const f = fakes();
  f.queue([start(screens(choiceFrames(Q1, LABELS)))]);
  const a = run(p.root, f, 'start', '--once').out.at(-1);
  assert.deepEqual([a.waiting, a.kind, a.options], ['q1', 'coordinator_question', [LABELS[0], LABELS[1], ...FIXED]]);
  const q = runnerFile(p.root).questions[0];
  assert.match(q.text, /codex's own question panel \(not an Orca gate\): A-10-14: At least 6 separable layer-0 bricks are missing; keep the literal rule or approve all of them\?$/);
  assert.equal(q.ref, `p:${fingerprint(Q1)}`);
  // read with shift+←, closed again with shift+→ (an open panel would swallow the runner's next message)
  assert.deepEqual(typed(f), [OPEN, MAIN]);
  assert.equal(frame(f), 'closed');
  assert.deepEqual(f.sends(), []);

  run(p.root, f, 'answer', '--id', 'q1', '--choice', LABELS[1]);
  run(p.root, f, 'start', '--once');
  assert.deepEqual(typed(f), [OPEN, MAIN, OPEN, DOWN, ENTER]); // one down from the marked first row, then Enter
  assert.equal(frame(f), 'gone');
  assert.deepEqual(f.sends(), []); // an option answer is keys only
  assert.match(log(p.root), /coordinator panel q1: moved the marker to "Approve all 5 layer-0 bricks" \(down\)/);
  assert.match(log(p.root), /coordinator panel q1: sent down, Enter for "Approve all 5 layer-0 bricks"/);
  assert.match(log(p.root), /coordinator panel q1: the panel moved on/);
});

test('choice panel: the first option needs no key but Enter; a marker that did not move is never submitted', () => {
  const p = fleet();
  const f = fakes();
  f.queue([start(screens(choiceFrames(Q1, LABELS)))]);
  run(p.root, f, 'start', '--once');
  run(p.root, f, 'answer', '--id', 'q1', '--choice', LABELS[0]);
  run(p.root, f, 'start', '--once');
  assert.deepEqual(typed(f), [OPEN, MAIN, OPEN, ENTER]);

  // the screen ignores ↓ (m0 has no DOWN key): the marker is not on the option, so Enter is never sent
  const q = fleet();
  const g = fakes();
  const frames = choiceFrames(Q1, LABELS);
  frames.m0.keys = { [MAIN]: 'closed' };
  g.queue([start(screens(frames))]);
  run(q.root, g, 'start', '--once');
  run(q.root, g, 'answer', '--id', 'q1', '--choice', LABELS[1]);
  const out = run(q.root, g, 'start', '--once').out;
  assert.deepEqual(typed(g), [OPEN, MAIN, OPEN, DOWN, MAIN]); // …and the panel is closed again
  assert.match(out.find((o) => o.blocked)?.detail, /the marker is not on "Approve all 5 layer-0 bricks" after down; nothing was submitted/);
  assert.equal(out.find((o) => o.blocked).blocked, 'runner_error');
});

test('free-text panel: only the text options; typed + Enter, no plain follow-up message', () => {
  const p = fleet();
  const f = fakes();
  const Q = 'Which backend should the 30 FAIL rows use?';
  f.queue([start(screens({
    closed: { lines: closed(), keys: { [OPEN]: 'f0' } },
    f0: { lines: free(Q), keys: { '*': 'f1', [MAIN]: 'closed' } },
    f1: { lines: free(Q), keys: { [ENTER]: 'gone', [MAIN]: 'closed' } },
    gone: { lines: GONE },
  }))]);
  const a = run(p.root, f, 'start', '--once').out.at(-1);
  assert.deepEqual([a.kind, a.options], ['coordinator_question', FIXED]);
  assert.match(runnerFile(p.root).questions[0].text, /: Which backend should the 30 FAIL rows use\?$/);
  // the text choice needs its note, like a gate's
  assert.equal(run(p.root, f, 'answer', '--id', 'q1', '--choice', ANSWER_TEXT).status, 2);
  assert.equal(runnerFile(p.root).questions[0].answer, null);
  run(p.root, f, 'answer', '--id', 'q1', '--choice', ANSWER_TEXT, '--text', 'pixel for the 30 FAIL rows');
  run(p.root, f, 'start', '--once');
  assert.deepEqual(typed(f), [OPEN, MAIN, OPEN, 'pixel for the 30 FAIL rows', ENTER]);
  assert.deepEqual(f.sends(), []);
  assert.equal(frame(f), 'gone');
  assert.match(log(p.root), new RegExp(`typed the answer \\(${'pixel for the 30 FAIL rows'.length} characters\\) \\+ Enter into the free-text panel`));
});

test('"answer with --text" on a choice panel: Other + Enter, the text typed + Enter, then the same text as a plain follow-up message', () => {
  const p = fleet();
  const f = fakes();
  f.queue([start(screens(choiceFrames(Q1, LABELS, { other: 'typing' })))]);
  run(p.root, f, 'start', '--once');
  run(p.root, f, 'answer', '--id', 'q1', '--choice', ANSWER_TEXT, '--text', 'keep the rule, but split brick 3');
  run(p.root, f, 'start', '--once');
  assert.deepEqual(typed(f), [OPEN, MAIN, OPEN, DOWN, DOWN, ENTER, 'keep the rule, but split brick 3', ENTER]);
  assert.deepEqual(f.sends(), [{ to: 'term_1', text: `${FOLLOW}keep the rule, but split brick 3` }]);
  // keys first, the message after (the panel is back at the main prompt by then)
  assert.deepEqual(f.keystream().slice(-2).map((k) => [k.text, k.enter]), [[ENTER, false], [`${FOLLOW}keep the rule, but split brick 3`, true]]);
  assert.equal(frame(f), 'gone');

  // Other submitted and the panel moved on: nothing is typed (it would land in the main prompt), the message still goes
  const q = fleet();
  const g = fakes();
  g.queue([start(screens(choiceFrames(Q1, LABELS, { other: 'gone' })))]);
  run(q.root, g, 'start', '--once');
  run(q.root, g, 'answer', '--id', 'q1', '--choice', ANSWER_TEXT, '--text', 'split brick 3');
  run(q.root, g, 'start', '--once');
  assert.deepEqual(typed(g), [OPEN, MAIN, OPEN, DOWN, DOWN, ENTER]);
  assert.deepEqual(g.sends(), [{ to: 'term_1', text: `${FOLLOW}split brick 3` }]);
  assert.match(log(q.root), /the panel moved on \(or could not be read\), no typing/);

  // a choice panel without "Other": nothing is pressed, the director is told
  const r = fleet();
  const h = fakes();
  h.queue([start(screens(choiceFrames(Q1, ['yes', 'no'])))]);
  run(r.root, h, 'start', '--once');
  run(r.root, h, 'answer', '--id', 'q1', '--choice', ANSWER_TEXT, '--text', 'maybe');
  const out = run(r.root, h, 'start', '--once').out;
  assert.match(out.find((o) => o.blocked).detail, /this panel has no "Other" option/);
  assert.deepEqual(typed(h), [OPEN, MAIN, OPEN, MAIN]);
  assert.deepEqual(h.sends(), []);
});

test('"1 of 2" questions: the position is shown, the next question is asked after the first is answered', () => {
  const p = fleet();
  const f = fakes();
  const Q2 = 'Second: which backend for the 30 FAIL rows?';
  const frames = {
    closed: { lines: closed(2), keys: { [OPEN]: 'a0' } },
    a0: { lines: choice(Q1, LABELS, 0, { pos: '1 of 2' }), keys: { [DOWN]: 'a1', [ENTER]: 'b0', [MAIN]: 'closed' } },
    a1: { lines: choice(Q1, LABELS, 1, { pos: '1 of 2' }), keys: { [ENTER]: 'b0', [MAIN]: 'closed' } },
    b0: { lines: choice(Q2, ['pixel', 'voxel', 'Other'], 0, { pos: '2 of 2' }), keys: { [MAIN]: 'closed2' } },
    closed2: { lines: closed(1), keys: { [OPEN]: 'b0' } },
  };
  f.queue([start(screens(frames))]);
  const a = run(p.root, f, 'start', '--once').out.at(-1);
  assert.deepEqual([a.kind, a.options.slice(0, 2)], ['coordinator_question', [LABELS[0], LABELS[1]]]);
  assert.match(runnerFile(p.root).questions[0].text, /\(not an Orca gate, question 1 of 2\): A-10-14/);

  run(p.root, f, 'answer', '--id', 'q1', '--choice', LABELS[0]);
  f.queue([tick(2)]);
  const b = run(p.root, f, 'start', '--once').out.at(-1);
  // Enter moved the panel to the second question (a different one: confirmed as moved on), which went back to closed
  assert.deepEqual([b.waiting, b.kind, b.options], ['q2', 'coordinator_question', ['pixel', 'voxel', ...FIXED]]);
  assert.match(runnerFile(p.root).questions[1].text, /question 2 of 2\): Second: which backend/);
  assert.deepEqual(typed(f), [OPEN, MAIN, OPEN, ENTER, MAIN, OPEN, MAIN]);
});

test('an unreadable panel: the raw screen tail with only the text / continue / stop options; the text goes as a plain message', () => {
  const p = fleet();
  const f = fakes();
  f.queue([start(screens({
    closed: { lines: closed(), keys: { [OPEN]: 'junk' } },
    junk: { lines: ['• some other overlay', '  neither numbered nor free text', FOOT], keys: { [MAIN]: 'closed' } },
  }))]);
  const a = run(p.root, f, 'start', '--once').out.at(-1);
  assert.deepEqual([a.kind, a.options], ['coordinator_question', FIXED]);
  const q = runnerFile(p.root).questions[0];
  assert.match(q.text, /could not read \(no numbered options and no "Type your answer" above "enter submit"\); its screen:\n• some other overlay\n {2}neither numbered nor free text\n {2}enter submit/);
  assert.ok(q.ref.startsWith('r:'));
  run(p.root, f, 'answer', '--id', 'q1', '--choice', ANSWER_TEXT, '--text', 'go with pixel');
  run(p.root, f, 'start', '--once');
  // no option is guessed: back to the main prompt (shift+→), then the director's words as a follow-up message
  assert.deepEqual(typed(f), [OPEN, MAIN, OPEN, MAIN]);
  assert.deepEqual(f.sends(), [{ to: 'term_1', text: `${FOLLOW}go with pixel` }]);

  // the panel does not open at all: still a question, with what the screen shows
  const q2 = fleet();
  const g = fakes();
  g.queue([start(screens({ closed: { lines: closed(), keys: {} } }))]);
  run(q2.root, g, 'start', '--once');
  assert.match(runnerFile(q2.root).questions[0].text, /the panel did not open after shift\+←/);
  assert.deepEqual(typed(g), [OPEN]);
});

test('a screen that cannot be read: never keys into it, said once in the log, and the director is asked after 3 waits in a row (once per outage)', () => {
  const p = fleet();
  const f = fakes();
  const blind = { term_1: { at: 'u', source: 'screen-unavailable', frames: { u: { lines: closed(), keys: { [OPEN]: 'u' } } } } };
  // two unreadable waits: nothing asked, nothing typed (the accumulated stream still shows closed panels)
  f.queue([start(blind), tick(2)]);
  const first = run(p.root, f, 'start', '--once').out;
  const q1 = runnerFile(p.root).questions[0];
  assert.deepEqual(typed(f), []);
  // the empty queue ends the third wait: that is the 3rd unreadable look → one question
  assert.deepEqual([first.find((o) => o.blocked).blocked, first.find((o) => o.blocked).options], ['coordinator_screen', ['checked the coordinator terminal, continue', 'stop']]);
  assert.match(q1.text, /could not be read on 3 waits in a row, so a codex question panel \(request_user_input\) may be waiting there/);
  assert.equal(log(p.root).match(/could not read the coordinator's screen \(term_1\)/g).length, 1); // said once, not on every wait

  // answered: the same outage is not asked again, a new outage (after a good read) is
  run(p.root, f, 'answer', '--id', 'q1', '--choice', 'checked the coordinator terminal, continue');
  f.queue([tick(4), tick(5), tick(6), tick(7)]);
  fs.rmSync(path.join(p.root, '.cursor', 'producer.control'), { force: true });
  assert.equal(run(p.root, f, 'start', '--once').out.some((o) => o.waiting || (o.blocked && o.blocked !== 'fleet_stall')), false);
  assert.equal(runnerFile(p.root).questions.filter((q) => q.kind === 'coordinator_screen').length, 1);
  const readable = { term_1: { at: 'g', frames: { g: { lines: GONE } } } };
  f.queue([tick(8, 't8', { screens: readable }), tick(9, 't9', { screens: blind }), tick(10), tick(11)]);
  fs.rmSync(path.join(p.root, '.cursor', 'producer.control'), { force: true });
  const again = run(p.root, f, 'start', '--once').out;
  assert.equal(again.find((o) => o.waiting)?.kind, 'coordinator_screen');
  assert.equal(runnerFile(p.root).questions.filter((q) => q.kind === 'coordinator_screen').length, 2);
  assert.deepEqual(typed(f), []);
  assert.equal(log(p.root).match(/could not read the coordinator's screen \(term_1\)/g).length, 2); // once per outage

  // a single unreadable wait in between good ones asks nothing
  const q = fleet();
  const g = fakes();
  g.queue([start({ term_1: { at: 'g', frames: { g: { lines: GONE } } } }), tick(2, 't2', { screens: blind }), tick(3, 't3', { screens: readable }), tick(4, 't4', { screens: blind }), tick(5, 't5', { screens: readable })]);
  assert.equal(run(q.root, g, 'start', '--once').out.some((o) => o.waiting || (o.blocked && o.blocked !== 'fleet_stall')), false);
});

test('"answered in the coordinator terminal, continue": nothing is typed, and the same panel is not asked again', () => {
  const p = fleet();
  const f = fakes();
  f.queue([start(screens(choiceFrames(Q1, LABELS)))]);
  run(p.root, f, 'start', '--once');
  run(p.root, f, 'answer', '--id', 'q1', '--choice', ANSWER_DONE);
  f.queue([tick(2), tick(3), tick(4)]);
  const out = run(p.root, f, 'start', '--once').out;
  assert.equal(out.some((o) => o.blocked || o.waiting), false);
  assert.equal(runnerFile(p.root).questions.length, 1);
  // it only waits: the closed marker is not opened again on every wait (the director may be in that panel)
  assert.deepEqual(typed(f), [OPEN, MAIN]);
  assert.ok(f.reads().length >= 4);
  assert.equal(f.sends().length, 0);
  assert.equal(frame(f), 'closed');

  // the director answered it in the terminal (a wait sees the screen without a panel), then the coordinator asks
  // something else: a new question. Until a wait sees the panel gone, the same closed marker stays quiet.
  f.queue([
    { name: 'answered in the terminal', screens: screens({ closed: { lines: GONE } }), write: working('t5') },
    { name: 'new question', screens: screens(choiceFrames('Another question entirely?', ['x', 'y', 'Other'])), write: working('t6') },
  ]);
  fs.rmSync(path.join(p.root, '.cursor', 'producer.control'), { force: true });
  const b = run(p.root, f, 'start', '--once').out.at(-1);
  assert.deepEqual([b.waiting, b.kind, b.options.slice(0, 2)], ['q2', 'coordinator_question', ['x', 'y']]);
});

test('no coordinator question while a gate is pending: the gate comes first and the screen is not touched', () => {
  const p = fleet();
  const f = fakes();
  const gate = { id: 'g1', status: 'pending', question: 'Approve PLAN?', options: '["approve","revise"]' };
  f.queue([start(), { name: 'gate opened', gates: [gate], screens: screens(choiceFrames(Q1, LABELS)) }]);
  const a = run(p.root, f, 'start', '--once').out.at(-1);
  assert.deepEqual([a.waiting, a.kind], ['q1', 'fleet_gate']);
  // the only read was before the gate (and the screen) existed; no key was ever sent
  assert.deepEqual([f.reads().filter((r) => r.frame !== null), f.keys()], [[], []]);
});

const PENDING = 'Concept PASS prerequisite blocks pixel/voxel for the 30 FAIL rows pending a director decision; no concept gates or backend policy were changed.';

test('director_pending: a HANDOFF detail waiting on the director with no gate, the same on two waits in a row → a question to relay', () => {
  const p = fleet();
  const f = fakes();
  // the detail changes in between: the count starts again, so only the last two (equal) waits ask
  f.queue([start(null, PENDING), tick(2, 'integrating the DAG'), tick(3, PENDING), tick(4, PENDING)]);
  const a = run(p.root, f, 'start', '--once').out.at(-1);
  assert.deepEqual([a.waiting, a.kind, a.options], ['q1', 'director_pending', ['send this answer to the lane', 'answered in the lane, continue', 'stop']]);
  assert.equal(f.waits().length, 4);
  const q = runnerFile(p.root).questions[0];
  assert.equal(q.text, `fleet HANDOFF working says it waits for the director, but no gate is open: ${PENDING}`); // the whole detail
  assert.equal(q.obs, `director_pending@${fingerprint(PENDING)}`);

  // the answer goes to the coordinator like a lane_blocked one, and the same detail is not asked again
  assert.equal(run(p.root, f, 'answer', '--id', 'q1', '--choice', 'send this answer to the lane').status, 2); // needs its note
  run(p.root, f, 'answer', '--id', 'q1', '--choice', 'send this answer to the lane', '--text', 'pixel for the 30 FAIL rows');
  f.queue([tick(5, PENDING), tick(6, PENDING), tick(7, PENDING)]);
  const out = run(p.root, f, 'start', '--once').out;
  assert.equal(out.some((o) => o.blocked || o.waiting), false);
  assert.equal(runnerFile(p.root).questions.length, 1);
  assert.deepEqual(f.sends().map((s) => s.to), ['term_1']);
  assert.match(f.sends()[0].text, /^Director's answer to your question: pixel for the 30 FAIL rows — continue the slice; update HANDOFF\.json when your status changes\.$/);
  assert.ok(f.reads().length >= f.waits().length); // the screen is read after every wait; nothing was on it
  assert.deepEqual(f.keys(), []);
});

test('director_pending: "answered in the lane, continue" only waits; a new detail is a new question', () => {
  const p = fleet();
  const f = fakes();
  f.queue([start(null, PENDING), tick(2, PENDING)]);
  run(p.root, f, 'start', '--once');
  run(p.root, f, 'answer', '--id', 'q1', '--choice', 'answered in the lane, continue');
  f.queue([tick(3, PENDING), tick(4, PENDING)]);
  assert.equal(run(p.root, f, 'start', '--once').out.some((o) => o.blocked || o.waiting), false);
  assert.deepEqual(f.sends(), []);
  const other = 'Awaiting the director for the voxel fallback policy.';
  f.queue([tick(5, other), tick(6, other)]);
  fs.rmSync(path.join(p.root, '.cursor', 'producer.control'), { force: true });
  const b = run(p.root, f, 'start', '--once').out.at(-1);
  assert.deepEqual([b.waiting, b.kind], ['q2', 'director_pending']);
});

test('director_pending: decisions already made, and other statuses, are never asked', () => {
  const p = fleet();
  const f = fakes();
  const made = 'Director resolved gate g4 (keep the literal rule); per director the 30 FAIL rows stay pixel. Continuing with review round 2.';
  f.queue([start(null, made), tick(2, made), tick(3, made), tick(4, made)]);
  const out = run(p.root, f, 'start', '--once').out;
  assert.equal(out.some((o) => o.blocked || o.waiting), false);
  assert.equal(runnerFile(p.root).questions?.length ?? 0, 0);

  // a lane that already says offer_commit / blocked is handled by its own rules, not as director_pending
  const q = fleet();
  const g = fakes();
  g.queue([{ ...start(null, PENDING), write: { [H]: { role: 'coordinator', status: 'blocked', detail: PENDING } } }]);
  const b = run(q.root, g, 'start', '--once').out.at(-1);
  assert.deepEqual([b.kind], ['lane_blocked']);
});

test('waitsOnDirector: waiting phrases match; decisions made, negations and other words do not', () => {
  for (const yes of [
    PENDING,
    'Pending the director decision on layer-0 bricks',
    'awaiting the director',
    'Awaiting director ruling on backend',
    'waiting for the director to pick',
    'director must decide between A and B',
    'The director needs to approve the budget bump',
    'director to decide',
    "Needs the director's ruling on the concept gate",
    'needs a director decision',
    'Director decision needed for brick count',
    'director decision is pending',
    'blocked on a director approval',
    'no gate opened pending a director decision', // the negation is not right before it
    'Holiday reserve decision pending director.', // a real pending decision (2026-10-05 review)
    'Holiday reserve decision pending the director.',
    'Reserve swap pending the director.', // no decision noun
    'Awaiting your decision on A-10-02.',
    'waiting for your ruling',
  ]) assert.ok(waitsOnDirector(yes), yes);
  for (const no of [
    'Director resolved gate g1: keep the literal rule',
    'per director: approve all 5 layer-0 bricks',
    'Applied the director decision from gate g4; continuing',
    'The director approved the plan; implementing',
    'no director decision pending',
    'Not pending a director ruling',
    'nothing awaiting the director',
    'previously pending a director decision, now decided by the director',
    'there was no need to wait for the director',
    "the director hasn't decided yet, but the integrator doesn't need it", // not a phrase of waiting
    'directory listing needs a decision',
    'Gate g2 pending (director gate), implementing meanwhile',
    'Awaiting director-approved reserve list', // "director-approved" is a thing, not the director
    'Reviewer awaiting director-side evidence.',
    'Worker is pending director-signed manifest paths',
    'Waiting for your next message from the reviewer',
    'S12 is pending director gate; implementing the rest meanwhile', // a gate exists
    'Merge pending director review is not required', // negated after the phrase
    'Reserve swap pending director approval is no longer needed',
    'S12 is pending director gate_6c4eda5aca3c; implementing the rest', // a gate id too
    'Merge pending director gate-g1 (opened above)',
    '',
    undefined,
  ]) assert.equal(waitsOnDirector(no), null, String(no));
});

// osascript stand-in: prints the prepared choice / note and logs what it was shown
const FAKE_OSA = `#!/usr/bin/env node
const fs = require('fs'), path = require('path');
const D = process.env.FAKE_DIR, a = process.argv.slice(2);
const script = a.filter((x, i) => a[i - 1] === '-e').join('\\n');
const args = a.filter((x, i) => x !== '-e' && a[i - 1] !== '-e');
const kind = script.includes('choose from list') ? 'choose' : 'note';
fs.appendFileSync(path.join(D, 'osa.log'), JSON.stringify({ kind, args }) + '\\n');
process.stdout.write(fs.readFileSync(path.join(D, kind === 'choose' ? 'osa-choice' : 'osa-note'), 'utf8') + '\\n');
`;

test('answer UX: the menu, the dialog and the CLI show both kinds with the whole text; the text choice needs its note', () => {
  const long = `${Q1} ${'More context about the 30 FAIL rows and the backend policy. '.repeat(12)}`.trim();
  const cq = { id: 'q1', key: 'S01:coordinator_question:x', kind: 'coordinator_question', slice: 'S01', text: `the coordinator asked in codex's own question panel (not an Orca gate): ${long}`, options: [LABELS[0], LABELS[1], ...FIXED], ref: 'p:x', answer: null };
  const dp = { id: 'q2', key: 'S01:director_pending', kind: 'director_pending', slice: 'S01', text: `fleet HANDOFF working says it waits for the director, but no gate is open: ${PENDING}`, options: ['send this answer to the lane', 'answered in the lane, continue', 'stop'], ref: null, answer: null };
  assert.deepEqual([textNeed(cq, ANSWER_TEXT), textNeed(cq, LABELS[0]), textNeed(cq, ANSWER_DONE), textNeed(cq, 'stop')], ['required', null, null, null]);
  assert.deepEqual([textNeed(dp, 'send this answer to the lane'), textNeed(dp, 'stop')], ['required', null]);
  assert.match(answerProblem(cq, ANSWER_TEXT, ''), /--text/);
  assert.equal(answerProblem(cq, ANSWER_TEXT, 'x'), null);
  assert.equal(answerProblem(cq, LABELS[1], ''), null);
  const m = menu(cq);
  assert.ok(m.includes(long), 'the menu shows the whole question');
  assert.match(m, new RegExp(`  3\\) ${ANSWER_TEXT}  \\(needs a note\\)\\n  4\\) ${ANSWER_DONE}\\n  5\\) stop`));
  assert.ok(menu(dp).includes(PENDING));

  const p = project({ slices: { S01: { needs: false, size: 'L' } } });
  fs.mkdirSync(path.join(p.root, '.cursor'), { recursive: true });
  fs.writeFileSync(path.join(p.root, '.cursor', 'producer-runner.json'), JSON.stringify({ slice: 'S01', step: 'blocked:x', questions: [cq, dp] }));
  const f = fakes();
  const bin = path.join(f.dir, 'osascript-fake');
  fs.writeFileSync(bin, FAKE_OSA, { mode: 0o755 });
  fs.writeFileSync(path.join(f.dir, 'osa-choice'), ANSWER_TEXT);
  fs.writeFileSync(path.join(f.dir, 'osa-note'), 'pixel for all of them');
  const dialog = (id) => spawnSync(process.execPath, [new URL('../scripts/answer-dialog.mjs', import.meta.url).pathname, '--project', p.root, '--id', id], { encoding: 'utf8', timeout: 20000, env: { ...env(p.root, f), PRODUCER_RUNNER_OSASCRIPT: bin } });
  assert.equal(dialog('q1').status, 0);
  const runs = fs.readFileSync(path.join(f.dir, 'osa.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(runs[0].args[1].includes(long), 'the dialog shows the whole question');
  assert.deepEqual(runs[0].args.slice(4, -1), cq.options);
  assert.match(runs[1].args[1], /^Note for "answer with --text" \(required, sent with the decision word for word\):$/);
  const a = runnerFile(p.root).questions[0].answer;
  assert.deepEqual([a.choice, a.text, a.via], [ANSWER_TEXT, 'pixel for all of them', 'dialog']);

  fs.writeFileSync(path.join(f.dir, 'osa-choice'), 'send this answer to the lane');
  assert.equal(dialog('q2').status, 0);
  assert.ok(fs.readFileSync(path.join(f.dir, 'osa.log'), 'utf8').includes(PENDING.slice(0, 60)));
  assert.deepEqual([runnerFile(p.root).questions[1].answer.choice, runnerFile(p.root).questions[1].answer.text], ['send this answer to the lane', 'pixel for all of them']);
});

// ---------------------------------------------------------------------------------------------------
// Review of 1364345: real codex screens (captured 2026-10-05, lego-stack S11) and the cases they showed.

const L = (t) => t.split('\n');
const REAL = {
  // (A) closed
  A: L(`• Waiting for background terminal (1h 29m 47s • esc to interrupt) · 1 background terminal running · /ps to view · /stop to close
  └ node ~/.agents/skills/cocos-orca-fleet/scripts/orca-wait.mjs coord
• Queued follow-up inputs
  ? 1 question
    shift+← to answer
› Ask Codex to do anything
  gpt-6-luna-high high · ~/Works/games/CocosCreator/cc-lego-stack · Run S11 Orca slice
  ? for shortcuts`),
  // (B) choice, wrapped question
  B: L(`• Queued follow-up inputs
  A-10-14: At least 6 separable neighboring bricks are required, but V1 L1 has 5 merged bricks and merge rules are out of scope. Keep the literal rule and report the known failure at review, or approve interpreting it as all 5
  layer-0 bricks separable?
  › 1. Keep literal rule; report at review
    2. Approve all 5 layer-0 bricks
    3. Other
  enter submit   ctrl+] skip   shift+→ main prompt`),
  // (C) free text
  C: L(`• Queued follow-up inputs
  A-10-02 needs a director reading: the fixed 120 ms quadOut glide moves 0.58× a tray block’s height on its first V3 L1 frame. Choose A: animate scale during the glide; B: measure the 0.35× step against the block at its model scale
  at the gap pose (recommended, <=0.26× across viewports); C: delay glide 80 ms (about 200 ms total); or D: lengthen the glide to about 220 ms.
  Type your answer
  enter submit   ctrl+] skip   shift+→ main prompt`),
  // (D) first of two
  D: L(`• Queued follow-up inputs
  1 of 2
  S11 reserve design gap: the slice names Teacher and Mail Carrier but gives no briefs or V-12 palettes. Which design and downstream update handling should the reserve-swap worker use?
  › 1. Approve the worker proposal: Teacher uses glasses/cardigan/books with G W N S; Mail Carrier uses peaked cap/satchel/letter with B D N S. Update only L100/L102 test names and strings. (Recommended)
    2. Approve reserve designs, but leave test names and strings for integration
    3. Give exact designs and update handling in a reply
    4. Other
  enter submit   ctrl+] skip   shift+→ main prompt   shift+← next question`),
  // (E) the second question, after the first was submitted
  E: L(`  ↳ > S11 reserve design gap: the slice names Teacher and Mail Carrier but gives no briefs or V-12 palettes. Which design and downstream update handling should the reserve-swap worker use?
    Approve the worker proposal: Teacher uses glasses/cardigan/books with G W N S; Mail Carrier uses peaked cap/satchel/letter with B D N S. Update only L100/L102 test names and strings. (Recommended)
• Queued follow-up inputs
  The food reserve list names Ice Lolly and Watermelon Slice but gives no prompts, model records, or authorized shared-file paths. For L054’s palette FAIL, should the worker leave the concept FAIL and list the swap as pending, or
  may it propose and add reserve details in models/prompts/strings?
  › 1. Leave L054 as honest FAIL and record the reserve swap as pending (Recommended)
    2. Authorize a narrowly scoped Ice Lolly swap and add required model/prompt/string fields
    3. Give exact replacement details and paths
    4. Other
  enter submit   ctrl+] skip   shift+→ main prompt`),
  // (F) "Other" already selected, its input row showing (typed text is not rendered)
  F: L(`  Should the chapter keep these FAIL rows for review, or should two failures use reserves with you supplying the target IDs and any missing reserve details?
    1. Keep all Holidays FAIL rows for director review (Recommended)
    2. Use two reserves; I will specify target IDs/details
    3. Provide exact reserve mappings and designs now
›
  enter submit   ctrl+] skip   shift+→ main prompt`),
  // (G) an answer echoed after submit: no panel
  G: L(`• Messages to be submitted after next tool call (press esc to interrupt and send immediately)
  ↳ > Your gate reply ended with “2 only the test file.” Which test file did you mean, if that is a separate scope instruction? I’ve resolved the gate as “add manifest path” and will continue the slic
    No separate test-file instruction
› Ask Codex to do anything`),
};
const UP = '\x1b[A';
const countOf = (n) => REAL.A.map((l) => l.replace('? 1 question', `? ${n} question${n > 1 ? 's' : ''}`));
// the same screen with the `›` marker on numbered row n
const moveMark = (sample, n) => sample.map((l) => l.replace(/^(\s*)(?:›\s+)?(\d+)\.\s/, (m, ws, num) => `  ${Number(num) === n ? '›' : ' '} ${num}. `));
// frames for a choice panel of `sample` with `rows` numbered rows: closed → (shift+←) → row 1 …; Enter → `after`
function realChoice(sample, rows, { closedLines = REAL.A, after = 'gone', enter = {} } = {}) {
  const f = { closed: { lines: closedLines, keys: { [OPEN]: 'm1' } }, gone: { lines: REAL.G } };
  for (let n = 1; n <= rows; n++) f[`m${n}`] = { lines: moveMark(sample, n), keys: { [DOWN]: `m${Math.min(n + 1, rows)}`, [UP]: `m${Math.max(n - 1, 1)}`, [ENTER]: enter[n] || after, [MAIN]: 'closed' } };
  return f;
}

test('real codex screens: A closed, B / D / E choice (wrapped, "1 of 2"), C free text, F "Other" selected, G no panel', () => {
  const closedA = parseScreen(REAL.A);
  assert.deepEqual([closedA.state, closedA.count], ['closed', 1]);
  assert.equal(parseScreen(countOf(2)).count, 2);

  const b = parseScreen(REAL.B);
  assert.deepEqual([b.state, b.ok, b.kind, b.marked, b.options.map((o) => o.label)], ['open', true, 'choice', 0, ['Keep literal rule; report at review', 'Approve all 5 layer-0 bricks', 'Other']]);
  assert.equal(b.question, 'A-10-14: At least 6 separable neighboring bricks are required, but V1 L1 has 5 merged bricks and merge rules are out of scope. Keep the literal rule and report the known failure at review, or approve interpreting it as all 5 layer-0 bricks separable?');
  assert.equal(b.otherInput, false);

  const c = parseScreen(REAL.C);
  assert.deepEqual([c.ok, c.kind, c.options], [true, 'free', []]);
  assert.match(c.question, /^A-10-02 needs a director reading: .* tray block’s height .* scale at the gap pose \(recommended, <=0\.26× across viewports\); C: delay glide 80 ms .* about 220 ms\.$/);

  const d = parseScreen(REAL.D);
  assert.deepEqual([d.ok, d.kind, d.index, d.total, d.marked, d.options.length], [true, 'choice', 1, 2, 0, 4]);
  assert.match(d.question, /^S11 reserve design gap: .* reserve-swap worker use\?$/);
  assert.match(d.options[0].label, /^Approve the worker proposal: Teacher uses glasses\/cardigan\/books .* \(Recommended\)$/);
  assert.equal(d.options[3].label, 'Other');

  // E: the echo of the first answer above is not part of the second question
  const e = parseScreen(REAL.E);
  assert.deepEqual([e.ok, e.marked, e.options.length], [true, 0, 4]);
  assert.equal(e.question, 'The food reserve list names Ice Lolly and Watermelon Slice but gives no prompts, model records, or authorized shared-file paths. For L054’s palette FAIL, should the worker leave the concept FAIL and list the swap as pending, or may it propose and add reserve details in models/prompts/strings?');

  // F: the bare `›` row after the numbered options is the input of an "Other" that is already selected
  const f = parseScreen(REAL.F);
  assert.deepEqual([f.ok, f.kind, f.marked, f.otherInput, f.options.map((o) => o.label)],
    [true, 'choice', 3, true, ['Keep all Holidays FAIL rows for director review (Recommended)', 'Use two reserves; I will specify target IDs/details', 'Provide exact reserve mappings and designs now', 'Other']]);
  assert.equal(f.options[2].desc, undefined); // the input row is not the description of option 3
  // …with typed text after the marker too
  assert.deepEqual([parseScreen(REAL.F.map((l) => (l === '›' ? '› my words' : l))).otherInput, parseScreen(REAL.F.map((l) => (l === '›' ? '› my words' : l))).marked], [true, 3]);

  assert.equal(parseScreen(REAL.G).state, 'none');
  // the footer is the footer row only: a line that mentions it is not a panel
  assert.equal(parseScreen(['  enter submit is how you send it', '› ']).state, 'none');
  assert.equal(parseScreen(['  press enter submit then ctrl+] skip when sure of it', '› ']).state, 'none');
});

test('real screens end to end: A + B wrapped question → option 2 by one down and Enter; the question text is the whole wrapped one', () => {
  const p = fleet();
  const f = fakes();
  f.queue([start(screens(realChoice(REAL.B, 3)))]);
  // the very first screen is A (the closed marker), then B once opened
  f.screens({ term_1: { at: 'closed', frames: realChoice(REAL.B, 3) } });
  const a = run(p.root, f, 'start', '--once').out.at(-1);
  assert.deepEqual([a.kind, a.options], ['coordinator_question', ['Keep literal rule; report at review', 'Approve all 5 layer-0 bricks', ...FIXED]]);
  assert.match(runnerFile(p.root).questions[0].text, /Keep the literal rule and report the known failure at review, or approve interpreting it as all 5 layer-0 bricks separable\?$/);
  run(p.root, f, 'answer', '--id', 'q1', '--choice', 'Approve all 5 layer-0 bricks');
  run(p.root, f, 'start', '--once');
  assert.deepEqual(typed(f), [OPEN, MAIN, OPEN, DOWN, ENTER]);
  assert.match(log(p.root), /coordinator panel q1: the panel moved on/);
});

test('real screens end to end: D "1 of 2" answered with its long first option, then E is asked as the second question', () => {
  const p = fleet();
  const f = fakes();
  const frames = {
    closed: { lines: countOf(2), keys: { [OPEN]: 'd1' } },
    d1: { lines: moveMark(REAL.D, 1), keys: { [DOWN]: 'd2', [ENTER]: 'e1', [MAIN]: 'closed' } },
    d2: { lines: moveMark(REAL.D, 2), keys: { [ENTER]: 'e1', [MAIN]: 'closed' } },
    e1: { lines: moveMark(REAL.E, 1), keys: { [MAIN]: 'closedE', [DOWN]: 'e1' } },
    closedE: { lines: countOf(1), keys: { [OPEN]: 'e1' } },
  };
  f.queue([start(screens(frames))]);
  const a = run(p.root, f, 'start', '--once').out.at(-1);
  const first = parseScreen(REAL.D).options[0].label;
  assert.deepEqual(a.options, [first, parseScreen(REAL.D).options[1].label, parseScreen(REAL.D).options[2].label, ...FIXED]);
  assert.match(runnerFile(p.root).questions[0].text, /\(not an Orca gate, question 1 of 2\): S11 reserve design gap/);
  run(p.root, f, 'answer', '--id', 'q1', '--choice', first);
  f.queue([tick(2)]);
  const b = run(p.root, f, 'start', '--once').out.at(-1);
  assert.deepEqual([b.waiting, b.kind], ['q2', 'coordinator_question']);
  assert.match(runnerFile(p.root).questions[1].text, /: The food reserve list names Ice Lolly and Watermelon Slice but .* in models\/prompts\/strings\?$/);
  assert.deepEqual(typed(f), [OPEN, MAIN, OPEN, ENTER, MAIN, OPEN, MAIN]);
});

test('real screen F ("Other" selected): the text goes straight in with Enter (no key to select Other), then as a plain message; a numbered option moves up or refuses', () => {
  const text = 'use two reserves: Holiday rows 1 and 3';
  const numbered = (n) => moveMark([REAL.F[0], REAL.F[1], REAL.F[2], REAL.F[3], '    4. Other', REAL.F[5]], n);
  const mk = (upWorks) => ({
    closed: { lines: REAL.A, keys: { [OPEN]: 'f' } },
    f: { lines: REAL.F, keys: { '*': 'f', [ENTER]: 'gone', [MAIN]: 'closed', ...(upWorks ? { [UP]: 'u3' } : {}) } },
    u3: { lines: numbered(3), keys: { [UP]: 'u2', [ENTER]: 'gone', [MAIN]: 'closed' } },
    u2: { lines: numbered(2), keys: { [UP]: 'u1', [ENTER]: 'gone', [MAIN]: 'closed' } },
    u1: { lines: numbered(1), keys: { [UP]: 'u1', [ENTER]: 'gone', [MAIN]: 'closed' } },
    gone: { lines: REAL.G },
  });
  const p = fleet();
  const f = fakes();
  f.queue([start(screens(mk(true)))]);
  const a = run(p.root, f, 'start', '--once').out.at(-1);
  assert.deepEqual(a.options, ['Keep all Holidays FAIL rows for director review (Recommended)', 'Use two reserves; I will specify target IDs/details', 'Provide exact reserve mappings and designs now', ...FIXED]);
  run(p.root, f, 'answer', '--id', 'q1', '--choice', ANSWER_TEXT, '--text', text);
  run(p.root, f, 'start', '--once');
  assert.deepEqual(typed(f), [OPEN, MAIN, OPEN, text, ENTER]);
  assert.deepEqual(f.sends(), [{ to: 'term_1', text: `${FOLLOW}${text}` }]);
  assert.match(log(p.root), /the "Other" input was already showing, typed the answer \+ Enter/);

  // a numbered option from there: three ups, the marker verified on it, then Enter
  const q = fleet();
  const g = fakes();
  g.queue([start(screens(mk(true)))]);
  run(q.root, g, 'start', '--once');
  run(q.root, g, 'answer', '--id', 'q1', '--choice', 'Keep all Holidays FAIL rows for director review (Recommended)');
  run(q.root, g, 'start', '--once');
  assert.deepEqual(typed(g), [OPEN, MAIN, OPEN, UP, UP, UP, ENTER]);
  assert.deepEqual(g.sends(), []);

  // the screen does not move the marker up: refused before Enter, the panel put back to the main prompt
  const r = fleet();
  const h = fakes();
  h.queue([start(screens(mk(false)))]);
  run(r.root, h, 'start', '--once');
  run(r.root, h, 'answer', '--id', 'q1', '--choice', 'Keep all Holidays FAIL rows for director review (Recommended)');
  const out = run(r.root, h, 'start', '--once').out;
  assert.deepEqual(typed(h), [OPEN, MAIN, OPEN, UP, UP, UP, MAIN]);
  assert.match(out.find((o) => o.blocked).detail, /the marker is not on "Keep all Holidays FAIL rows for director review \(Recommended\)" after up, up, up; nothing was submitted/);
});

test('never submit when unsure: Enter that leaves the panel up is an error; a free-text submit that did not take is not typed again; an unreadable screen after Enter on "Other" gets no text', () => {
  // an option: Enter leaves the same panel on screen → error (the keys sent are in it), panel back to the main prompt
  const p = fleet();
  const f = fakes();
  f.queue([start(screens(realChoice(REAL.B, 3, { enter: { 1: 'm1', 2: 'm2', 3: 'm3' } })))]);
  run(p.root, f, 'start', '--once');
  run(p.root, f, 'answer', '--id', 'q1', '--choice', 'Approve all 5 layer-0 bricks');
  const out = run(p.root, f, 'start', '--once').out;
  assert.match(out.find((o) => o.blocked).detail, /the panel still shows the question after Enter \(sent down, Enter\); check the coordinator terminal/);
  assert.deepEqual(typed(f), [OPEN, MAIN, OPEN, DOWN, ENTER, MAIN]);

  // free text (real C): Enter keeps the panel → an error, and the text was typed exactly once
  const q = fleet();
  const g = fakes();
  const stuck = { closed: { lines: REAL.A, keys: { [OPEN]: 'c' } }, c: { lines: REAL.C, keys: { '*': 'c', [ENTER]: 'c', [MAIN]: 'closed' } } };
  g.queue([start(screens(stuck))]);
  run(q.root, g, 'start', '--once');
  run(q.root, g, 'answer', '--id', 'q1', '--choice', ANSWER_TEXT, '--text', 'A, but scale the step to 0.26x');
  const out2 = run(q.root, g, 'start', '--once').out;
  assert.match(out2.find((o) => o.blocked).detail, /the panel still shows the question after the answer and Enter .* nothing typed again/);
  assert.deepEqual(typed(g), [OPEN, MAIN, OPEN, 'A, but scale the step to 0.26x', ENTER, MAIN]);
  assert.deepEqual(g.sends(), []);
  // (and with the screen unreadable after Enter the same: it cannot be confirmed)
  const r = fleet();
  const h = fakes();
  h.queue([start(screens({ closed: { lines: REAL.A, keys: { [OPEN]: 'c' } }, c: { lines: REAL.C, keys: { '*': 'c', [ENTER]: 'blind', [MAIN]: 'closed' } }, blind: { source: 'screen-unavailable', lines: [] } }))]);
  run(r.root, h, 'start', '--once');
  run(r.root, h, 'answer', '--id', 'q1', '--choice', ANSWER_TEXT, '--text', 'C');
  assert.match(run(r.root, h, 'start', '--once').out.find((o) => o.blocked).detail, /cannot be read\); nothing typed again/);

  // "Other" chosen, then the screen cannot be read: no text typed into whatever has the keys; the plain message still goes
  const s = fleet();
  const k = fakes();
  const blind = realChoice(REAL.B, 3, { enter: { 3: 'blind' } });
  blind.blind = { source: 'screen-unavailable', lines: [] };
  k.queue([start(screens(blind))]);
  run(s.root, k, 'start', '--once');
  run(s.root, k, 'answer', '--id', 'q1', '--choice', ANSWER_TEXT, '--text', 'my own words');
  const held = run(s.root, k, 'start', '--once').out;
  assert.deepEqual(typed(k), [OPEN, MAIN, OPEN, DOWN, DOWN, ENTER]);
  // the screen cannot be read and a panel was the last thing seen (the "Other" input may be open): the plain
  // message is not sent into it; the director gets the usual send_failed question
  assert.deepEqual(k.sends(), []);
  assert.equal(held.find((o) => o.blocked).blocked, 'send_failed');
  // once the screen can be read again, "retry the send" delivers it
  k.screens({ term_1: { at: 'g', frames: { g: { lines: GONE } } } });
  run(s.root, k, 'answer', '--id', 'q2', '--choice', 'retry the send');
  run(s.root, k, 'start', '--once');
  assert.deepEqual(k.sends(), [{ to: 'term_1', text: `${FOLLOW}my own words` }]);
});

test('input hygiene: control bytes never become keys, a text starting with "-" is not a flag, a refused key is logged', () => {
  const p = fleet();
  const f = fakes();
  const Q = 'Which backend should the 30 FAIL rows use?';
  const frames = { closed: { lines: closed(), keys: { [OPEN]: 'f0' } }, f0: { lines: free(Q), keys: { '*': 'f1', [MAIN]: 'closed' } }, f1: { lines: free(Q), keys: { [ENTER]: 'gone', [MAIN]: 'closed' } }, gone: { lines: GONE } };
  f.queue([start(screens(frames))]);
  run(p.root, f, 'start', '--once');
  run(p.root, f, 'answer', '--id', 'q1', '--choice', ANSWER_TEXT, '--text', '-x a\x1b[B b\x07\ttab');
  run(p.root, f, 'start', '--once');
  const t = typed(f)[3];
  assert.equal(t, ' -x a[B b tab'); // no ESC / BEL, one line, and a leading space so the CLI cannot read a flag
  assert.ok(!/[\x00-\x08\x0b-\x1f\x7f]/.test(t));
  assert.equal(typed(f)[4], ENTER);

  // a key the terminal refuses: the error says so and the log keeps it
  const q = fleet();
  const g = fakes();
  g.queue([start(screens(choiceFrames(Q1, LABELS)))]);
  run(q.root, g, 'start', '--once');
  fs.writeFileSync(path.join(g.dir, 'keys-fail'), '1');
  run(q.root, g, 'answer', '--id', 'q1', '--choice', LABELS[1]);
  const out = run(q.root, g, 'start', '--once').out;
  assert.match(out.find((o) => o.blocked).detail, /keys refused/);
  assert.match(log(q.root), /coordinator panel q1: failed: .*keys refused/);
});

test('an acked panel: gone clears the ack (the same question later is asked again); 5 waits do not open and close the panel 5 times; an unreadable read changes nothing; held at most 12 waits', () => {
  const p = fleet();
  const f = fakes();
  f.queue([start(screens(choiceFrames(Q1, LABELS)))]);
  run(p.root, f, 'start', '--once');
  run(p.root, f, 'answer', '--id', 'q1', '--choice', ANSWER_DONE);
  const acked = () => (sliceState(p.root, 'S01').acked || []).filter((x) => x.startsWith('cq:'));

  // 1. a transient unreadable read is not "gone": the acks and the quiet marker stay, and it is said once
  const blind = { term_1: { at: 'u', frames: { u: { source: 'screen-unavailable', lines: [] } } } };
  f.queue([tick(2, 't2', { screens: blind }), tick(3, 't3', { screens: blind }), tick(4, 't4', { screens: screens(choiceFrames(Q1, LABELS)) })]);
  assert.equal(run(p.root, f, 'start', '--once').out.some((o) => o.blocked || o.waiting), false);
  assert.deepEqual([acked().length, sliceState(p.root, 'S01').cq_quiet], [1, 1]);
  assert.equal(log(p.root).match(/could not read the coordinator's screen/g).length, 1);
  assert.deepEqual(typed(f), [OPEN, MAIN]); // only the first look opened it: the marker stayed quiet

  // 2. the count changed (a second question queued behind it): one look, then quiet again for 5 waits
  const two = screens(choiceFrames(Q1, LABELS, { n: 2 }));
  f.queue([tick(5, 't5', { screens: two }), tick(6), tick(7), tick(8), tick(9)]);
  fs.rmSync(path.join(p.root, '.cursor', 'producer.control'), { force: true });
  assert.equal(run(p.root, f, 'start', '--once').out.some((o) => o.blocked || o.waiting), false);
  assert.deepEqual(typed(f), [OPEN, MAIN, OPEN, MAIN]);
  assert.equal(sliceState(p.root, 'S01').cq_quiet, 2);

  // 3. held 12 waits at most: then it is asked about again (the director may not have answered it after all)
  fs.writeFileSync(ev(p.root, 'S01', 'producer-state.json'), JSON.stringify({ ...sliceState(p.root, 'S01'), cq_held: 11 }));
  f.queue([tick(10), tick(11), tick(12)]);
  fs.rmSync(path.join(p.root, '.cursor', 'producer.control'), { force: true });
  const out = run(p.root, f, 'start', '--once').out;
  assert.deepEqual([out.at(-1).waiting, out.at(-1).kind], ['q2', 'coordinator_question']);
  assert.match(log(p.root), /still on screen after 12 waits: asking about it on the next wait/);
});

test('an acked panel that has gone: the same question shown again afterwards is asked again', () => {
  const p = fleet();
  const f = fakes();
  f.queue([start(screens(choiceFrames(Q1, LABELS)))]);
  run(p.root, f, 'start', '--once');
  run(p.root, f, 'answer', '--id', 'q1', '--choice', ANSWER_DONE);
  f.queue([
    tick(2, 't2', { screens: { term_1: { at: 'g', frames: { g: { lines: GONE } } } } }), // answered in the terminal
    tick(3, 't3', { screens: screens(choiceFrames(Q1, LABELS)) }), // the same text again
  ]);
  const b = run(p.root, f, 'start', '--once').out.at(-1);
  assert.deepEqual([b.waiting, b.kind], ['q2', 'coordinator_question']);
  assert.equal(runnerFile(p.root).questions[1].text, runnerFile(p.root).questions[0].text);
  assert.deepEqual((sliceState(p.root, 'S01').acked || []).filter((x) => x.startsWith('cq:')), []);
});

test('the panel is checked in the committing phase too', () => {
  const p = fleet();
  const f = fakes();
  const evidence = { [evRel('S01', 'review.md')]: 'F1\n\nAPPROVED\n', [evRel('S01', 'runtime-state.json')]: { status: 'verified' }, [evRel('S01', 'final-report.md')]: 'x', [evRel('S01', 'stats.json')]: {} };
  f.queue([
    start(null),
    { name: 'offer', write: { [H]: { role: 'coordinator', status: 'offer_commit' }, ...evidence } },
    // HANDOFF written again (still offer_commit) so orca-wait returns at once, with the panel on screen
    { name: 'asks while committing', screens: screens(realChoice(REAL.B, 3)), write: { [H]: { role: 'coordinator', status: 'offer_commit', detail: 'asked' } } },
  ]);
  const a = run(p.root, f, 'start', '--once').out.at(-1);
  assert.deepEqual([a.waiting, a.kind], ['q1', 'coordinator_question']);
  assert.equal(sliceState(p.root, 'S01').phase, 'committing');
  assert.equal(f.sends().length, 1); // the commit request went out first
  assert.match(f.sends()[0].text, /^approved — commit \(producer: Step 2d passed\)$/);
  assert.deepEqual(typed(f), [OPEN, MAIN]);
});

test('a panel is raised before lane_blocked and unknown_status, which follow once it is answered', () => {
  for (const [state, kind] of [[{ status: 'blocked', detail: 'which material?' }, 'lane_blocked'], [{ status: 'pondering', detail: 'x' }, 'unknown_status']]) {
    const p = fleet();
    const f = fakes();
    f.queue([{ ...start(screens(choiceFrames(Q1, LABELS))), write: { [H]: { role: 'coordinator', ...state } } }]);
    const a = run(p.root, f, 'start', '--once').out.at(-1);
    assert.deepEqual([a.waiting, a.kind], ['q1', 'coordinator_question']);
    run(p.root, f, 'answer', '--id', 'q1', '--choice', ANSWER_DONE);
    f.queue([{ name: 'again', result: 'idle' }]);
    const b = run(p.root, f, 'start', '--once').out.at(-1); // the panel is still on screen, held for the director — and the lane's own question comes
    assert.deepEqual([b.waiting, b.kind], ['q2', kind]);
  }
});

test('director_pending: a detail about a gate already decided is not a new wait; a new one after the relay is', () => {
  const gate = { id: 'g1', status: 'pending', question: 'Approve PLAN?', options: '["approve","revise"]' };
  const asked = (out) => out.some((o) => o.blocked || o.waiting);
  // (a) the detail names the relayed gate, the lane rewrites HANDOFF after the relay with the same words
  const D = 'Gate g1 opened: slice pending a director decision on PLAN.';
  const p = fleet();
  const f = fakes();
  f.queue([start(null, D), { name: 'gate opened', gates: [gate], write: working(D) }]);
  assert.equal(run(p.root, f, 'start', '--once').out.at(-1).kind, 'fleet_gate');
  run(p.root, f, 'answer', '--id', 'q1', '--choice', 'approve');
  f.set('gates.json', []);
  f.queue([tick(3, D), tick(4, D), tick(5, D), tick(6, D)]);
  fs.rmSync(path.join(p.root, '.cursor', 'producer.control'), { force: true });
  assert.equal(asked(run(p.root, f, 'start', '--once').out), false);

  // (b) no gate id in it, but HANDOFF was written before the relay and not since
  const D2 = 'Slice pending a director decision on PLAN.';
  const q = fleet();
  const g = fakes();
  g.queue([start(null, D2), { name: 'gate opened', gates: [gate] }]);
  assert.equal(run(q.root, g, 'start', '--once').out.at(-1).kind, 'fleet_gate');
  assert.equal(sliceState(q.root, 'S01').dp_fp, null); // a gate event resets the count (seen once before it)
  assert.equal(sliceState(q.root, 'S01').dp_seen, 0);
  run(q.root, g, 'answer', '--id', 'q1', '--choice', 'approve');
  g.set('gates.json', []);
  g.queue([{ name: 'w1' }, { name: 'w2' }, { name: 'w3' }, { name: 'w4' }]);
  fs.rmSync(path.join(q.root, '.cursor', 'producer.control'), { force: true });
  assert.equal(asked(run(q.root, g, 'start', '--once').out), false);

  // (c) the lane rewrites HANDOFF after the relay with a new wait that names no relayed gate: asked on the second look
  const D3 = 'Voxel fallback is pending a director decision on the backend.';
  g.queue([tick(7, D3), tick(8, D3)]);
  fs.rmSync(path.join(q.root, '.cursor', 'producer.control'), { force: true });
  const out = run(q.root, g, 'start', '--once').out;
  assert.deepEqual([out.at(-1).waiting, out.at(-1).kind], ['q2', 'director_pending']);
});

// ---------------------------------------------------------------------------------------------------
// Review round 2 of 6e97e92.

test('R1: the wait that releases a held panel only waits (no stall nudge into the panel); the next wait asks again', () => {
  const p = fleet();
  const f = fakes();
  f.queue([start(screens(choiceFrames(Q1, LABELS)))]);
  run(p.root, f, 'start', '--once');
  run(p.root, f, 'answer', '--id', 'q1', '--choice', ANSWER_DONE);
  f.queue([tick(2)]);
  run(p.root, f, 'start', '--once'); // applies the answer: the panel is held
  // held for 12 waits already: the next one releases it. An idle coordinator is what would be nudged.
  fs.writeFileSync(ev(p.root, 'S01', 'producer-state.json'), JSON.stringify({ ...sliceState(p.root, 'S01'), cq_held: 12 }));
  fs.rmSync(path.join(p.root, '.cursor', 'producer.control'), { force: true });
  f.queue([{ name: 'idle', result: 'idle' }, { name: 'idle', result: 'idle' }, { name: 'idle', result: 'idle' }]);
  const out = run(p.root, f, 'start', '--once').out;
  assert.deepEqual([out.at(-1).waiting, out.at(-1).kind], ['q2', 'coordinator_question']);
  assert.deepEqual(f.sends(), []); // no "resume the cocos-orca-fleet Coordinator loop" typed into the panel
  assert.equal(sliceState(p.root, 'S01').nudged_stall, undefined);
  assert.match(log(p.root), /still on screen after 12 waits: asking about it on the next wait/);
});

test('R1: an open panel is put back to the main prompt (shift+→, confirmed) before the runner sends a message; one that stays open blocks the send', () => {
  const gate = { id: 'g1', status: 'pending', question: 'Approve PLAN?', options: '["approve","revise"]' };
  const open = (stays) => ({ term_1: { at: 'open', frames: { open: { lines: moveMark(REAL.B, 1), keys: stays ? {} : { [MAIN]: 'closed' } }, closed: { lines: REAL.A, keys: {} } } } });
  const p = fleet();
  const f = fakes();
  f.queue([start(null), { name: 'gate opened', gates: [gate] }]);
  assert.equal(run(p.root, f, 'start', '--once').out.at(-1).kind, 'fleet_gate');
  f.screens(open(false)); // a panel is open on the coordinator when the decision is relayed
  run(p.root, f, 'answer', '--id', 'q1', '--choice', 'approve');
  run(p.root, f, 'start', '--once');
  // the panel was put away with a raw key first, then the message went with its Enter
  assert.deepEqual(f.keystream().map((k) => [k.text === MAIN ? 'main' : k.text, k.enter]), [['main', false], ['Director decision for gate g1: approve. Resolve your gate with it and continue.', true]]);
  assert.match(log(p.root), /closed an open question panel on term_1 \(shift\+→\) before sending gate:g1:q1/);
  assert.equal(frame(f), 'closed');

  // a panel that does not close: nothing is sent, the director is told the send failed
  const q = fleet();
  const g = fakes();
  g.queue([start(null), { name: 'gate opened', gates: [gate] }]);
  run(q.root, g, 'start', '--once');
  g.screens(open(true));
  run(q.root, g, 'answer', '--id', 'q1', '--choice', 'approve');
  const out = run(q.root, g, 'start', '--once').out;
  assert.deepEqual(g.sends(), []);
  assert.deepEqual(g.keys().map((k) => k.text), [MAIN]);
  assert.equal(out.find((o) => o.blocked).blocked, 'send_failed');
  assert.match(runnerFile(q.root).questions[1].text, /a question panel is still open on term_1 after shift\+→; the message would be typed into it, nothing sent/);

  // no panel (or an unreadable screen): the message goes as before, with no key
  const r = fleet();
  const h = fakes();
  h.queue([start(null), { name: 'gate opened', gates: [gate] }]);
  run(r.root, h, 'start', '--once');
  run(r.root, h, 'answer', '--id', 'q1', '--choice', 'approve');
  run(r.root, h, 'start', '--once');
  assert.deepEqual([h.sends().length, h.keys()], [1, []]);
});

test('R4: a coordinator panel held for the director does not mask a blocked commit; the panel is raised first', () => {
  const p = fleet();
  const f = fakes();
  const evidence = { [evRel('S01', 'review.md')]: 'F1\n\nAPPROVED\n', [evRel('S01', 'runtime-state.json')]: { status: 'verified' }, [evRel('S01', 'final-report.md')]: 'x', [evRel('S01', 'stats.json')]: {} };
  f.queue([
    start(null),
    { name: 'offer', write: { [H]: { role: 'coordinator', status: 'offer_commit' }, ...evidence } },
    { name: 'asks while committing', screens: screens(realChoice(REAL.B, 3)), write: { [H]: { role: 'coordinator', status: 'offer_commit', detail: 'asked' } } },
  ]);
  assert.equal(run(p.root, f, 'start', '--once').out.at(-1).kind, 'coordinator_question');
  run(p.root, f, 'answer', '--id', 'q1', '--choice', ANSWER_DONE); // the director has the panel in the terminal
  // the commit hook fails and the coordinator says so: asked at once, not after the hold runs out
  f.queue([{ name: 'blocked', write: { [H]: { role: 'coordinator', status: 'blocked', detail: 'commit-guard refused: dirty tree' } } }]);
  const b = run(p.root, f, 'start', '--once').out.at(-1);
  assert.deepEqual([b.waiting, b.kind], ['q2', 'lane_blocked']);
  assert.match(runnerFile(p.root).questions[1].text, /commit blocked: commit-guard refused: dirty tree/);
  assert.deepEqual(typed(f), [OPEN, MAIN]); // the held panel was not opened again
});

// ---------------------------------------------------------------------------------------------------
// Review round 3 of c36a5d0: an unreadable screen after a panel was seen.

const BLIND = { term_1: { at: 'u', frames: { u: { source: 'screen-unavailable', lines: [] } } } };
const GATE1 = { id: 'g1', status: 'pending', question: 'Approve PLAN?', options: '["approve","revise"]' };

test('U1: the screen goes unreadable with a panel last seen: the lane is only waited on (no stall nudge); with no panel last seen it is nudged as before', () => {
  const p = fleet();
  const f = fakes();
  f.queue([start(screens(choiceFrames(Q1, LABELS)))]);
  run(p.root, f, 'start', '--once');
  run(p.root, f, 'answer', '--id', 'q1', '--choice', ANSWER_DONE); // the director has the panel in the terminal
  f.queue([tick(2)]);
  run(p.root, f, 'start', '--once');
  assert.equal(sliceState(p.root, 'S01').cq_panel_seen, true);
  // the screen cannot be read and the coordinator is idle: this is the stall nudge, which would be typed into the panel
  f.queue([{ name: 'idle 1', result: 'idle', screens: BLIND }, { name: 'idle 2', result: 'idle' }]);
  fs.rmSync(path.join(p.root, '.cursor', 'producer.control'), { force: true });
  const out = run(p.root, f, 'start', '--once').out;
  assert.deepEqual(f.sends(), []);
  assert.equal(sliceState(p.root, 'S01').nudged_stall, undefined);
  assert.equal(out.find((o) => o.blocked).blocked, 'coordinator_screen'); // the third unreadable wait asks the director once
  assert.deepEqual(typed(f), [OPEN, MAIN]);
  // the director checked the terminal: the hold ends, and a still-blind idle lane is nudged again
  const cs = runnerFile(p.root).questions.find((x) => x.kind === 'coordinator_screen');
  run(p.root, f, 'answer', '--id', cs.id, '--choice', 'checked the coordinator terminal, continue');
  f.queue([{ name: 'idle 3', result: 'idle', screens: BLIND }, { name: 'idle 4', result: 'idle' }]);
  fs.rmSync(path.join(p.root, '.cursor', 'producer.control'), { force: true });
  run(p.root, f, 'start', '--once'); // the runner applies the answer, then waits on the still-blind lane
  assert.equal(sliceState(p.root, 'S01').cq_panel_seen, false);
  assert.match(f.sends().at(-1)?.text || '', /^resume the cocos-orca-fleet Coordinator loop/);

  // no panel last seen (a read that showed none): an unreadable screen changes nothing, the idle lane is nudged
  const q = fleet();
  const g = fakes();
  g.queue([start({ term_1: { at: 'g', frames: { g: { lines: GONE } } } }), { name: 'idle', result: 'idle', screens: BLIND }]);
  run(q.root, g, 'start', '--once');
  assert.equal(Boolean(sliceState(q.root, 'S01').cq_panel_seen), false);
  assert.match(g.sends()[0].text, /^resume the cocos-orca-fleet Coordinator loop/);
});

test('U1: a gate decision is not sent while the screen is unreadable and a panel was last seen; "retry the send" delivers it once it can be read', () => {
  const p = fleet();
  const f = fakes();
  f.queue([start(screens(choiceFrames(Q1, LABELS)))]);
  run(p.root, f, 'start', '--once');
  run(p.root, f, 'answer', '--id', 'q1', '--choice', ANSWER_DONE);
  f.queue([{ name: 'gate opened', gates: [GATE1], screens: BLIND }]);
  assert.equal(run(p.root, f, 'start', '--once').out.at(-1).kind, 'fleet_gate');
  run(p.root, f, 'answer', '--id', 'q2', '--choice', 'approve');
  const out = run(p.root, f, 'start', '--once').out;
  assert.equal(out.find((o) => o.blocked).blocked, 'send_failed');
  assert.deepEqual(f.sends(), []); // nothing typed into a panel that may be open
  assert.match(runnerFile(p.root).questions[2].text, /cannot be read and a question panel was the last thing seen there/);

  f.screens({ term_1: { at: 'g', frames: { g: { lines: GONE } } } });
  run(p.root, f, 'answer', '--id', 'q3', '--choice', 'retry the send');
  run(p.root, f, 'start', '--once');
  assert.deepEqual(f.sends(), [{ to: 'term_1', text: 'Director decision for gate g1: approve. Resolve your gate with it and continue.' }]);
  assert.equal(sliceState(p.root, 'S01').cq_panel_seen, false);
});

test('U1: after a confirmed keys answer (no panel left), an unreadable screen lets messages through; cq_last is cleared', () => {
  const p = fleet();
  const f = fakes();
  f.queue([start(screens(realChoice(REAL.B, 3)))]);
  run(p.root, f, 'start', '--once');
  assert.deepEqual(sliceState(p.root, 'S01').cq_last, { fp: `p:${fingerprint(parseScreen(REAL.B).question)}`, count: 1 });
  run(p.root, f, 'answer', '--id', 'q1', '--choice', 'Approve all 5 layer-0 bricks');
  f.queue([{ name: 'gate opened', gates: [GATE1], screens: BLIND }]); // the screen goes unreadable after the answer
  assert.equal(run(p.root, f, 'start', '--once').out.at(-1).kind, 'fleet_gate');
  const s = sliceState(p.root, 'S01');
  assert.deepEqual([s.cq_panel_seen, s.cq_last], [false, null]);
  run(p.root, f, 'answer', '--id', 'q2', '--choice', 'approve');
  const out = run(p.root, f, 'start', '--once').out;
  assert.equal(out.some((o) => o.blocked === 'send_failed'), false);
  assert.deepEqual(f.sends(), [{ to: 'term_1', text: 'Director decision for gate g1: approve. Resolve your gate with it and continue.' }]);
  assert.deepEqual(typed(f), [OPEN, MAIN, OPEN, DOWN, ENTER]); // no key into the unreadable screen

  // the next of several questions is a panel still pending: the flag stays set (and cq_last is the old one, cleared)
  const q = fleet();
  const g = fakes();
  const frames = {
    closed: { lines: countOf(2), keys: { [OPEN]: 'd1' } },
    d1: { lines: moveMark(REAL.D, 1), keys: { [ENTER]: 'e1', [MAIN]: 'closed' } },
    e1: { lines: moveMark(REAL.E, 1), keys: { [MAIN]: 'closedE' } },
    closedE: { lines: countOf(1), keys: { [OPEN]: 'e1' } },
  };
  g.queue([start(screens(frames))]);
  run(q.root, g, 'start', '--once');
  run(q.root, g, 'answer', '--id', 'q1', '--choice', parseScreen(REAL.D).options[0].label);
  g.queue([{ name: 'blind', screens: BLIND, write: working('x') }]);
  run(q.root, g, 'start', '--once');
  assert.equal(sliceState(q.root, 'S01').cq_panel_seen, true);
});
