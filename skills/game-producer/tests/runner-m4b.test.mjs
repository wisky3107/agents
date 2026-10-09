import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { loadProject, preflight, policyAgents, sameSpec, budgetMode, liteWhenNoAssets, isCc4, ripStudy, sliceFront } from '../scripts/lib/project.mjs';
import { fill, prompts, normalizeStatus, manualRequired } from '../scripts/lib/lanes.mjs';
import { NOTES, POLICY, project, fakes, runner, evRel, ev, sliceState, clearControl, approvedEvidence, commitStep, lastCommit, singleCommitText } from './harness.mjs';

// Lane state machines (plan M4b) against a fake orca / bootstrap (pretty-printed JSON, like the
// real ones) and the real orca-wait.
process.env.PRODUCER_RUNNER_CURSOR = 'on'; // in-process prompt builds: no real cursor-agent probe
const H = evRel('S01', 'HANDOFF.json');
const W = (status, extra = {}) => ({ [H]: { role: 'writer', status, detail: 'd', sha: null, ...extra } });
const R = (status, verdict, runtime) => ({ [H]: { role: 'reviewer', status }, ...approvedEvidence('S01', verdict, runtime) });
const preview = (port) => ({ [evRel('S01', 'preview-startup.json')]: { projectPath: '/p', previewUrl: `http://127.0.0.1:${port}/`, status: 'ready' } });
const log = (root, id = 'S01') => fs.readFileSync(ev(root, id, 'producer-log.md'), 'utf8');
const single = () => project({ slices: { S01: { needs: false } } });
const runnerFile = (root) => JSON.parse(fs.readFileSync(path.join(root, '.cursor', 'producer-runner.json'), 'utf8'));

test('single lane: writer → fresh reviewer → Step 2d accept → commit → recorded; prompts filled, each lane spawned once', () => {
  const p = single();
  const f = fakes();
  f.queue([
    { name: 'writer works', write: W('working') },
    { name: 'writer ready', write: { ...W('ready_for_review'), ...preview(7461) } },
    { name: 'review approved', write: R('approved', '**APPROVED**') }, // markdown around the verdict is the same verdict
    commitStep('S01'),
  ]);
  const out = runner(p.root, f, 'start', '--once').out;
  assert.deepEqual(out.find((o) => o.merged), { merged: 'S01', commit: lastCommit(f) });
  assert.match(out.at(-1).done, /release slice S01 is merged/);
  const sp = f.spawns();
  assert.deepEqual(sp.map((s) => [s.role, s.slice, s.agent]), [['worker', 'S01', 'claude --model sonnet --effort high'], ['worker', 'S01', 'claude --model opus']]);
  assert.match(sp[0].title, /^slice-runner-proj-\w+-S01$/);
  assert.match(sp[1].title, /^review-runner-proj-\w+-S01$/);
  for (const s of sp) assert.doesNotMatch(s.prompt, /<(?!ISO>)(?:[A-Z][A-Z_|]*|Sxx)>/);
  assert.match(sp[0].prompt, /implementing slice S01 as a single agent/);
  assert.match(sp[0].prompt, /Locks already resolved \(do not open AGENT_NOTES.md\): writer=claude --model sonnet --effort high reviewer=claude --model opus budget=advisory/);
  assert.match(sp[0].prompt, /Director decisions \(GIVEN\): director gate: S02 GIVEN/);
  assert.match(sp[0].prompt, /--port \(port of previewUrl in \/.+preview-startup\.json\)/); // the writer records the port itself
  assert.match(sp[1].prompt, /http:\/\/127\.0\.0\.1:7461\//); // the reviewer gets the writer's port
  assert.match(sp[0].prompt, /"updatedAt":"<ISO>"/); // the agent's own placeholder stays
  assert.deepEqual(f.sends(), [{ to: 'term_1', text: singleCommitText(p.root, 'S01') }]);
  assert.deepEqual(f.closes(), ['term_2', 'term_1']); // the reviewer at its verdict, the writer once recorded
  assert.equal(sliceState(p.root, 'S01').phase, 'done');
  // single lane: the commit is on main — harvest + record, no merge (M4c)
  const proj = loadProject(p.root);
  assert.deepEqual([proj.release.slices.S01, proj.release.current_slice], ['merged', '']);
  assert.match(proj.notesText, new RegExp(`\\n- S01 single merged fix_rounds=0 bump=none commit=${lastCommit(f).slice(0, 7)} merged=y -\\n`));
  // a rerun: done, no second writer, no second commit
  assert.match(runner(p.root, f, 'start', '--once').out.at(-1).done, /S01 is merged/);
  assert.equal(f.spawns().length, 2);
  assert.equal(f.sends().length, 1);
});

test('single lane: one nudge at idle 2, resume lane at idle 3; a stale review.md is not a verdict; fix round', () => {
  const p = single();
  const f = fakes();
  f.queue([
    { name: 'idle 1', result: 'idle' },
    { name: 'idle 2', result: 'idle' },
    { name: 'idle 3', result: 'idle' },
    { name: 'resumed writer ready', write: { ...W('ready_for_review'), ...preview(7461) } },
    { name: 'changes', write: R('changes_requested', 'CHANGES_REQUESTED') },
    { name: 'fixed', write: W('ready_for_review') },
    { name: 'reviewer 2 idle before its verdict', result: 'idle' },
    { name: 'approved', write: R('approved', 'APPROVED') },
    commitStep('S01'),
  ]);
  assert.equal(runner(p.root, f, 'start', '--once').out.find((o) => o.merged)?.commit, lastCommit(f));
  assert.deepEqual(f.spawns().map((s) => [s.handle, s.agent.split(' ')[2]]), [['term_1', 'sonnet'], ['term_2', 'sonnet'], ['term_3', 'opus'], ['term_4', 'opus']]);
  assert.match(f.spawns()[1].prompt, /RESUME: a previous writer stopped\. Finish verify \+ evidence only/);
  const sends = f.sends();
  assert.deepEqual(sends.map((s) => s.to), ['term_1', 'term_2', 'term_2']);
  assert.match(sends[0].text, /^Status check: .*preview-startup\.json/);
  assert.match(sends[1].text, /^Fix round 1: apply exactly the rows of the `## fix_routing` table/);
  assert.equal(sends[2].text, singleCommitText(p.root, 'S01'));
  assert.deepEqual(f.closes().slice(0, 3), ['term_1', 'term_3', 'term_4']);
  const s = sliceState(p.root, 'S01');
  assert.deepEqual([s.fix_rounds, s.respawns, s.commit_sha], [1, 1, lastCommit(f)]);
  // the costs go to lessons.jsonl once
  const lessons = fs.readFileSync(path.join(p.root, '.cursor', 'evidence', 'lessons.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(lessons.map((r) => [r.event, r.count]), [['fix_round', 1], ['respawn', 1]]);
  assert.match(loadProject(p.root).notesText, new RegExp(`- S01 single merged fix_rounds=1 bump=none commit=${lastCommit(f).slice(0, 7)} merged=y -`));
  assert.deepEqual(Object.values(s.outbox).map((e) => e.sent), [true, true, true]);
  assert.match(log(p.root), /writer term_1 stopped \(idle, idle_streak 3\): resume lane/);
});

test('single lane: INFRA_BLOCKED with the port up → cursor for the rest of the run (a frozen Orca tab first gets one fresh reviewer; or ask under no_cursor); port down → writer restarts once, then ask', async () => {
  const server = spawn(process.execPath, ['-e', "const s=require('http').createServer((q,r)=>r.end('ok')).listen(0,'127.0.0.1',()=>console.log(s.address().port))"]);
  const port = await new Promise((r) => server.stdout.once('data', (d) => r(Number(String(d).trim()))));
  const infra = { [H]: { role: 'reviewer', status: 'infra_blocked' }, [evRel('S01', 'review.md')]: 'curl: 000\nINFRA_BLOCKED\n' };
  const probeOff = (root, f) => runner(root, f, 'start', '--once', { env: { PRODUCER_RUNNER_CURSOR: 'off' } });
  try {
    const p = single();
    const f = fakes();
    f.queue([
      { write: { ...W('ready_for_review'), ...preview(port) } },
      { name: 'infra', write: infra },
      { name: 'approved', write: R('approved', 'APPROVED') },
      commitStep('S01'),
    ]);
    assert.equal(runner(p.root, f, 'start', '--once').out.find((o) => o.merged)?.commit, lastCommit(f));
    // never the same sandboxed reviewer again (SKILL anti-pattern); the switch is locked run-wide
    assert.deepEqual(f.spawns().slice(1).map((s) => s.agent), ['claude --model opus', 'cursor --model auto']);
    assert.equal(runnerFile(p.root).reviewer_override, 'cursor --model auto');

    // a frozen Orca tab: one fresh reviewer of the same agent (its prompt falls back to Chrome headless), then Cursor
    const fz = single();
    const ff = fakes();
    const frozen = { [H]: { role: 'reviewer', status: 'infra_blocked' }, [evRel('S01', 'review.md')]: 'run-smoke: page never became ready; rAF 0/2s, hasFocus false\nINFRA_BLOCKED\n' };
    ff.queue([
      { write: { ...W('ready_for_review'), ...preview(port) } },
      { name: 'frozen', write: frozen },
      { name: 'frozen again', write: frozen },
      { name: 'approved', write: R('approved', 'APPROVED') },
      commitStep('S01'),
    ]);
    assert.equal(runner(fz.root, ff, 'start', '--once').out.find((o) => o.merged)?.commit, lastCommit(ff));
    assert.deepEqual(ff.spawns().slice(1).map((x) => x.agent), ['claude --model opus', 'claude --model opus', 'cursor --model auto']);
    assert.match(log(fz.root), /INFRA_BLOCKED for a frozen Orca tab while 127\.0\.0\.1:\d+ answers 200: a fresh reviewer with the Chrome headless fallback/);

    // a sandbox that reached nothing (curl 000) or a missing Playwright is not a frozen tab: straight to Cursor
    for (const body of ['curl: 000; page never became ready, frozen?\nINFRA_BLOCKED\n', 'rAF 0, then run-smoke --channel chrome: playwright not found\nINFRA_BLOCKED\n']) {
      const nz = single();
      const nf = fakes();
      nf.queue([{ write: { ...W('ready_for_review'), ...preview(port) } }, { name: 'not frozen', write: { [H]: { role: 'reviewer', status: 'infra_blocked' }, [evRel('S01', 'review.md')]: body } }, { name: 'approved', write: R('approved', 'APPROVED') }, commitStep('S01')]);
      runner(nz.root, nf, 'start', '--once');
      assert.deepEqual(nf.spawns().slice(1).map((x) => x.agent), ['claude --model opus', 'cursor --model auto'], body);
    }

    const n = project({ notes: NOTES(`${POLICY} no_cursor=true`), slices: { S01: { needs: false } } });
    const g = fakes();
    g.queue([{ write: { ...W('ready_for_review'), ...preview(port) } }, { name: 'infra', write: infra }]);
    const a = runner(n.root, g, 'start', '--once').out.at(-1);
    assert.deepEqual([a.waiting, a.kind], ['q1', 'infra_blocked']);
    assert.equal(g.spawns().length, 2);
    // no policy, but the probe says Cursor cannot log in: the same ask, no Cursor reviewer
    const po = single();
    const pf = fakes();
    pf.queue([{ write: { ...W('ready_for_review'), ...preview(port) } }, { name: 'infra', write: infra }]);
    const b = probeOff(po.root, pf).out.at(-1);
    assert.deepEqual([b.kind, pf.spawns().map((x) => x.agent)], ['infra_blocked', ['claude --model sonnet --effort high', 'claude --model opus']]);
    assert.match(runnerFile(po.root).questions[0].text, /Cursor is off: PRODUCER_RUNNER_CURSOR/);

    const q = single();
    const h = fakes();
    h.queue([
      { write: { ...W('ready_for_review'), ...preview(1) } },
      { name: 'infra 1', write: infra },
      { name: 'writer restarted', write: W('ready_for_review') },
      { name: 'infra 2', write: infra },
    ]);
    const out = runner(q.root, h, 'start', '--once').out;
    assert.deepEqual([out.at(-1).waiting, out.at(-1).kind], ['q1', 'infra_blocked']);
    assert.match(h.sends()[0].text, /^The reviewer found no preview at 127\.0\.0\.1:1 \(INFRA_BLOCKED\)\. Restart or reuse the preview/);
    assert.deepEqual(h.spawns().map((s) => s.agent), ['claude --model sonnet --effort high', 'claude --model opus', 'claude --model opus']);
  } finally {
    server.kill();
  }
});

test('Step 2d: no commit on manual_required or missing evidence; HANDOFF without a status is a question', () => {
  const p = single();
  const f = fakes();
  f.queue([{ write: { ...W('ready_for_review'), ...preview(7461) } }, { write: R('approved', 'APPROVED', { status: 'manual_required', reason: 'no preview' }) }]);
  const a = runner(p.root, f, 'start', '--once').out.at(-1);
  assert.deepEqual([a.waiting, a.kind, a.options], ['q1', 'manual_required', ['spawn a fresh reviewer', 'mark blocked', 'stop']]);
  assert.deepEqual(f.sends(), []);
  fs.rmSync(ev(p.root, 'S01', 'evidence', 'final-report.md'));
  fs.writeFileSync(ev(p.root, 'S01', 'evidence', 'runtime-state.json'), JSON.stringify({ status: 'verified', manual_required: false }));
  runner(p.root, f, 'answer', '--id', 'q1', '--choice', 'stop');
  runner(p.root, f, 'start', '--once');
  clearControl(p.root);
  fs.writeFileSync(ev(p.root, 'S01', 'producer-state.json'), JSON.stringify({ ...sliceState(p.root, 'S01'), phase: 'accept' }));
  const b = runner(p.root, f, 'start', '--once').out.at(-1);
  assert.deepEqual([b.kind], ['approval_evidence']);
  const text = JSON.parse(fs.readFileSync(path.join(p.root, '.cursor', 'producer-runner.json'), 'utf8')).questions.at(-1).text;
  assert.match(text, /evidence missing: final-report\.md/);

  const q = single();
  const g = fakes();
  g.queue([{ write: { [H]: { role: 'writer', detail: 'no status field' } } }]);
  const c = runner(q.root, g, 'start', '--once').out.at(-1);
  assert.deepEqual([c.waiting, c.kind], ['q1', 'unknown_status']);
  assert.equal(g.spawns().length, 1); // no nudge-then-respawn on a status the runner cannot read
  assert.equal(manualRequired({ checks: [{ id: 'a', result: 'manual_required' }] }), true);
  assert.equal(manualRequired({ status: 'verified', manual_required: [] }), false);
  assert.deepEqual([{ manual_required: { feel: 'no device' } }, { manual_required: 2 }, { status: 'MANUAL_REQUIRED' }, { manual_required: 0 }, { manual_required: 'none' }].map(manualRequired),
    [true, true, true, false, false]);
});

test('fleet lane: gate relayed as text (never resolved by the runner), takeover handle, accept → commit to the current coordinator', () => {
  const p = project({ slices: { S01: { needs: false, size: 'L' } } });
  const f = fakes();
  const gate = { id: 'g1', status: 'pending', question: 'Approve PLAN?', options: '["approve","revise"]' };
  f.queue([
    { name: 'run created', runs: [{ id: 'run_1', coordinator_handle: 'term_1' }], write: { [H]: { role: 'orchestrator', status: 'working' } } },
    { name: 'gate opened', gates: [gate] },
  ]);
  const a = runner(p.root, f, 'start', '--once').out.at(-1);
  assert.deepEqual([a.waiting, a.kind, a.options], ['q1', 'fleet_gate', ['approve', 'revise', 'stop']]);
  const sp = f.spawns();
  assert.deepEqual(sp.map((s) => [s.role, s.agent]), [['coordinator', 'claude --model sonnet']]);
  assert.match(sp[0].prompt, /running slice S01/);
  assert.match(sp[0].prompt, /LITE: true/); // no assets and lite_when_no_assets on
  assert.match(sp[0].prompt, /writer=claude --model sonnet --effort high reviewer=claude --model opus scanner=claude --model sonnet art=antigravity mesh=auto mesh_agent=claude --model opus budget=advisory lite=true cursor=on/);
  assert.equal(sliceState(p.root, 'S01').run, 'run_1');
  // the branch main was on at selection is where the slice merges back (M4c)
  assert.equal(sliceState(p.root, 'S01').base_branch, spawnSync('git', ['-C', p.root, 'symbolic-ref', '--short', 'HEAD'], { encoding: 'utf8' }).stdout.trim());

  runner(p.root, f, 'answer', '--id', 'q1', '--choice', 'approve', '--text', 'ship the 3 boards');
  // the gate stays pending (only the coordinator resolves it): after GATE_PATIENCE pauses → ask again
  const b = runner(p.root, f, 'start', '--once').out.at(-1);
  assert.deepEqual([b.waiting, b.kind], ['q2', 'gate_unresolved']);
  assert.deepEqual(f.sends(), [{ to: 'term_1', text: 'Director decision for gate g1: approve — ship the 3 boards. Resolve your gate with it and continue.' }]);
  assert.doesNotMatch(fs.readFileSync(path.join(f.dir, 'calls.log'), 'utf8'), /gate-resolve|run-use|task-create|dispatch/);

  f.set('gates.json', [{ ...gate, status: 'resolved' }]);
  f.set('runs.json', [{ id: 'run_1', coordinator_handle: 'term_7' }]); // takeover
  const fleetEvidence = { [evRel('S01', 'review.md')]: 'F1\n\nAPPROVED\n', [evRel('S01', 'runtime-state.json')]: { status: 'verified' }, [evRel('S01', 'final-report.md')]: 'x', [evRel('S01', 'stats.json')]: {} };
  f.queue([
    { name: 'offer', write: { [H]: { role: 'coordinator', status: 'offer_commit' }, ...fleetEvidence } },
    // the coordinator commits and exits: committed + sha wins over the missing terminal
    { name: 'committed', write: { [H]: { role: 'coordinator', status: 'committed', sha: 'f00d' } }, result: 'missing' },
  ]);
  runner(p.root, f, 'answer', '--id', 'q2', '--choice', 'continue waiting');
  const c = runner(p.root, f, 'start', '--once').out.at(-1);
  // committed: the merge journal starts; this fake commit has no branch to merge (M4c has the real ones)
  assert.deepEqual([sliceState(p.root, 'S01').phase, sliceState(p.root, 'S01').commit_sha, c.kind], ['merge', 'f00d', 'merge_source_missing']);
  // the fleet's commit line names the runner: a bare "approved — commit" typed by hand is not it (M6)
  assert.deepEqual(f.sends().at(-1), { to: 'term_7', text: 'approved — commit (producer: Step 2d passed)' });
  assert.equal(sliceState(p.root, 'S01').coordinator, 'term_7');
  assert.equal(f.spawns().length, 1); // a fleet coordinator is never respawned
});

test('fleet lane: offer_commit with manual_required is not committed; idle → one nudge then the human; missing → reported', () => {
  const p = project({ slices: { S01: { needs: false, size: 'L' } } });
  const f = fakes();
  f.queue([
    { runs: [{ id: 'run_1', coordinator_handle: 'term_1' }], write: { [H]: { role: 'coordinator', status: 'working' } } },
    { name: 'idle 1', result: 'idle' },
    { name: 'idle 2', result: 'idle' },
    { name: 'idle 3', result: 'idle' },
  ]);
  const a = runner(p.root, f, 'start', '--once').out.at(-1);
  assert.deepEqual([a.waiting, a.kind], ['q1', 'fleet_stall']);
  assert.equal(f.sends().length, 1);
  assert.match(f.sends()[0].text, /^resume the cocos-orca-fleet Coordinator loop/);
  runner(p.root, f, 'answer', '--id', 'q1', '--choice', 'nudged again, continue');
  f.queue([{ name: 'offer', write: { [H]: { role: 'coordinator', status: 'offer_commit' }, [evRel('S01', 'review.md')]: 'F1\n\nAPPROVED\n', [evRel('S01', 'runtime-state.json')]: { status: 'manual_required' } } }]);
  const b = runner(p.root, f, 'start', '--once').out.at(-1);
  assert.deepEqual([b.waiting, b.kind], ['q2', 'manual_required']);
  assert.equal(f.sends().length, 1); // no "approved — commit"
  runner(p.root, f, 'answer', '--id', 'q2', '--choice', 'stop');
  runner(p.root, f, 'start', '--once');
  clearControl(p.root);
  fs.writeFileSync(ev(p.root, 'S01', 'producer-state.json'), JSON.stringify({ ...sliceState(p.root, 'S01'), phase: 'fleet' }));
  fs.writeFileSync(path.join(p.root, H), JSON.stringify({ role: 'coordinator', status: 'working' }));
  // gone for Orca too (terminal show: stale) — a "missing" that terminal show disproves is M6's test
  f.queue([{ name: 'gone', result: 'missing', dead: ['term_1'] }]);
  const c = runner(p.root, f, 'start', '--once').out.at(-1);
  assert.deepEqual([c.waiting, c.kind], ['q3', 'coordinator_missing']);
  assert.equal(f.spawns().length, 1);
});

test('failures: a message to a closed writer is a question; "resume lane carries it" puts it in the resume prompt', () => {
  const p = single();
  const f = fakes();
  f.queue([
    { name: 'ready', write: { ...W('ready_for_review'), ...preview(7461) } },
    { name: 'changes, writer gone', write: R('changes_requested', 'CHANGES_REQUESTED'), dead: ['term_1'] },
  ]);
  const a = runner(p.root, f, 'start', '--once').out.at(-1);
  assert.deepEqual([a.waiting, a.kind, a.options], ['q1', 'send_failed', ['resume lane carries it', 'retry the send', 'drop the message', 'mark blocked', 'stop']]);
  assert.deepEqual(f.sends(), []);
  runner(p.root, f, 'answer', '--id', 'q1', '--choice', 'resume lane carries it');
  f.queue([]);
  runner(p.root, f, 'start', '--once');
  const resume = f.spawns()[2];
  assert.equal(resume.agent, 'claude --model sonnet --effort high');
  assert.match(resume.prompt, /RESUME: a previous writer stopped before this reached it[\s\S]*Fix round 1: apply exactly the rows/);
  const s = sliceState(p.root, 'S01');
  assert.deepEqual([s.phase, s.writer, s.outbox['fix:1'].dropped], ['writer', 'term_3', true]);

  // the commit cannot ride a resume lane (it would send an approved slice back to review)
  const q = single();
  const g = fakes();
  g.queue([
    { name: 'ready', write: { ...W('ready_for_review'), ...preview(7461) } },
    { name: 'approved, writer gone', write: R('approved', 'APPROVED'), dead: ['term_1'] },
  ]);
  const b = runner(q.root, g, 'start', '--once').out.at(-1);
  assert.deepEqual([b.kind, b.options], ['send_failed', ['retry the send', 'drop the message', 'mark blocked', 'stop']]);
  assert.match(runnerFile(q.root).questions[0].text, /the lane that must commit is gone/);
});

test('failures: orca-error retried once then asked; a prompt bootstrap could not send is asked, then respawned on request', () => {
  const p = single();
  const f = fakes();
  f.queue([{ name: 'runtime down', result: 'error' }, { name: 'still down', result: 'error' }]);
  const a = runner(p.root, f, 'start', '--once').out.at(-1);
  assert.deepEqual([a.waiting, a.kind], ['q1', 'orca_error']);
  assert.match(log(p.root), /orca-error, retrying the wait once/);

  const q = single();
  const g = fakes();
  fs.writeFileSync(path.join(g.dir, 'bootstrap-no-prompt'), '1');
  const b = runner(q.root, g, 'start', '--once').out.at(-1);
  assert.deepEqual([b.waiting, b.kind], ['q1', 'prompt_not_sent']);
  fs.rmSync(path.join(g.dir, 'bootstrap-no-prompt'));
  runner(q.root, g, 'answer', '--id', 'q1', '--choice', 'close it and spawn again');
  g.queue([]);
  runner(q.root, g, 'start', '--once');
  assert.deepEqual(g.spawns().map((s) => s.handle), ['term_1', 'term_2']);
  assert.deepEqual(g.closes(), ['term_1']);
});

test('resume safety: registry reattach, unsent outbox delivered once, adopt and in-flight yaml statuses, blocked state vs yaml', () => {
  // killed between spawn and recording the handle: the registry gives it back, no second writer
  const p = project({ notes: NOTES(POLICY, '{S01: in_progress}'), slices: { S01: { needs: false } } });
  const f = fakes();
  fs.mkdirSync(ev(p.root, 'S01'), { recursive: true });
  const since = new Date(Date.now() - 1000).toISOString();
  fs.writeFileSync(ev(p.root, 'S01', 'producer-state.json'), JSON.stringify({ phase: 'spawn-writer', lane: 'single', writer_spawning: since }));
  fs.appendFileSync(path.join(f.dir, 'registry.jsonl'), 'not json\n' + JSON.stringify({ ts: new Date().toISOString(), cwd: p.root, role: 'worker', slice: 'S01', handle: 'term_9' }) + '\n');
  const re = runner(p.root, f, 'start', '--once').out.at(-1);
  assert.deepEqual([re.waiting, re.kind], ['q1', 'prompt_not_sent']);
  assert.equal(f.spawns().length, 0);
  assert.equal(sliceState(p.root, 'S01').writer, 'term_9');
  assert.match(log(p.root), /reattached writer term_9 from the spawn registry/);
  runner(p.root, f, 'answer', '--id', 'q1', '--choice', 'prompt is in the terminal, continue');
  f.queue([]);
  runner(p.root, f, 'start', '--once');
  assert.match(fs.readFileSync(path.join(f.dir, 'calls.log'), 'utf8'), /terminal wait --terminal term_9/);
  // an outbox intent written before a kill is delivered on resume, once
  clearControl(p.root);
  const s = sliceState(p.root, 'S01');
  fs.writeFileSync(ev(p.root, 'S01', 'producer-state.json'), JSON.stringify({ ...s, outbox: { 'fix:1': { to: 'term_9', text: 'Fix round 1: …', sent: false } } }));
  f.queue([]);
  runner(p.root, f, 'start', '--once');
  clearControl(p.root);
  f.queue([]);
  runner(p.root, f, 'start', '--once');
  assert.deepEqual(f.sends(), [{ to: 'term_9', text: 'Fix round 1: …' }]);

  // in flight with no runner state (an LLM producer started it, or yaml `approved`): ask, never spawn blind
  for (const status of ['in_progress', 'approved', 'changes_requested']) {
    const q = project({ notes: NOTES(POLICY, `{S01: ${status}}`), slices: { S01: { needs: false } } });
    const g = fakes();
    const a = runner(q.root, g, 'start', '--once').out.at(-1);
    assert.deepEqual([a.waiting, a.kind, g.spawns().length], ['q1', 'adopt', 0], status);
    if (status === 'in_progress') {
      runner(q.root, g, 'answer', '--id', 'q1', '--choice', 'no lane is running, start it');
      g.queue([]);
      runner(q.root, g, 'start', '--once');
      assert.equal(g.spawns().length, 1);
    }
  }

  // runner state says blocked but the director flipped the yaml back to in_progress: one question, no hot loop
  const b = project({ notes: NOTES(POLICY, '{S01: in_progress}'), slices: { S01: { needs: false } } });
  const h = fakes();
  fs.mkdirSync(ev(b.root, 'S01'), { recursive: true });
  fs.writeFileSync(ev(b.root, 'S01', 'producer-state.json'), JSON.stringify({ phase: 'blocked', lane: 'single', blocked_reason: 'lane_hung: mark blocked' }));
  const t0 = Date.now();
  const c = runner(b.root, h, 'start', '--once').out.at(-1);
  assert.deepEqual([c.waiting, c.kind], ['q1', 'blocked_resume']);
  assert.ok(Date.now() - t0 < 10000);
  runner(b.root, h, 'answer', '--id', 'q1', '--choice', 'start the slice fresh');
  h.queue([]);
  runner(b.root, h, 'start', '--once');
  assert.equal(h.spawns().length, 1);
  assert.ok(fs.readdirSync(ev(b.root, 'S01')).some((n) => /^producer-state\.prev-/.test(n)));

  // a HANDOFF from an older run is not news; an unknown status is a question; mark blocked moves on
  const r = single();
  const k = fakes();
  fs.mkdirSync(ev(r.root, 'S01', 'evidence'), { recursive: true });
  fs.writeFileSync(path.join(r.root, H), JSON.stringify({ status: 'ready_for_review' }));
  k.queue([{ name: 'idle on the stale file', result: 'idle' }, { name: 'odd', write: W('done') }]);
  const d = runner(r.root, k, 'start', '--once').out.at(-1);
  assert.deepEqual([d.waiting, d.kind, d.options], ['q1', 'unknown_status', ['treat as working, keep waiting', 'treat as ready_for_review', 'mark blocked', 'stop']]);
  assert.equal(k.spawns().length, 1); // no reviewer on the stale ready_for_review
  runner(r.root, k, 'answer', '--id', 'q1', '--choice', 'mark blocked');
  k.queue([]);
  const e = runner(r.root, k, 'start', '--once').out.at(-1);
  assert.equal(e.kind, 'stuck');
  assert.equal(loadProject(r.root).release.slices.S01, 'blocked');
  assert.equal(sliceState(r.root, 'S01').phase, 'blocked');
});

test('stop-after Sxx stops once Sxx is merged, not before', () => {
  const p = project({ slices: { S01: { needs: false }, S02: { needs: false } } });
  const f = fakes();
  runner(p.root, f, 'stop-after', 'S01');
  f.queue([]);
  runner(p.root, f, 'start', '--once'); // S01 not merged yet: it starts
  assert.equal(f.spawns().length, 1);
  p.commit('feat(S01): first slice');
  fs.writeFileSync(path.join(p.root, '.cursor', 'producer.control'), 'stop-after S01\n');
  const a = runner(p.root, f, 'start', '--once').out.at(-1);
  assert.match(a.stopped, /stop-after S01: S01 is merged; not starting S02/);
  assert.equal(f.spawns().length, 1);
});

test('dry-run and status are read-only even with docs/brief-progress.json; the brief gate holds before the first dispatch only', () => {
  const p = project({ slices: { S01: { needs: false }, S02: { needs: false } } });
  fs.mkdirSync(path.join(p.root, 'docs'));
  fs.writeFileSync(path.join(p.root, 'docs', 'brief-progress.json'), JSON.stringify({ runId: 'r1', phase: 'done', contractHash: 'stale' }));
  const f = fakes();
  const hash = () => {
    const h = crypto.createHash('sha256');
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (e.name === '.git') continue;
        const q = path.join(d, e.name);
        h.update(q);
        if (e.isDirectory()) walk(q);
        else h.update(fs.readFileSync(q)).update(String(fs.statSync(q).mtimeMs));
      }
    };
    walk(p.root);
    return h.digest('hex');
  };
  const before = hash();
  const dry = runner(p.root, f, 'start', '--dry-run').out[0];
  runner(p.root, f, 'status');
  assert.equal(hash(), before);
  assert.deepEqual(dry.blockers.map((b) => b.code), ['brief_progress']);
  assert.match(dry.blockers[0].detail, /gate_stale/);
  p.commit('feat(S01): first slice'); // after the first dispatch the brief gate no longer applies
  assert.deepEqual(runner(p.root, f, 'start', '--dry-run').out[0].blockers, []);
});

test('contracts_uncommitted: untracked slices/contracts or a dirty slice file block the dispatch; runner-owned AGENT_NOTES dirt does not', () => {
  const p = project({ slices: { S01: { needs: false }, S02: { needs: false } } });
  const f = fakes();
  const codes = () => runner(p.root, f, 'start', '--dry-run').out[0].blockers.map((b) => b.code);
  const g = (...a) => spawnSync('git', ['-C', p.root, ...a], { encoding: 'utf8' });
  p.commit('feat(S01): first slice'); // past the brief gate
  fs.appendFileSync(path.join(p.root, 'AGENT_NOTES.md'), '\n- runner note\n');
  assert.deepEqual(codes(), []);
  const s2 = path.join(p.root, 'slices', 'S02-x.md');
  fs.writeFileSync(s2, fs.readFileSync(s2, 'utf8') + '\nedit\n');
  assert.deepEqual(codes(), ['contracts_uncommitted']);
  g('checkout', '--', 'slices');
  fs.writeFileSync(path.join(p.root, 'HOW_TO.md'), '# how\n');
  const dry = runner(p.root, f, 'start', '--dry-run').out[0];
  assert.deepEqual(dry.blockers.map((b) => b.code), ['contracts_uncommitted']);
  assert.match(dry.blockers[0].detail, /HOW_TO\.md.*Commit the contract set/);
  g('add', 'HOW_TO.md');
  assert.deepEqual(codes(), ['contracts_uncommitted']); // staged is still absent from HEAD
  g('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'docs: contracts');
  assert.deepEqual(codes(), []);
});

test('locks: policy agents vs yaml, budget mode, lite flag, cursor state, cc4, study pin, template guard, status aliases', async () => {
  assert.deepEqual(policyAgents('goal=end_to_end budget=advisory orchestrator=codex:gpt-6-luna-high:high scanner=claude:sonnet:high writer=claude:sonnet:high reviewer=codex:gpt-6.1-sol art=antigravity (director gate: S01 GIVEN, reviewer=x (nested) still inside)'), {
    orchestrator_agent: 'codex:gpt-6-luna-high:high', scanner_agent: 'claude:sonnet:high', writer_agent: 'claude:sonnet:high', reviewer_agent: 'codex:gpt-6.1-sol',
  });
  assert.deepEqual(policyAgents('deploy=none · reviewer=claude --model opus · art=antigravity'), { reviewer_agent: 'claude --model opus' });
  assert.deepEqual(policyAgents('lite=true coordinator=codex --model gpt-5.6-terra scanner/planner/writer/reviewer/rip-analyst=opencode --model opencode'), {
    orchestrator_agent: 'codex --model gpt-5.6-terra', scanner_agent: 'opencode --model opencode', planner_agent: 'opencode --model opencode',
    writer_agent: 'opencode --model opencode', reviewer_agent: 'opencode --model opencode',
  });
  assert.equal(sameSpec('claude:sonnet:high', 'claude --model sonnet --effort high'), true);
  assert.equal(sameSpec('codex', 'codex --model gpt-6.1-sol'), true);
  assert.equal(sameSpec('codex:gpt-6.1-sol', 'claude --model opus --effort medium'), false);
  assert.equal(sameSpec('claude:opus:high', 'claude --model opus --effort medium'), false);

  const conflict = project({ notes: NOTES(`${POLICY} reviewer=codex:gpt-6.1-sol`), slices: { S01: { needs: false } } });
  assert.deepEqual(preflight(loadProject(conflict.root), 'S01').map((b) => b.code), ['agent_conflict']);
  const mode = (policy, scope) => {
    const p = project({ notes: NOTES(policy), slices: { S01: { needs: false } } });
    if (scope) fs.writeFileSync(path.join(p.root, 'SCOPE.md'), `# SCOPE\n\nbudget_mode: ${scope}\n`);
    return budgetMode(loadProject(p.root));
  };
  assert.equal(mode(POLICY), 'advisory');
  assert.equal(mode(POLICY.replace('budget=advisory', 'budget=gate')), 'gate:15');
  assert.equal(mode(POLICY.replace('budget=advisory', 'budget=gate:20')), 'gate:20');
  assert.equal(mode(POLICY.replace('budget=advisory', 'bump=15%'), 'gate'), 'gate:15');
  assert.equal(mode(POLICY.replace('budget=advisory', 'bump=15%')), 'advisory'); // legacy token alone
  assert.equal(mode(POLICY.replace('budget=advisory', 'budget=loose')), null);
  // Cursor off: no_cursor (the director's override) moves every Cursor role; otherwise the runner's
  // one cursor_off answer does — until then nothing is moved and the runner asks before spawning
  const cur = (policy) => loadProject(project({ notes: NOTES(policy), slices: { S01: { needs: false, size: 'L' } } }).root);
  const { fleetLocks, cursorUndecided } = await import('../scripts/lib/lanes.mjs');
  const cursorFleet = (pj) => Object.assign(pj.fleet, { scanner_agent: 'cursor --model auto', reviewer_agent: 'cursor --model auto' }) && pj;
  try {
    process.env.PRODUCER_RUNNER_CURSOR = 'off';
    const pj = cursorFleet(cur(POLICY));
    assert.deepEqual(cursorUndecided(pj, 'fleet'), ['reviewer', 'scanner']);
    assert.deepEqual(cursorUndecided(pj, 'single'), ['reviewer']);
    fs.mkdirSync(path.join(pj.root, '.cursor'), { recursive: true });
    fs.writeFileSync(path.join(pj.root, '.cursor', 'producer-runner.json'), JSON.stringify({ questions: [], cursor_substitute: 'claude --model sonnet --effort high' }));
    assert.deepEqual(cursorUndecided(pj, 'fleet'), []);
    assert.equal(fleetLocks(pj, 'advisory', true), 'writer=claude --model sonnet --effort high reviewer=claude --model sonnet --effort high scanner=claude --model sonnet --effort high art=antigravity mesh=auto mesh_agent=claude --model opus budget=advisory lite=true cursor=off (Cursor roles above already moved by the director)');
    // mesh_agent: Cursor off moves it to Opus with no question (a mesh worker needs no image tools)
    const { meshAgent } = await import('../scripts/lib/lanes.mjs');
    const withMesh = (spec) => { const p = cur(POLICY); p.fleet.mesh_agent = spec; return p; };
    assert.equal(meshAgent(withMesh('cursor --model auto')), 'claude --model opus');
    assert.equal(meshAgent(withMesh('codex')), 'codex');
    assert.equal(meshAgent(withMesh('art_backend')), 'art_backend');
    assert.deepEqual(cursorUndecided(withMesh('cursor --model auto'), 'fleet'), []); // never a cursor_off question
    const nc = cursorFleet(cur(`${POLICY} no_cursor=true`));
    assert.deepEqual(cursorUndecided(nc, 'fleet'), []); // the policy decided
    assert.match(fleetLocks(nc, 'advisory', true), /reviewer=claude --model sonnet --effort high .* cursor=off \(Cursor roles/);
    process.env.PRODUCER_RUNNER_CURSOR = 'ON'; // normalised
    assert.match(fleetLocks(cursorFleet(cur(POLICY)), 'advisory', true), /reviewer=cursor --model auto scanner=cursor --model auto .* cursor=on$/);
  } finally {
    process.env.PRODUCER_RUNNER_CURSOR = 'on';
  }
  const lite = project({ notes: NOTES(`${POLICY} lite=false`), slices: { S01: { needs: false, size: 'L' } } });
  assert.equal(liteWhenNoAssets(loadProject(lite.root)), false);
  assert.match(prompts(loadProject(lite.root), 'S01').fleet(), /LITE: false/);
  const art = project({ slices: { S01: { needs: false, size: 'L', assets: 'hero.png' } } });
  assert.match(prompts(loadProject(art.root), 'S01').fleet(), /LITE: false/);
  assert.match(prompts(loadProject(art.root), 'S01').fleet(), /Engine: Cocos Creator 3\.8 \+ Funplay/);

  // cc4 before any cocos-cli-mcp.config.json exists: package.json creator 4.x
  const cc4 = project({ slices: { S01: { needs: false, size: 'L' } } });
  fs.writeFileSync(path.join(cc4.root, 'package.json'), JSON.stringify({ creator: { version: '4.0.0' } }));
  assert.equal(isCc4(loadProject(cc4.root)), true);
  assert.match(prompts(loadProject(cc4.root), 'S01').fleet(), /Engine: cc4/);

  // port project: a study is needed unless `rip_study: []`; only a reviewed pin with its hash goes to the lane
  const port = project({
    notes: NOTES(POLICY, '{}', 'rip_port:\n  analysis_path: reference/x/rip-port/\n  slice_studies:\n    S01: {status: reviewed, sha256: abc123}\n    S02: {status: analyzed, sha256: def}\n'),
    slices: { S01: { needs: false }, S02: { needs: false } },
  });
  const pj = loadProject(port.root);
  assert.deepEqual(ripStudy(pj, 'S01', sliceFront(pj, 'S01').data), { needed: true, pin: 'reference/x/rip-port/slices/S01/ sha256=abc123', status: 'reviewed' });
  assert.match(prompts(pj, 'S01').writer(), /Slice study: reference\/x\/rip-port\/slices\/S01\/ sha256=abc123\./);
  assert.deepEqual(preflight(pj, 'S02').map((b) => b.code), ['needs_slice_study']);
  const off = project({ notes: NOTES(POLICY, '{}', 'rip_port:\n  enabled: false\n'), slices: { S01: { needs: false } } });
  assert.deepEqual(preflight(loadProject(off.root), 'S01'), []); // a disabled port needs no study

  assert.throws(() => fill('slice <Sxx> at <NEW_KEY>', { Sxx: 'S01' }), /unfilled placeholders: <NEW_KEY>/);
  assert.equal(fill('at <ISO> for <Sxx>', { Sxx: 'S01' }), 'at <ISO> for S01');
  assert.deepEqual(['READY_FOR_REVIEW', 'ready_for_independent_review', 'done', null].map(normalizeStatus), ['ready_for_review', 'ready_for_review', null, null]);
  // a lane naming its step (pilot 1: "implementing") is working: the runner only waits on it
  assert.deepEqual(['implementing', 'In_Progress', 'reviewing', 'shipped'].map(normalizeStatus), ['working', 'working', 'working', null]);
});

test('single lane: check-slice FAIL at ready_for_review goes back to the writer (not a fix round); fixed → reviewer', () => {
  // an old spec the slice turned red: its Run: header runs a script that passes only once tests/fixed.flag exists
  const p = project({
    slices: { S01: { needs: false } },
    files: {
      'tests/old.spec.ts': '/**\n * Run:\n *   node tests/run-old.js\n */\n',
      'tests/run-old.js': "const fs = require('fs'); if (!fs.existsSync('tests/fixed.flag')) { console.log('FAIL placement'); process.exit(1); }\n",
    },
  });
  const f = fakes();
  f.queue([
    { name: 'writer ready, spec red', write: { ...W('ready_for_review'), ...preview(7461) } },
    { name: 'writer fixed', write: { 'tests/fixed.flag': 'x', ...W('ready_for_review', { detail: 'static fixed' }) } },
    { name: 'review approved', write: R('approved', 'APPROVED') },
    commitStep('S01'),
  ]);
  const out = runner(p.root, f, 'start', '--once').out;
  assert.deepEqual(out.find((o) => o.merged), { merged: 'S01', commit: lastCommit(f) });
  const sends = f.sends();
  assert.match(sends[0].text, /^Static check FAIL before review \(specs\), see .*static-check\.txt\. .*This is not a review round\.$/);
  assert.equal(f.spawns().length, 2); // writer, then one reviewer only after the fix
  assert.match(fs.readFileSync(ev(p.root, 'S01', 'evidence/static-check.txt'), 'utf8'), /PASS specs: 1\/1 specs [^\n]*\n[\s\S]*RESULT PASS/);
  assert.match(log(p.root), /static check FAIL \(specs\)[\s\S]*static check PASS/);
  const s = sliceState(p.root, 'S01');
  assert.equal(s.fix_rounds || 0, 0);
  assert.equal(s.static_bounces, 1);
});
