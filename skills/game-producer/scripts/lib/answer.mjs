/**
 * One way in for the director's answer (plan M6): the `answer` CLI (flags or a menu), the runner's own
 * terminal and the macOS dialog all end in `submit` → st.answer, which refuses a question that already
 * has an answer; the runner applies each answer once.
 */
import * as st from './state.mjs';

/** Does this choice need a note? 'required' | 'optional' (relayed to the lane) | null */
export function textNeed(q, choice) {
  if (choice === 'send this answer to the lane') return 'required';
  if (q?.kind === 'fleet_gate') return choice === 'answer with --text' ? 'required' : choice === 'stop' ? null : 'optional';
  if (q?.kind === 'coordinator_question') return choice === 'answer with --text' ? 'required' : null; // typed into the coordinator's codex panel
  if (q?.kind === 'spawn_unconfirmed' && choice.startsWith('reattach')) return 'required';
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
  if (!q.options.includes(choice)) return `choice must be one of: ${q.options.join(', ')}`;
  if (q.kind === 'spawn_unconfirmed' && choice.startsWith('reattach') && !/^\S+$/.test(text)) return 'give the terminal handle as the note (--text)';
  if (textNeed(q, choice) === 'required' && !text.trim()) {
    return q.kind === 'fleet_gate' ? 'this gate needs the decision as the note (--text)' : 'give the answer for the lane as the note (--text)';
  }
  return null;
}

/** Record the director's answer; `via` names the way in (terminal, dialog, menu; none = the CLI flags). */
export function submit(root, id, choice, text = '', via = null) {
  const first = answerProblem(null, choice, text); // what is wrong whatever the question (a lane answer without its text)
  if (first !== 'no such question') throw new Error(first);
  // the rest under the runner-file lock, against the question as it is then
  return st.answer(root, id, choice, text, { by: 'human', ...(via ? { via } : {}) }, (q) => answerProblem(q, choice, text));
}

// lane-written text goes to a terminal: no control characters (escape sequences) but newline and tab
const printable = (t) => String(t || '').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');

/** The question as the director reads it: where the run stands (context lines), header, full text, numbered options. */
export function menu(q, context = []) {
  const lines = [...context.map(printable), ...(context.length ? [''] : []), `${q.id} · ${q.kind}${q.slice ? ` · ${q.slice}` : ''}`, printable(q.text).trim(), ''];
  q.options.forEach((o, i) => lines.push(`  ${i + 1}) ${printable(o)}${textNeed(q, o) === 'required' ? '  (needs a note)' : ''}`));
  lines.push('', 'Type the number and Enter. A note may follow the number ("2 <note>"); it is passed on word for word.');
  return lines.join('\n');
}

/** "2" or "2 a note" → { choice, text } | { error } */
export function parseReply(q, line) {
  const m = String(line).trim().match(/^(\d+)(?:[\s.):-]+(.*))?$/);
  if (!m) return { error: `type a number from 1 to ${q.options.length}` };
  const n = Number(m[1]);
  if (n < 1 || n > q.options.length) return { error: `type a number from 1 to ${q.options.length}` };
  return { choice: q.options[n - 1], text: (m[2] || '').trim() };
}

export const openQuestions = (root) => st.readRunner(root).questions.filter((q) => !q.answer);
