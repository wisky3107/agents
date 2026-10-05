/**
 * A coordinator that asks the director through codex's own question tool (request_user_input) instead of
 * an Orca gate: the runner never sees that question, and the lane can wait on it for an hour
 * ("Waiting for user input", 2026-10-04/05). The runner reads the coordinator's rendered screen after
 * each lane wait, relays what it finds to the director as one `coordinator_question`, and types the
 * director's answer into the panel. Every outside call goes through lib/orca.mjs (readScreen, sendKeys).
 *
 * What the codex TUI shows (checked on two real slices):
 *   closed   "Queued follow-up inputs / ? 1 question / shift+← to answer"   (shift+← opens the panel)
 *   choice   question text, numbered options with a `›` marker on the picked one (the last is "Other"),
 *            footer "enter submit   ctrl+] skip   shift+→ main prompt"; two questions add "1 of 2"
 *            and "shift+← next question"
 *   free     question text, "Type your answer", the same footer
 * Keys: shift+← `ESC[1;2D` opens, down `ESC[B` moves the marker, Enter `\r` submits, shift+→ `ESC[1;2C`
 * goes back to the main prompt. Typing into "Other" did not render the typed text, so a free answer on
 * a choice panel is also sent as a plain follow-up message (lanes.mjs does that).
 *
 * Never guess: an option is pressed only after the marker is verified on it, a panel that is not the
 * one the director saw is left alone, a screen that cannot be parsed is asked about with its raw tail.
 */
import crypto from 'node:crypto';
import * as io from './orca.mjs';

export const KEYS = { open: '\x1b[1;2D', down: '\x1b[B', up: '\x1b[A', enter: '\r', main: '\x1b[1;2C' };
export const ANSWER_TEXT = 'answer with --text';
export const ANSWER_DONE = 'answered in the coordinator terminal, continue';
export const FIXED_OPTIONS = [ANSWER_TEXT, ANSWER_DONE, 'stop'];
export const FOLLOW_UP = "Director's answer to your question";

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07/g;
const clean = (l) => String(l).replace(ANSI, '').replace(/[\x00-\x1f\x7f]/g, '').replace(/\s+$/, '');
const oneLine = (t) => String(t || '').replace(/\s+/g, ' ').trim();
const OPTION = /^\s*([›❯>])?\s*(\d{1,2})[.)]\s+(\S.*)$/;
// the footer row only: a transcript line that mentions "enter submit" is not one
const FOOTER = /^\s*enter submit\b.*\bctrl\+\]\s*skip\b/i;
const INPUT_ROW = /^\s*[›❯>](?:\s.*)?$/; // the bare input row of an "Other" that is already selected
const POSITION = /^\s*(?:question\s+)?(\d+)\s*(?:of|\/)\s*(\d+)\s*$/i;
const ANCHOR = /queued follow-up|shift\+←|^\s*[─━═╭╰│┌└┐┘-]{3,}\s*$/i;
export const isOther = (label) => /^other\b/i.test(label);
export const fingerprint = (text) => crypto.createHash('sha1').update(oneLine(text).toLowerCase()).digest('hex').slice(0, 12);

const keyPause = () => {
  const ms = process.env.PRODUCER_RUNNER_KEY_MS === undefined ? 250 : Number(process.env.PRODUCER_RUNNER_KEY_MS) || 0;
  if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

/** The question text above `row`: the paragraph directly above it (a wrapped question is several rows). */
function questionAbove(lines, row) {
  const got = [];
  for (let i = row - 1; i >= 0 && got.length < 20; i--) {
    const l = lines[i];
    if (!l.trim()) {
      if (got.length) break;
      continue;
    }
    // "1 of 2" between the question and its options is skipped; above the question it ends it
    if (POSITION.test(l)) {
      if (got.length) break;
      continue;
    }
    if (ANCHOR.test(l)) break;
    got.unshift(l.trim().replace(/^[?•›❯]\s+/, ''));
  }
  return oneLine(got.join(' '));
}

function position(lines, from, footerRow) {
  for (let i = Math.max(0, from - 4); i < footerRow; i++) {
    const m = lines[i].match(POSITION);
    if (m) return { index: Number(m[1]), total: Number(m[2]) };
  }
  const m = lines[footerRow].match(/\b(\d+) of (\d+)\b/);
  return m ? { index: Number(m[1]), total: Number(m[2]) } : { index: null, total: null };
}

/** An open panel above the footer row `f`. → { ok: true, kind, question, options, marked, index, total } | { ok: false, error } */
function parseOpen(lines, f) {
  let typeAt = -1;
  for (let i = f - 1; i >= Math.max(0, f - 4); i--) {
    if (/type your answer/i.test(lines[i])) {
      typeAt = i;
      break;
    }
  }
  if (typeAt >= 0) {
    const question = questionAbove(lines, typeAt);
    if (!question) return { ok: false, error: 'no question text above "Type your answer"' };
    return { ok: true, kind: 'free', question, options: [], marked: null, ...position(lines, typeAt, f) };
  }
  let j = f - 1;
  while (j >= 0 && f - j <= 14 && !OPTION.test(lines[j])) j--;
  if (j < 0 || f - j > 14) return { ok: false, error: 'no numbered options and no "Type your answer" above "enter submit"' };
  const rows = [];
  let expect = Number(lines[j].match(OPTION)[2]);
  let gap = 0;
  for (let k = j; k >= 0; k--) {
    const m = lines[k].match(OPTION);
    if (m && Number(m[2]) === expect) {
      rows.unshift({ row: k, marker: Boolean(m[1]), label: m[3].trim() });
      gap = 0;
      if (expect === 1) break;
      expect--;
    } else if (++gap > 6) return { ok: false, error: 'the numbered options are not consecutive' };
  }
  if (!rows.length || expect !== 1) return { ok: false, error: 'the numbered options do not start at 1' };
  const labels = rows.map((o) => o.label);
  if (new Set(labels).size !== labels.length) return { ok: false, error: 'two options have the same label' };
  // a bare `›` row (or one with typed text) after the last numbered option is the input row of an "Other"
  // that is already selected (2026-10-05 capture): a synthetic last option, marked, in input mode
  let inputRow = -1;
  for (let k = rows[rows.length - 1].row + 1; k < f; k++) {
    if (INPUT_ROW.test(lines[k]) && !OPTION.test(lines[k])) {
      inputRow = k;
      break;
    }
  }
  const options = rows.map((o, i) => {
    const end = i + 1 < rows.length ? rows[i + 1].row : inputRow >= 0 ? inputRow : f;
    const desc = oneLine(lines.slice(o.row + 1, end).join(' '));
    return { label: o.label, ...(desc ? { desc } : {}) };
  });
  const question = questionAbove(lines, rows[0].row);
  if (!question) return { ok: false, error: 'no question text above the options' };
  const marks = rows.map((o, i) => (o.marker ? i : -1)).filter((i) => i >= 0);
  let marked = marks.length === 1 ? marks[0] : null;
  let otherInput = false;
  if (inputRow >= 0 && !marks.length && !options.some((o) => isOther(o.label))) {
    options.push({ label: 'Other' });
    marked = options.length - 1;
    otherInput = true;
  }
  return { ok: true, kind: 'choice', question, options, marked, otherInput, ...position(lines, rows[0].row, f) };
}

/**
 * The screen as the runner reads it. → { state: 'none' }
 *   | { state: 'closed', count, row }          the "? N question … to answer" marker, panel not open
 *   | { state: 'open', footer, ok, … }         a panel is open (parseOpen's fields; ok false = unreadable)
 */
export function parseScreen(raw) {
  const lines = raw.map(clean);
  let f = -1;
  lines.forEach((l, i) => {
    if (FOOTER.test(l)) f = i;
  });
  if (f >= 0) return { state: 'open', footer: f, lines, ...parseOpen(lines, f) };
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/\?\s*(\d+)\s+questions?\b/i);
    if (m && /to answer/i.test(lines.slice(i, i + 3).join(' '))) return { state: 'closed', count: Number(m[1]), row: i, lines };
  }
  return { state: 'none' };
}

const tailOf = (lines) => lines.filter((l) => l.trim()).slice(-25).join('\n');
// a fingerprint of the rows around an unreadable panel, digits dropped (timers and counters repaint)
const rawFp = (lines, row) => `r:${fingerprint(lines.slice(Math.max(0, row - 10), row + 1).join(' ').replace(/\d+/g, '#'))}`;

function raw(lines, row, why, count = null) {
  const clear = lines.map(clean);
  return { state: 'raw', fp: rawFp(clear, row), tail: tailOf(clear), why, count };
}

function pressMain(handle) {
  try {
    io.sendKeys(handle, KEYS.main);
  } catch {
    /* the panel stays open: the next read shows it */
  }
}

/**
 * Look at the coordinator's screen; open a closed panel to read it (shift+←) and close it again unless
 * `keepOpen` (a panel left open would swallow the runner's next plain message). A closed marker with
 * `quietCount` questions is one the director already dealt with: it is not opened again (shift+← / shift+→
 * on every wait would pull a director who is answering in that terminal out of the panel).
 * → { state: 'unknown' } (the screen could not be read: no state may change on it) | { state: 'none' } (read,
 *   no panel) | { state: 'quiet' } | { state: 'panel', panel, fp, count } | { state: 'raw', fp, tail, why, count }
 */
export function readPanel(handle, { keepOpen = false, quietCount = null } = {}) {
  let scr = io.readScreen(handle);
  if (!scr) return { state: 'unknown' };
  let p = parseScreen(scr.lines);
  if (p.state === 'none') return { state: 'none' };
  const first = p;
  if (p.state === 'closed' && quietCount !== null && p.count === quietCount) return { state: 'quiet' };
  let opened = false;
  if (p.state === 'closed') {
    try {
      io.sendKeys(handle, KEYS.open);
    } catch (err) {
      return raw(first.lines, first.row, `the panel could not be opened: ${err.message}`, first.count);
    }
    opened = true;
    keyPause();
    scr = io.readScreen(handle);
    if (!scr) {
      pressMain(handle); // the panel may be open and unreadable: back to the main prompt
      return { state: 'unknown' };
    }
    p = parseScreen(scr.lines);
    if (p.state !== 'open') return raw(first.lines, first.row, 'the panel did not open after shift+←', first.count);
  }
  const count = first.state === 'closed' ? first.count : null;
  const out = p.ok ? { state: 'panel', panel: p, fp: `p:${fingerprint(p.question)}`, count } : raw(p.lines, p.footer, p.error, count);
  if (opened && !keepOpen) pressMain(handle);
  return out;
}

/** The question for the director. → { detail, options, ref, obs } */
export function describe(r) {
  if (r.state === 'panel') {
    const p = r.panel;
    const pos = p.total > 1 ? `, question ${p.index || '?'} of ${p.total}` : '';
    const notes = p.options.filter((o) => o.desc).map((o) => `\n  ${o.label}: ${o.desc}`).join('');
    const options = p.kind === 'choice' ? p.options.map((o) => o.label).filter((l) => !isOther(l) && !FIXED_OPTIONS.includes(l)) : [];
    return {
      detail: `the coordinator asked in codex's own question panel (not an Orca gate${pos}): ${p.question}${notes}`,
      options: [...options, ...FIXED_OPTIONS], ref: r.fp, obs: `cq:${r.fp}`, count: r.count,
    };
  }
  return {
    detail: `the coordinator shows a question panel the runner could not read (${r.why}); its screen:\n${r.tail}`,
    options: FIXED_OPTIONS, ref: r.fp, obs: `cq:${r.fp}`, count: r.count,
  };
}

/**
 * One look for the runner. → { unknown: true } (the screen could not be read) | { gone: true } (read: no panel)
 * | { quiet: true } (the one the director already dealt with) | { detail, options, ref, obs, count } (a question)
 */
export function find(handle, quietCount = null) {
  const r = readPanel(handle, { quietCount });
  if (r.state === 'unknown') return { unknown: true };
  if (r.state === 'none') return { gone: true };
  return r.state === 'quiet' ? { quiet: true } : describe(r);
}

/** Press the marker onto option `to` (verified before anything is submitted). → the keys sent */
function moveTo(handle, panel, to, fp, say) {
  if (panel.marked === null) throw new Error('cannot tell which option is marked; nothing sent');
  const n = to - panel.marked;
  const sent = [];
  for (let i = 0; i < Math.abs(n); i++) {
    io.sendKeys(handle, n > 0 ? KEYS.down : KEYS.up);
    sent.push(n > 0 ? 'down' : 'up');
    keyPause();
  }
  if (n !== 0) {
    const scr = io.readScreen(handle);
    const p = scr ? parseScreen(scr.lines) : null;
    if (!(p?.state === 'open' && p.ok && `p:${fingerprint(p.question)}` === fp && p.marked === to)) {
      throw new Error(`the marker is not on "${panel.options[to].label}" after ${sent.join(', ')}; nothing was submitted`);
    }
  }
  say(`moved the marker to "${panel.options[to].label}" (${sent.length ? sent.join(', ') : 'already there'})`);
  return sent;
}

/** Is the question `fp` still the one on screen? true | false (moved on or gone) | null (cannot tell: unreadable) */
function stillOpen(handle, fp) {
  const scr = io.readScreen(handle);
  if (!scr) return null;
  const p = parseScreen(scr.lines);
  return p.state === 'open' && p.ok ? `p:${fingerprint(p.question)}` === fp : p.state === 'open' ? null : false;
}

/** After an answer: a panel left open goes back to the main prompt, so the runner's next message reaches the composer. */
function restore(handle) {
  try {
    const scr = io.readScreen(handle);
    if (scr && parseScreen(scr.lines).state === 'open') pressMain(handle);
  } catch {
    /* best effort */
  }
}

/** The director picked one of the panel's options. Throws when it cannot be pressed safely. */
export function answerOption(handle, ref, label, say) {
  const r = readPanel(handle, { keepOpen: true });
  try {
    if (r.state === 'none') {
      say('no question panel on the screen any more: nothing sent');
      return;
    }
    if (r.state === 'unknown') throw new Error("the coordinator's screen could not be read; nothing sent — answer it in the coordinator terminal");
    if (r.state !== 'panel') throw new Error(`the panel cannot be read now (${r.why}); nothing sent — answer it in the coordinator terminal`);
    if (r.fp !== ref) throw new Error(`the coordinator now shows a different question ("${r.panel.question.slice(0, 80)}"); nothing sent`);
    if (r.panel.kind !== 'choice') throw new Error('the panel is a free-text question now; nothing sent');
    const to = r.panel.options.findIndex((o) => o.label === label);
    if (to < 0) throw new Error(`"${label}" is not on the panel any more; nothing sent`);
    const sent = moveTo(handle, r.panel, to, r.fp, say);
    io.sendKeys(handle, KEYS.enter);
    keyPause();
    say(`sent ${[...sent, 'Enter'].join(', ')} for "${label}"`);
    const after = stillOpen(handle, r.fp);
    if (after === true) throw new Error(`the panel still shows the question after Enter (sent ${[...sent, 'Enter'].join(', ')}); check the coordinator terminal`);
    say(after === null ? 'the panel after Enter could not be read: check the coordinator terminal' : 'the panel moved on');
  } finally {
    restore(handle);
  }
}

/**
 * The director's own words. A free-text panel: typed + Enter. A choice panel: "Other" picked + Enter,
 * the text typed + Enter while the panel is still on that question, and the caller also sends the text
 * as a plain message (typing into "Other" did not render). A panel that is gone or cannot be read: only
 * the plain message. → { followUp: boolean, left: boolean } (left: an unreadable panel is still on the screen)
 */
export function answerText(handle, ref, text, say) {
  const r = readPanel(handle, { keepOpen: true });
  try {
    if (r.state === 'none') {
      say('no question panel on the screen any more: the answer goes as a plain message only');
      return { followUp: true, left: false };
    }
    if (r.state === 'unknown') {
      say("the coordinator's screen could not be read: nothing typed, the answer goes as a plain message only");
      return { followUp: true, left: true };
    }
    if (r.state !== 'panel' || !ref?.startsWith('p:')) {
      say(`the panel was not read as a question the director saw (${r.state === 'panel' ? 'asked unreadable' : r.why}): main prompt, the answer goes as a plain message only`);
      return { followUp: true, left: true };
    }
    if (r.fp !== ref) throw new Error(`the coordinator now shows a different question ("${r.panel.question.slice(0, 80)}"); nothing sent`);
    if (r.panel.kind === 'free') {
      io.sendKeys(handle, text);
      keyPause();
      io.sendKeys(handle, KEYS.enter);
      keyPause();
      say(`typed the answer (${text.length} characters) + Enter into the free-text panel`);
      // moved on, or this call fails: a text that may have been taken is never typed a second time
      if (stillOpen(handle, r.fp) !== false) throw new Error('the panel still shows the question after the answer and Enter (or the screen cannot be read); nothing typed again — check the coordinator terminal');
      say('the panel moved on');
      return { followUp: false, left: false };
    }
    const other = r.panel.options.findIndex((o) => isOther(o.label));
    if (other < 0) throw new Error('this panel has no "Other" option: pick one of its options, or answer it in the coordinator terminal; nothing sent');
    // "Other" already selected (its input row is showing): no key to choose it, the text goes straight in
    const sent = r.panel.otherInput ? [] : moveTo(handle, r.panel, other, r.fp, say);
    if (!r.panel.otherInput) {
      io.sendKeys(handle, KEYS.enter);
      keyPause();
    }
    // the typed text only goes where the question is still on screen (an input for "Other"); a panel that
    // moved on, or a screen that cannot be read, would put it in the main prompt, where the plain message
    // below already is
    if (r.panel.otherInput || stillOpen(handle, r.fp) === true) {
      io.sendKeys(handle, text);
      keyPause();
      io.sendKeys(handle, KEYS.enter);
      keyPause();
      say(`${r.panel.otherInput ? 'the "Other" input was already showing' : `sent ${[...sent, 'Enter'].join(', ')} for "${r.panel.options[other].label}"`}, typed the answer + Enter`);
    } else say(`sent ${[...sent, 'Enter'].join(', ')} for "${r.panel.options[other].label}"; the panel moved on (or could not be read), no typing`);
    return { followUp: true, left: false };
  } finally {
    restore(handle);
  }
}

/**
 * Before the runner sends a plain message to the coordinator: an OPEN question panel would take that message
 * (and its Enter) as its answer. An open panel is sent back to the main prompt (shift+→) and the screen is read
 * again; a panel that is still open — or a screen that can no longer be read — throws, so nothing is sent.
 * → { closed: boolean } (closed: a panel was open and has been put away); a screen that cannot be read at
 * the start is no evidence of a panel, the message goes as before.
 */
export function mainPrompt(handle) {
  const scr = io.readScreen(handle);
  if (!scr || parseScreen(scr.lines).state !== 'open') return { closed: false };
  io.sendKeys(handle, KEYS.main);
  keyPause();
  const again = io.readScreen(handle);
  if (!again) throw new Error(`a question panel is open on ${handle} and could not be confirmed closed after shift+→; nothing sent`);
  if (parseScreen(again.lines).state === 'open') throw new Error(`a question panel is still open on ${handle} after shift+→; the message would be typed into it, nothing sent — answer or close the panel`);
  return { closed: true };
}
