import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initial, step, MAX_FIX_ROUNDS } from '../scripts/lib/fleet-dag.mjs';

// Pure DAG: every scenario is a list of events; we read the actions and the task table.
const CFG = {
  lite: false, art2dBackend: 'antigravity',
  agents: { scan: 'claude --model sonnet', artManifest: 'cursor --model auto', artImport: 'claude --model opus', concept: 'antigravity', mesh: 'codex --model gpt-6.1-sol --effort high', art2d: 'antigravity', writer: 'claude --model opus --effort high', reviewer: 'cursor --model auto' },
};
function play(events, cfg = CFG, from = initial()) {
  let state = from; const log = [];
  for (const e of events) { const r = step(cfg, state, e); state = r.state; log.push(r.actions); }
  return { state, log, last: log.at(-1) };
}
const starts = (acts) => acts.filter((a) => a.do === 'start').map((a) => a.task);
const done = (task, body = 'ok', outcome = 'succeeded') => ({ type: 'done', task, outcome, body });
const review = (task, result) => ({ type: 'review', task, result: { ok: true, errors: [], fix_groups: {}, director: [], unclear: [], followups: [], infra_only: false, ...result } });
const row = (ids, owner, reason = null, change = 'fix it') => ({ ids, owner, owner_raw: reason ? `${owner} (${reason})` : owner, reason, scope: ['a.ts'], change, acceptance: 'seen' });
const status = (s) => Object.fromEntries(Object.values(s.tasks).map((t) => [t.name, t.status]));

test('lite: implement → integrate (same terminal) → review → offer_commit → commit → committed', () => {
  const lite = { ...CFG, lite: true };
  const a = play([{ type: 'start' }], lite);
  assert.deepEqual(starts(a.last), ['implement']);
  const b = play([done('implement')], lite, a.state);
  assert.deepEqual(b.last, [{ do: 'start', task: 'integrate' }], 'implement terminal is kept, not released');
  assert.equal(b.state.tasks.integrate.reuse, 'implement');
  const c = play([done('integrate'), done('review', 'APPROVED')], lite, b.state);
  assert.deepEqual(c.log[1], [{ do: 'release', task: 'review' }, { do: 'check_review', task: 'review' }]);
  const d = play([review('review', { verdict: 'APPROVED' })], lite, c.state);
  assert.deepEqual(d.last, [{ do: 'handoff', status: 'offer_commit', detail: 'APPROVED fix_rounds=0 review_rounds=1' }]);
  const e = play([{ type: 'commit' }, done('commit', 'committed 1a2b3c4d on S06')], lite, d.state);
  assert.deepEqual(starts(e.log[0]), ['commit']);
  assert.deepEqual(e.last, [{ do: 'handoff', status: 'committed', detail: 'fix_rounds=0', sha: '1a2b3c4d' }, { do: 'close_chain' }]);
  assert.equal(e.state.phase, 'committed');
});

test('full: scan → art-manifest ∥ implement; manifest fans out per row; integrate waits on the last art task of each row', () => {
  const a = play([{ type: 'start' }, done('scan')]);
  assert.deepEqual(starts(a.log[0]), ['scan']);
  assert.deepEqual(a.last, [{ do: 'release', task: 'scan' }, { do: 'start', task: 'art-manifest' }, { do: 'start', task: 'implement' }]);
  const b = play([done('art-manifest'), { type: 'manifest', rows: [
    { stem: 'truck', kind: '3d', source: 'generate' },
    { stem: 'cat', kind: '3d', source: 'generate', animated: true },
    { stem: 'crate', kind: '3d', source: 'import' },
    { stem: 'button', kind: '2d', source: 'generate' },
  ] }], CFG, a.state);
  assert.deepEqual(b.log[0], [{ do: 'release', task: 'art-manifest' }, { do: 'read_manifest' }]);
  assert.deepEqual(starts(b.last).sort(), ['art-2d', 'art-concept-cat', 'art-concept-truck', 'art-import-crate']);
  assert.deepEqual(b.state.tasks.integrate.deps.sort(), ['art-2d', 'art-anim-cat', 'art-import-crate', 'art-mesh-truck', 'implement']);
  assert.equal(b.state.tasks['art-concept-cat'].opts.animated, true);
  assert.equal(b.state.tasks['art-2d'].opts.backend, 'antigravity');
  // a mesh starts only after its own concept; anim after its mesh
  const c = play([done('art-concept-truck')], CFG, b.state);
  assert.deepEqual(starts(c.last), ['art-mesh-truck']);
  const d = play([done('art-concept-cat'), done('art-mesh-cat')], CFG, c.state);
  assert.deepEqual(starts(d.last), ['art-anim-cat']);
  // integrate only when implement and every art leaf are done
  const e = play([done('implement'), done('art-mesh-truck'), done('art-import-crate'), done('art-2d')], CFG, d.state);
  assert.ok(!e.log.flat().some((x) => x.do === 'start' && x.task === 'integrate'));
  const f = play([done('art-anim-cat')], CFG, e.state);
  assert.deepEqual(starts(f.last), ['integrate']);
});

test('fix round: code then scene on the implement terminal, art fix chain re-meshes and re-animates, then a fresh review', () => {
  const base = play([{ type: 'start' }, done('scan'), done('art-manifest'), { type: 'manifest', rows: [{ stem: 'cat', kind: '3d', source: 'generate', animated: true }] },
    done('art-concept-cat'), done('art-mesh-cat'), done('art-anim-cat'), done('implement'), done('integrate'), done('review', 'CHANGES_REQUESTED', 'failed')]);
  assert.equal(base.state.tasks.review.status, 'done', 'a CHANGES_REQUESTED review is a settled review, not a failed worker');
  const r = play([review('review', { verdict: 'CHANGES_REQUESTED', fix_groups: { code: [row(['F1'], 'code')], scene: [row(['F2'], 'scene')], concept: [row(['F3'], 'concept', 'cat')] } })], CFG, base.state);
  const t = r.state.tasks;
  assert.deepEqual(starts(r.last).sort(), ['fix1-code', 'fix1-concept-cat']);
  assert.equal(t['fix1-code'].reuse, 'implement');
  assert.deepEqual(t['fix1-remesh-cat'].deps, ['fix1-concept-cat']);
  assert.deepEqual(t['fix1-reanim-cat'].deps, ['fix1-remesh-cat']);
  assert.deepEqual(t['fix1-scene'].deps.sort(), ['fix1-code', 'fix1-reanim-cat']);
  assert.deepEqual(t['review-r2'].deps.sort(), ['fix1-code', 'fix1-concept-cat', 'fix1-reanim-cat', 'fix1-remesh-cat', 'fix1-scene']);
  assert.equal(t['review-r2'].agent, CFG.agents.reviewer);
  const s = play([done('fix1-code'), done('fix1-concept-cat'), done('fix1-remesh-cat'), done('fix1-reanim-cat'), done('fix1-scene')], CFG, r.state);
  assert.deepEqual(starts(s.last), ['review-r2']);
});

test('art-only fix adds an integrate pass; round cap asks; "one more" continues; stop blocks', () => {
  const lite = { ...CFG, lite: true };
  // finish started tasks until a review is done; return its name
  const toReview = (p) => {
    for (let guard = 0; guard < 20; guard++) {
      const t = Object.values(p.state.tasks).find((x) => x.status === 'started');
      p = play([done(t.name)], lite, p.state);
      if (t.role === 'review') return [p, t.name];
    }
    throw new Error('no review');
  };
  let [p, rv] = toReview(play([{ type: 'start' }], lite));
  p = play([review(rv, { verdict: 'CHANGES_REQUESTED', fix_groups: { asset: [row(['F1'], 'asset')] } })], lite, p.state);
  assert.deepEqual(p.state.tasks['fix1-integrate'].deps, ['fix1-asset']);
  for (let n = 2; n <= MAX_FIX_ROUNDS; n++) {
    [p, rv] = toReview(p);
    p = play([review(rv, { verdict: 'CHANGES_REQUESTED', fix_groups: { code: [row(['F9'], 'code')] } })], lite, p.state);
  }
  [p, rv] = toReview(p);
  assert.equal(rv, `review-r${MAX_FIX_ROUNDS + 1}`);
  p = play([review(rv, { verdict: 'CHANGES_REQUESTED', fix_groups: { code: [row(['F9'], 'code')] } })], lite, p.state);
  assert.deepEqual(p.last.map((a) => [a.do, a.kind]), [['ask', 'changes_after_rounds']]);
  const more = play([{ type: 'answer', ref: p.last[0].ref, choice: 'one more fix round' }], lite, p.state);
  assert.equal(more.state.fixRound, MAX_FIX_ROUNDS + 1);
  const stop = play([{ type: 'answer', ref: p.last[0].ref, choice: 'stop' }], lite, p.state);
  assert.equal(stop.state.phase, 'stopped');
  assert.deepEqual(stop.last, [{ do: 'handoff', status: 'blocked', detail: 'stopped at changes_after_rounds' }]);
});

test('director and unclear rows ask before any fix task; the decision rides on the fix specs', () => {
  const lite = { ...CFG, lite: true };
  let p = play([{ type: 'start' }, done('implement'), done('integrate'), done('review')], lite);
  p = play([review('review', { verdict: 'CHANGES_REQUESTED', director: [row(['F2'], 'director')], unclear: [row(['F3'], 'unclear', 'needs tools/x.mjs')], fix_groups: { code: [row(['F1'], 'code')] } })], lite, p.state);
  assert.deepEqual(p.last.map((a) => a.kind), ['review_director']);
  p = play([{ type: 'answer', ref: p.last[0].ref, choice: 'answer with --text', text: 'keep the paw coin' }], lite, p.state);
  assert.deepEqual(p.last.map((a) => a.kind), ['fix_routing_unclear']);
  p = play([{ type: 'answer', ref: p.last[0].ref, choice: 'allow the paths and fix as code' }], lite, p.state);
  const fix = p.state.tasks['fix1-code'];
  assert.deepEqual(fix.fix.rows.map((r) => r.ids[0]), ['F1', 'F3']);
  assert.match(fix.note, /keep the paw coin/);
  assert.match(fix.note, /paths allowed/);
  assert.deepEqual(starts(p.last), ['fix1-code']);
});

test('infra verdict → infra action; resolved with a swapped reviewer → fresh review on that reviewer for the rest of the lane', () => {
  const lite = { ...CFG, lite: true };
  let p = play([{ type: 'start' }, done('implement'), done('integrate'), done('review', 'INFRA_BLOCKED', 'failed')], lite);
  p = play([review('review', { verdict: 'INFRA_BLOCKED' })], lite, p.state);
  assert.deepEqual(p.last, [{ do: 'infra', task: 'review' }]);
  p = play([{ type: 'infra_resolved', reviewer: 'cursor --model auto' }], lite, p.state);
  assert.deepEqual(starts(p.last), ['review-r2']);
  assert.equal(p.state.tasks['review-r2'].agent, 'cursor --model auto');
  const infraOnly = play([{ type: 'start' }, done('implement'), done('integrate'), done('review'), review('review', { verdict: 'CHANGES_REQUESTED', infra_only: true })], lite);
  assert.deepEqual(infraOnly.last, [{ do: 'infra', task: 'review' }]);
  assert.equal(infraOnly.state.fixRound, 0, 'infra is not a fix round');
});

test('worker questions relay through ask/answer → reply once; failed worker asks; retry restarts the same task', () => {
  const lite = { ...CFG, lite: true };
  let p = play([{ type: 'start' }, { type: 'question', task: 'implement', msgId: 'msg_1', text: 'Which fruit?', options: [] }], lite);
  assert.deepEqual(p.last, [{ do: 'ask', kind: 'worker_question', ref: 'msg:msg_1', text: 'implement: Which fruit?', options: null }]);
  assert.deepEqual(play([{ type: 'question', task: 'implement', msgId: 'msg_1', text: 'again' }], lite, p.state).last, [], 'a replayed Delivery asks once');
  p = play([{ type: 'answer', ref: 'msg:msg_1', choice: 'answer with --text', text: 'banana' }], lite, p.state);
  assert.deepEqual(p.last, [{ do: 'reply', msgId: 'msg_1', text: 'banana' }]);
  p = play([done('implement', 'tsc failed', 'failed')], lite, p.state);
  assert.equal(p.last[0].kind, 'worker_failed');
  const retry = play([{ type: 'answer', ref: p.last[0].ref, choice: 'retry the task' }], lite, p.state);
  assert.deepEqual(starts(retry.last), ['implement']);
  assert.equal(retry.state.tasks.implement.attempt, 2);
  const cont = play([{ type: 'answer', ref: p.last[0].ref, choice: 'continue as done' }], lite, p.state);
  assert.deepEqual(starts(cont.last), ['integrate']);
});

test('replays are no-ops: duplicate start, duplicate done, stale review, commit before offer', () => {
  const lite = { ...CFG, lite: true };
  const p = play([{ type: 'start' }], lite);
  assert.deepEqual(play([{ type: 'start' }], lite, p.state).last, []);
  const q = play([done('implement')], lite, p.state);
  assert.deepEqual(play([done('implement')], lite, q.state).last, []);
  assert.deepEqual(play([review('review', { verdict: 'APPROVED' })], lite, q.state).last, []);
  assert.deepEqual(play([{ type: 'commit' }], lite, q.state).last, []);
  assert.deepEqual(status(q.state), { implement: 'done', integrate: 'started', review: 'planned' });
});

test('commit without a sha asks; retry restarts the commit task', () => {
  const lite = { ...CFG, lite: true };
  let p = play([{ type: 'start' }, done('implement'), done('integrate'), done('review'), review('review', { verdict: 'APPROVED' }), { type: 'commit' }, done('commit', 'nothing to commit')], lite);
  assert.equal(p.last[0].kind, 'commit_failed');
  p = play([{ type: 'answer', ref: p.last[0].ref, choice: 'retry the commit' }], lite, p.state);
  assert.deepEqual(starts(p.last), ['commit']);
});
