// Director console data layer. Reads come straight from the systems' own modules and files
// (orca-memory src, the game-producer runner's state.mjs/project.mjs, the cocos-playbook
// registries, Orca's terminal list). Writes go only through the systems' own CLIs, one allowlisted
// action each, so every decision keeps its audit trail (mode-log, ledger, curation, runner answers)
// and the console can do nothing the CLIs would refuse. Every action is logged to
// <logs>/director-console.jsonl.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';

const HOME = os.homedir();
const env = process.env;
export const CFG = {
  gamesRoot: env.CONSOLE_GAMES_ROOT ?? path.join(HOME, 'Works/games/CocosCreator'),
  runnerDir: env.CONSOLE_RUNNER_DIR ?? path.join(HOME, '.agents/skills/game-producer/scripts'),
  omSrc: env.CONSOLE_ORCA_MEMORY_SRC ?? path.join(HOME, 'Works/agent/orca-memory/src'),
  playbook: env.CONSOLE_PLAYBOOK ?? path.join(HOME, 'Works/games/cocos-playbook'),
  orcaBin: env.CONSOLE_ORCA_BIN ?? 'orca',
  logs: env.CONSOLE_LOG_DIR ?? path.join(HOME, '.agents/logs'),
  resGuardHome: env.CONSOLE_RES_GUARD_HOME ?? path.join(HOME, '.agents'), // tools/res-guard's run/ and logs/
  resGuardCli: env.CONSOLE_RES_GUARD_CLI ?? path.join(HOME, '.agents/tools/res-guard/res-guard.mjs'),
  workspaces: env.CONSOLE_WORKSPACES ?? path.join(HOME, 'orca/workspaces'), // Orca worktrees: <workspaces>/<project>/<name>
  omnirouteHome: env.CONSOLE_OMNIROUTE_HOME ?? path.join(HOME, '.omniroute'), // storage.sqlite: accounts + quota snapshots
  omnirouteUrl: env.CONSOLE_OMNIROUTE_URL ?? 'http://127.0.0.1:20128',
  omnirouteCli: env.CONSOLE_OMNIROUTE_CLI ?? path.join(HOME, '.local/lib/node_modules/omniroute'), // its machine-token module
  agyRotateState: env.CONSOLE_AGY_ROTATE_STATE ?? path.join(HOME, '.agents/logs/agy-rotate-state.json'),
  agentQuestions: env.CONSOLE_AGENT_QUESTIONS ?? path.join(HOME, '.agents/tools/agent-questions'), // store.mjs + its CLI
  bootIdea: env.CONSOLE_BOOT_IDEA_CLI ?? path.join(HOME, '.agents/tools/boot-idea/boot-idea.mjs'),
  uploads: env.CONSOLE_UPLOADS ?? path.join(HOME, '.agents/run/director-console-uploads'), // boot images until boot-idea moves them
};

const om = {
  config: await import(path.join(CFG.omSrc, 'config.ts')),
  archive: await import(path.join(CFG.omSrc, 'archive.ts')),
  pilot: await import(path.join(CFG.omSrc, 'pilot.ts')),
  hook: await import(path.join(CFG.omSrc, 'hook.ts')),
  util: await import(path.join(CFG.omSrc, 'util.ts')),
};
const runnerState = await import(path.join(CFG.runnerDir, 'lib/state.mjs'));
const runnerProject = await import(path.join(CFG.runnerDir, 'lib/project.mjs'));
const runnerAnswer = await import(path.join(CFG.runnerDir, 'lib/answer.mjs'));
const runnerContext = await import(path.join(CFG.runnerDir, 'lib/context.mjs'));
const runnerTranslate = await import(path.join(CFG.runnerDir, 'lib/translate.mjs'));
const aq = await import(path.join(CFG.agentQuestions, 'store.mjs'));

const readJson = (f, fallback = null) => {
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fallback; }
};
const readJsonl = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } }) : []);
const memHome = () => om.util.memoryHome();
const tail = (arr, n) => arr.slice(Math.max(0, arr.length - n));
const real = (p) => {
  try { return fs.realpathSync.native(p); } catch { return path.resolve(p); }
};

// ------------------------------------------------------------------ projects

/** Registered memory projects plus any checkout under the games root that a runner has touched. */
export function projects() {
  const cfg = om.config.loadConfig();
  const byPath = new Map();
  for (const p of cfg.projects) byPath.set(real(p.paths[0]), { id: p.project_id, path: p.paths[0], mode: p.memory.mode, registered: true });
  if (fs.existsSync(CFG.gamesRoot)) {
    for (const e of fs.readdirSync(CFG.gamesRoot, { withFileTypes: true })) {
      const dir = path.join(CFG.gamesRoot, e.name);
      if (!e.isDirectory() || !fs.existsSync(path.join(dir, '.cursor', 'producer-runner.json'))) continue;
      const r = real(dir);
      if (!byPath.has(r)) byPath.set(r, { id: e.name, path: dir, mode: null, registered: false });
    }
  }
  return [...byPath.values()].map((p) => {
    const runner = runnerOf(p.path);
    return { ...p, runner, levels: levelsOf(p.path), active_at: activeAt(p.path, runner) };
  }).sort(projectOrder);
}

/** Last sign of work: the runner's state write or the checkout's last HEAD move (commit, merge, checkout). */
function activeAt(root, runner) {
  const head = safe(() => fs.statSync(path.join(root, '.git', 'logs', 'HEAD')).mtimeMs) ?? 0;
  const t = Math.max(head, Date.parse(runner?.updated ?? '') || 0);
  return t ? new Date(t).toISOString() : null;
}

/** Console order: open runner questions first (most first), then a live runner, then the latest activity, then id. */
export function projectOrder(a, b) {
  return (b.runner?.open_questions ?? 0) - (a.runner?.open_questions ?? 0)
    || Number(!!b.runner?.alive) - Number(!!a.runner?.alive)
    || (Date.parse(b.active_at ?? '') || 0) - (Date.parse(a.active_at ?? '') || 0)
    || a.id.localeCompare(b.id);
}

/** The project's slices in order with their release status: the level map on the console. */
function levelsOf(root) {
  const lp = safe(() => runnerProject.loadProject(root));
  if (!lp) return [];
  const ids = new Set([...Object.keys(lp.sliceFiles ?? {}), ...Object.keys(lp.release?.slices ?? {})]);
  return [...ids].filter((s) => /^S\d+/.test(s)).sort(sliceOrder).map((s) => ({ slice: s, status: lp.release?.slices?.[s] ?? 'planned', file: lp.sliceFiles?.[s] ?? null }));
}

/** Archive size and refresh state for the console header. */
export function memorySummary() {
  const records = safe(() => om.archive.loadArchive()) ?? [];
  return { records: records.length, active: records.filter((r) => r.lifecycle === 'active').length };
}

function runnerOf(root) {
  if (!fs.existsSync(path.join(root, '.cursor', 'producer-runner.json'))) return null;
  const r = runnerState.readRunner(root);
  const lock = runnerState.lockHolder(root);
  return {
    slice: r.slice, step: r.step, updated: r.updated ?? null,
    alive: !!lock?.alive, lock, control: runnerState.readControl(root),
    open_questions: (r.questions ?? []).filter((q) => !q.answer).length,
  };
}

const findProject = (id) => {
  const p = projects().find((x) => x.id === id);
  if (!p) throw new Error(`unknown project ${id}`);
  return p;
};

/** One project in depth: its slices (status, rounds, merge journal, memory) and live terminals. */
export function projectDetail(id) {
  const p = findProject(id);
  let release = null;
  let sliceFiles = {};
  try {
    const lp = runnerProject.loadProject(p.path);
    release = lp.release ?? null;
    sliceFiles = lp.sliceFiles ?? {};
  } catch { /* not a producer project (no MILESTONES): slices come from the evidence dir only */ }
  const tasksDir = path.join(p.path, '.cursor', 'evidence', 'tasks');
  const ids = new Set([...Object.keys(sliceFiles), ...(fs.existsSync(tasksDir) ? fs.readdirSync(tasksDir).filter((t) => /^T-S\d+/.test(t)).map((t) => t.slice(2)) : [])]);
  const report = p.registered ? safe(() => om.pilot.pilotReport(om.config.loadConfig().projects.find((x) => x.project_id === p.id))) : null;
  const bySlice = new Map((report?.slices ?? []).map((s) => [s.slice, s]));
  const slices = [...ids].sort(sliceOrder).map((s) => {
    const dir = runnerState.sliceDir(p.path, s);
    const ev = path.join(dir, 'evidence');
    const journal = readJson(path.join(dir, 'merge-journal.json'));
    const stats = readJson(path.join(ev, 'stats.json'));
    const pilot = bySlice.get(s);
    return {
      slice: s, file: sliceFiles[s] ?? null,
      status: release?.slices?.[s] ?? null,
      handoff: readJson(path.join(ev, 'HANDOFF.json')),
      fix_rounds: rounds(stats?.fix_rounds) ?? pilot?.fix_rounds ?? null,
      review_rounds: rounds(stats?.review_rounds) ?? pilot?.review_rounds ?? null,
      merge: journal ? Object.fromEntries(Object.entries(journal.steps ?? {}).map(([k, v]) => [k, v?.note ?? 'done'])) : null,
      manual_deferred: openDeferred(path.join(ev, 'manual-deferred.json')),
      memory: pilot ? { phase: pilot.phase, packs: pilot.memory.packs, injected_tokens: pilot.memory.injected_tokens, cited: pilot.cited_ids, verdicts: pilot.verdicts, unjudged: pilot.unjudged_items } : null,
    };
  });
  const terminals = orcaTerminals().filter((t) => (t.worktreePath ?? '').includes(path.basename(p.path)))
    .map((t) => ({ handle: t.handle, title: t.title, worktree: t.worktreePath, agent: t.agentIdentity ?? null, connected: t.connected, last_output_at: t.lastOutputAt ?? null, preview: (t.preview ?? '').slice(-600) }));
  const now = p.runner ? liveSlices(p.path) : [];
  const titles = new Map(orcaTerminals().map((t) => [t.handle, t.title]));
  for (const x of now) for (const k of ['writer', 'reviewer']) if (x[k]) x[k] = { handle: x[k], title: titles.get(x[k]) ?? null, live: titles.has(x[k]) };
  return { ...p, release: release ? { goal: release.goal ?? null, current_slice: release.current_slice ?? null } : null, slices, terminals, now };
}

const IMG = /\.(png|jpe?g|webp|gif)$/i;

/** Image files under dir (depth ≤ 3), newest first: what a slice's evidence shows. */
function imagesUnder(dir, n = 6) {
  const out = [];
  const walk = (d, depth) => {
    let es;
    try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of es) {
      const f = path.join(d, e.name);
      if (e.isDirectory() && depth < 3 && e.name !== 'memory') walk(f, depth + 1);
      else if (e.isFile() && IMG.test(e.name)) out.push({ path: f, name: path.relative(dir, f), at: safe(() => fs.statSync(f).mtimeMs) ?? 0 });
    }
  };
  walk(dir, 0);
  return out.sort((a, b) => b.at - a.at).slice(0, n).map((x) => ({ ...x, at: new Date(x.at).toISOString() }));
}

// a review.md ends on its verdict (the runner reads the last line); prose before it may name others
const VERDICT = /^\W*(?:verdict\W*)?(APPROVED|CHANGES[_ ]REQUESTED|REQUEST[_ ]CHANGES|REJECTED|BLOCKED|NEEDS[_ ]FIX(?:ES)?)\b/i;
export const reviewVerdict = (text) => String(text ?? '').split('\n').reverse().map((l) => l.match(VERDICT)?.[1]).find(Boolean)?.toUpperCase().replace(' ', '_') ?? null;

/**
 * Where each slice in progress stands (the runner's slice when its step is not done, plus every
 * phase-2 lane), else the runner's last slice: phase, checkout, writer/reviewer, the review verdict,
 * the runner log's last lines and the evidence's newest images (the lane's worktree first).
 */
export function liveSlices(root) {
  const r = runnerState.readRunner(root);
  const live = [...new Set([r.step && r.step !== 'done' ? r.slice : null, ...(r.lanes ?? []).map((l) => l.slice)].filter(Boolean))];
  const ids = live.length ? live : r.slice ? [r.slice] : [];
  return ids.map((id) => {
    const s = runnerState.readSliceState(root, id);
    const checkout = s.lane_checkout && fs.existsSync(s.lane_checkout) ? s.lane_checkout : root;
    const evs = [...new Set([path.join(runnerState.sliceDir(checkout, id), 'evidence'), path.join(runnerState.sliceDir(root, id), 'evidence')])];
    const first = (f) => evs.map((d) => path.join(d, f)).find((x) => fs.existsSync(x)) ?? null;
    const handoff = readJson(first('HANDOFF.json') ?? '');
    const stats = readJson(first('stats.json') ?? '');
    const reviewFile = first('review.md');
    const review = reviewFile ? { verdict: safe(() => reviewVerdict(fs.readFileSync(reviewFile, 'utf8'))), at: new Date(fs.statSync(reviewFile).mtimeMs).toISOString(), path: reviewFile } : null;
    const logText = safe(() => fs.readFileSync(path.join(runnerState.sliceDir(root, id), 'producer-log.md'), 'utf8')) ?? '';
    const seen = new Set();
    const images = evs.flatMap((d) => imagesUnder(d)).filter((x) => !seen.has(x.name) && seen.add(x.name)).sort((a, b) => b.at.localeCompare(a.at)).slice(0, 6);
    return {
      slice: id, live: live.includes(id), phase: s.phase ?? null, lane: s.lane ?? null, checkout, in_main: path.resolve(checkout) === path.resolve(root),
      selected_at: s.selected_at ?? null, updated: s.updated ?? null, writer: s.writer ?? null, reviewer: s.reviewer ?? null,
      static_result: s.static_result ?? null, commit_sha: s.commit_sha ?? null, wait: s.lane_wait ?? null,
      handoff: handoff ? { role: handoff.role ?? null, status: handoff.status ?? null } : null,
      fix_rounds: rounds(stats?.fix_rounds), review_rounds: rounds(stats?.review_rounds), review,
      log: tail(logText.split('\n').filter(Boolean), 8), images,
    };
  });
}

/** A file the page may show as an image: an image under $HOME or a temp dir, at most 25 MB. → abs path */
export function imageFile(p) {
  if (!p || !path.isAbsolute(p) || !IMG.test(p)) throw Object.assign(new Error('not an image path'), { status: 400 });
  const f = real(p);
  const roots = [HOME, '/tmp', '/private/tmp', '/var/folders', '/private/var/folders'].map(real);
  if (!IMG.test(f) || !roots.some((r) => f.startsWith(r + path.sep))) throw Object.assign(new Error('not an allowed image'), { status: 403 });
  const st = safe(() => fs.statSync(f));
  if (!st?.isFile() || st.size > 25 * 1024 * 1024) throw Object.assign(new Error('no such image'), { status: 404 });
  return f;
}

// stats.json is agent-written: a round count may be a number, a list of rounds, or {count|total|n: number}
export const rounds = (v) => (typeof v === 'number' ? v : Array.isArray(v) ? v.length : v && typeof v === 'object' ? [v.count, v.total, v.n, v.rounds].find((x) => typeof x === 'number') ?? null : null);
const sliceOrder = (a, b) => Number(a.match(/\d+/)?.[0]) - Number(b.match(/\d+/)?.[0]) || a.localeCompare(b);
function safe(fn) {
  try { return fn(); } catch { return null; }
}

let termCache = { at: 0, list: [] };
function orcaTerminals() {
  if (Date.now() - termCache.at < 10000) return termCache.list;
  const r = spawnSync(CFG.orcaBin, ['terminal', 'list', '--json'], { encoding: 'utf8', timeout: 15000, maxBuffer: 32 * 1024 * 1024 });
  const list = r.status === 0 ? (safe(() => JSON.parse(r.stdout).result.terminals) ?? []) : [];
  termCache = { at: Date.now(), list };
  return list;
}

// ------------------------------------------------------------------ pending decisions

const TRANSLATE_RETRY_MS = 10 * 60 * 1000; // translate.mjs RETRY_MS
const translating = new Map(); // `${root}#${id}#${key}` → the runner's translate call in flight
const pidAlive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
};

/**
 * The question in Vietnamese. The runner's own `q.lang` when it was made from this exact question;
 * else the runner's translate code (one `claude -p` sonnet call, cached on the question like the
 * dialog does) is started in the background for every project, not only those with
 * `release.question_lang: vi`, and the card shows English until the next refresh picks it up.
 */
function viTranslation(root, q) {
  const key = runnerTranslate.questionKey('vi', q);
  if (q.lang?.lang === 'vi' && q.lang.key === key && !q.lang.failed) return { vi: q.lang, state: 'ok' };
  if (q.lang?.key === key && q.lang.failed && Date.now() - Date.parse(q.lang.at) < TRANSLATE_RETRY_MS) return { vi: null, state: 'failed', error: q.lang.failed };
  const job = `${root}#${q.id}#${key}`;
  if (translating.has(job)) return { vi: null, state: 'translating' };
  if (env.CONSOLE_TRANSLATE === 'off') return { vi: null, state: 'off' };
  const project = safe(() => runnerProject.loadProject(root));
  // a Vietnamese project's open dialog is translating this question already
  if (project && runnerTranslate.questionLang(project) === 'vi' && q.dialog_pid && pidAlive(q.dialog_pid)) return { vi: null, state: 'translating' };
  // translate.mjs reads only release.question_lang from the project
  const vi = { ...(project ?? {}), release: { ...(project?.release ?? {}), question_lang: 'vi' } };
  const context = safe(() => runnerContext.questionContext(root, q)) ?? [];
  const settled = () => !runnerState.readRunner(root).questions?.find((x) => x.id === q.id && !x.answer);
  translating.set(job, runnerTranslate.translated(root, vi, q, context, settled).catch(() => null).finally(() => translating.delete(job)));
  return { vi: null, state: 'translating' };
}

const pilotN = (root) => safe(() => runnerAnswer.pilotOf?.(root)?.n) ?? null;

/** An open runner question with all the runner's dialog shows, plus its Vietnamese translation. */
function questionView(p, q) {
  const tr = viTranslation(p.path, q);
  return {
    project: p.id, id: q.id, kind: q.kind, slice: q.slice ?? null, asked_at: q.asked_at, text: q.text, detail: q.detail ?? null,
    options: [
      ...(q.options ?? []).map((o, i) => ({ choice: o, note: runnerAnswer.textNeed(q, o), vi_label: tr.vi?.labels?.[i] ?? null, vi_text: tr.vi?.options?.[i] ?? null })),
      // a workflow pilot runs here: hand the question to the pilot agent (it stays open until answered)
      ...(runnerAnswer.extraChoices?.(p.path, q) ?? []).map((o) => ({ choice: o, note: runnerAnswer.textNeed(q, o), pilot: true, vi_label: `Giao cho pilot agent${pilotN(p.path) ? ` (pilot ${pilotN(p.path)})` : ''} xử lý`, vi_text: 'Câu hỏi vẫn mở; pilot agent trả lời thay bạn' })),
    ],
    pilot_handoff: q.pilot_handoff ?? null, pilot_returned: q.pilot_returned ?? null,
    judge: q.judge ? { at: q.judge.at ?? null, defer: q.judge.defer ?? null, choice: q.judge.choice ?? null, reason: q.judge.reason ?? null } : null,
    context: safe(() => runnerContext.questionContext(p.path, q)) ?? [],
    ref: q.ref ?? null, obs: q.obs ?? null, key: q.key ?? null, also: q.also ?? [], notified: q.notified ?? null,
    vi: tr.vi ? { summary: tr.vi.summary, why: tr.vi.why || null, at: tr.vi.at ?? null } : null,
    vi_state: tr.state, vi_error: tr.error ?? null,
  };
}

/** Everything that waits on the director, across systems. */
const TRIAGE_TEXT = ['finding', 'lesson', 'observation', 'summary', 'text', 'claim', 'note', 'topic'];

/**
 * Open triage rows grouped by source file: one file with four bad rows is one thing to fix, not four identical
 * cards (capytal S42, 2026-10-17). Each row keeps a short preview of what the agent wrote, taken from the archive's
 * triage.json (refresh-latest.json carries only source and reason), so the director can tell the rows apart.
 */
export function triageGroups(open, archived) {
  const raws = new Map();
  for (const t of Array.isArray(archived) ? archived : []) {
    if (t?.resolution || !t?.source) continue;
    if (!raws.has(t.source)) raws.set(t.source, []);
    raws.get(t.source).push(t.raw ?? null);
  }
  const preview = (raw) => {
    if (raw == null) return null;
    if (typeof raw !== 'object') return String(raw).slice(0, 300);
    const f = TRIAGE_TEXT.find((k) => typeof raw[k] === 'string' && raw[k].trim());
    return (f ? raw[f] : JSON.stringify(raw)).slice(0, 300);
  };
  const groups = new Map();
  for (const t of open) {
    if (!groups.has(t.source)) groups.set(t.source, { source: t.source, reason: t.reason ?? '', reasons: [], count: 0, items: [] });
    const g = groups.get(t.source);
    if (t.reason && !g.reasons.includes(t.reason)) g.reasons.push(t.reason);
    g.count += 1;
  }
  for (const g of groups.values()) {
    g.reason = g.reasons.join('; ');
    const rs = raws.get(g.source) ?? [];
    g.items = rs.slice(0, g.count).map((raw) => ({ keys: raw && typeof raw === 'object' ? Object.keys(raw) : [], text: preview(raw) }));
  }
  return [...groups.values()];
}

export function pending(ps = projects()) {
  const questions = ps.flatMap((p) => {
    if (!p.runner) return [];
    return (runnerState.readRunner(p.path).questions ?? []).filter((q) => !q.answer).map((q) => questionView(p, q));
  });
  const home = memHome();
  const draftRoot = path.join(home, 'reports', 'judge-drafts');
  // one dir per project; a stray file there (a run summary) must not take the overview down
  const drafts = (fs.existsSync(draftRoot) ? fs.readdirSync(draftRoot, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name) : []).flatMap((proj) =>
    fs.readdirSync(path.join(draftRoot, proj)).filter((f) => f.endsWith('.json')).map((f) => readJson(path.join(draftRoot, proj, f))).filter((d) => d && !d.applied_at));
  const refresh = readJson(path.join(home, 'reports', 'refresh-latest.json'));
  const ageH = refresh ? (Date.now() - Date.parse(refresh.at)) / 3600000 : null;
  const deferred = ps.flatMap((p) => {
    const tasks = path.join(p.path, '.cursor', 'evidence', 'tasks');
    if (!fs.existsSync(tasks)) return [];
    return fs.readdirSync(tasks).filter((t) => /^T-S\d+/.test(t)).sort((a, b) => sliceOrder(a.slice(2), b.slice(2))).flatMap((t) => {
      const items = openDeferred(path.join(tasks, t, 'evidence', 'manual-deferred.json'));
      return items.length ? [{ project: p.id, slice: t.slice(2), items }] : [];
    });
  });
  const unregistered = safe(() => om.hook.findUnregistered(om.config.loadConfig()).filter((u) => u.active)) ?? [];
  return {
    questions, drafts, agent_questions: agentQuestions(),
    triage: triageGroups(refresh?.triage_open ?? [], readJson(path.join(om.archive.archiveDir(), 'triage.json')) ?? []),
    refresh: refresh ? { at: refresh.at, ok: refresh.ok, failed_step: refresh.failed_step, stale: ageH > 48 } : null,
    manual_deferred: deferred, unregistered,
  };
}

/**
 * Open questions agents asked the director in Orca terminals (tools/agent-questions), with the
 * terminal's title. One whose terminal Orca no longer lists is left out (its session is gone);
 * when Orca does not answer at all, every open one is shown.
 */
export function agentQuestions() {
  const terms = orcaTerminals();
  const byHandle = new Map(terms.map((t) => [t.handle, t]));
  return aq.open().filter((q) => !terms.length || byHandle.get(q.handle)?.connected)
    .map((q) => {
      const t = byHandle.get(q.handle);
      return {
        ...q, terminal: t ? { title: t.title ?? null, worktree: t.worktreePath ?? null, last_output_at: t.lastOutputAt ? new Date(t.lastOutputAt).toISOString() : null } : null,
        quick: q.kind === 'stop' ? quickRepliesFor(q) : null,
      };
    });
}

/** The last boots from the console (tools/boot-idea), newest first. */
export const boots = (n = 8) => tail(readJsonl(path.join(CFG.logs, 'boot-idea.jsonl')), n).reverse();

const clip = (s, n = 200) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/**
 * What needs the director now, one row per item with a stable key. The page announces each key
 * once (a card in the page, plus an OS notification when allowed) and marks it resolved when the
 * key goes away. Deferred manual checks are left out: they wait for ship, not for a decision.
 */
export function attention(ps = projects(), pd = pending(ps)) {
  const items = [];
  const add = (it) => items.push({ project: null, tag: null, since: null, quest: null, ...it, body: clip(it.body) });
  for (const q of pd.questions) add({
    key: `runner:${q.project}:${q.id}`, kind: 'runner', tag: q.kind ?? null, level: 'critical', project: q.project, since: q.asked_at ?? null,
    title: `${q.project}${q.slice ? ` ${q.slice}` : ''}: runner đang chờ bạn trả lời`, body: q.vi?.summary ?? q.text, href: '#quests', quest: 'runner',
  });
  for (const q of pd.agent_questions ?? []) add({
    key: `agent:${q.id}`, kind: 'agent', tag: q.kind, level: 'critical', project: q.project, since: q.asked_at ?? null,
    title: `${q.project}: agent hỏi bạn${q.terminal?.title ? ` (${q.terminal.title.replace(/^[^\w(]+/u, '').slice(0, 40)})` : ''}`,
    body: q.kind === 'ask' ? q.questions.map((x) => x.question).join(' · ') : String(q.text).trim().split(/\n\s*\n/).at(-1), href: '#quests', quest: 'agent',
  });
  // A runner that died mid-slice: no live lock, still in the lane step, and nobody asked it to stop.
  // Keyed by the dead runner's pid: the runner file's `updated` moves with every cache or answer write.
  for (const p of ps) {
    const r = p.runner;
    if (!r || r.alive || r.step !== 'lane' || ['stop', 'pause'].includes(r.control?.cmd)) continue;
    add({
      key: `runner-down:${p.id}:${r.slice}:${r.lock?.pid ?? ''}`, kind: 'runner-down', level: 'critical', project: p.id, since: r.updated ?? null,
      title: `${p.id}: runner dừng giữa ${r.slice}`, body: `Runner không còn chạy, ${r.slice} chưa xong và không có lệnh stop/pause. Xem log rồi chạy lại runner.`,
      href: `#worlds/${encodeURIComponent(p.id)}`,
    });
  }
  for (const d of pd.drafts) add({
    key: `draft:${d.project}:${d.slice}:${d.created_at ?? ''}`, kind: 'draft', level: 'warning', project: d.project, since: d.created_at ?? null,
    title: `${d.project} ${d.slice}: bản nháp chấm memory chờ duyệt`, body: `${d.rows?.length ?? 0} dòng cần verdict của bạn.`, href: '#quests', quest: 'draft',
  });
  for (const t of pd.triage) add({
    key: `triage:${t.source}`, kind: 'triage', level: 'warning', project: String(t.source).split(':')[0],
    title: t.count > 1 ? `Memory triage: ${t.count} dòng cùng một file cần xem` : 'Memory triage: một dòng cần xem', body: `${t.source}: ${t.reason ?? ''}`, href: '#quests', quest: 'triage',
  });
  const rf = pd.refresh;
  if (rf && !rf.ok) add({
    key: `refresh-failed:${rf.at}`, kind: 'system', level: 'critical', since: rf.at,
    title: 'Refresh kho memory bị lỗi', body: `Bước lỗi: ${rf.failed_step ?? '?'}. Kho giữ bản cũ cho tới khi sửa.`, href: '#quests', quest: 'system',
  });
  else if (rf?.stale) add({
    key: `refresh-stale:${rf.at}`, kind: 'system', level: 'warning', since: rf.at,
    title: 'Kho memory quá 48 giờ chưa refresh', body: 'Job refresh 09:03 không chạy hoặc không ghi báo cáo.', href: '#quests', quest: 'system',
  });
  for (const u of pd.unregistered) add({
    key: `unregistered:${u.path}`, kind: 'system', level: 'info', project: path.basename(u.path), since: u.last_task_at ?? null,
    title: `${path.basename(u.path)} chưa đăng ký orca-memory`, body: 'Dự án đang chạy nhưng mọi hook memory đều tắt.', href: '#quests', quest: 'system',
  });
  for (const a of resourceAlerts()) add({ ...a, kind: 'system', href: '#resources' });
  return { at: new Date().toISOString(), items };
}

// ------------------------------------------------------------------ resources (tools/res-guard)

const rgState = () => readJson(path.join(CFG.resGuardHome, 'run', 'res-guard', 'state.json'), null);
const RG_STALE_MS = 10 * 60000; // the watcher ticks every 60 s

/** res-guard's live alert rows (swap, pressure, disk, too many editors), or one row when its watcher stopped. */
function resourceAlerts() {
  const st = rgState();
  if (!st?.lastTick) return [];
  if (Date.now() - Date.parse(st.lastTick) > RG_STALE_MS) {
    return [{ key: 'res-guard:stale', level: 'warning', since: st.lastTick, title: 'res-guard ngừng theo dõi máy', body: `Lần đo cuối ${st.lastTick}. Kiểm tra launchd com.agents.res-guard.` }];
  }
  return (st.alerts ?? []).map((a) => ({ key: `res-guard:${a.key}`, level: a.level, since: null, title: `Tài nguyên máy: ${a.title}`, body: a.body }));
}

/** The watcher's last sample, its editor verdicts, a 24 h trend (≤ 288 points) and its recent events. */
export function resources() {
  const st = rgState() ?? {};
  const dir = path.join(CFG.resGuardHome, 'logs', 'res-guard');
  const day = (ms) => new Date(ms).toISOString().slice(0, 10);
  const since = Date.now() - 24 * 3600000;
  const rows = [...new Set([day(since), day(Date.now())])].flatMap((d) => readJsonl(path.join(dir, `samples-${d}.jsonl`))).filter((x) => Date.parse(x.at) >= since);
  const every = Math.max(1, Math.ceil(rows.length / 288));
  const trend = rows.filter((_, i) => i % every === 0).map((x) => ({
    at: x.at, availPct: x.availPct, swapGB: Math.round(x.swapUsedMB / 102.4) / 10, editors: x.editors?.length ?? 0, pressure: x.pressure,
  }));
  return {
    at: new Date().toISOString(),
    installed: fs.existsSync(path.join(HOME, 'Library', 'LaunchAgents', 'com.agents.res-guard.plist')),
    lastTick: st.lastTick ?? null,
    stale: !st.lastTick || Date.now() - Date.parse(st.lastTick) > RG_STALE_MS,
    last: st.last ?? null,
    alerts: st.alerts ?? [],
    editors: st.editorVerdicts ?? [],
    omniroute: st.omniroute ?? null,
    trend,
    events: tail(readJsonl(path.join(CFG.resGuardHome, 'logs', 'res-guard.jsonl')), 40).reverse(),
  };
}

/** The checks of one manual-deferred.json still waiting: none once the director signed them off. */
const openDeferred = (file) => {
  const d = readJson(file);
  return d?.signed_off ? [] : deferredItems(d);
};

/**
 * manual-deferred.json is written by agents in several shapes ({items:[string]},
 * {items:[{item|row|check, reason}]}, the same objects as JSON strings, {status, reason, items:[...]}):
 * one readable line per item.
 */
export function deferredItems(d) {
  if (!d || typeof d !== 'object') return [];
  const raw = Array.isArray(d) ? d : Array.isArray(d.items) ? d.items : Array.isArray(d.items?.items) ? d.items.items : [];
  return raw.flatMap((x) => {
    // an item some agents wrote as a JSON string ('{"row":"…","reason":"…"}') reads like an object
    if (typeof x === 'string' && /^\s*\{/.test(x)) x = safe(() => JSON.parse(x)) ?? x;
    if (typeof x === 'string') return x.trim() ? [x.trim()] : [];
    if (!x || typeof x !== 'object') return [];
    const what = x.item ?? x.row ?? x.check ?? x.text ?? x.name ?? null;
    if (!what) return [JSON.stringify(x)];
    return [x.reason ? `${what} (${x.reason})` : String(what)];
  });
}

// ------------------------------------------------------------------ memory, pilot, playbook

export function memory() {
  const home = memHome();
  const records = om.archive.loadArchive();
  const count = (f) => records.reduce((m, r) => ((m[f(r)] = (m[f(r)] ?? 0) + 1), m), {});
  return {
    modes: om.config.loadConfig().projects.map((p) => ({ id: p.project_id, mode: p.memory.mode, data_owner: p.data_owner, notes: p.notes ?? null })),
    archive: { records: records.length, by_project: count((r) => r.project_id), by_lifecycle: count((r) => r.lifecycle), by_kind: count((r) => r.kind) },
    refresh: readJson(path.join(home, 'reports', 'refresh-latest.json')),
    refresh_log: tail(readJsonl(path.join(home, 'reports', 'refresh-log.jsonl')), 10).reverse(),
    hook_log: tail(readJsonl(path.join(home, 'pilot', 'hook-log.jsonl')), 40).reverse(),
    mode_log: tail(readJsonl(path.join(home, 'config', 'mode-log.jsonl')), 20).reverse(),
  };
}

export function searchRecords(q = '', project = '') {
  const needle = q.toLowerCase();
  return om.archive.loadArchive()
    .filter((r) => (!project || r.project_id === project) && (!needle || r.record_id.toLowerCase().includes(needle) || r.claim.toLowerCase().includes(needle) || (r.topic ?? '').includes(needle)))
    .slice(0, 100)
    .map((r) => ({ record_id: r.record_id, kind: r.kind, topic: r.topic, lifecycle: r.lifecycle, claim: r.claim.slice(0, 240) }));
}

export function record(id) {
  const r = om.archive.loadArchive().find((x) => x.record_id === id);
  if (!r) throw new Error(`no record ${id}`);
  return r;
}

export function pilotReport(id) {
  const desc = om.config.loadConfig().projects.find((p) => p.project_id === id);
  if (!desc) throw new Error(`${id} is not registered with orca-memory`);
  return om.pilot.pilotReport(desc);
}

// ------------------------------------------------------------------ judge draft: what each row means

const VI_RETRY_MS = 10 * 60 * 1000;
const viJobs = new Map(); // cache key → the translate call in flight
const viDir = () => env.CONSOLE_VI_CACHE ?? path.join(HOME, '.agents/run/director-console-vi');
let pilotCache = new Map(); // project → { at, report }

function claudeEnv() {
  const f = env.PRODUCER_RUNNER_CLAUDE_SETTINGS || path.join(HOME, '.claude', 'settings.json');
  const e = readJson(f)?.env;
  return e && typeof e === 'object' ? Object.fromEntries(Object.entries(e).map(([k, v]) => [k, String(v)])) : {};
}

/** One `claude -p` call with the runner translator's flags (no tools, no hooks, no project CLAUDE.md) → { out } | { error }. */
function claudeStructured(prompt, schema, { model = 'sonnet', role = 'translate', timeoutMs = 120000 } = {}) {
  const args = ['-p', '--output-format', 'json', '--model', model, '--restricted', '--tools', '', '--strict-mcp-config',
    '--disable-slash-commands', '--permission-prompts', 'none', '--json-schema', JSON.stringify(schema)];
  return new Promise((resolve) => {
    let out = ''; let err = ''; let done = false;
    const finish = (v) => { if (!done) { done = true; clearTimeout(timer); resolve(v); } };
    let child;
    try { child = spawn(env.PRODUCER_RUNNER_TRANSLATE_CMD || 'claude', args, { cwd: os.tmpdir(), env: { ...env, ...claudeEnv(), CC_ROLE: role }, stdio: ['pipe', 'pipe', 'pipe'] }); } catch (e) { resolve({ error: e.code || 'spawn' }); return; }
    const timer = setTimeout(() => { child.kill(); finish({ error: 'ETIMEDOUT' }); }, timeoutMs);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => finish({ error: e.code || 'spawn' }));
    child.on('close', (code) => {
      let j = null;
      try { j = JSON.parse(out); } catch { j = null; }
      if (j && !j.is_error && j.structured_output) finish({ out: j.structured_output });
      else finish({ error: `${code !== 0 ? `exit ${code}` : 'no valid JSON'}${err ? `: ${err.trim().slice(-160)}` : ''}` });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(prompt);
  });
}

/** One `claude -p` sonnet call → the rows in Vietnamese, or { error }. */
async function translateRows(items) {
  const schema = {
    type: 'object', required: ['rows'],
    properties: { rows: { type: 'array', items: { type: 'object', required: ['n', 'claim', 'evidence'], properties: { n: { type: 'integer' }, claim: { type: 'string' }, evidence: { type: 'string' } } } } },
  };
  const prompt = [
    'Translate into Vietnamese the rows below for a game-production director who judges whether a memory lesson helped an agent.',
    'Keep file paths, line refs like "notes.md:92", slice ids (S08), numbers, code, identifiers and the names inside backticks exactly as written. Plain natural sentences; do not add advice or opinions.',
    `Return JSON { rows } with exactly ${items.length} entries in the given order: { n, claim: the lesson in Vietnamese (at most 400 characters; shorten but keep every condition and number), evidence: the judge's evidence in Vietnamese, whole }. An empty input stays "".`,
    '', ...items.map((it, i) => `--- ${i + 1}\nLESSON: ${it.claim}\nEVIDENCE: ${it.evidence}`),
  ].join('\n');
  const r = await claudeStructured(prompt, schema);
  const rows = r.out?.rows;
  const ok = Array.isArray(rows) && rows.length === items.length && rows.every((x, i) => Number(x.n) === i + 1 && typeof x.claim === 'string' && typeof x.evidence === 'string');
  return ok ? { rows: rows.map((x) => ({ claim: x.claim.trim(), evidence: x.evidence.trim() })) } : { error: r.error ?? 'rows do not match' };
}

// ------------------------------------------------------------------ agent questions: quick replies

const suggestJobs = new Map(); // question id → the claude call in flight

/**
 * Quick replies for an agent's plain-text question: the rule-based ones (tools/agent-questions
 * quickReplies) at once, then 2–4 from one `claude -p` haiku call made in the background and cached
 * on disk by question id. → { state, source, replies: [{ label, text }] }
 */
function quickRepliesFor(q) {
  const rules = aq.quickReplies(q.text);
  const file = path.join(viDir(), `suggest-${aq.safeId(q.id)}.json`);
  const cached = readJson(file);
  if (cached?.replies?.length) return { state: 'ok', source: 'llm', replies: cached.replies };
  if (cached?.failed && Date.now() - Date.parse(cached.at) < VI_RETRY_MS) return { state: 'failed', source: 'rules', replies: rules, error: cached.failed };
  if (env.CONSOLE_TRANSLATE === 'off' || env.CONSOLE_SUGGEST === 'off') return { state: 'off', source: 'rules', replies: rules };
  if (!suggestJobs.has(q.id)) {
    const schema = { type: 'object', required: ['replies'], properties: { replies: { type: 'array', items: { type: 'object', required: ['label', 'text'], properties: { label: { type: 'string' }, text: { type: 'string' } } } } } };
    const prompt = [
      'An AI coding agent ended its turn with a question for the director, a game producer. Suggest the 2 to 4 replies the director is most likely to send, the most likely first.',
      'Write them in the language of the agent\'s message. Each reply has a label (at most 5 words, for a button) and a text (the exact message sent to the agent: one short sentence that names the option or action, e.g. "Commit đi" or "Chọn phương án 2: chia 3 slice").',
      'If the message offers explicit options, give one reply per option (at most 4). Do not invent facts, file names or numbers the message does not contain. Return JSON { replies }.',
      '', '--- AGENT MESSAGE (its end)', String(q.text).slice(-3000),
    ].join('\n');
    suggestJobs.set(q.id, claudeStructured(prompt, schema, { model: 'haiku', role: 'suggest', timeoutMs: 60000 }).then((r) => {
      const replies = (r.out?.replies ?? []).filter((x) => typeof x?.label === 'string' && typeof x?.text === 'string' && x.label.trim() && x.text.trim())
        .slice(0, 4).map((x) => ({ label: x.label.trim().slice(0, 48), text: x.text.trim().slice(0, 600) }));
      fs.mkdirSync(viDir(), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(replies.length ? { replies, at: new Date().toISOString() } : { failed: r.error ?? 'no replies', at: new Date().toISOString() }));
    }).catch(() => {}).finally(() => suggestJobs.delete(q.id)));
  }
  return { state: 'pending', source: 'rules', replies: rules };
}

/** Vietnamese claim + evidence for each row, cached on disk by content; started in the background → { state, rows?, error? }. */
function draftTranslation(items) {
  const key = crypto.createHash('sha256').update(JSON.stringify(items)).digest('hex').slice(0, 16);
  const file = path.join(viDir(), `draft-${key}.json`);
  const cached = readJson(file);
  if (cached?.rows?.length === items.length) return { state: 'ok', rows: cached.rows };
  if (cached?.failed && Date.now() - Date.parse(cached.at) < VI_RETRY_MS) return { state: 'failed', error: cached.failed };
  if (viJobs.has(key)) return { state: 'translating' };
  if (env.CONSOLE_TRANSLATE === 'off') return { state: 'off' };
  viJobs.set(key, translateRows(items).then((r) => {
    fs.mkdirSync(viDir(), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(r.rows ? { rows: r.rows, at: new Date().toISOString() } : { failed: r.error, at: new Date().toISOString() }));
  }).catch(() => {}).finally(() => viJobs.delete(key)));
  return { state: 'translating' };
}

/**
 * What a draft's rows mean, from the archive and the pilot report: the lesson itself (claim,
 * conditions), where it came from, whether the slice's own notes cite it, whether the agent saw it
 * at all (a shadow pack is measured, never shown), plus the Vietnamese claim and evidence.
 */
export function draftInfo(project, slice) {
  if (!/^[A-Za-z0-9][\w.-]*$/.test(project ?? '') || !/^S\d+[a-z]?$/i.test(slice ?? '')) throw new Error('bad project or slice');
  const d = readJson(path.join(memHome(), 'reports', 'judge-drafts', project, `${slice}.json`));
  if (!d) throw new Error(`no draft for ${project} ${slice}`);
  const byId = new Map(om.archive.loadArchive().map((r) => [r.record_id, r]));
  let pilot = pilotCache.get(project);
  if (!pilot || Date.now() - pilot.at > 60000) {
    pilot = { at: Date.now(), report: safe(() => pilotReport(project)) };
    pilotCache.set(project, pilot);
  }
  const sl = pilot.report?.slices?.find((x) => x.slice === slice) ?? null;
  const cited = new Set(sl?.cited_ids ?? []);
  const rows = (d.rows ?? []).map((r) => {
    const rec = byId.get(r.record);
    return {
      stage: r.stage, record: r.record, found: !!rec,
      claim: rec?.claim ?? null, kind: rec?.kind ?? null, topic: rec?.topic ?? null, lifecycle: rec?.lifecycle ?? null,
      conditions: rec?.conditions ?? null, limitations: rec?.limitations ?? null, observed_at: rec?.observed_at ?? null,
      sources: (rec?.source_refs ?? []).map((x) => x.uri).slice(0, 3),
      cited: cited.has(r.record),
    };
  });
  const tr = draftTranslation(rows.map((x, i) => ({ claim: (x.claim ?? '').slice(0, 800), evidence: String(d.rows[i].evidence ?? '').slice(0, 700) })));
  return {
    project, slice, phase: sl?.phase ?? null, merged: sl?.merged ?? null, injected_tokens: sl?.memory?.injected_tokens ?? null,
    rows: rows.map((x, i) => ({ ...x, vi: tr.rows ? tr.rows[i] : null })),
    vi_state: tr.state, vi_error: tr.error ?? null,
  };
}

export function playbook() {
  const reg = readJson(path.join(CFG.playbook, 'registry.json'), { recipes: [] });
  const kits = readJson(path.join(CFG.playbook, 'kits', 'registry.json'), null);
  return { library: reg.library ?? null, recipes: reg.recipes ?? [], kits };
}

/** A recipe's markdown, only from inside the playbook root. */
export function recipeText(rel) {
  const root = fs.realpathSync(CFG.playbook);
  const file = fs.realpathSync(path.resolve(root, rel));
  if (!file.startsWith(root + path.sep) || !file.endsWith('.md')) throw new Error('outside the playbook');
  return fs.readFileSync(file, 'utf8');
}

// ------------------------------------------------------------------ previews

const EDITOR_CMD = /\/CocosCreator\.app\/Contents\/MacOS\/CocosCreator(?:\s|$)/;
const previewPorts = new Map(); // editor pid → its preview port, found once with lsof + a probe

/** Running Cocos Creator 3.x editors: pid, checkout, minutes up. `--project <path>` runs to the next ` --flag`. */
export function editorsFromPs(text) {
  return text.split('\n').flatMap((line) => {
    const m = /^\s*(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (!m || !EDITOR_CMD.test(m[3])) return [];
    const dir = /--project[= ]+(.+?)(?=\s+--|$)/.exec(m[3])?.[1].trim();
    return dir ? [{ pid: Number(m[1]), path: dir, up_min: Math.round(etimeSec(m[2]) / 60) }] : [];
  });
}
const etimeSec = (t) => {
  const [d, rest] = t.includes('-') ? t.split('-') : [0, t];
  return Number(d) * 86400 + rest.split(':').map(Number).reduce((a, x) => a * 60 + x, 0);
};

/** The orientation a project is built for: AGENT_NOTES `orientation:`, else the design resolution. */
export function orientationOf(dir) {
  const notes = safe(() => fs.readFileSync(path.join(dir, 'AGENT_NOTES.md'), 'utf8')) ?? '';
  const m = /^\s*orientation:\s*(portrait|landscape)\b/m.exec(notes);
  if (m) return { value: m[1], source: 'AGENT_NOTES.md' };
  const d = readJson(path.join(dir, 'settings', 'v2', 'packages', 'project.json'))?.general?.designResolution;
  if (d?.width && d?.height) return { value: d.width > d.height ? 'landscape' : 'portrait', source: `designResolution ${d.width}x${d.height}` };
  return { value: 'portrait', source: 'default' };
}

/** Which console project a checkout belongs to: its main path, or an Orca worktree <workspaces>/<project>/<name>. */
export function checkoutOf(dir, ps) {
  const r = real(dir);
  const main = ps.find((p) => real(p.path) === r);
  if (main) return { project: main.id, checkout: 'main' };
  const rel = path.relative(real(CFG.workspaces), r).split(path.sep);
  if (rel.length === 2 && !rel[0].startsWith('..')) return { project: ps.find((p) => p.id === rel[0] || path.basename(p.path) === rel[0])?.id ?? rel[0], checkout: rel[1] };
  return { project: path.basename(r), checkout: 'main' };
}

/**
 * GET / of a port: the Creator preview page answers 200 with "<title>Cocos Creator - …". No keep-alive:
 * an open connection into the editor would read as a client to res-guard.
 */
function probePreview(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/', agent: false, headers: { connection: 'close' }, timeout: 1500 }, (res) => {
      let t = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { if (t.length < 4096) t += c; });
      res.on('end', () => resolve(res.statusCode === 200 && /<title>Cocos Creator\b/.test(t)));
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(false));
  });
}

function listenPorts(pid) {
  // launchd's PATH has no /usr/sbin
  const r = spawnSync(fs.existsSync('/usr/sbin/lsof') ? '/usr/sbin/lsof' : 'lsof', ['-nP', '-a', '-p', String(pid), '-iTCP', '-sTCP:LISTEN', '-Fn'], { encoding: 'utf8', timeout: 5000 });
  return [...new Set((r.stdout || '').split('\n').filter((l) => l.startsWith('n')).map((l) => Number(l.split(':').pop())))].filter(Boolean);
}

/**
 * Every open Creator editor with its preview: live only when the editor runs and its preview page
 * answers now. The page frames http://127.0.0.1:<port>/ at the project's orientation.
 */
export async function previews() {
  const ps = projects();
  const r = spawnSync('ps', ['-axo', 'pid=,etime=,command='], { encoding: 'utf8', timeout: 5000, maxBuffer: 16 * 1024 * 1024 });
  const eds = editorsFromPs(r.stdout || '');
  for (const pid of previewPorts.keys()) if (!eds.some((e) => e.pid === pid)) previewPorts.delete(pid);
  return Promise.all(eds.map(async (e) => {
    let port = previewPorts.get(e.pid) ?? null;
    let alive = port ? await probePreview(port) : false;
    if (!alive) {
      port = null;
      for (const p of listenPorts(e.pid)) if (await probePreview(p)) { port = p; alive = true; break; }
      if (port) previewPorts.set(e.pid, port);
    }
    const p = ps.find((x) => x.id === checkoutOf(e.path, ps).project);
    const branch = safe(() => spawnSync('git', ['-C', e.path, 'branch', '--show-current'], { encoding: 'utf8', timeout: 3000 }).stdout.trim()) || null;
    return {
      ...e, ...checkoutOf(e.path, ps), branch, port, alive, url: port ? `http://127.0.0.1:${port}/` : null,
      orientation: orientationOf(e.path), runner: p?.runner ? { slice: p.runner.slice, step: p.runner.step, alive: p.runner.alive } : null,
    };
  }));
}

// ------------------------------------------------------------------ quota (OmniRoute accounts)

// OmniRoute holds the Claude, Codex and Antigravity accounts. `/api/usage/<connection>` answers each
// account's live quota windows; it wants OmniRoute's machine token (`x-omniroute-cli-token`, derived
// from a salt file only this user can read), which stays in this server. Its own snapshots in
// storage.sqlite are the fallback when OmniRoute does not answer: it refreshes only accounts in use,
// so an idle agy account's snapshot can be days old, and the page says how old.
const QUOTA_PROVIDERS = ['claude', 'codex', 'agy'];
const QUOTA_TTL_MS = { claude: 120000, codex: 120000, agy: 600000 }; // agy asks Google: ~4 s per account
const QUOTA_FORCE_MS = 60000;
const quotaCache = new Map(); // connection id → { at, live }
let quotaForcedAt = 0;
let omToken = null;

const sqliteJson = (db, sql) => {
  const r = spawnSync('sqlite3', ['-readonly', '-json', db, sql], { encoding: 'utf8', timeout: 15000, maxBuffer: 16 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`sqlite3: ${(r.stderr || '').trim().slice(0, 200)}`);
  return r.stdout.trim() ? JSON.parse(r.stdout) : [];
};

async function omnirouteToken() {
  if (env.CONSOLE_OMNIROUTE_TOKEN) return env.CONSOLE_OMNIROUTE_TOKEN;
  // node-machine-id runs `ioreg`, which lives in /usr/sbin: without it the token comes out empty
  if (!process.env.PATH?.split(':').includes('/usr/sbin')) process.env.PATH = `${process.env.PATH ?? ''}:/usr/sbin:/sbin`;
  if (!omToken) omToken = (await import(path.join(CFG.omnirouteCli, 'bin/cli/utils/cliToken.mjs'))).getCliToken();
  const t = await omToken;
  if (!t) { omToken = null; throw new Error('OmniRoute machine token unavailable'); }
  return t;
}

async function liveUsage(id) {
  const r = await fetch(`${CFG.omnirouteUrl}/api/usage/${encodeURIComponent(id)}`, {
    headers: { 'x-omniroute-cli-token': await omnirouteToken() }, signal: AbortSignal.timeout(20000),
  });
  const j = await r.json().catch(() => null);
  if (!r.ok || !j) throw new Error(j?.error?.message ?? j?.message ?? `OmniRoute ${r.status}`);
  return j;
}

/** One window as { remaining %, resetAt }: Claude and agy report remainingPercentage, Codex remaining/total. */
export function quotaWindow(q) {
  if (!q) return null;
  const pct = q.remainingPercentage ?? (q.total ? (q.remaining / q.total) * 100 : q.remaining);
  return Number.isFinite(pct) ? { remaining: Math.max(0, Math.min(100, Math.round(pct * 10) / 10)), resetAt: q.resetAt ?? null } : null;
}

/**
 * The windows the page shows. agy image: OmniRoute refuses an image request when either the model's
 * window (gemini-3.1-flash-image) or the Gemini family's weekly window is spent, so the usable share
 * is the smaller of the two.
 */
export function quotaView(provider, usage) {
  const q = usage?.quotas ?? {};
  if (provider === 'claude') return { session: quotaWindow(q['session (5h)']), weekly: quotaWindow(q['weekly (7d)']) };
  if (provider === 'codex') return { session: quotaWindow(q.session), weekly: quotaWindow(q.weekly) };
  const image = quotaWindow(q['gemini-3.1-flash-image']);
  const weekly = quotaWindow(q.gemini_weekly);
  const bind = image && weekly ? (weekly.remaining < image.remaining ? weekly : image) : image;
  return { image: bind ? { ...bind, model: image, weekly } : null };
}

/** The latest OmniRoute snapshot per window of each account, shaped like /api/usage's `quotas`. */
function snapshotUsage(db, ids) {
  if (!ids.length) return new Map();
  const list = ids.map((i) => `'${String(i).replace(/'/g, "''")}'`).join(',');
  const rows = sqliteJson(db, `select connection_id, window_key, remaining_percentage, next_reset_at, created_at from (
    select q.*, row_number() over (partition by connection_id, window_key order by created_at desc) rn from quota_snapshots q
    where connection_id in (${list})) where rn = 1`);
  const out = new Map();
  for (const r of rows) {
    const u = out.get(r.connection_id) ?? { quotas: {}, at: r.created_at };
    u.quotas[r.window_key] = { remainingPercentage: r.remaining_percentage, resetAt: r.next_reset_at };
    if (r.created_at > u.at) u.at = r.created_at;
    out.set(r.connection_id, u);
  }
  return out;
}

/**
 * Every Claude, Codex and agy account in OmniRoute with its quota: live when OmniRoute answers,
 * else its last snapshot (`source: snapshot`, `as_of`). An account switched off there
 * (`active: false`) is listed with its last snapshot and never asked. agy accounts are `valid` when they
 * report the image window and agy-rotate has not marked them invalid. `force` skips the cache, at
 * most once a minute.
 */
export async function quota({ force = false } = {}) {
  const db = path.join(CFG.omnirouteHome, 'storage.sqlite');
  if (!fs.existsSync(db)) return { at: new Date().toISOString(), error: `no OmniRoute database at ${db}`, claude: [], codex: [], agy: [] };
  const accounts = sqliteJson(db, `select id, provider, coalesce(email, display_name, name) as who, priority, is_active from provider_connections
    where provider in (${QUOTA_PROVIDERS.map((p) => `'${p}'`).join(',')}) order by provider, rowid`);
  const now = Date.now();
  if (force && now - quotaForcedAt >= QUOTA_FORCE_MS) quotaForcedAt = now;
  else force = false;
  const results = await Promise.all(accounts.map(async (a) => {
    if (!a.is_active) return { a }; // switched off in OmniRoute: listed with its last snapshot, never asked
    const c = quotaCache.get(a.id);
    if (!force && c && now - c.at < QUOTA_TTL_MS[a.provider]) return { a, live: c.live, at: c.at };
    try {
      const live = await liveUsage(a.id);
      quotaCache.set(a.id, { at: Date.now(), live });
      return { a, live, at: Date.now() };
    } catch (e) {
      return { a, error: e.message };
    }
  }));
  const missing = results.filter((r) => !r.live).map((r) => r.a.id);
  const snaps = safe(() => snapshotUsage(db, missing)) ?? new Map();
  const rotate = readJson(CFG.agyRotateState) ?? {};
  const out = { at: new Date(now).toISOString(), claude: [], codex: [], agy: [] };
  for (const r of results) {
    const usage = r.live ?? snaps.get(r.a.id) ?? null;
    const row = {
      id: r.a.id, who: r.a.who, plan: r.live?.plan ?? null, active: !!r.a.is_active,
      source: r.live ? 'live' : usage ? 'snapshot' : 'none', as_of: r.live ? new Date(r.at).toISOString() : usage?.at ?? null,
      error: r.error ?? null, ...quotaView(r.a.provider, usage),
    };
    if (r.a.provider === 'agy') {
      const until = rotate.invalid?.[r.a.who];
      const invalid = until && Date.parse(until) > now;
      row.valid = row.active && !!row.image && !invalid;
      row.why = !row.active ? 'tắt trong OmniRoute' : invalid ? `agy-rotate: invalid tới ${until}` : row.image ? null : 'không báo quota ảnh';
    }
    out[r.a.provider].push(row);
  }
  return out;
}

// ------------------------------------------------------------------ actions

const OM_CLI = () => path.join(CFG.omSrc, 'cli.ts');
const RUNNER = () => path.join(CFG.runnerDir, 'producer-runner.mjs');
const need = (v, name) => {
  if (typeof v !== 'string' || !v.trim()) throw new Error(`${name} is required`);
  return v;
};

/** Allowlisted actions → the CLI argv each one runs. Nothing else can be run. */
const ACTIONS = {
  'runner.answer': (b) => {
    const p = findProject(b.project);
    return [RUNNER(), 'answer', '--project', p.path, '--id', need(b.id, 'id'), '--choice', need(b.choice, 'choice'), ...(b.text ? ['--text', String(b.text)] : [])];
  },
  'runner.control': (b) => {
    const p = findProject(b.project);
    if (b.cmd === 'stop-after') return [RUNNER(), 'stop-after', need(b.slice, 'slice'), '--project', p.path];
    if (!['pause', 'stop', 'clear'].includes(b.cmd)) throw new Error('cmd must be pause|stop|clear|stop-after');
    return [RUNNER(), b.cmd, '--project', p.path];
  },
  'memory.mode': (b) => [OM_CLI(), 'mode', '--project', need(b.project, 'project'), need(b.mode, 'mode'), '--note', need(b.note, 'note')],
  'memory.promote': (b) => [OM_CLI(), 'promote', need(b.record, 'record'), '--to', need(b.to, 'to'), '--note', need(b.note, 'note')],
  'memory.retract': (b) => [OM_CLI(), 'retract', need(b.record, 'record'), '--note', need(b.note, 'note')],
  'memory.refresh': () => [OM_CLI(), 'refresh'],
  // the runner writes `signed_off` into the slice's manual-deferred.json (done or waived)
  'manual.signoff': (b) => {
    const p = findProject(b.project);
    if (!['done', 'waived'].includes(b.how)) throw new Error('how must be done|waived');
    return [RUNNER(), 'sign-off', need(b.slice, 'slice'), '--note', `${b.how}: ${need(b.note, 'note')}`, '--project', p.path];
  },
  'triage.dismiss': (b) => [OM_CLI(), 'dismiss', need(b.source, 'source'), '--note', need(b.note, 'note')],
  // res-guard closes only a Creator running on exactly that checkout (close-editor.sh, then SIGTERM)
  'editor.close': (b) => {
    const p = need(b.project, 'project');
    if (!path.isAbsolute(p)) throw new Error('project must be an absolute path');
    return [CFG.resGuardCli, 'close-editor', '--project', p, '--reason', 'director console'];
  },
  'draft.apply': (b) => {
    // the person's edits (verdict, confirmed) go into the draft first; apply-draft writes the ledger
    const root = fs.realpathSync(path.join(memHome(), 'reports', 'judge-drafts'));
    const file = fs.realpathSync(need(b.file, 'file'));
    if (!file.startsWith(root + path.sep) || !file.endsWith('.json')) throw new Error('not a judge draft');
    const d = readJson(file);
    if (!d || d.applied_at) throw new Error('draft missing or already applied');
    const edits = new Map((b.rows ?? []).map((r) => [`${r.stage}|${r.record}`, r]));
    d.rows = d.rows.map((r) => {
      const e = edits.get(`${r.stage}|${r.record}`);
      if (!e) return r;
      if (e.verdict && !om.pilot.VERDICTS.includes(e.verdict)) throw new Error(`bad verdict ${e.verdict}`);
      return { ...r, verdict: e.verdict ?? r.verdict, confirmed: !!e.confirmed, ...(e.verdict && e.verdict !== r.verdict ? { edited_by: 'director-console' } : {}) };
    });
    om.util.writeAtomic(file, JSON.stringify(d, null, 2) + '\n');
    return [OM_CLI(), 'pilot', 'apply-draft', '--file', file];
  },
  // tools/agent-questions types the answer into the agent's own Orca terminal
  'agent.answer': (b) => {
    const picks = (b.picks ?? []).map((p) => `${Number(p.n)}=${need(p.label, 'label')}`);
    return [AQ_CLI(), 'answer', '--id', need(b.id, 'id'), ...picks.flatMap((p) => ['--pick', p]), ...(b.text ? ['--text', String(b.text)] : [])];
  },
  'agent.dismiss': (b) => [AQ_CLI(), 'dismiss', '--id', need(b.id, 'id'), '--note', need(b.note, 'note')],
  'agent.focus': (b) => [AQ_CLI(), 'focus', '--id', need(b.id, 'id')],
  // tools/boot-idea starts the orca-global session; the page's images are staged for it to move
  'boot.idea': (b) => {
    const opt = (k, flag) => (b[k] ? [flag, String(b[k])] : []);
    const dir = stageImages(b.images ?? []);
    return [CFG.bootIdea, '--source', need(b.source, 'source'), '--text', String(b.text ?? ''), ...opt('link', '--link'), ...opt('slug', '--slug'),
      ...opt('template', '--template'), ...opt('brief', '--brief'), ...opt('goal', '--goal'), ...opt('deploy', '--deploy'), ...opt('memory', '--memory'),
      ...opt('impl_agent', '--impl-agent'), ...opt('agent', '--agent'), ...(dir ? ['--images-dir', dir] : [])];
  },
};
const AQ_CLI = () => path.join(CFG.agentQuestions, 'agent-questions.mjs');

const MAGIC = [[/\.png$/i, [0x89, 0x50, 0x4e, 0x47]], [/\.jpe?g$/i, [0xff, 0xd8, 0xff]], [/\.gif$/i, [0x47, 0x49, 0x46]], [/\.webp$/i, [0x52, 0x49, 0x46, 0x46]]];

/** The page's images ([{name, data: base64}], ≤ 10, ≤ 12 MB each, real image bytes) in a fresh staging dir. → dir | null */
export function stageImages(images) {
  if (!Array.isArray(images) || !images.length) return null;
  if (images.length > 10) throw new Error('at most 10 images');
  const dir = path.join(CFG.uploads, `${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`);
  fs.mkdirSync(dir, { recursive: true });
  images.forEach((im, i) => {
    const base = path.basename(String(im?.name ?? '')).replace(/[^\w.-]+/g, '_').replace(/^\.+/, '') || `image-${i + 1}.png`;
    const magic = MAGIC.find(([re]) => re.test(base));
    const buf = Buffer.from(String(im?.data ?? '').replace(/^data:[^,]*,/, ''), 'base64');
    if (!magic || buf.length < 8 || !magic[1].every((x, k) => buf[k] === x)) throw new Error(`${base} is not a png/jpg/gif/webp image`);
    if (buf.length > 12 * 1024 * 1024) throw new Error(`${base} is over 12 MB`);
    fs.writeFileSync(path.join(dir, `${String(i + 1).padStart(2, '0')}-${base}`), buf);
  });
  return dir;
}
export const ACTION_NAMES = Object.keys(ACTIONS);

const ACTION_TIMEOUT = { 'memory.refresh': 600000, 'boot.idea': 240000 };

/** Run one allowlisted CLI without blocking the server (a boot waits up to 90 s for its session). */
export async function runAction(name, body = {}) {
  const build = ACTIONS[name];
  if (!build) throw Object.assign(new Error(`unknown action ${name}`), { status: 404 });
  const argv = build(body);
  const r = await new Promise((resolve) => {
    let stdout = ''; let stderr = '';
    const child = spawn(process.execPath, argv, { stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => child.kill(), ACTION_TIMEOUT[name] ?? 120000);
    child.stdout.on('data', (d) => { if (stdout.length < 16 * 1024 * 1024) stdout += d; });
    child.stderr.on('data', (d) => { if (stderr.length < 1024 * 1024) stderr += d; });
    child.on('error', (e) => { clearTimeout(timer); resolve({ status: null, stdout, stderr: stderr + e.message }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ status: code, stdout, stderr }); });
  });
  const out = (r.stdout ?? '').trim();
  const err = (r.stderr ?? '').trim();
  const result = { ok: r.status === 0, code: r.status, out: safe(() => JSON.parse(out)) ?? out.slice(-4000), err: err.slice(-2000) || null };
  fs.mkdirSync(CFG.logs, { recursive: true });
  // a boot's images are bytes, not audit: the log keeps their names
  const logged = body.images ? { ...body, images: body.images.map((im) => im?.name ?? '?') } : body;
  fs.appendFileSync(path.join(CFG.logs, 'director-console.jsonl'), JSON.stringify({ at: new Date().toISOString(), action: name, body: logged, argv: argv.slice(1), code: r.status, out: out.slice(-500), err: err.slice(-300) || null }) + '\n');
  return result;
}
export function actionLog(n = 30) {
  return tail(readJsonl(path.join(CFG.logs, 'director-console.jsonl')), n).reverse();
}
