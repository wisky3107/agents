/**
 * One way in for the director's answer (plan M6): the `answer` CLI (flags or a menu), the runner's own
 * terminal and the macOS dialog all end in `submit` → st.answer, which refuses a question that already
 * has an answer; the runner applies each answer once.
 */
import * as st from './state.mjs';

/**
 * A project under a workflow pilot (`producer-runner.mjs pilot --set`, written by the workflow-pilot
 * skill at launch) gets one more way to answer: hand the question to the pilot agent. It is not one of
 * the question's options and not an answer — the question stays open, marked `pilot_handoff`, until the
 * pilot agent (woken by `pilot-wait`) answers it with `answer --by pilot`, or the director does first.
 * A pilot registered with `--auto` (the director delegated everything) gets every question the judge and
 * autopilot leave without the director being asked; the pilot gives one back with `pilot --return`.
 */
export const PILOT_CHOICE = 'resolve by pilot agent';
export const pilotOf = (root) => st.readRunner(root).pilot || null;
/** The extra rows after a question's options: the pilot handoff while a pilot runs and the question is not handed yet. */
export const extraChoices = (root, q) => (q && !q.answer && !q.pilot_handoff && !q.pilot_returned && pilotOf(root) ? [PILOT_CHOICE] : []);

/** Does this choice need a note? 'required' | 'optional' (relayed to the lane) | null */
export function textNeed(q, choice) {
  if (choice === PILOT_CHOICE) return 'optional'; // a hint for the pilot agent
  if (choice === 'send this answer to the lane') return 'required';
  if (q?.kind === 'fleet_gate') return choice === 'answer with --text' ? 'required' : choice === 'stop' ? null : 'optional';
  if (q?.kind === 'coordinator_question') return choice === 'answer with --text' ? 'required' : null; // typed into the coordinator's codex panel
  if (q?.kind === 'spawn_unconfirmed' && choice.startsWith('reattach')) return 'required';
  if (q?.kind === 'coordinator_missing' && choice.startsWith('rebind')) return 'required'; // the resumed coordinator's handle
  if (q?.kind === 'director_gate' && isGivenChoice(choice)) return 'optional'; // the note goes on the policy line
  return null;
}

/** director_gate's "approve it here" choice: the runner writes `<Sxx> GIVEN` on the policy line. */
export const givenChoice = (id) => `${id} GIVEN — record it on the policy line`;
export const isGivenChoice = (choice) => /^S\d{2}[a-z]? GIVEN — record it on the policy line$/.test(choice);

/** Why this answer cannot be recorded, or null. */
export function answerProblem(q, choice, text = '') {
  if (choice === 'send this answer to the lane' && !text.trim()) return 'give the answer for the lane as the note (--text)';
  if (!q) return 'no such question';
  if (q.answer) return `${q.id} is already answered (${q.answer.choice})`;
  if (choice === PILOT_CHOICE) return q.pilot_handoff ? `${q.id} is already handed to the pilot agent` : null;
  if (!q.options.includes(choice)) return `choice must be one of: ${q.options.join(', ')}`;
  if ((q.kind === 'spawn_unconfirmed' && choice.startsWith('reattach')) || (q.kind === 'coordinator_missing' && choice.startsWith('rebind'))) {
    if (!/^\S+$/.test(text)) return 'give the terminal handle as the note (--text)';
  }
  if (textNeed(q, choice) === 'required' && !text.trim()) {
    return q.kind === 'fleet_gate' ? 'this gate needs the decision as the note (--text)' : 'give the answer for the lane as the note (--text)';
  }
  return null;
}

/** Record the director's answer; `via` names the way in (terminal, dialog, menu; none = the CLI flags). */
export function submit(root, id, choice, text = '', via = null, by = 'human') {
  if (choice === PILOT_CHOICE) return handToPilot(root, id, text, via);
  if (by === 'pilot' && !pilotOf(root)) throw new Error('no pilot is registered for this project (producer-runner.mjs pilot --set)');
  const first = answerProblem(null, choice, text); // what is wrong whatever the question (a lane answer without its text)
  if (first !== 'no such question') throw new Error(first);
  // the rest under the runner-file lock, against the question as it is then
  return st.answer(root, id, choice, text, { by, ...(via ? { via } : {}) }, (q) => answerProblem(q, choice, text));
}

/** The director hands one open question to the pilot agent: marked, still unanswered. → the question */
export function handToPilot(root, id, text = '', via = null) {
  return st.editQuestions(root, (r) => {
    const q = r.questions.find((x) => x.id === id);
    if (!q) throw new Error(`no question ${id}`);
    if (!r.pilot) throw new Error('no pilot is registered for this project (producer-runner.mjs pilot --set)');
    if (q.answer) throw new Error(`${id} is already answered (${q.answer.choice})`);
    if (q.pilot_handoff) throw new Error(`${id} is already handed to the pilot agent (${q.pilot_handoff.at})`);
    if (q.pilot_returned) throw new Error(`the pilot agent gave ${id} back to the director: ${q.pilot_returned.note}`);
    q.pilot_handoff = { at: st.now(), pilot: r.pilot.n ?? null, ...(text.trim() ? { text: text.trim() } : {}), ...(via ? { via } : {}) };
    // handed from any way in: a restarted runner does not open the dialog again (`pilot --clear` undoes both)
    if (!q.dialog_done) q.dialog_done = 'pilot';
    return q;
  });
}

/** The pilot agent gives a handed question back: the director answers it (asked as usual). → the question */
export function returnToDirector(root, id, note) {
  if (!String(note || '').trim()) throw new Error('say why with --note: the director reads it with the question');
  return st.editQuestions(root, (r) => {
    const q = r.questions.find((x) => x.id === id);
    if (!q) throw new Error(`no question ${id}`);
    if (q.answer) throw new Error(`${id} is already answered (${q.answer.choice})`);
    if (!q.pilot_handoff) throw new Error(`${id} is not handed to the pilot agent`);
    delete q.pilot_handoff;
    if (q.dialog_done === 'pilot') delete q.dialog_done;
    q.pilot_returned = { at: st.now(), note: note.trim() };
    return q;
  });
}

// lane-written text goes to a terminal: no control characters (escape sequences) but newline and tab
const printable = (t) => String(t || '').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');

/** The question as the director reads it: where the run stands (context lines), header, full text, numbered options. */
export function menu(q, context = [], extras = []) {
  const lines = [...context.map(printable), ...(context.length ? [''] : []), `${q.id} · ${q.kind}${q.slice ? ` · ${q.slice}` : ''}`, printable(q.text).trim(), ''];
  if (q.pilot_handoff) lines.splice(lines.length - 1, 0, `(handed to the pilot agent ${q.pilot_handoff.at}; an answer here still wins)`);
  if (q.pilot_returned) lines.splice(lines.length - 1, 0, `The pilot agent gave this back to you: ${printable(q.pilot_returned.note)}`);
  [...q.options, ...extras].forEach((o, i) => lines.push(`  ${i + 1}) ${printable(o)}${textNeed(q, o) === 'required' ? '  (needs a note)' : ''}`));
  lines.push('', 'Type the number and Enter. A note may follow the number ("2 <note>"); it is passed on word for word.');
  return lines.join('\n');
}

/** "2" or "2 a note" → { choice, text } | { error }; extras number on after the options */
export function parseReply(q, line, extras = []) {
  const all = [...q.options, ...extras];
  const m = String(line).trim().match(/^(\d+)(?:[\s.):-]+(.*))?$/);
  if (!m) return { error: `type a number from 1 to ${all.length}` };
  const n = Number(m[1]);
  if (n < 1 || n > all.length) return { error: `type a number from 1 to ${all.length}` };
  return { choice: all[n - 1], text: (m[2] || '').trim() };
}

export const openQuestions = (root) => st.readRunner(root).questions.filter((q) => !q.answer);
