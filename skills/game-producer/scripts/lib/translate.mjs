/**
 * The director's language for the answer dialog (pilot 8, 2026-10-06: the director could not read the
 * cut-off English question and options). AGENT_NOTES `release.question_lang: vi` (the default since
 * 2026-10-07 when the key is missing; `""` keeps English) → one `claude -p`
 * call per question turns the question, the judge's reason and every option into that language,
 * kept on the question (`q.lang`, keyed by a hash of what was translated: a refreshed question is
 * translated again) so a reopened dialog does not ask again. The answer still goes in as the exact
 * English option; a failed call leaves the dialog in English and is retried after RETRY_MS.
 *
 * PRODUCER_RUNNER_TRANSLATE_CMD replaces `claude` (tests).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import * as st from './state.mjs';
import * as io from './orca.mjs';

const NAMES = { vi: 'Vietnamese' };
const MODEL = 'sonnet';
const TIMEOUT_MS = 120000;
const RETRY_MS = 10 * 60 * 1000;

// The director reads Vietnamese (2026-10-07): a project with no `question_lang` key gets it.
const DEFAULT_LANG = 'vi';

/** The language the director reads questions in (`release.question_lang`; missing → DEFAULT_LANG,
 *  `""` or `en` → English), or null for English. */
export function questionLang(project) {
  const raw = project?.release?.question_lang;
  const v = String(raw === undefined ? DEFAULT_LANG : raw ?? '').trim().toLowerCase();
  return NAMES[v] ? v : null;
}

/** What a translation was made from: the same id with other text or options needs a new one. */
export const questionKey = (lang, q) => crypto.createHash('sha256')
  .update(JSON.stringify([lang, q.kind, q.text, q.options, q.judge?.defer || ''])).digest('hex').slice(0, 16);

/** Same env route as the judge: `--restricted` runs and a fresh Orca terminal miss the user's settings. */
function settingsEnv() {
  const f = process.env.PRODUCER_RUNNER_CLAUDE_SETTINGS || path.join(os.homedir(), '.claude', 'settings.json');
  try {
    const env = JSON.parse(fs.readFileSync(f, 'utf8')).env;
    return env && typeof env === 'object' ? Object.fromEntries(Object.entries(env).map(([k, v]) => [k, String(v)])) : {};
  } catch {
    return {};
  }
}

function prompt(lang, q, context) {
  return [
    `Translate a question that an automated game-production runner asks its human director into ${NAMES[lang]}.`,
    'The director decides from your translation alone, so keep every fact: file paths, slice ids, numbers, counts, option letters, code, error text and names stay exactly as written.',
    'Plain, natural sentences; no added advice, no opinion on which option is right.',
    '',
    'Return JSON:',
    `- summary: the question in ${NAMES[lang]}, whole, in at most 900 characters. Start with what happened, then what is being asked.`,
    `- why: the reason the judge left it to the director, in ${NAMES[lang]}; "" when there is none.`,
    `- options: exactly ${q.options.length} entries, in the given order, one per option: { n: its number below, text: the complete ${NAMES[lang]} translation, label: a short ${NAMES[lang]} label of at most 60 characters for a one-line list, keeping a leading "A:", "B:" if the option has one }.`,
    '',
    'Run context (do not translate, for understanding only):',
    ...context,
    '',
    `Question (${q.kind}${q.slice ? `, slice ${q.slice}` : ''}):`,
    String(q.text || '').trim(),
    '',
    `Judge's reason: ${String(q.judge?.defer || '').trim() || '(none)'}`,
    '',
    'Options:',
    ...q.options.map((o, i) => `${i + 1}. ${o}`),
  ].join('\n');
}

/** Valid only when every option comes back once, in order (n = 1..N), with a translation and a label. */
function valid(out, n) {
  return Boolean(out && typeof out.summary === 'string' && out.summary.trim()
    && Array.isArray(out.options) && out.options.length === n
    && out.options.every((o, i) => o && Number(o.n) === i + 1 && typeof o.text === 'string' && o.text.trim() && typeof o.label === 'string' && o.label.trim()));
}

/** One `claude -p` run, killed when `abort()` turns true (polled each second) or after TIMEOUT_MS. → { status, stdout, stderr, error } */
function call(bin, args, input, env, abort) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(bin, args, { cwd: os.tmpdir(), env, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      resolve({ status: null, stdout: '', stderr: '', error: err.code || 'spawn' });
      return;
    }
    let stdout = '';
    let stderr = '';
    let error = null;
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const started = Date.now();
    const timer = setInterval(() => {
      if (abort()) error = 'aborted';
      else if (Date.now() - started > TIMEOUT_MS) error = 'ETIMEDOUT';
      if (error) child.kill();
    }, 1000);
    child.on('error', (err) => (error = error || err.code || 'spawn'));
    child.on('close', (status) => {
      clearInterval(timer);
      resolve({ status, stdout, stderr, error });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

/**
 * The question in the director's language → { lang, key, summary, why, options, labels } | null (English).
 * `abort()` true (answered another way, runner halted) ends the call early and writes nothing.
 */
export async function translated(root, project, q, context = [], abort = () => false) {
  const lang = questionLang(project);
  if (!lang) return null;
  const key = questionKey(lang, q);
  if (q.lang?.key === key && !q.lang.failed) return q.lang;
  if (q.lang?.key === key && q.lang.failed && Date.now() - Date.parse(q.lang.at) < RETRY_MS) return null;
  const entry = { type: 'object', properties: { n: { type: 'integer' }, text: { type: 'string' }, label: { type: 'string' } }, required: ['n', 'text', 'label'] };
  const schema = {
    type: 'object',
    properties: { summary: { type: 'string' }, why: { type: 'string' }, options: { type: 'array', items: entry } },
    required: ['summary', 'why', 'options'],
  };
  const bin = process.env.PRODUCER_RUNNER_TRANSLATE_CMD || 'claude';
  // like the judge: --restricted skips settings files, hooks and the project's CLAUDE.md; no tools at all
  const args = ['-p', '--output-format', 'json', '--model', MODEL, '--restricted', '--tools', '', '--strict-mcp-config',
    '--disable-slash-commands', '--permission-prompts', 'none', '--json-schema', JSON.stringify(schema)];
  io.appendRegistry({ ts: st.now(), project: root, cwd: root, role: 'translate', slice: q.slice || null, agentSpec: `claude --model ${MODEL}`, command: 'claude -p (translate)', title: `translate-${q.id}`, handle: null });
  const env = { ...process.env, ...settingsEnv(), CC_ROLE: 'translate', CC_PROJECT: root, CC_SLICE: q.slice || '' };
  const r = await call(bin, args, prompt(lang, q, context), env, abort);
  if (r.error === 'aborted') return null;
  let out = null;
  try {
    const j = JSON.parse(r.stdout);
    out = j.is_error ? null : j.structured_output;
  } catch {
    out = null;
  }
  const rec = valid(out, q.options.length)
    ? {
      lang, key, summary: out.summary.trim(), why: String(out.why || '').trim(),
      options: out.options.map((o) => o.text.trim()), labels: out.options.map((o) => o.label.trim().replace(/\s+/g, ' ')), at: st.now(),
    }
    : { lang, key, failed: `${r.error || (r.status !== 0 ? `exit ${r.status}` : 'no valid JSON')}${r.stderr ? `: ${r.stderr.trim().slice(-160)}` : ''}`, at: st.now() };
  try {
    // only onto the question this translation was made for (a cleared runner file may reuse the id)
    st.editQuestions(root, (file) => {
      const cur = file.questions.find((x) => x.id === q.id);
      if (cur && questionKey(lang, cur) === key) cur.lang = rec;
    });
  } catch {
    /* the runner file is for the cache only */
  }
  return rec.failed ? null : rec;
}
