import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { NOTES, POLICY, project, fakes, runner, evRel, ev, sliceState, approvedEvidence, commitStep, clearControl } from './harness.mjs';
import * as st from '../scripts/lib/state.mjs';

// Phase 2 M5c/M5d (docs/plans/2026-10-15-runner-parallel-phase2 §M5): max_parallel=2 runs a parallel_ok pair as two
// lanes in one runner — the first in main, the one beside it in its own worktree; they take turns one orca-wait at a
// time; a question parks only its lane; a worktree lane merges once no lane works in main.
process.env.PRODUCER_RUNNER_CURSOR = 'on';
const TWO = POLICY.replace('max_parallel=1', 'max_parallel=2');
const W = (id, status, wt) => ({ [evRel(id, 'HANDOFF.json')]: { role: 'writer', status, detail: status === 'blocked' ? 'which API?' : 'd', sha: null }, [evRel(id, 'preview-startup.json')]: { projectPath: wt, previewUrl: 'http://127.0.0.1:7461/', status: 'ready' } });
const R = (id) => ({ [evRel(id, 'HANDOFF.json')]: { role: 'reviewer', status: 'approved' }, ...approvedEvidence(id, 'APPROVED') });
const VERIFY = (id) => ({ name: `verify-${id}`, write: { [evRel(id, 'verify-main.json')]: { status: 'verified', detail: 'smoke green' } } });
// one turn: orca-wait calls the fake terminal wait again until its time is up, so a busy step outlasts that time
const TURN_MS = '300';
const BUSY = (n) => ({ name: `busy-${n}`, sleepMs: 400 });
const start = (p, f) => runner(p.root, f, 'start', '--once', { env: { PRODUCER_RUNNER_LANES_WAIT_MS: TURN_MS } });
const lines = (dir, f) => (fs.existsSync(path.join(dir, f)) ? fs.readFileSync(path.join(dir, f), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const log = (root, id) => fs.readFileSync(ev(root, id, 'producer-log.md'), 'utf8');
const at = (root, id, re) => Date.parse(log(root, id).split('\n').find((l) => re.test(l))?.slice(0, 24) || NaN);
const CLOSE = `#!/bin/bash
echo "close $1" >> "$FAKE_DIR/editor.log"
if [ -f "$FAKE_DIR/editor-up" ]; then grep -vxF "$1" "$FAKE_DIR/editor-up" > "$FAKE_DIR/editor-up.tmp"; mv "$FAKE_DIR/editor-up.tmp" "$FAKE_DIR/editor-up"; fi
exit 0
`;
const OPEN = `#!/bin/bash
echo "open $1" >> "$FAKE_DIR/editor.log"
echo "$1" >> "$FAKE_DIR/editor-up"
`;
const PROBE = `import fs from 'node:fs';
import path from 'node:path';
const f = path.join(process.env.FAKE_DIR, 'editor-up');
const up = fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\\n') : [];
const here = fs.realpathSync(process.cwd());
const reachable = up.includes(here);
console.log(JSON.stringify({ funplay: { url: 'http://127.0.0.1:1/', reachable, servedProject: reachable ? path.basename(here) : null, parity: reachable ? true : null } }, null, 2));
`;
/** S01 + S02 with no dag between them; a parallel_ok pair unless told otherwise; Creator scripts for the worktree lane. */
function pairProject({ parallelOk = [['S01', 'S02']], release = '', gate2 = false } = {}) {
  // gate2: S02 needs the director and the policy line has not given it (the harness policy gives S02 by default)
  const policy = gate2 ? TWO.replace(/ \(director gate: S02 GIVEN\)/, '') : TWO;
  const p = project({
    notes: NOTES(policy, '{}', release), slices: { S01: { needs: false }, S02: { needs: gate2 } }, dag: { S01: [], S02: [] }, parallelOk,
    files: { '.gitignore': '/.cursor/evidence/\n', 'scripts/close-editor.sh': CLOSE, 'scripts/open-editor.sh': OPEN,
      '.cursor/skills/vibe-game-director/scripts/probe.mjs': PROBE, 'funplay-cocos-mcp.config.json': '{"port": 1}' },
  });
  for (const f of ['scripts/close-editor.sh', 'scripts/open-editor.sh']) fs.chmodSync(path.join(p.root, f), 0o755);
  spawnSync('git', ['-C', p.root, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qam', 'exec bits']);
  return { ...p, wt: `${p.root}-wt-S02-x`, wt1: `${p.root}-wt-S01-x` };
}
/** Rewrite the policy's max_parallel (a director's re-lock between two runner runs). */
const maxParallel = (p, n) => {
  const notes = path.join(p.root, 'AGENT_NOTES.md');
  fs.writeFileSync(notes, fs.readFileSync(notes, 'utf8').replace(/max_parallel=\d/, `max_parallel=${n}`));
};

test('M5d: S01 already works in main (started with one lane), S02 beside it in a worktree merges after S01', () => {
  const p = pairProject();
  const f = fakes();
  // the director allows two lanes while S01 runs alone in main (pilot 24 S36 + S37): S01 stays in main
  maxParallel(p, 1);
  f.queue({ term_1: [BUSY(0)] });
  assert.ok(start(p, f).out.at(-1).stopped);
  assert.equal(sliceState(p.root, 'S01').lane_in_main, true);
  clearControl(p.root);
  maxParallel(p, 2);
  // handles in spawn order: term_1 S01 writer, term_2 S02 writer, term_3 S02 reviewer (S02 is ready first),
  // term_4 S01 reviewer, term_5 the verifier in main after S02's worktree merge
  f.queue({
    term_1: [BUSY(1), BUSY(2), BUSY(3), BUSY(4), { name: 's01-ready', write: W('S01', 'ready_for_review', p.root) }, commitStep('S01')],
    term_2: [{ name: 's02-ready', wt: 'S02', write: W('S02', 'ready_for_review', p.wt) }, { ...commitStep('S02'), wt: 'S02' }],
    term_3: [{ name: 's02-approved', wt: 'S02', write: R('S02') }],
    term_4: [{ name: 's01-approved', write: R('S01') }],
    term_5: [VERIFY('S02')],
  });
  const out = runner(p.root, f, 'start', '--once', { env: { PRODUCER_RUNNER_LANES_WAIT_MS: TURN_MS, PRODUCER_RUNNER_WAIT_LOG_MS: '1' } }).out;
  assert.deepEqual(out.filter((o) => o.merged).map((o) => o.merged), ['S01', 'S02'], JSON.stringify(out.slice(-3)));
  assert.ok(out.at(-1).done, 'then the release slice is merged');
  // the wait names where the blocking lane is, says so again while it lasts (pilot 24 S39: 92 min, said once) and when it ends
  assert.match(log(p.root, 'S02'), /merge waits: S01 works in main \(S01 at \w[\w-]*\)/);
  assert.match(log(p.root, 'S02'), /merge waits: S01 works in main: still waiting, \d+ min; S01 at \w/);
  assert.match(log(p.root, 'S02'), /merge waits: S01 works in main: done waiting after \d+ min/);
  assert.equal(sliceState(p.root, 'S02').lane_wait_since, null);

  assert.deepEqual(lines(f.dir, 'wtcreate.log').map((c) => c.name), ['S02-x'], 'one worktree: the lane beside');
  const spawns = f.spawns();
  assert.deepEqual(spawns.map((s) => [s.handle, s.slice, s.path === p.root ? 'main' : s.path === p.wt ? 'wt' : s.path]),
    [['term_1', 'S01', 'main'], ['term_2', 'S02', 'wt'], ['term_3', 'S02', 'wt'], ['term_4', 'S01', 'main'], ['term_5', 'S02', 'main']]);
  // the lanes took turns: S02's writer and reviewer answered while S01's writer was still busy
  const waits = f.waits().map((w) => `${w.on}:${w.step}`);
  assert.ok(waits.indexOf('term_3:s02-approved') < waits.indexOf('term_1:s01-ready'), waits.join(' '));
  assert.match(log(p.root, 'S02'), /selected \(single lane, beside S01: in its own worktree\)/);
  // M5d: S02 was ready to merge while S01 still worked in main; it merged once S01 was done
  assert.match(log(p.root, 'S02'), /merge waits: S01 works in main/);
  assert.ok(at(p.root, 'S01', /phase done/) <= at(p.root, 'S02', /merge journal started/));
  const r = st.readRunner(p.root);
  assert.deepEqual(r.lanes, []);
  assert.equal(r.merge_owner, null);
  assert.equal(sliceState(p.root, 'S02').phase, 'done');
});

test('M5c: max_parallel=2 without a parallel_ok pair runs one lane at a time, in main', () => {
  const p = pairProject({ parallelOk: [] });
  const f = fakes();
  f.queue({
    term_1: [{ name: 's01-ready', write: W('S01', 'ready_for_review', p.root) }, commitStep('S01')],
    term_2: [{ name: 's01-approved', write: R('S01') }],
    term_3: [{ name: 's02-ready', write: W('S02', 'ready_for_review', p.root) }, commitStep('S02')],
    term_4: [{ name: 's02-approved', write: R('S02') }],
  });
  const out = start(p, f).out;
  assert.deepEqual(out.filter((o) => o.merged).map((o) => o.merged), ['S01', 'S02']);
  assert.deepEqual(lines(f.dir, 'wtcreate.log'), []);
  assert.ok(f.spawns().every((s) => s.path === p.root));
  assert.ok(at(p.root, 'S01', /phase done/) <= at(p.root, 'S02', /selected/), 'S02 starts once S01 is done');
  assert.doesNotMatch(log(p.root, 'S02'), /beside/);
});

test('M5c: a question parks only its lane — S01 merges while S02 waits for the director', () => {
  const p = pairProject();
  const f = fakes();
  // pair placement: both in worktrees. term_1 S01 writer, term_2 S02 writer (blocked: a question), term_3 S01 reviewer,
  // term_4 S01's verifier in main after its worktree merge
  f.queue({
    term_1: [{ name: 's01-ready', wt: 'S01', write: W('S01', 'ready_for_review', p.wt1) }, { ...commitStep('S01'), wt: 'S01' }],
    term_2: [{ name: 's02-blocked', wt: 'S02', write: W('S02', 'blocked', p.wt) }],
    term_3: [{ name: 's01-approved', wt: 'S01', write: R('S01') }],
    term_4: [VERIFY('S01')],
  });
  const out = start(p, f).out;
  const asked = out.find((o) => o.asked);
  assert.equal(asked?.slice, 'S02', JSON.stringify(out));
  assert.equal(asked.kind, 'lane_blocked');
  assert.equal(asked.lane, 'worktree');
  assert.ok(out.indexOf(asked) < out.findIndex((o) => o.merged === 'S01'), 'the director hears of it at once, not after S01');
  assert.ok(f.notices().some((n) => n.includes(asked.asked)), 'notified');
  const last = out.at(-1);
  assert.equal(last.waiting, asked.asked, 'nothing else can move: the runner waits for that answer');
  assert.equal(sliceState(p.root, 'S01').phase, 'done');

  runner(p.root, f, 'answer', '--id', last.waiting, '--choice', 'answered in the lane, continue');
  // term_5 S02 reviewer, term_6 the verifier in main
  f.queue({
    term_2: [{ name: 's02-ready', wt: 'S02', write: W('S02', 'ready_for_review', p.wt) }, { ...commitStep('S02'), wt: 'S02' }],
    term_5: [{ name: 's02-approved', wt: 'S02', write: R('S02') }],
    term_6: [VERIFY('S02')],
  });
  const again = start(p, f).out;
  assert.equal(again.find((o) => o.merged)?.merged, 'S02', JSON.stringify(again.slice(-3)));
  assert.equal(f.spawns().filter((s) => s.slice === 'S02').length, 3, 'writer, reviewer, verifier: the writer was not spawned again');
});

test('M5c: a killed runner resumes both lanes — no second worktree, no second writer', () => {
  const p = pairProject();
  const f = fakes();
  f.queue({ term_1: [BUSY(1)], term_2: [BUSY(2)] });
  const first = start(p, f).out;
  assert.ok(first.at(-1).stopped, JSON.stringify(first.slice(-2)));
  assert.deepEqual(st.readRunner(p.root).lanes.map((l) => l.slice), ['S01', 'S02']);
  assert.equal(sliceState(p.root, 'S02').lane_checkout, p.wt);
  assert.equal(sliceState(p.root, 'S01').lane_checkout, p.wt1, 'pair placement: S01 in its own worktree too');
  // status shows the lanes as the lane loop sees them, not the one-lane 'more than one slice in progress'
  const shown = runner(p.root, f, 'status').out[0];
  assert.deepEqual(shown.next, { live: ['S01', 'S02'], next: null });
  assert.deepEqual(shown.lanes.map((l) => [l.slice, l.lane]), [['S01', 'worktree'], ['S02', 'worktree']]);

  clearControl(p.root);
  // term_3 S01 reviewer, term_4 S02 reviewer, term_5 and term_6 the verifiers in main
  f.queue({
    term_1: [{ name: 's01-ready', wt: 'S01', write: W('S01', 'ready_for_review', p.wt1) }, { ...commitStep('S01'), wt: 'S01' }],
    term_2: [{ name: 's02-ready', wt: 'S02', write: W('S02', 'ready_for_review', p.wt) }, { ...commitStep('S02'), wt: 'S02' }],
    term_3: [{ name: 's01-approved', wt: 'S01', write: R('S01') }],
    term_4: [{ name: 's02-approved', wt: 'S02', write: R('S02') }],
    term_5: [VERIFY('S01')],
    term_6: [VERIFY('S02')],
  });
  const out = start(p, f).out;
  assert.deepEqual(out.filter((o) => o.merged).map((o) => o.merged), ['S01', 'S02'], JSON.stringify(out.slice(-3)));
  assert.equal(lines(f.dir, 'wtcreate.log').length, 2, 'no worktree created twice');
  assert.deepEqual(f.spawns().map((s) => s.slice), ['S01', 'S02', 'S01', 'S02', 'S01', 'S02']);
});

test('M5c: a lane sent back to main (worktree_failed → main) waits until the lane in main is done', () => {
  const p = pairProject();
  const f = fakes();
  fs.writeFileSync(path.join(f.dir, 'worktree-create-fail'), '1');
  f.queue({ term_1: [BUSY(1)] });
  const first = start(p, f).out;
  // pair placement: both lanes ask for their worktree; the director sends both to main
  const qs = first.filter((o) => o.blocked === 'worktree_failed');
  assert.deepEqual(qs.map((q) => q.slice), ['S01', 'S02'], JSON.stringify(first));
  for (const q of qs) runner(p.root, f, 'answer', '--id', q.question, '--choice', 'run this slice in main');
  fs.rmSync(path.join(f.dir, 'worktree-create-fail'));

  clearControl(p.root);
  // term_2 S01 reviewer; S02's writer (term_3) starts only after S01 is done, in main
  f.queue({
    term_1: [BUSY(2), { name: 's01-ready', write: W('S01', 'ready_for_review', p.root) }, commitStep('S01')],
    term_2: [{ name: 's01-approved', write: R('S01') }],
    term_3: [{ name: 's02-ready', write: W('S02', 'ready_for_review', p.root) }, commitStep('S02')],
    term_4: [{ name: 's02-approved', write: R('S02') }],
  });
  const out = start(p, f).out;
  assert.deepEqual(out.filter((o) => o.merged).map((o) => o.merged), ['S01', 'S02'], JSON.stringify(out.slice(-3)));
  const s02 = f.spawns().filter((s) => s.slice === 'S02');
  assert.ok(s02.every((s) => s.path === p.root), 'S02 in main');
  assert.match(log(p.root, 'S02'), /S01 works in main; this lane runs in main after it/);
  assert.ok(at(p.root, 'S01', /phase done/) <= at(p.root, 'S02', /spawned writer/));
});

test('M5c pair placement: a pair starts both lanes in their own worktrees, main stays free; merges go one at a time (merge_owner)', () => {
  const p = pairProject();
  const f = fakes();
  const wt1 = p.wt1;
  // term_1/term_2 the writers, term_3/term_4 the reviewers, term_5 S01's verifier (slow), term_6 S02's
  f.queue({
    term_1: [{ name: 's01-ready', wt: 'S01', write: W('S01', 'ready_for_review', wt1) }, { ...commitStep('S01'), wt: 'S01' }],
    term_2: [BUSY(1), { name: 's02-ready', wt: 'S02', write: W('S02', 'ready_for_review', p.wt) }, { ...commitStep('S02'), wt: 'S02' }],
    term_3: [{ name: 's01-approved', wt: 'S01', write: R('S01') }],
    term_4: [{ name: 's02-approved', wt: 'S02', write: R('S02') }],
    term_5: [BUSY(2), BUSY(3), VERIFY('S01')],
    term_6: [VERIFY('S02')],
  });
  const out = start(p, f).out;
  assert.deepEqual(out.filter((o) => o.merged).map((o) => o.merged), ['S01', 'S02'], JSON.stringify(out.slice(-3)));
  assert.deepEqual(lines(f.dir, 'wtcreate.log').map((c) => c.name), ['S01-x', 'S02-x']);
  // pilot 24 S40/S41: the first lane of a pair took main for 0.07 s of "alone" and S41's merge would wait for it
  assert.match(log(p.root, 'S01'), /selected \(single lane, S02 pairs with it: in its own worktree, main stays free\)/);
  assert.match(log(p.root, 'S02'), /selected \(single lane, beside S01: in its own worktree\)/);
  assert.doesNotMatch(log(p.root, 'S01') + log(p.root, 'S02'), /works in main/);
  assert.ok(f.spawns().slice(0, 4).every((s) => s.path !== p.root), 'the two writers and two reviewers never work in main');
  // S02's worktree comes before S01's first wait: a lane that just spawned hands over (pilot 24 S39: ~80 s late)
  const calls = fs.readFileSync(path.join(f.dir, 'calls.log'), 'utf8').split('\n');
  assert.ok(calls.findIndex((c) => c.startsWith('worktree create') && c.includes('S02-x')) < calls.findIndex((c) => c.startsWith('terminal wait') && c.includes('term_1')), calls.slice(0, 12).join('\n'));
  assert.match(log(p.root, 'S02'), /merge waits: S01 is merging/);
  assert.ok(at(p.root, 'S01', /phase done/) <= at(p.root, 'S02', /merge journal started/));
  assert.equal(st.readRunner(p.root).merge_owner, null);
});

test('M5c pair placement: a partner that cannot start now (its director gate is open) leaves main to the first lane', () => {
  const p = pairProject({ gate2: true });
  const f = fakes();
  f.queue({
    term_1: [{ name: 's01-ready', write: W('S01', 'ready_for_review', p.root) }, commitStep('S01')],
    term_2: [{ name: 's01-approved', write: R('S01') }],
  });
  const out = start(p, f).out;
  assert.ok(out.find((o) => o.blocked === 'director_gate' && o.slice === 'S02'), JSON.stringify(out));
  assert.equal(out.find((o) => o.merged)?.merged, 'S01');
  assert.deepEqual(lines(f.dir, 'wtcreate.log'), [], 'S01 alone in main: no worktree');
  assert.match(log(p.root, 'S01'), /selected \(single lane\); slice in_progress/);
  assert.equal(out.at(-1).waiting !== undefined, true, 'then the runner waits for the S02 gate');
});
