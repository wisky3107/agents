import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { tick, answer, commit, stats, load, manifestRows, findRow, specFor } from '../scripts/lib/fleet-driver.mjs';

// The driver against an in-memory Orca: every call is logged; the inbox is a queue the test fills.
function fakeOrca({ failStart = 0, crashStartOnce = false } = {}) {
  const o = { calls: [], tasks: [], dispatches: {}, inbox: [], n: 0, failStart, crashStartOnce };
  const log = (name, a) => o.calls.push([name, a]);
  return Object.assign(o, {
    taskList: () => o.tasks.map((t) => ({ ...t })),
    taskCreate: (a) => { log('taskCreate', a); const id = `task_${++o.n}`; o.tasks.push({ id, title: a.title, status: 'pending' }); return { ok: true, task: id }; },
    dispatchShow: (task) => o.dispatches[task] ?? null,
    workerStart: (a) => {
      log('workerStart', a);
      if (o.failed?.[a.task] && a.retryOf !== o.failed[a.task]) return { ok: false, error: `task_not_startable: Task ${a.task} is failed` };
      if (o.failStart > 0) { o.failStart--; (o.failed ??= {})[a.task] = 'ctx_failed'; return { ok: false, error: 'agent_not_ready', receipt: { failedStage: 'launch' }, dispatch: 'ctx_failed' }; }
      const id = `ctx_${++o.n}`, handle = a.terminal ?? `term_${o.n}`;
      o.dispatches[a.task] = { id, status: 'dispatched', handle };
      if (o.crashStartOnce) { o.crashStartOnce = false; throw new Error('killed after worker-start'); }
      return { ok: true, dispatch: id, handle };
    },
    runCheck: (a) => { log('runCheck', a); const messages = o.inbox.splice(0); return { ok: true, delivery: messages.length ? `del_${++o.n}` : null, messages }; },
    reply: (id, text) => { log('reply', { id, text }); return { ok: true }; },
    workerRelease: (d) => { log('workerRelease', d); return { ok: true, state: 'released' }; },
    closeTerminal: (h) => { log('closeTerminal', h); return true; },
    terminalWaitIdle: (h) => { log('waitIdle', h); return true; },
  });
}
const dispatchOf = (o, title) => o.dispatches[o.tasks.find((t) => t.title.includes(`:${title}#`)).id].id;
const done = (o, title, body = 'ok', outcome = 'succeeded') => o.inbox.push({ id: `msg_${++o.n}`, type: 'worker_done', dispatch: dispatchOf(o, title), outcome, body });

function context({ lite = true, io = fakeOrca(), assets = {}, manifest = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-driver-'));
  const evidenceRoot = path.join(dir, 'wt', '.cursor/evidence/tasks/T-S06/evidence');
  fs.mkdirSync(evidenceRoot, { recursive: true });
  const manifestPath = path.join(dir, 'wt', 'manifest.json');
  if (manifest) fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  const questions = [];
  const ctx = {
    sliceDir: dir, evidenceRoot, run: 'run_1', worktree: `path:${dir}/wt`, manifestPath, sliceAssets: assets, slug: 'cc-test', waitMs: 10,
    cfg: { lite, art2dBackend: 'antigravity', agents: { scan: 'claude --model sonnet', artManifest: 'cursor --model auto', artImport: 'claude --model opus', concept: 'antigravity', mesh: 'codex --model gpt-6.1-sol --effort high', art2d: 'antigravity', writer: 'claude --model opus --effort high', reviewer: 'cursor --model auto' } },
    values: { EVIDENCE_ROOT: evidenceRoot, FEATURE: 'S06-spider-forest', TASK_ID: 'T-S06', SLICE_ID: 'S06', WORKTREE_PATH: `${dir}/wt`, ART_PATHS: 'assets/art', SCENE: 'assets/scenes/game.scene',
      ART_BACKEND: 'antigravity', MESH_BACKEND: 'auto', MESH_AGENT: 'codex', CONCEPT_ROUTE: 'antigravity', PROJECT_SLUG: 'cc-test', CHAR_ANIM_HOME: '/x/anim' },
    io, ask: (q) => questions.push(q), log: () => {},
  };
  return { ctx, io, questions };
}
const review = (ctx, verdict) => fs.writeFileSync(path.join(ctx.evidenceRoot, 'review.md'), `# Review\n\n## escaped\nnone\n\n${verdict}\n`);

test('lite lane end to end: specs written, chain reuses the implement terminal, fresh reviewer, commit on the chain, HANDOFF and stats', () => {
  const { ctx, io } = context();
  tick(ctx);
  const [, impl] = io.calls.find(([n]) => n === 'workerStart');
  assert.equal(impl.agent, 'claude --model opus --effort high');
  assert.equal(impl.worktree, ctx.worktree);
  assert.ok(fs.existsSync(path.join(ctx.evidenceRoot, 'specs/implement-1.md')));
  assert.match(fs.readFileSync(path.join(ctx.evidenceRoot, 'specs/implement-1.md'), 'utf8'), /^Project rules are binding[\s\S]*ROLE: writer\./);
  const implHandle = io.dispatches[io.tasks[0].id].handle;
  done(io, 'implement'); tick(ctx);
  const integrate = io.calls.filter(([n]) => n === 'workerStart').at(-1)[1];
  assert.equal(integrate.terminal, implHandle, 'integrate reuses the implement terminal');
  assert.deepEqual(io.calls.at(-2), ['waitIdle', implHandle], 'tui-idle before the reuse');
  done(io, 'integrate'); tick(ctx);
  const rv = io.calls.filter(([n]) => n === 'workerStart').at(-1)[1];
  assert.deepEqual([rv.terminal, rv.agent], [null, 'cursor --model auto']);
  review(ctx, 'APPROVED'); done(io, 'review', 'APPROVED'); tick(ctx);
  assert.equal(JSON.parse(fs.readFileSync(path.join(ctx.evidenceRoot, 'HANDOFF.json'), 'utf8')).status, 'offer_commit');
  assert.ok(io.calls.some(([n, d]) => n === 'workerRelease' && d === dispatchOf(io, 'review')));
  assert.ok(!io.calls.some(([n, d]) => n === 'workerRelease' && d === dispatchOf(io, 'implement')), 'the chain terminal is not released');
  commit(ctx);
  assert.equal(io.calls.filter(([n]) => n === 'workerStart').at(-1)[1].terminal, implHandle);
  assert.match(fs.readFileSync(path.join(ctx.evidenceRoot, 'specs/commit-1.md'), 'utf8'), /feat\(S06\)/);
  done(io, 'commit', 'committed 0123abcd'); tick(ctx);
  const h = JSON.parse(fs.readFileSync(path.join(ctx.evidenceRoot, 'HANDOFF.json'), 'utf8'));
  assert.deepEqual([h.role, h.status, h.sha], ['fleet-driver', 'committed', '0123abcd']);
  assert.deepEqual(io.calls.at(-1), ['workerRelease', dispatchOf(io, 'commit')], 'the chain closes by releasing its last dispatch');
  assert.ok(!io.calls.some(([n]) => n === 'closeTerminal'), 'never terminal close instead of release');
  assert.deepEqual(stats(ctx), { fix_rounds: 0, review_rounds: 1, coordinator: 'fleet-driver (script)',
    agents: { implement: 'claude --model opus --effort high', integrate: 'claude --model opus --effort high', review: 'cursor --model auto', commit: 'claude --model opus --effort high' } });
});

test('inbox: the ack of a batch goes with the next wait; duplicate and foreign messages are ignored', () => {
  const { ctx, io } = context();
  tick(ctx);
  done(io, 'implement');
  io.inbox.push({ id: 'msg_x', type: 'worker_done', dispatch: 'ctx_other', outcome: 'succeeded', body: 'not ours' });
  tick(ctx);
  const del = load(ctx).delivery;
  assert.ok(del);
  // the same Delivery replayed (unacked): the implement worker_done must not start integrate twice
  io.inbox.push({ id: load(ctx).seen[0], type: 'worker_done', dispatch: dispatchOf(io, 'implement'), outcome: 'succeeded' });
  tick(ctx);
  assert.equal(io.calls.filter(([n]) => n === 'runCheck').at(-1)[1].ack, del);
  assert.equal(io.calls.filter(([n]) => n === 'workerStart').length, 2, 'implement + integrate, nothing twice');
});

test('kill after worker-start: the live dispatch is adopted, never started twice', () => {
  const io = fakeOrca({ crashStartOnce: true });
  const { ctx } = context({ io });
  assert.throws(() => tick(ctx), /killed after worker-start/);
  assert.equal(Object.values(load(ctx).tasks)[0].intent, 'start');
  tick(ctx); // resume
  assert.equal(io.calls.filter(([n]) => n === 'workerStart').length, 1);
  assert.equal(io.calls.filter(([n]) => n === 'taskCreate').length, 1);
  const rec = load(ctx).tasks['implement#1'];
  assert.deepEqual([rec.intent, rec.dispatch], [undefined, io.dispatches[rec.task].id]);
});

test('kill after task-create: the task is found by title, not created again', () => {
  const { ctx, io } = context();
  tick(ctx);
  const d = load(ctx);
  // forget the task id and the dispatch, as if killed right after task-create
  d.tasks['implement#1'] = { intent: 'create' };
  delete io.dispatches[io.tasks[0].id];
  fs.writeFileSync(path.join(ctx.sliceDir, 'fleet-driver.json'), JSON.stringify(d));
  tick(ctx);
  assert.equal(io.calls.filter(([n]) => n === 'taskCreate').length, 1);
  assert.equal(load(ctx).tasks['implement#1'].task, io.tasks[0].id);
});

test('worker question → runner question → reply; a failed worker-start asks and retries on answer', () => {
  const io = fakeOrca({ failStart: 1 });
  const { ctx, questions } = context({ io });
  tick(ctx);
  assert.equal(questions[0].kind, 'fleet_worker_start');
  assert.match(questions[0].text, /failedStage/);
  assert.ok(!io.calls.some(([n]) => n === 'workerRelease'), 'the failed start keeps its terminal until the answer');
  answer(ctx, questions[0].ref, 'retry');
  assert.equal(io.calls.filter(([n]) => n === 'workerStart').length, 2);
  assert.equal(io.calls.filter(([n]) => n === 'workerStart').at(-1)[1].retryOf, 'ctx_failed', 'the replacement names the failed dispatch');
  const i = io.calls.findIndex(([n, x]) => n === 'workerRelease' && x === 'ctx_failed');
  assert.ok(i > io.calls.findLastIndex(([n]) => n === 'workerStart'), 'released once the replacement runs');
  io.inbox.push({ id: 'msg_q', type: 'question', dispatch: dispatchOf(io, 'implement'), question: 'Which fruit?', options: [] });
  tick(ctx);
  assert.deepEqual(questions.at(-1), { kind: 'worker_question', ref: 'msg:msg_q', text: 'implement: Which fruit?', options: null });
  answer(ctx, 'msg:msg_q', 'answer with --text', 'banana');
  assert.deepEqual(io.calls.at(-1), ['reply', { id: 'msg_q', text: 'banana' }]);
});

test('full lane: manifest rows come from the slice assets block, wherever the manifest keeps them; a missing row asks', () => {
  const manifest = { meshes: [{ stem: 'truck', file: 'truck.glb', expect_dims: [2, 1, 4], forward: '+Z', tri_budget: 8000, slice: 'S06' }], s06: { '2d': [{ stem: 'btn', file: 'btn.png' }] } };
  const assets = { '2d': [{ stem: 'btn', p: 1 }], '3d': [{ stem: 'truck', p: 1 }], vfx: [], audio: [] };
  assert.deepEqual(manifestRows(manifest, assets).rows, [{ stem: 'btn', kind: '2d', source: 'generate', animated: false }, { stem: 'truck', kind: '3d', source: 'generate', animated: false }]);
  assert.deepEqual(manifestRows(manifest, { '3d': [{ stem: 'cat' }] }).missing, ['cat']);
  const { ctx, io, questions } = context({ lite: false, assets, manifest });
  tick(ctx); done(io, 'scan'); tick(ctx); done(io, 'art-manifest'); tick(ctx);
  const titles = io.tasks.map((t) => t.title.split(':')[1]);
  assert.deepEqual(titles.sort(), ['art-2d#1', 'art-concept-truck#1', 'art-manifest#1', 'implement#1', 'scan#1']);
  const concept = fs.readFileSync(path.join(ctx.evidenceRoot, 'specs/art-concept-truck-1.md'), 'utf8');
  assert.match(concept, /--expect-dims "2,1,4"/);
  assert.match(concept, /--forward \+Z/);
  assert.equal(questions.length, 0);
  const bad = context({ lite: false, assets: { '3d': [{ stem: 'cat' }] }, manifest });
  tick(bad.ctx); done(bad.io, 'scan'); tick(bad.ctx); done(bad.io, 'art-manifest'); tick(bad.ctx);
  assert.equal(bad.questions[0].kind, 'fleet_manifest');
  assert.match(bad.questions[0].text, /no row for cat/);
});

test('specFor: fix rows, decisions and memory ride on the spec; findRow searches nested sections', () => {
  const { ctx } = context();
  ctx.memory = { fix: '/m/pack.md' };
  const d = { starts: { implement: 'claude --model opus' }, dag: { tasks: {} } };
  const t = { name: 'fix1-code', role: 'fix', reuse: 'implement', fix: { owner: 'code', rows: [{ ids: ['F1'], scope: ['a.ts'], change: 'flip', acceptance: 'seen' }] }, note: 'Director decisions: keep coin' };
  const spec = specFor(ctx, d, t);
  assert.match(spec, /F1 · a\.ts · flip · seen/);
  assert.match(spec, /MEMORY: \/m\/pack\.md\nDirector decisions: keep coin/);
  assert.equal(findRow({ a: { b: [{ stem: 'x', v: 1 }] } }, 'x').v, 1);
});

test('retry when the failed dispatch was lost from fleet-driver.json: Orca still names it (dispatch-show), the replacement retries it', () => {
  const io = fakeOrca({ failStart: 1 });
  const { ctx, questions } = context({ io });
  tick(ctx);
  // the state an older driver left (capytal S44): failedDispatch dropped, the Task failed in Orca
  const d = load(ctx);
  delete d.tasks['implement#1'].failedDispatch;
  fs.writeFileSync(path.join(ctx.sliceDir, 'fleet-driver.json'), JSON.stringify(d));
  io.dispatches[d.tasks['implement#1'].task] = { id: 'ctx_failed', status: 'failed', handle: 'term_gone' };
  answer(ctx, questions[0].ref, 'retry');
  const last = io.calls.filter(([n]) => n === 'workerStart').at(-1)[1];
  assert.equal(last.retryOf, 'ctx_failed');
  assert.ok(load(ctx).tasks['implement#1'].dispatch && !load(ctx).tasks['implement#1'].intent);
});
