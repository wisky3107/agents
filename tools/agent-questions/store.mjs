// agent-questions store: what a Claude Code agent asked the director in an Orca terminal, one JSON
// file per question in <home>/<session>--<id>.json. The hook (agent-questions.mjs hook) writes them;
// the director console reads them and answers through `agent-questions.mjs answer`, which types the
// answer into the agent's own terminal. An answer typed in the chat closes the question the same way.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const HOME = os.homedir();
export const home = () => process.env.AGENT_QUESTIONS_HOME ?? path.join(HOME, '.agents', 'run', 'agent-questions');
export const logFile = () => process.env.AGENT_QUESTIONS_LOG ?? path.join(HOME, '.agents', 'logs', 'agent-questions.jsonl');
const GAMES_ROOT = () => process.env.AGENT_QUESTIONS_GAMES_ROOT ?? path.join(HOME, 'Works', 'games');
const WORKSPACES = () => process.env.AGENT_QUESTIONS_WORKSPACES ?? path.join(HOME, 'orca', 'workspaces');

// the runner's own lanes: it watches their idle turns itself, so a plain-text question there is not
// the director's (an AskUserQuestion dialog still is: it blocks the lane)
export const RUNNER_ROLES = new Set(['worker', 'writer', 'reviewer', 'verifier', 'coordinator', 'producer', 'translate', 'judge', 'fixer']);
const IMG = /\.(png|jpe?g|webp|gif)$/i;
const MAX_IMAGES = 8;

const readJson = (f) => {
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; }
};
export const safeId = (s) => String(s ?? '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);

function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

export function log(row) {
  try {
    fs.mkdirSync(path.dirname(logFile()), { recursive: true });
    fs.appendFileSync(logFile(), JSON.stringify({ at: new Date().toISOString(), ...row }) + '\n');
  } catch { /* the log never breaks a hook */ }
}

const fileOf = (q) => path.join(home(), `${safeId(q.session_id)}--${safeId(q.id)}.json`);

export function save(q) {
  writeAtomic(fileOf(q), JSON.stringify({ ...q, updated_at: new Date().toISOString() }, null, 2) + '\n');
  return q;
}

/** Every question on disk (newest first), or only one session's. */
export function all({ session = null } = {}) {
  const dir = home();
  if (!fs.existsSync(dir)) return [];
  const prefix = session ? `${safeId(session)}--` : '';
  return fs.readdirSync(dir).filter((f) => f.endsWith('.json') && f.startsWith(prefix))
    .map((f) => readJson(path.join(dir, f))).filter((q) => q?.id)
    .sort((a, b) => String(b.asked_at).localeCompare(String(a.asked_at)));
}

export const open = (opts) => all(opts).filter((q) => q.status === 'open');

export function get(id) {
  const q = all().find((x) => x.id === id);
  if (!q) throw new Error(`no agent question ${id}`);
  return q;
}

/** Close a question with how it ended; a question no longer open is left as it is. */
export function close(q, status, extra = {}) {
  const cur = readJson(fileOf(q)) ?? q;
  if (cur.status !== 'open' && cur.status !== 'answering') return cur;
  const next = { ...cur, status, closed_at: new Date().toISOString(), ...extra };
  save(next);
  log({ event: status, id: q.id, project: q.project, ...(extra.answer ? { via: extra.answer.via } : {}) });
  return next;
}

/** Old closed questions go after a week, so the dir stays small. */
export function prune(days = 7) {
  const cut = Date.now() - days * 86400000;
  for (const q of all()) {
    if (q.status === 'open' || q.status === 'answering') continue;
    if (Date.parse(q.closed_at ?? q.updated_at ?? q.asked_at) < cut) fs.rmSync(fileOf(q), { force: true });
  }
}

/** Which project a session works in: the runner's CC_PROJECT, a games checkout, an Orca worktree, else the git root. */
export function projectOf(cwd, ccProject = null) {
  const p = path.resolve(ccProject || cwd || '/');
  const under = (root) => {
    const rel = path.relative(root, p);
    return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel.split(path.sep) : null;
  };
  const ws = under(WORKSPACES());
  if (ws?.length) return ws[0];
  const games = under(GAMES_ROOT());
  // <games>/<engine>/<name> (CocosCreator/cc-x, Unity/MagicPad)
  if (games?.length >= 2) return games[1];
  for (let d = p; d !== path.dirname(d); d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, '.git'))) return path.basename(d);
  }
  return path.basename(p) || p;
}

/**
 * Does the end of an assistant turn ask the director something? The last two paragraphs, with
 * code, URLs and inline code stripped, hold a question mark or a confirm phrase.
 */
export function looksLikeQuestion(text) {
  const clean = String(text ?? '').replace(/```[\s\S]*?```/g, ' ').replace(/`[^`\n]*`/g, ' ').replace(/https?:\/\/\S+/g, ' ').trim();
  if (!clean) return false;
  const paras = clean.split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean);
  const end = paras.slice(-2).join('\n').toLowerCase();
  if (/[?？]/.test(end)) return true;
  // phrases that ask even without a "?" (statements like "Bạn chọn Vàng." or "Let me know if…" do not)
  return ['xác nhận giúp', 'bạn có muốn', 'chọn giúp', 'đồng ý không', 'ok không', 'được không', 'duyệt giúp',
    'should i ', 'do you want', 'would you like', 'let me know which', 'please confirm', 'confirm whether'].some((k) => end.includes(k));
}

const ACTIONS = [
  [/\bcommit\b/, 'Commit đi'], [/\bpush\b/, 'Push đi'], [/\bmerge\b/, 'Merge đi'], [/\bdeploy\b|lên prod/, 'Deploy đi'],
  [/\b(?:re)?run\b|chạy (?:lại|tiếp)/, 'Chạy đi'], [/tiếp tục|\bcontinue\b|\bproceed\b/, 'Tiếp tục đi'],
];
const ASKS = /(có muốn|có nên|có cần|được không|ok không|đồng ý không|duyệt không|xác nhận|should i|do you want|would you like|shall i|want me to)/;

/**
 * Rule-based quick replies for the end of a plain-text question ([{label, text}], ≤ 4): the action it
 * names (commit, push, merge, deploy, run, continue) or else a yes, the options it lists (1. / a) /
 * A:), and a no. The console adds better ones from a model when it can.
 */
export function quickReplies(text) {
  const raw = String(text ?? '').replace(/```[\s\S]*?```/g, ' ').trim();
  const paras = raw.split(/\n\s*\n/).map((x) => x.trim()).filter(Boolean);
  const endRaw = paras.slice(-3).join('\n');
  const end = endRaw.replace(/`[^`\n]*`/g, ' ').replace(/https?:\/\/\S+/g, ' ').toLowerCase();
  const out = [];
  const add = (label, t = label) => { if (out.length < 4 && !out.some((x) => x.label === label)) out.push({ label, text: t }); };
  const asks = ASKS.test(end) || /[?？]/.test(end);
  if (!asks) return [];
  const acts = ACTIONS.filter(([re]) => re.test(end)).map(([, label]) => label);
  for (const a of acts.slice(0, 2)) add(a);
  const opts = [...endRaw.matchAll(/^\s*(?:[-*]\s*)?(?:\*\*)?\(?([1-9]|[a-dA-D])[.):](?:\*\*)?\s+(.{2,140})$/gm)];
  if (opts.length >= 2 && opts.length <= 5) {
    for (const o of opts.slice(0, 4 - out.length)) {
      const what = o[2].replace(/\*\*/g, '').trim();
      add(`${o[1]}. ${what.length > 28 ? `${what.slice(0, 27)}…` : what}`, `Chọn ${o[1]}: ${what}`);
    }
    return out;
  }
  // "A hay B?" / "A or B?" with two short sides (≤ 3 words each): one reply per side; a longer one
  // is left to the model
  const lastRaw = (endRaw.split('\n').reverse().find((l) => /[?？]/.test(l)) ?? '').split(/[?？]/)[0];
  const last = lastRaw.toLowerCase();
  const alt = acts.length ? null : lastRaw.match(/(?:^|[:,;]\s*)([^:,;]{1,60}?)\s+(?:hay là|hay|hoặc|or)\s+([^:,;]{1,60})$/i);
  if (alt) {
    const a = alt[1].replace(/^.*\b(?:nên|dùng|chọn|là|should i|do you want|prefer)\s+/i, '').trim();
    const b = alt[2].trim();
    if (a.split(/\s+/).length <= 3 && b.split(/\s+/).length <= 3) {
      add(a, `${a}.`);
      add(b, `${b}.`);
    }
    return out;
  }
  // an open question (which, what, how many) has no rule answer; a yes/no one does
  if (!acts.length && /\b(which|what|how many|how much|why|where)\b|nào|gì|mấy|bao nhiêu|tại sao|ở đâu/.test(last)) return out;
  if (!acts.length) add('Có, làm đi');
  add(acts.length ? 'Chưa, để sau' : 'Không', acts.length ? 'Chưa, để sau.' : 'Không.');
  return out;
}

/** Image files a question names (absolute, ~/, or relative to the agent's cwd) that exist. */
export function imagesIn(texts, cwd) {
  const out = new Set();
  const re = /(?:^|[\s(`'"[<:=])([^\s`'"()<>[\]]+\.(?:png|jpe?g|webp|gif))(?=$|[\s`'")\]>,;:!?]|\.(?:\s|$))/gim;
  for (const t of texts.flat().filter(Boolean)) {
    for (const m of String(t).matchAll(re)) {
      let p = m[1];
      if (p.startsWith('~/')) p = path.join(HOME, p.slice(2));
      else if (!path.isAbsolute(p)) p = path.resolve(cwd || '/', p);
      try {
        if (IMG.test(p) && fs.statSync(p).isFile()) out.add(p);
      } catch { /* not a file */ }
      if (out.size >= MAX_IMAGES) return [...out];
    }
  }
  return [...out];
}

/** The last assistant text in a transcript before the current turn's tool call: what the agent said around its question. */
export function lastAssistantText(transcript, maxBytes = 400000) {
  if (!transcript) return null;
  let text = '';
  try {
    const st = fs.statSync(transcript);
    const fd = fs.openSync(transcript, 'r');
    const n = Math.min(st.size, maxBytes);
    const buf = Buffer.alloc(n);
    fs.readSync(fd, buf, 0, n, st.size - n);
    fs.closeSync(fd);
    text = buf.toString('utf8');
  } catch { return null; }
  const lines = text.split('\n').reverse();
  for (const l of lines) {
    let j;
    try { j = JSON.parse(l); } catch { continue; }
    if (j.type === 'user' && typeof j.message?.content === 'string') return null; // the turn started: nothing said yet
    if (j.type !== 'assistant') continue;
    const parts = Array.isArray(j.message?.content) ? j.message.content.filter((c) => c.type === 'text').map((c) => c.text) : [];
    if (parts.length) return parts.join('\n').trim();
  }
  return null;
}

export const newId = () => `${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`;
