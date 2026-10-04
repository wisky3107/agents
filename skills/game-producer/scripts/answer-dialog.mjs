#!/usr/bin/env node
/**
 * answer-dialog.mjs — the director answers a runner question from a macOS dialog (plan M6). The runner
 * spawns it detached, once per question: `choose from list` with the options, then a note dialog when
 * the choice takes one (a gate's note goes to the coordinator with the decision). The answer goes
 * through lib/answer.mjs like the CLI. Answered another way meanwhile → the dialog is closed and
 * nothing is written. "Later" closes it; the terminal and `answer` still work.
 *
 *   answer-dialog.mjs --project <path> --id <qN>
 *
 * PRODUCER_RUNNER_OSASCRIPT replaces osascript (tests); it gets the same `-e` lines and arguments.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import * as st from './lib/state.mjs';
import { submit, textNeed } from './lib/answer.mjs';
import { questionContext } from './lib/context.mjs';

const OSA = process.env.PRODUCER_RUNNER_OSASCRIPT || 'osascript';
const CANCEL = '<<later>>';
// arguments go in as `argv` of the run handler: no quoting of question text into AppleScript source
const CHOOSE = [
  'on run argv',
  'set opts to items 3 thru -1 of argv',
  'set r to choose from list opts with title (item 1 of argv) with prompt (item 2 of argv) OK button name "Answer" cancel button name "Later"',
  `if r is false then return "${CANCEL}"`,
  'return item 1 of r',
  'end run',
];
const NOTE = [
  'on run argv',
  'set r to display dialog (item 2 of argv) with title (item 1 of argv) default answer "" buttons {(item 3 of argv), "Send"} default button "Send" cancel button (item 3 of argv)',
  'return text returned of r',
  'end run',
];

const argv = process.argv.slice(2);
const get = (k) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : undefined);
const root = get('--project') && fs.realpathSync(get('--project'));
const id = get('--id');
if (!root || !id) {
  process.stderr.write('usage: answer-dialog.mjs --project <path> --id <qN>\n');
  process.exit(2);
}
const question = () => st.readRunner(root).questions.find((x) => x.id === id) || null;
const open = () => {
  const q = question();
  return Boolean(q && !q.answer);
};

// the director stopped or paused the runner: no dialog left on screen (the question stays answerable);
// `stop-after Sxx` is not a halt — the runner keeps waiting on this question
const halted = () => ['stop', 'pause'].includes(st.readControl(root)?.cmd);
let current = null;
process.on('SIGTERM', () => {
  current?.kill();
  process.exit(0);
});

/** One osascript run; killed as soon as the question is answered another way or the runner halts. → { code, out } */
function osa(lines, args) {
  return new Promise((resolve) => {
    const child = spawn(OSA, [...lines.flatMap((l) => ['-e', l]), ...args], { stdio: ['ignore', 'pipe', 'ignore'] });
    current = child;
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    const timer = setInterval(() => {
      if (!open() || halted()) child.kill();
    }, 1000);
    const done = (code) => {
      clearInterval(timer);
      resolve({ code, out: out.replace(/\r?\n$/, '') });
    };
    child.on('close', done);
    child.on('error', () => done(-1));
  });
}

const q = question();
if (!q || q.answer) process.exit(0);
const title = `producer-runner · ${path.basename(root)}`;
// where the run stands first, then the whole question, then why the judge left it to the director
const PROMPT_CHARS = 3000;
const body = String(q.text || '').trim();
const why = q.judge?.defer ? `\n\n${String(q.judge.defer).trim()}` : '';
const prompt = `${questionContext(root, q).join('\n')}\n\n${q.id} · ${q.kind}${q.slice ? ` · ${q.slice}` : ''}\n${
  body.length > PROMPT_CHARS ? `${body.slice(0, PROMPT_CHARS)}… (the rest: \`producer-runner.mjs answer\` or the runner terminal)` : body}${why}`;
const picked = await osa(CHOOSE, [title, prompt, ...q.options]);
// "Later": a restarted runner does not open this question's dialog again
if (picked.code === 0 && picked.out === CANCEL && open()) st.setQuestion(root, id, { dialog_done: 'later' });
if (picked.code !== 0 || picked.out === CANCEL || !q.options.includes(picked.out) || !open()) process.exit(0);
const choice = picked.out;
let text = '';
const need = textNeed(q, choice);
if (need) {
  const where = q.kind === 'director_gate' ? 'written on the policy line' : 'sent with the decision';
  const note = await osa(NOTE, [title, need === 'required' ? `Note for "${choice}" (required, ${where} word for word):` : `Note for "${choice}" (optional, ${where} word for word; leave empty for none):`, need === 'required' ? 'Cancel' : 'Skip']);
  if (note.code === 0) text = note.out.trim();
  else if (need === 'required') process.exit(0); // cancelled: no answer
}
if (!open()) process.exit(0);
try {
  submit(root, id, choice, text, 'dialog');
} catch (err) {
  // answered at the same moment another way, or a note the choice cannot take: the runner keeps waiting
  process.stderr.write(`${err.message}\n`);
}
