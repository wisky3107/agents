/**
 * Fleet driver: runs fleet-dag.mjs against Orca from the runner's own terminal, which is the Run's
 * coordinator (plan 2026-10-16-fleet-script-coordinator, M0 proved a plain process may hold a Run).
 * Every action is intent → act → record in `fleet-driver.json`, so a kill at any point is reconciled
 * from Orca (task-list by title, dispatch-show) instead of creating or dispatching twice.
 *
 * ctx: { sliceDir, checkout, evidenceRoot (abs), run, worktree (orca selector of the feature worktree),
 *        cfg (fleet-dag cfg), values (base spec values), sliceAssets ({2d,3d,vfx,audio}), manifestPath,
 *        slicePaths ({code, scene}), slug, memory ({ role: path }), waitMs, io, ask(q), log(msg) }
 * A question is { kind, ref, text, options }: kept in `pending` (so a kill cannot lose it) and passed to ctx.ask
 * when given; the runner asks it and calls answer(ctx, ref, choice, text), which drops it from `pending`.
 */
import fs from 'node:fs';
import path from 'node:path';
import * as orca from './orca.mjs';
import { initial, step } from './fleet-dag.mjs';
import { render } from '../../../cocos-orca-fleet/scripts/spec-templates.mjs';
import { checkReview } from '../../../cocos-orca-fleet/scripts/review-check.mjs';

const FILE = 'fleet-driver.json';
const fresh = () => ({ dag: null, tasks: {}, seen: [], delivery: null, starts: {}, retained: [], chainLast: null, pending: [] });

export function load(ctx) {
  try { return { ...fresh(), ...JSON.parse(fs.readFileSync(path.join(ctx.sliceDir, FILE), 'utf8')) }; } catch { return fresh(); }
}
function save(ctx, d) {
  const f = path.join(ctx.sliceDir, FILE);
  fs.writeFileSync(f + '.tmp', JSON.stringify(d, null, 2));
  fs.renameSync(f + '.tmp', f);
}

/** One driver turn: start the DAG once, then one inbox wait. → { waited, phase } */
export function tick(ctx) {
  const d = load(ctx);
  if (!d.dag) { d.dag = initial(); save(ctx, d); feed(ctx, d, { type: 'start' }); return { waited: false, phase: d.dag.phase }; }
  resume(ctx, d);
  const r = (ctx.io ?? orca).runCheck({ run: ctx.run, ack: d.delivery, waitMs: ctx.waitMs ?? 60000 });
  if (!r.ok) { ctx.log?.(`fleet-driver: check failed: ${r.error}`); return { waited: true, phase: d.dag.phase, error: r.error }; }
  d.delivery = null;
  for (const m of r.messages) {
    if (d.seen.includes(m.id)) continue;
    const name = taskOf(d, m);
    if (!name) { ctx.log?.(`fleet-driver: ${m.type} ${m.id} from an unknown dispatch ${m.dispatch}, ignored`); d.seen.push(m.id); continue; }
    const e = m.type === 'worker_done' ? { type: 'done', task: name, outcome: m.outcome ?? 'failed', body: m.body }
      : { type: m.type === 'question' ? 'question' : 'escalation', task: name, msgId: m.id, text: m.question ?? m.body, options: m.options };
    feed(ctx, d, e);
    d.seen.push(m.id);
  }
  d.delivery = r.delivery; // acked on the next wait, after every message of this batch is recorded
  save(ctx, d);
  return { waited: true, phase: d.dag.phase };
}

/**
 * The runner's answer to a driver question. Driver-level refs (a start, the manifest, infra) are handled
 * here; every other ref belongs to the DAG.
 */
export function answer(ctx, ref, choice, text = '') {
  const d = load(ctx);
  d.pending = d.pending.filter((q) => q.ref !== ref);
  const [kind, k] = [ref.split(':')[0], ref.slice(ref.indexOf(':') + 1)];
  if (/^stop$/i.test(choice) && ['spec', 'create', 'reuse', 'start', 'manifest', 'infra'].includes(kind)) {
    d.dag.phase = 'stopped';
    writeHandoff(ctx, { status: 'blocked', detail: `stopped at ${ref}` });
  } else if (['spec', 'create', 'reuse', 'start'].includes(kind)) startTask(ctx, d, k.split('#')[0]);
  else if (kind === 'manifest') { const e = manifestEvent(ctx, d); if (e) feed(ctx, d, e); }
  else if (kind === 'infra') feed(ctx, d, { type: 'infra_resolved', reviewer: text.trim() || null });
  else feed(ctx, d, { type: 'answer', ref, choice, text });
  save(ctx, d);
  return d.dag.phase;
}
export const commit = (ctx) => { const d = load(ctx); feed(ctx, d, { type: 'commit' }); return d.dag.phase; };
export const infraResolved = (ctx, reviewer = null) => { const d = load(ctx); feed(ctx, d, { type: 'infra_resolved', reviewer }); return d.dag.phase; };

/** Facts for stats.json: launch spec per role as it actually ran, rounds. */
export function stats(ctx) {
  const d = load(ctx);
  return { fix_rounds: d.dag?.fixRound ?? 0, review_rounds: d.dag?.reviewRound ?? 0, agents: d.starts, coordinator: 'fleet-driver (script)' };
}

/** Only a worker_done from the task's active dispatch counts (protocol floor). */
function taskOf(d, m) {
  for (const [key, rec] of Object.entries(d.tasks)) if (rec.dispatch && rec.dispatch === m.dispatch) return key.split('#')[0];
  return null;
}

/** Feed one event; run its actions, feeding back the events they produce, until quiet. */
function feed(ctx, d, first) {
  const queue = [first];
  while (queue.length) {
    const r = step(ctx.cfg, d.dag, queue.shift());
    d.dag = r.state;
    save(ctx, d);
    for (const a of r.actions) {
      const back = act(ctx, d, a);
      save(ctx, d);
      if (back) queue.push(back);
    }
  }
}

/** Finish half-done starts left by a kill (intent recorded, no dispatch yet). */
function resume(ctx, d) {
  for (const [key, rec] of Object.entries(d.tasks)) if (rec.intent && !rec.dispatch) startTask(ctx, d, key.split('#')[0]);
}

/** A question for the runner: recorded first, then handed over (once per ref). */
function raise(ctx, d, q) {
  if (d.pending.some((x) => x.ref === q.ref)) return;
  d.pending.push(q);
  save(ctx, d);
  ctx.ask?.(q);
}

function act(ctx, d, a) {
  const io = ctx.io ?? orca;
  switch (a.do) {
    case 'start': startTask(ctx, d, a.task); return null;
    case 'release': {
      const rec = d.tasks[key(d, a.task)];
      if (!rec?.dispatch) return null;
      const r = io.workerRelease(rec.dispatch);
      if (r.ok && r.state !== 'released') d.retained.push({ task: a.task, handle: rec.handle, state: r.state, reason: r.reason });
      return null;
    }
    case 'read_manifest': return manifestEvent(ctx, d);
    case 'check_review': return reviewEvent(ctx, a.task);
    case 'infra': raise(ctx, d, { kind: 'fleet_infra', ref: `infra:${a.task}`, text: `${a.task}: preview / runtime environment blocked the review`, options: null }); return null;
    case 'reply': {
      const r = io.reply(a.msgId, a.text);
      if (!r.ok) ctx.log?.(`fleet-driver: reply ${a.msgId} failed: ${r.error}`);
      return null;
    }
    case 'ask': raise(ctx, d, { kind: a.kind, ref: a.ref, text: a.text, options: a.options }); return null;
    case 'handoff': writeHandoff(ctx, a); return null;
    case 'close_chain': {
      // Orca hands a reused terminal to each new dispatch: only the last one's release closes it
      // (the first answers retained: ownership_transferred; spike 2, 2026-10-16).
      const rec = d.tasks[d.chainLast];
      if (!rec?.dispatch) return null;
      const r = io.workerRelease(rec.dispatch);
      if (!r.ok || r.state !== 'released') d.retained.push({ task: d.chainLast, handle: rec.handle, state: r.state ?? 'error', reason: r.reason ?? r.error });
      return null;
    }
    default: return null;
  }
}

const key = (d, name) => `${name}#${d.dag.tasks[name]?.attempt ?? 1}`;

function startTask(ctx, d, name) {
  const io = ctx.io ?? orca;
  const t = d.dag.tasks[name], k = key(d, name);
  const rec = (d.tasks[k] ??= {});
  const title = `${ctx.values.TASK_ID}:${k}`;
  if (!rec.task) {
    rec.intent = 'create'; save(ctx, d);
    const found = io.taskList(ctx.run)?.find((x) => x.title === title);
    let spec;
    try { spec = specFor(ctx, d, t); } catch (e) {
      delete rec.intent;
      raise(ctx, d, { kind: 'fleet_spec', ref: `spec:${k}`, text: `${name}: spec cannot be filled: ${e.message}`, options: null });
      return;
    }
    if (found) rec.task = found.id;
    else {
      fs.mkdirSync(path.join(ctx.evidenceRoot, 'specs'), { recursive: true });
      fs.writeFileSync(path.join(ctx.evidenceRoot, 'specs', `${k.replace('#', '-')}.md`), spec);
      const r = io.taskCreate({ run: ctx.run, title, spec });
      if (!r.ok) { delete rec.intent; raise(ctx, d, { kind: 'fleet_orca', ref: `create:${k}`, text: `${name}: task-create failed: ${r.error}`, options: null }); return; }
      rec.task = r.task;
    }
    save(ctx, d);
  }
  if (rec.intent === 'start') { // killed after worker-start was sent: adopt a live dispatch
    const live = io.dispatchShow(rec.task);
    if (live && !/failed|abandoned|stopped/.test(live.status)) { Object.assign(rec, { dispatch: live.id, handle: live.handle }); delete rec.intent; return; }
    // a failed or stopped attempt Orca still names is what the replacement retries, even when this file lost it
    // (capytal S44: an older driver dropped failedDispatch before the retry)
    if (live && /failed|stopped/.test(live.status) && !rec.failedDispatch) rec.failedDispatch = live.id;
  }
  rec.intent = 'start'; save(ctx, d);
  const terminal = t.reuse ? d.tasks[key(d, t.reuse)]?.handle : null;
  if (t.reuse && !terminal) { raise(ctx, d, { kind: 'fleet_orca', ref: `reuse:${k}`, text: `${name}: no terminal to reuse from ${t.reuse}`, options: null }); return; }
  // a worker sends worker_done before its turn ends: a brief pasted into a busy TUI is lost (monster-truck S02)
  if (terminal && io.terminalWaitIdle && !io.terminalWaitIdle(terminal)) ctx.log?.(`fleet-driver: ${terminal} not tui-idle after 90 s, starting ${name} anyway`);
  // a failed start leaves its Task failed: the replacement names it (`--retry-of`, Orca recovery reference;
  // without it: task_not_startable, capytal S44). Its terminal was kept for the human (codex update menu)
  // and is released once the replacement runs.
  const failed = rec.failedDispatch || null;
  const prev = failed || (t.retry ? d.tasks[`${name}#${(t.attempt ?? 2) - 1}`]?.dispatch : null);
  const r = io.workerStart({ run: ctx.run, task: rec.task, agent: t.agent, terminal, worktree: ctx.worktree, retryOf: prev });
  if (failed && r.ok) {
    const rel = io.workerRelease(failed);
    ctx.log?.(`fleet-driver: released the failed start ${failed} of ${name}: ${rel.ok ? rel.state : rel.error}`);
    delete rec.failedDispatch;
  }
  if (!r.ok) {
    // never relaunch blind: the receipt says what is left (failedStage, residualResources)
    if (r.dispatch && !terminal && r.dispatch !== failed) rec.failedDispatch = r.dispatch;
    raise(ctx, d, { kind: 'fleet_worker_start', ref: `start:${k}`, text: `${name}: worker-start failed: ${r.error}; receipt ${JSON.stringify(r.receipt ?? {}).slice(0, 400)}`, options: null });
    return;
  }
  Object.assign(rec, { dispatch: r.dispatch, handle: r.handle });
  delete rec.intent;
  d.starts[name] = t.reuse ? d.starts[t.reuse] ?? null : t.agent;
  if (t.reuse === 'implement' || name === 'implement') d.chainLast = k;
}

/** The spec text for one task: the role card filled from base values, the manifest row and fix rows. */
export function specFor(ctx, d, t) {
  const row = t.stem ? findRow(readJson(ctx.manifestPath), t.stem) ?? {} : {};
  const values = {
    ...ctx.values, ROLE: t.name, SPEC: t.agent ?? d.starts[t.reuse] ?? '', IMPLEMENT_HANDLE: 'none', ART_HANDLE: 'none', MESH_HANDLE: 'none',
    ...(t.stem ? { STEM: t.stem, MODEL_FILE: row.file ?? `${t.stem}.glb`, ROW_EXPECT_DIMS: (row.expect_dims ?? []).join(','), ROW_FORWARD: row.forward ?? '-Z',
      TRI_BUDGET: row.tri_budget ?? '', ANIM_ID: `${ctx.slug}-${t.stem}` } : {}),
    ...(t.fix ? { FIX_ROWS: t.fix.rows.map((r) => `${r.ids.join(',')} · ${r.scope.join(', ')} · ${r.change} · ${r.acceptance}`).join('\n') } : {}),
  };
  const role = t.role === 'fix' && t.opts?.art ? 'fix — art variant' : t.role;
  let text = render(role, values, { animated: !!t.opts?.animated, backend: t.opts?.backend ?? null });
  const extra = [ctx.memory?.[t.role] && `MEMORY: ${ctx.memory[t.role]}`, t.note, t.retry && `This is attempt ${t.attempt}; the previous attempt failed.`].filter(Boolean);
  if (extra.length) text += `\n${extra.join('\n')}\n`;
  return text;
}

function readJson(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } }

/** The manifest row for a stem, wherever the project keeps it (flat lists, per-slice sections, assets.{2d,3d}). */
export function findRow(json, stem) {
  if (!json || typeof json !== 'object') return null;
  if (!Array.isArray(json) && json.stem === stem) return json;
  for (const v of Object.values(json)) {
    const hit = v && typeof v === 'object' ? findRow(v, stem) : null;
    if (hit) return hit;
  }
  return null;
}

/** Manifest rows for this slice's assets block → the DAG's manifest event (or a question when rows are missing). */
export function manifestRows(json, sliceAssets) {
  const rows = [], missing = [];
  for (const [group, list] of Object.entries(sliceAssets ?? {})) for (const a of list ?? []) {
    const stem = typeof a === 'string' ? a : a.stem;
    const r = findRow(json, stem);
    if (!r) { missing.push(stem); continue; }
    rows.push({ stem, kind: group === '3d' ? '3d' : group, source: r.source === 'import' ? 'import' : 'generate', animated: !!r.animated });
  }
  return { rows, missing };
}

function manifestEvent(ctx, d) {
  const json = readJson(ctx.manifestPath);
  const { rows, missing } = manifestRows(json, ctx.sliceAssets);
  if (!json || missing.length) {
    raise(ctx, d, { kind: 'fleet_manifest', ref: 'manifest', text: `art-manifest: ${json ? `no row for ${missing.join(', ')}` : `cannot read ${ctx.manifestPath}`}`, options: null });
    return null;
  }
  return { type: 'manifest', rows };
}

/** Newest review file of the evidence dir → review-check → the DAG's review event. */
function reviewEvent(ctx, task) {
  const files = fs.readdirSync(ctx.evidenceRoot).filter((f) => /^review.*\.md$/.test(f))
    .map((f) => ({ f, m: fs.statSync(path.join(ctx.evidenceRoot, f)).mtimeMs })).sort((a, b) => b.m - a.m);
  if (!files.length) return { type: 'review', task, result: { ok: false, verdict: null, errors: [{ code: 'no_review', message: 'no review*.md in the evidence dir' }] } };
  return { type: 'review', task, result: checkReview(fs.readFileSync(path.join(ctx.evidenceRoot, files[0].f), 'utf8'), { paths: ctx.slicePaths ?? null }) };
}

function writeHandoff(ctx, a) {
  const f = path.join(ctx.evidenceRoot, 'HANDOFF.json');
  fs.mkdirSync(ctx.evidenceRoot, { recursive: true });
  fs.writeFileSync(f, JSON.stringify({ role: 'fleet-driver', status: a.status, detail: a.detail, sha: a.sha ?? null, updatedAt: new Date().toISOString() }) + '\n');
}
