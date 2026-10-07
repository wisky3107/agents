#!/usr/bin/env node
/**
 * answer-dialog.mjs — the director answers a runner question from a macOS dialog (plan M6). The runner
 * spawns it detached, once per question: `choose from list` with the options, then a note dialog when
 * the choice takes one (a gate's note goes to the coordinator with the decision). The answer goes
 * through lib/answer.mjs like the CLI. Answered another way meanwhile → the dialog is closed and
 * nothing is written. "Later" closes it; the terminal and `answer` still work.
 *
 * AGENT_NOTES `release.question_lang: vi`, the default when the key is missing (`""` = English;
 * lib/translate.mjs): the question, the judge's reason and
 * every option are shown translated, each option in full in the prompt and as a short numbered row in
 * the list (list rows cut long text); the pick maps back to the exact English option. The last row
 * opens the whole question (translation and English) in a text editor, then the list comes back.
 *
 *   answer-dialog.mjs --project <path> --id <qN>
 *
 * PRODUCER_RUNNER_OSASCRIPT replaces osascript (tests); it gets the same `-e` lines and arguments.
 * PRODUCER_RUNNER_OPEN replaces `open -e` for the whole-question file (tests).
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import * as st from './lib/state.mjs';
import { submit, textNeed } from './lib/answer.mjs';
import { questionContext } from './lib/context.mjs';
import { loadProject } from './lib/project.mjs';
import { translated, questionKey } from './lib/translate.mjs';

const OSA = process.env.PRODUCER_RUNNER_OSASCRIPT || 'osascript';
const CANCEL = '<<later>>';
// the prompt label never scrolls: past this the dialog would outgrow a laptop screen
const PROMPT_CHARS = 1800;
// a translated prompt carries every option in full as well
const PROMPT_CHARS_LANG = 2600;
const LABEL_CHARS = 70;
// each option's share when the full options would push the prompt past PROMPT_CHARS_LANG
const OPTION_CHARS = 300;
// arguments go in as `argv` of the run handler: no quoting of question text into AppleScript source
const CHOOSE = [
  'on run argv',
  // the list comes back after the whole question opened in TextEdit: bring it to the front
  'activate',
  'set opts to items 5 thru -1 of argv',
  'set r to choose from list opts with title (item 1 of argv) with prompt (item 2 of argv) OK button name (item 3 of argv) cancel button name (item 4 of argv)',
  `if r is false then return "${CANCEL}"`,
  'return item 1 of r',
  'end run',
];
const NOTE = [
  'on run argv',
  'set r to display dialog (item 2 of argv) with title (item 1 of argv) default answer "" buttons {(item 3 of argv), (item 4 of argv)} default button (item 4 of argv) cancel button (item 3 of argv)',
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

let q = question();
if (!q || q.answer) process.exit(0);
const title = `producer-runner · ${path.basename(root)}`;
const context = questionContext(root, q);
let project = null;
try {
  project = loadProject(root);
} catch {
  /* no project: English */
}
let tr = project ? await translated(root, project, q, context, () => !open() || halted()) : null;
// the translation can take a while: answered, halted or rewritten meanwhile → start from the file again
if (!open() || halted()) process.exit(0);
q = question();
// rewritten during the translation: its rows would map to the wrong options
if (tr && tr.key !== questionKey(tr.lang, q)) tr = null;
const head = `${context.join('\n')}\n\n${q.id} · ${q.kind}${q.slice ? ` · ${q.slice}` : ''}\n`;
const body = String(q.text || '').trim();
const whyEn = q.judge?.defer ? String(q.judge.defer).trim() : '';
/** Cut to n characters (code points, never half an emoji), with "…" when cut. */
function cut(text, n) {
  const chars = Array.from(text);
  return chars.length > n ? `${chars.slice(0, n - 1).join('')}…` : text;
}
const FULL = tr ? 'Xem toàn văn (tiếng Việt + tiếng Anh)' : 'Show the whole question';
const ui = tr
  ? { ok: 'Trả lời', later: 'Để sau', send: 'Gửi', cancel: 'Huỷ', skip: 'Bỏ qua' }
  : { ok: 'Answer', later: 'Later', send: 'Send', cancel: 'Cancel', skip: 'Skip' };
let prompt;
let rows;
if (tr) {
  // numbers, not letters: options often start with their own "A:", "B:"
  rows = tr.labels.map((l, i) => cut(`${i + 1}. ${l}`, LABEL_CHARS));
  const full = tr.options.map((o, i) => `${i + 1}. ${o}`);
  const long = full.join('\n').length > PROMPT_CHARS_LANG - 1000;
  const opts = `\n\nCác lựa chọn:\n${(long ? full.map((o) => cut(o, OPTION_CHARS)) : full).join('\n')}`;
  const why = tr.why ? `\n\nVì sao judge để bạn quyết: ${tr.why}` : '';
  const room = PROMPT_CHARS_LANG - head.length - why.length - opts.length;
  const summary = tr.summary.length > room ? `${tr.summary.slice(0, Math.max(200, room))}… (xem toàn văn ở dòng cuối danh sách)` : tr.summary;
  prompt = `${head}${summary}${why}${opts}`;
} else {
  rows = [...q.options];
  // where the run stands first, then the whole question, then why the judge left it to the director
  const shown = body.length > PROMPT_CHARS ? `${body.slice(0, PROMPT_CHARS)}… (the whole question: the last row, the runner terminal, or \`answer\` in a terminal)` : body;
  prompt = `${head}${shown}${whyEn ? `\n\n${whyEn}` : ''}`;
}

/** The whole question in a text file, opened in a text editor (`open -e`). */
function showWhole() {
  const lines = [title, '', head.trim(), ''];
  if (tr) {
    lines.push(tr.summary, '');
    if (tr.why) lines.push(`Vì sao judge để bạn quyết: ${tr.why}`, '');
    lines.push('Các lựa chọn:', ...tr.options.map((o, i) => `${i + 1}. ${o}`), '', '---- English (nguyên văn) ----', '');
  }
  lines.push(body, '');
  if (whyEn) lines.push(whyEn, '');
  lines.push('Options:', ...q.options.map((o, i) => `${i + 1}. ${o}`), '');
  // .cursor/producer* is already kept out of git (state.mjs ensureExcluded)
  const file = path.join(root, '.cursor', 'producer-questions', `${id}.txt`);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, lines.join('\n'));
    const opener = process.env.PRODUCER_RUNNER_OPEN;
    spawnSync(opener || 'open', opener ? [file] : ['-e', file], { stdio: 'ignore', timeout: 10000 });
  } catch {
    /* best effort: the terminal and `answer` still show the question */
  }
}

let picked;
for (;;) {
  picked = await osa(CHOOSE, [title, prompt, ui.ok, ui.later, ...rows, FULL]);
  if (picked.code !== 0 || picked.out !== FULL || !open()) break;
  showWhole();
}
// "Later": a restarted runner does not open this question's dialog again
if (picked.code === 0 && picked.out === CANCEL && open()) st.setQuestion(root, id, { dialog_done: 'later' });
const at = rows.indexOf(picked.out);
if (picked.code === 0 && picked.out !== CANCEL && at < 0) process.stderr.write(`answer-dialog: the pick "${picked.out}" matches no row; nothing recorded\n`);
if (picked.code !== 0 || picked.out === CANCEL || at < 0 || !open()) process.exit(0);
const choice = q.options[at];
let text = '';
const need = textNeed(q, choice);
if (need) {
  const label = tr ? rows[at] : choice;
  const ask = tr
    ? `Ghi chú cho "${label}" (${need === 'required' ? 'bắt buộc' : 'không bắt buộc, để trống nếu không có'}; ${q.kind === 'director_gate' ? 'ghi nguyên văn lên policy line' : 'gửi nguyên văn kèm quyết định'}):`
    : `Note for "${label}" (${need === 'required' ? 'required' : 'optional'}, ${q.kind === 'director_gate' ? 'written on the policy line' : 'sent with the decision'} word for word${need === 'required' ? '' : '; leave empty for none'}):`;
  const note = await osa(NOTE, [title, ask, need === 'required' ? ui.cancel : ui.skip, ui.send]);
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
