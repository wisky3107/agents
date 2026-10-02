/**
 * Runner state on disk — nothing important lives only in memory (plan M4.2):
 *   .cursor/producer.lock          {pid, host, started_at, mode, terminal_handle}: one producer per project
 *   .cursor/producer.control       pause | stop | stop-after <Sxx>   (written by the CLI, read between steps)
 *   .cursor/producer-runner.json   {slice, step, questions[], updated}
 *   .cursor/evidence/tasks/T-<Sxx>/producer-state.json, producer-log.md, merge-journal.json
 * Only the runner takes the lock; an LLM producer must not run a slice loop while it is held.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const files = (root) => ({
  lock: path.join(root, '.cursor', 'producer.lock'),
  control: path.join(root, '.cursor', 'producer.control'),
  runner: path.join(root, '.cursor', 'producer-runner.json'),
});
export const sliceDir = (root, id) => path.join(root, '.cursor', 'evidence', 'tasks', `T-${id}`);
export const sliceFiles = (root, id) => ({
  state: path.join(sliceDir(root, id), 'producer-state.json'),
  wait: path.join(sliceDir(root, id), 'wait-state.json'),
  log: path.join(sliceDir(root, id), 'producer-log.md'),
  journal: path.join(sliceDir(root, id), 'merge-journal.json'),
});

export function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

export const now = () => new Date().toISOString();

/**
 * Runner-owned files under .cursor/ (lock, control, runner file, handoff prompts, and the .tmp /
 * .dead leftovers of a crash) for projects whose .gitignore predates them: git info/exclude, with
 * the project's path inside the repo when it is not the repo root.
 */
export function ensureExcluded(root) {
  const ex = spawnSync('git', ['-C', root, 'rev-parse', '--git-path', 'info/exclude', '--show-prefix'], { encoding: 'utf8' });
  if (ex.status !== 0) return;
  const [exclude, prefix = ''] = ex.stdout.split('\n');
  const file = path.resolve(root, exclude.trim());
  const want = [`/${prefix.trim()}.cursor/producer*`];
  try {
    const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    const missing = want.filter((w) => !text.split('\n').includes(w));
    if (missing.length) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, `${text && !text.endsWith('\n') ? '\n' : ''}${missing.join('\n')}\n`);
    }
  } catch {
    /* best effort: the files are small and never staged by the runner */
  }
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

/**
 * Take the project lock. A live holder refuses (exit); a dead one is taken over and reported, so the
 * caller can log it. → { ok, takenOver?, holder? }
 */
export function acquireLock(root, mode, terminalHandle = process.env.ORCA_TERMINAL_HANDLE || null) {
  const f = files(root).lock;
  const holder = readJson(f);
  if (holder?.pid === process.pid) return { ok: true, takenOver: null };
  if (holder) {
    const sameHost = !holder.host || holder.host === os.hostname();
    if (sameHost && alive(holder.pid)) return { ok: false, holder };
    if (!sameHost) return { ok: false, holder, reason: 'lock held on another host' };
    // a dead holder: move its lock aside first — rename is atomic, so of two runners taking over
    // at the same moment only one succeeds; the other finds the file gone and is refused below
    const aside = `${f}.dead-${holder.pid}-${process.pid}`;
    try {
      fs.renameSync(f, aside);
    } catch (err) {
      if (err.code === 'ENOENT') return { ok: false, holder: readJson(f), reason: 'another runner took over the dead lock' };
      throw err;
    }
    const moved = readJson(aside);
    if (moved?.pid !== holder.pid || moved?.started_at !== holder.started_at) {
      // the file was already a faster runner's fresh lock: put it back (link never overwrites) and refuse
      try {
        fs.linkSync(aside, f);
      } catch {
        /* a newer lock is in place already */
      }
      fs.rmSync(aside, { force: true });
      return { ok: false, holder: moved, reason: 'another runner took over the dead lock' };
    }
    fs.rmSync(aside, { force: true });
  }
  const mine = { pid: process.pid, host: os.hostname(), started_at: now(), mode, terminal_handle: terminalHandle };
  fs.mkdirSync(path.dirname(f), { recursive: true });
  try {
    // `wx`: two runners starting at the same moment cannot both create the lock
    fs.writeFileSync(f, JSON.stringify(mine, null, 2) + '\n', { flag: 'wx' });
  } catch (err) {
    if (err.code === 'EEXIST') return { ok: false, holder: readJson(f) };
    throw err;
  }
  return { ok: true, takenOver: holder || null };
}

export function releaseLock(root) {
  const f = files(root).lock;
  if (readJson(f)?.pid === process.pid) fs.rmSync(f, { force: true });
}

export function lockHolder(root) {
  const h = readJson(files(root).lock);
  return h ? { ...h, alive: (!h.host || h.host === os.hostname()) && alive(h.pid) } : null;
}

/** `pause` | `stop` | `stop-after Sxx` | null */
export function readControl(root) {
  try {
    const t = fs.readFileSync(files(root).control, 'utf8').trim();
    if (!t) return null;
    const [cmd, arg] = t.split(/\s+/);
    return { cmd, arg: arg || null };
  } catch {
    return null;
  }
}

const excludedRoots = new Set();
/** ensureExcluded once per process, before the first runner file is written. */
function excludeOnce(root) {
  if (excludedRoots.has(root)) return;
  excludedRoots.add(root);
  ensureExcluded(root);
}

export function writeControl(root, text) {
  excludeOnce(root);
  fs.mkdirSync(path.dirname(files(root).control), { recursive: true });
  if (text) fs.writeFileSync(files(root).control, `${text}\n`);
  else fs.rmSync(files(root).control, { force: true });
}

export function readRunner(root) {
  return readJson(files(root).runner, { slice: null, step: null, questions: [], updated: null });
}

export function writeRunner(root, patch) {
  excludeOnce(root);
  const next = { ...readRunner(root), ...patch, updated: now() };
  writeJson(files(root).runner, next);
  return next;
}

export function readSliceState(root, id) {
  return readJson(sliceFiles(root, id).state, {});
}

export function writeSliceState(root, id, patch) {
  const next = { ...readSliceState(root, id), ...patch, updated: now() };
  writeJson(sliceFiles(root, id).state, next);
  return next;
}

/**
 * A slice selected afresh must not inherit the lane state of an earlier attempt (handles, phase,
 * wait streaks, merge journal): move producer-state.json, merge-journal.json and wait-*.json aside
 * as *.prev-<ts>.json.
 */
export function archiveSliceState(root, id) {
  const dir = sliceDir(root, id);
  if (!fs.existsSync(dir)) return [];
  const stamp = now().replace(/[:.]/g, '-');
  const moved = [];
  for (const f of fs.readdirSync(dir)) {
    if (f !== 'producer-state.json' && f !== 'merge-journal.json' && !/^wait-[a-z]+\.json$/.test(f)) continue;
    const to = `${f.replace(/\.json$/, '')}.prev-${stamp}.json`;
    fs.renameSync(path.join(dir, f), path.join(dir, to));
    moved.push(to);
  }
  return moved;
}

/** One line per event in producer-log.md — the SKILL's per-slice log, append only. */
export function log(root, id, line) {
  const f = sliceFiles(root, id).log;
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.appendFileSync(f, `${now()} runner: ${line}\n`);
}

/**
 * Questions for the human. Each has fixed `options`; `producer-runner answer --id q --choice o` records
 * the choice once; the runner applies it once (`applied`).
 */
export function ask(root, q) {
  const r = readRunner(root);
  const existing = r.questions.find((x) => x.key === q.key && !x.applied);
  if (existing) return { question: existing, isNew: false };
  const question = { id: `q${r.questions.length + 1}`, asked_at: now(), answer: null, ...q };
  writeRunner(root, { questions: [...r.questions, question] });
  return { question, isNew: true };
}

export function answer(root, id, choice, text = '', meta = { by: 'human' }) {
  const r = readRunner(root);
  const q = r.questions.find((x) => x.id === id);
  if (!q) throw new Error(`no question ${id}`);
  if (q.answer) throw new Error(`${id} is already answered (${q.answer.choice})`);
  if (!q.options.includes(choice)) throw new Error(`choice must be one of: ${q.options.join(', ')}`);
  q.answer = { choice, text, at: now(), ...meta };
  writeRunner(root, { questions: r.questions });
  return q;
}

/**
 * The judge's verdict and, when it chose, its answer — in one write. A director who answered while
 * the judge ran wins: their answer stays, the verdict is only noted. → the question
 */
export function judgeVerdict(root, id, v) {
  const r = readRunner(root);
  const q = r.questions.find((x) => x.id === id);
  if (!q) throw new Error(`no question ${id}`);
  q.judge = { at: now(), ...v, ...(q.answer && v.choice ? { superseded: 'the director answered first' } : {}) };
  if (v.choice && !q.answer) q.answer = { choice: v.choice, text: v.text || '', at: now(), by: 'judge', reason: v.reason, ...(v.quote ? { quote: v.quote } : {}) };
  writeRunner(root, { questions: r.questions });
  return q;
}

/** Merge fields into one question. */
export function setQuestion(root, id, patch) {
  const r = readRunner(root);
  const q = r.questions.find((x) => x.id === id);
  if (!q) throw new Error(`no question ${id}`);
  Object.assign(q, patch);
  writeRunner(root, { questions: r.questions });
  return q;
}

export function markApplied(root, id) {
  const r = readRunner(root);
  const q = r.questions.find((x) => x.id === id);
  if (q) q.applied = now();
  writeRunner(root, { questions: r.questions });
}
