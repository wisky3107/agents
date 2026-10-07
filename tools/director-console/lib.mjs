// Director console data layer. Reads come straight from the systems' own modules and files
// (orca-memory src, the game-producer runner's state.mjs/project.mjs, the cocos-playbook
// registries, Orca's terminal list). Writes go only through the systems' own CLIs, one allowlisted
// action each, so every decision keeps its audit trail (mode-log, ledger, curation, runner answers)
// and the console can do nothing the CLIs would refuse. Every action is logged to
// <logs>/director-console.jsonl.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const HOME = os.homedir();
const env = process.env;
export const CFG = {
  gamesRoot: env.CONSOLE_GAMES_ROOT ?? path.join(HOME, 'Works/games/CocosCreator'),
  runnerDir: env.CONSOLE_RUNNER_DIR ?? path.join(HOME, '.agents/skills/game-producer/scripts'),
  omSrc: env.CONSOLE_ORCA_MEMORY_SRC ?? path.join(HOME, 'Works/agent/orca-memory/src'),
  playbook: env.CONSOLE_PLAYBOOK ?? path.join(HOME, 'Works/games/cocos-playbook'),
  orcaBin: env.CONSOLE_ORCA_BIN ?? 'orca',
  logs: env.CONSOLE_LOG_DIR ?? path.join(HOME, '.agents/logs'),
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
  return [...byPath.values()].map((p) => ({ ...p, runner: runnerOf(p.path) })).sort((a, b) => a.id.localeCompare(b.id));
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
      manual_deferred: deferredItems(readJson(path.join(ev, 'manual-deferred.json'))),
      memory: pilot ? { phase: pilot.phase, packs: pilot.memory.packs, injected_tokens: pilot.memory.injected_tokens, cited: pilot.cited_ids, verdicts: pilot.verdicts, unjudged: pilot.unjudged_items } : null,
    };
  });
  const terminals = orcaTerminals().filter((t) => (t.worktreePath ?? '').includes(path.basename(p.path)))
    .map((t) => ({ handle: t.handle, title: t.title, worktree: t.worktreePath, agent: t.agentIdentity ?? null, connected: t.connected, last_output_at: t.lastOutputAt ?? null, preview: (t.preview ?? '').slice(-600) }));
  return { ...p, release: release ? { goal: release.goal ?? null, current_slice: release.current_slice ?? null } : null, slices, terminals };
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

/** Everything that waits on the director, across systems. */
export function pending() {
  const ps = projects();
  const questions = ps.flatMap((p) => {
    if (!p.runner) return [];
    return (runnerState.readRunner(p.path).questions ?? []).filter((q) => !q.answer).map((q) => ({
      project: p.id, id: q.id, kind: q.kind, slice: q.slice ?? null, asked_at: q.asked_at, text: q.text, detail: q.detail ?? null,
      options: (q.options ?? []).map((o) => ({ choice: o, note: runnerAnswer.textNeed(q, o) })),
    }));
  });
  const home = memHome();
  const draftRoot = path.join(home, 'reports', 'judge-drafts');
  const drafts = (fs.existsSync(draftRoot) ? fs.readdirSync(draftRoot) : []).flatMap((proj) =>
    fs.readdirSync(path.join(draftRoot, proj)).filter((f) => f.endsWith('.json')).map((f) => readJson(path.join(draftRoot, proj, f))).filter((d) => d && !d.applied_at));
  const refresh = readJson(path.join(home, 'reports', 'refresh-latest.json'));
  const ageH = refresh ? (Date.now() - Date.parse(refresh.at)) / 3600000 : null;
  const deferred = ps.flatMap((p) => {
    const tasks = path.join(p.path, '.cursor', 'evidence', 'tasks');
    if (!fs.existsSync(tasks)) return [];
    return fs.readdirSync(tasks).filter((t) => /^T-S\d+/.test(t)).sort((a, b) => sliceOrder(a.slice(2), b.slice(2))).flatMap((t) => {
      const items = deferredItems(readJson(path.join(tasks, t, 'evidence', 'manual-deferred.json')));
      return items.length ? [{ project: p.id, slice: t.slice(2), items }] : [];
    });
  });
  const unregistered = safe(() => om.hook.findUnregistered(om.config.loadConfig()).filter((u) => u.active)) ?? [];
  return {
    questions, drafts,
    triage: refresh?.triage_open ?? [],
    refresh: refresh ? { at: refresh.at, ok: refresh.ok, failed_step: refresh.failed_step, stale: ageH > 48 } : null,
    manual_deferred: deferred, unregistered,
  };
}

/**
 * manual-deferred.json is written by agents in several shapes ({items:[string]},
 * {items:[{item|row|check, reason}]}, {status, reason, items:[...]}): one readable line per item.
 */
export function deferredItems(d) {
  if (!d || typeof d !== 'object') return [];
  const raw = Array.isArray(d) ? d : Array.isArray(d.items) ? d.items : Array.isArray(d.items?.items) ? d.items.items : [];
  return raw.flatMap((x) => {
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
  'triage.dismiss': (b) => [OM_CLI(), 'dismiss', need(b.source, 'source'), '--note', need(b.note, 'note')],
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
};
export const ACTION_NAMES = Object.keys(ACTIONS);

export function runAction(name, body = {}) {
  const build = ACTIONS[name];
  if (!build) throw Object.assign(new Error(`unknown action ${name}`), { status: 404 });
  const argv = build(body);
  const r = spawnSync(process.execPath, argv, { encoding: 'utf8', timeout: name === 'memory.refresh' ? 600000 : 120000, maxBuffer: 16 * 1024 * 1024 });
  const out = (r.stdout ?? '').trim();
  const err = (r.stderr ?? '').trim();
  const result = { ok: r.status === 0, code: r.status, out: safe(() => JSON.parse(out)) ?? out.slice(-4000), err: err.slice(-2000) || null };
  fs.mkdirSync(CFG.logs, { recursive: true });
  fs.appendFileSync(path.join(CFG.logs, 'director-console.jsonl'), JSON.stringify({ at: new Date().toISOString(), action: name, body, argv: argv.slice(1), code: r.status, out: out.slice(-500), err: err.slice(-300) || null }) + '\n');
  return result;
}

export function actionLog(n = 30) {
  return tail(readJsonl(path.join(CFG.logs, 'director-console.jsonl')), n).reverse();
}
