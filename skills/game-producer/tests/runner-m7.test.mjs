import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseScreen, fingerprint, ANSWER_TEXT, ANSWER_DONE } from '../scripts/lib/coordq.mjs';
import { waitsOnDirector } from '../scripts/lib/lanes.mjs';
import { menu, textNeed, answerProblem } from '../scripts/lib/answer.mjs';
import { project, fakes, env, runner, evRel, ev } from './harness.mjs';

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
const tick = (n, detail = `tick ${n}`) => ({ name: `tick ${n}`, write: working(detail) });
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
  assert.match(log(q.root), /the panel moved on, no typing/);

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

test('a screen read that is only the stream, or fails, asks nothing', () => {
  const p = fleet();
  const f = fakes();
  f.queue([start({ term_1: { at: 'closed', source: 'screen-unavailable', frames: { closed: { lines: closed(), keys: { [OPEN]: 'closed' } } } } }), tick(2)]);
  const out = run(p.root, f, 'start', '--once').out;
  assert.equal(out.some((o) => o.blocked || o.waiting), false);
  assert.deepEqual(typed(f), []); // the accumulated stream still shows closed panels: never keys into it
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
  assert.deepEqual(f.reads().length > 0, true); // the screen is read on every wait; nothing was on it
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
  assert.deepEqual(runs[0].args.slice(2), cq.options);
  assert.match(runs[1].args[1], /^Note for "answer with --text" \(required, sent with the decision word for word\):$/);
  const a = runnerFile(p.root).questions[0].answer;
  assert.deepEqual([a.choice, a.text, a.via], [ANSWER_TEXT, 'pixel for all of them', 'dialog']);

  fs.writeFileSync(path.join(f.dir, 'osa-choice'), 'send this answer to the lane');
  assert.equal(dialog('q2').status, 0);
  assert.ok(fs.readFileSync(path.join(f.dir, 'osa.log'), 'utf8').includes(PENDING.slice(0, 60)));
  assert.deepEqual([runnerFile(p.root).questions[1].answer.choice, runnerFile(p.root).questions[1].answer.text], ['send this answer to the lane', 'pixel for all of them']);
});
