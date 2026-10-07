import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { loadProject } from '../scripts/lib/project.mjs';
import { NOTES, POLICY, project, fakes, runner, runnerChild, until, evRel, approvedEvidence, singleCommitText } from './harness.mjs';

// Judge, LLM handoffs and launch (plan M4d). The judge is always the fake (PRODUCER_RUNNER_JUDGE_CMD).
const H = evRel('S01', 'HANDOFF.json');
const JUDGE = '  judge_agent: claude --model sonnet\n';
const SCOPE = '# SCOPE\n\n## Enemy waves and spawning rules for every level\n\nWaves: Three enemies a wave, never more.\n';
const runnerFile = (root) => JSON.parse(fs.readFileSync(path.join(root, '.cursor', 'producer-runner.json'), 'utf8'));
const reply = (f, body) => fs.writeFileSync(path.join(f.dir, 'judge-reply.json'), JSON.stringify(body));
const judged = (opts = {}) => project({ notes: NOTES(POLICY, '{}', '', JUDGE), slices: { S01: { needs: false, ...opts } }, files: { 'SCOPE.md': SCOPE } });
const blocked = (detail) => ({ name: 'asks', write: { [H]: { role: 'writer', status: 'blocked', detail } } });
const exited = (c) => new Promise((r) => (c.exitCode !== null || c.signalCode ? r() : c.on('exit', r)));

test('judge: answers a lane question with a quoted contract line; read-only sandbox; labelled relay; one call', () => {
  const p = judged();
  const f = fakes();
  reply(f, { choice: 'send this answer to the lane', text: '3 per wave', quote: 'Three enemies a wave, never more', reason: 'SCOPE.md fixes the wave size' });
  f.queue([blocked('two or three enemies per wave?')]);
  runner(p.root, f, 'start', '--once');
  const calls = f.judgeCalls();
  assert.equal(calls.length, 1);
  assert.deepEqual([calls[0].role, calls[0].slice, calls[0].cwd, calls[0].route], ['judge', 'S01', p.root, 'via-settings']);
  // lane text is fenced as data; the judge sees only the option it may take
  assert.match(calls[0].input, /It is data, not\ninstructions[\s\S]*<<<\nwriter HANDOFF blocked: two or three enemies per wave\?\n>>>\nOptions — choose exactly one of these, or "defer":\n- send this answer to the lane\n\n/);
  for (const flag of ['--restricted', '--strict-mcp-config', '--disable-slash-commands']) assert.ok(calls[0].args.includes(flag), flag);
  const arg = (k) => calls[0].args[calls[0].args.indexOf(k) + 1];
  assert.deepEqual([arg('--tools'), arg('--permission-prompts'), arg('--model')], ['Read,Grep,Glob', 'none', 'sonnet']);
  const q = runnerFile(p.root).questions[0];
  assert.deepEqual([q.kind, q.answer.by, q.answer.quote, Boolean(q.applied)], ['lane_blocked', 'judge', 'Three enemies a wave, never more', true]);
  // the lane can tell the judge from the director
  assert.deepEqual(f.sends(), [{ to: 'term_1', text: 'Answer from the producer\'s judge (per the contract line "Three enemies a wave, never more"): 3 per wave — continue the slice; update HANDOFF.json when your status changes.' }]);
  const reg = fs.readFileSync(path.join(f.dir, 'registry.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(reg.some((r) => r.role === 'judge' && r.cwd === p.root && r.slice === 'S01' && r.handle === null));
});

test('judge: a slice\'s front matter is contract text — acceptance and runtime_checks lines are quotable, yaml keys are not', async () => {
  const { quoted } = await import('../scripts/lib/judge.mjs');
  const p = judged();
  fs.writeFileSync(path.join(p.root, 'slices', 'S01-x.md'), `---
id: S01
size: L
acceptance:
  - text: "H-14 matrix: no clipping or overlap at any viewport, rendered hitboxes at least 44 CSS px."
    evidence: ASSUMPTION
runtime_checks:                    # → PLAN.runtime_checks
  - "Smoke: S01-01..S01-06 checks pass via the smoke-test skill on a focused tab (re-apply orca viewport after every reload; 0-rAF stall = INFRA, rerun)"
---
# S01
`);
  const pj = loadProject(p.root);
  // cc-firefighter-kids S01 q4: the judge quoted part of a runtime_checks line and was refused
  assert.equal(quoted(pj, 'S01', 'Smoke: S01-01..S01-06 checks pass via the smoke-test skill on a focused tab (re-apply orca viewport after every reload; '), true);
  assert.equal(quoted(pj, 'S01', '0-rAF stall = INFRA, rerun'), false); // a fragment under 30 characters is still refused
  assert.equal(quoted(pj, 'S01', 'no clipping or overlap at any viewport, rendered hitboxes'), true);
  assert.equal(quoted(pj, 'S01', 'runtime_checks: Smoke: S01-01..S01-06 checks pass'), false); // a yaml key is not contract text
  assert.equal(quoted(pj, 'S01', 'Ten enemies a wave on every level of the game'), false);
});

test('judge: defer, forbidden options, a missing or invented quote, broken output, a failed call, an unverified provider → the director', () => {
  const cases = [
    ['defer', { choice: 'defer', reason: 'the contracts do not say' }, /judge deferred: the contracts do not say/],
    ['stop', { choice: 'stop', reason: 'x' }, /chose "stop", which is not an allowed option/],
    ['answered', { choice: 'answered in the lane, continue', reason: 'x' }, /chose "answered in the lane, continue", which is not an allowed option/],
    ['no text', { choice: 'send this answer to the lane', quote: 'Three enemies a wave', reason: 'x' }, /without the answer text/],
    ['invented quote', { choice: 'send this answer to the lane', text: '5', quote: 'Five enemies a wave is fine for every level', reason: 'x' }, /quote is not a sentence \(30\+ characters\)/],
    ['short quote', { choice: 'send this answer to the lane', text: '3', quote: 'Three enemies a wave', reason: 'x' }, /quote is not a sentence/],
    ['heading quote', { choice: 'send this answer to the lane', text: '3', quote: 'Enemy waves and spawning rules for every level', reason: 'x' }, /quote is not a sentence/],
    ['no quote', { choice: 'send this answer to the lane', text: '3', reason: 'x' }, /quote is not a sentence/],
  ];
  for (const [name, body, why] of cases) {
    const p = judged();
    const f = fakes();
    reply(f, body);
    f.queue([blocked('which wave size?')]);
    const out = runner(p.root, f, 'start', '--once').out;
    assert.deepEqual([out.at(-1).waiting, out.at(-1).kind], ['q1', 'lane_blocked'], name);
    assert.match(runnerFile(p.root).questions[0].judge.defer, why, name);
    assert.equal(f.sends().length, 0, name);
    runner(p.root, f, 'start', '--once'); // the same open question is not judged twice
    assert.equal(f.judgeCalls().length, 1, name);
  }
  for (const [name, arm, why] of [
    ['broken', (f) => fs.writeFileSync(path.join(f.dir, 'judge-raw.txt'), 'not json at all'), /gave no JSON answer/],
    ['failed', (f) => fs.writeFileSync(path.join(f.dir, 'judge-fail'), '1'), /judge call failed \(exit 1\)/],
    ['is_error', (f) => fs.writeFileSync(path.join(f.dir, 'judge-raw.txt'), '{"type":"result","is_error":true,"subtype":"error_max_turns"}'), /ended in an error \(error_max_turns\)/],
  ]) {
    const p = judged();
    const f = fakes();
    arm(f);
    f.queue([blocked('which wave size?')]);
    runner(p.root, f, 'start', '--once');
    assert.match(runnerFile(p.root).questions[0].judge.defer, why, name);
  }
  const p = project({ notes: NOTES(POLICY, '{}', '', '  judge_agent: codex --model gpt-6\n'), slices: { S01: { needs: false } } });
  const f = fakes();
  f.queue([blocked('which palette?')]);
  runner(p.root, f, 'start', '--once');
  assert.match(runnerFile(p.root).questions[0].judge.defer, /not a verified provider/);
  assert.equal(f.judgeCalls().length, 0);
});

test('judge: PLAN sign-off never reaches it; a design gate answered from the slice file is relayed with its quote', () => {
  const p = project({ notes: NOTES(POLICY, '{}', '', JUDGE), slices: { S01: { needs: false, size: 'L' } } });
  const f = fakes();
  f.queue([
    { name: 'run', runs: [{ id: 'run_1', coordinator_handle: 'term_1' }], write: { [H]: { role: 'coordinator', status: 'working' } } },
    { name: 'gate', gates: [{ id: 'g1', status: 'pending', question: 'PLAN approval: docs/plans/S01.md — 2 open questions', options: '["approve","revise"]' }] },
  ]);
  const a = runner(p.root, f, 'start', '--once').out.at(-1);
  assert.deepEqual([a.waiting, a.kind, f.judgeCalls().length], ['q1', 'fleet_gate', 0]);
  assert.match(runnerFile(p.root).questions[0].judge.defer, /plan sign-off, budget, credit or cost question is the director's/);

  const q = project({ notes: NOTES(POLICY, '{}', '', JUDGE), slices: { S01: { needs: false, size: 'L', body: '\nLevel 1 uses the forest tile set.\n' } } });
  const g = fakes();
  reply(g, { choice: 'forest', quote: 'Level 1 uses the forest tile set', reason: 'the slice file decides it' });
  g.queue([
    { name: 'run', runs: [{ id: 'run_1', coordinator_handle: 'term_1' }], write: { [H]: { role: 'coordinator', status: 'working' } } },
    { name: 'gate', gates: [{ id: 'g2', status: 'pending', question: 'Which tile set for level 1?', options: '["forest","desert"]' }] },
  ]);
  runner(q.root, g, 'start', '--once');
  assert.deepEqual(g.sends()[0], { to: 'term_1', text: 'Decision for gate g2 (producer judge, per the contract line "Level 1 uses the forest tile set"): forest. Resolve your gate with it and continue.' });
  assert.match(g.judgeCalls()[0].input, /- forest\n- desert\n\n/);

  // a gate that offers the runner's own actions: never the judge's to pick
  const b = project({ notes: NOTES(POLICY, '{}', '', JUDGE), slices: { S01: { needs: false, size: 'L', body: '\nLevel 1 uses the forest tile set.\n' } } });
  const k = fakes();
  reply(k, { choice: 'mark blocked', quote: 'Level 1 uses the forest tile set', reason: 'x' });
  k.queue([
    { name: 'run', runs: [{ id: 'run_1', coordinator_handle: 'term_1' }], write: { [H]: { role: 'coordinator', status: 'working' } } },
    { name: 'gate', gates: [{ id: 'g3', status: 'pending', question: 'Which tile set for level 1?', options: '["forest","mark blocked","skip this slice"]' }] },
  ]);
  runner(b.root, k, 'start', '--once');
  assert.match(k.judgeCalls()[0].input, /- forest\n\n/);
  assert.match(runnerFile(b.root).questions[0].judge.defer, /chose "mark blocked", which is not an allowed option/);
  assert.equal(loadProject(b.root).release.slices.S01, 'in_progress');
});

test('judge: "treat as approved" only when review.md really ends APPROVED', () => {
  const run = (verdict) => {
    const p = judged();
    const f = fakes();
    reply(f, { choice: 'treat as approved', reason: 'the verdict line is APPROVED with markup' });
    f.queue([
      { write: { [H]: { role: 'writer', status: 'ready_for_review' }, [evRel('S01', 'preview-startup.json')]: { previewUrl: 'http://127.0.0.1:7461/' } } },
      { write: { [H]: { role: 'reviewer', status: 'approved' }, ...approvedEvidence('S01', verdict) } },
      // the review file stays as it is for the runner's extra looks (M6: a late review file is waited for)
      { result: 'idle' }, { result: 'idle' },
    ]);
    runner(p.root, f, 'start', '--once');
    return { p, f, q: runnerFile(p.root).questions[0] };
  };
  // markup the runner's own check does not strip: the judge may confirm it
  const ok = run('APPROVED (minor notes only)');
  assert.deepEqual([ok.q.kind, ok.q.answer?.by, ok.q.answer?.choice], ['verdict_mismatch', 'judge', 'treat as approved']);
  assert.deepEqual(ok.f.sends(), [{ to: 'term_1', text: singleCommitText(ok.p.root, 'S01') }]);
  // a CHANGES_REQUESTED or conditional review: the option is not even offered, the judge's pick is refused
  for (const verdict of ['CHANGES_REQUESTED, but approve the art', 'APPROVED pending the art pass', 'APPROVED subject to the art pass', 'APPROVED (needs follow-up)']) {
    const no = run(verdict);
    assert.equal(no.q.answer, null, verdict);
    assert.match(no.q.judge.defer, /chose "treat as approved", which is not an allowed option/, verdict);
    assert.doesNotMatch(no.f.judgeCalls()[0].input, /- treat as approved/, verdict);
    assert.deepEqual(no.f.sends(), [], verdict);
  }
});

test('judge: a lane that keeps asking gets the director after two judge answers', () => {
  const p = judged();
  const f = fakes();
  reply(f, { choice: 'send this answer to the lane', text: '3 per wave', quote: 'Three enemies a wave, never more', reason: 'SCOPE.md' });
  f.queue([blocked('wave size?'), blocked('wave size for level 2?'), blocked('wave size for level 3?')]);
  const out = runner(p.root, f, 'start', '--once').out.at(-1);
  assert.deepEqual([out.waiting, out.kind], ['q3', 'lane_blocked']);
  assert.equal(f.judgeCalls().length, 2);
  assert.match(runnerFile(p.root).questions[2].judge.defer, /answered 2 lane_blocked questions for S01 already/);
});

test('judge: the director answering during a judge call wins; a kill mid-call re-asks the judge once', async () => {
  const p = judged();
  const f = fakes();
  reply(f, { choice: 'send this answer to the lane', text: '3 per wave', quote: 'Three enemies a wave, never more', reason: 'SCOPE.md' });
  fs.writeFileSync(path.join(f.dir, 'judge-sleep'), '1500');
  f.queue([blocked('wave size?')]);
  const child = runnerChild(p.root, f, 'start', '--once');
  let err = '';
  child.stderr.on('data', (d) => (err += d));
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  await until(path.join(f.dir, 'judge-call-1.json'));
  runner(p.root, f, 'answer', '--id', 'q1', '--choice', 'answered in the lane, continue');
  await exited(child);
  assert.doesNotMatch(out, /"error"/);
  const q = runnerFile(p.root).questions[0];
  assert.deepEqual([q.answer.by, q.answer.choice, q.judge.superseded], ['human', 'answered in the lane, continue', 'the director answered first']);
  assert.deepEqual(f.sends(), []); // the judge's text was not sent

  // killed while the judge ran: no verdict was written, so the restart asks the judge again — once
  const r = judged();
  const g = fakes();
  reply(g, { choice: 'send this answer to the lane', text: '3 per wave', quote: 'Three enemies a wave, never more', reason: 'SCOPE.md' });
  fs.writeFileSync(path.join(g.dir, 'judge-sleep'), '3000');
  g.queue([blocked('wave size?')]);
  const c2 = runnerChild(r.root, g, 'start', '--once');
  await until(path.join(g.dir, 'judge-call-1.json'));
  c2.kill('SIGKILL');
  await exited(c2);
  fs.rmSync(path.join(g.dir, 'judge-sleep'));
  runner(r.root, g, 'start', '--once');
  assert.equal(g.judgeCalls().length, 2);
  assert.equal(g.sends().length, 1);
});

test('LLM handoffs: Step 0–1 and Step 3 once; a prompt not sent and an unconfirmed spawn are reported, never respawned blind', () => {
  const p = project({ notes: NOTES(''), slices: { S01: { needs: false } } });
  const f = fakes();
  assert.equal(runner(p.root, f, 'start', '--once').out.at(-1).kind, 'needs_policy');
  runner(p.root, f, 'answer', '--id', 'q1', '--choice', 'run Step 0-1 with an LLM producer');
  const a = runner(p.root, f, 'start', '--once').out.at(-1);
  assert.deepEqual([a.handed_to_llm, a.handle, a.again], ['step01', 'term_1', false]);
  const sp = f.spawns();
  assert.deepEqual([sp.length, sp[0].role, sp[0].slice, sp[0].agent], [1, 'producer', null, 'claude --model sonnet']);
  assert.match(sp[0].title, /^producer-step01-runner-proj-/);
  assert.match(sp[0].prompt, /you do Step 0–1 only/);
  assert.ok(sp[0].prompt.includes(`producer-runner.mjs launch --project ${p.root}`));
  // the policy line is not written yet: asked again; the same answer does not spawn a second producer
  assert.equal(runner(p.root, f, 'start', '--once').out.at(-1).waiting, 'q2');
  runner(p.root, f, 'answer', '--id', 'q2', '--choice', 'run Step 0-1 with an LLM producer');
  assert.equal(runner(p.root, f, 'start', '--once').out.at(-1).again, true);
  assert.equal(f.spawns().length, 1);
  // handoff-reset lets the director get a new one
  assert.deepEqual(runner(p.root, f, 'handoff-reset').out[0].forgot, ['step01']);

  // Step 3 at the stop condition in runner mode, once per goal; llm mode only points at it
  const done = (mode) => project({ notes: NOTES(POLICY, '{S01: merged}', mode ? `  producer_mode: ${mode}\n` : ''), slices: { S01: { needs: false } } });
  const r = done('runner');
  const g = fakes();
  const b = runner(r.root, g, 'start', '--once').out.at(-1);
  assert.deepEqual([b.handed_to_llm, b.handle, b.again, Boolean(b.done)], ['step3', 'term_1', false, true]);
  assert.match(g.spawns()[0].prompt, /you do Step 3 only/);
  const again = runner(r.root, g, 'start', '--once').out.at(-1);
  assert.deepEqual([again.again, /handoff-reset/.test(again.next)], [true, true]);
  assert.deepEqual(Object.keys(runnerFile(r.root).llm), ['step3:end_to_end']);
  assert.equal(g.spawns().length, 1);
  const l = done(null);
  const h = fakes();
  assert.match(runner(l.root, h, 'start', '--once').out.at(-1).next_step, /run game-producer Step 3/);
  assert.equal(h.spawns().length, 0);

  // bootstrap created the terminal but could not send the prompt: the director is told what to paste
  const n = done('runner');
  const k = fakes();
  fs.writeFileSync(path.join(k.dir, 'bootstrap-no-prompt'), '1');
  const c = runner(n.root, k, 'start', '--once').out.at(-1);
  assert.match(c.next, /prompt was not sent: paste \.cursor\/producer-handoff-step3\.md/);
  const filled = fs.readFileSync(path.join(n.root, '.cursor', 'producer-handoff-step3.md'), 'utf8');
  assert.ok(filled.includes(`Cocos project at ${n.root}`) && !/<PROJECT>|```/.test(filled));
  // an interrupted spawn with no registry row: reported, not spawned again
  const u = done('runner');
  const m = fakes();
  fs.mkdirSync(path.join(u.root, '.cursor'), { recursive: true });
  fs.writeFileSync(path.join(u.root, '.cursor', 'producer-runner.json'), JSON.stringify({ questions: [], llm: { 'step3:end_to_end': { spawning: new Date().toISOString() } } }));
  const d = runner(u.root, m, 'start', '--once').out.at(-1);
  assert.deepEqual([d.unconfirmed, m.spawns().length], [true, 0]);
  assert.match(d.next, /handoff-reset/);
});

test('launch: one terminal running start, quoted for the shell; refused while a producer is live, stopped or just launched', async () => {
  const p = project({ prefix: "runner proj $HOME 'q-", slices: { S01: { needs: false } } });
  const f = fakes();
  const out = runner(p.root, f, 'launch').out[0];
  assert.equal(out.launched, 'term_created');
  const c = f.creates()[0];
  assert.deepEqual([c.worktree, c.title.startsWith('producer-runner-')], [`path:${p.root}`, true]);
  // the shell gives `start` the exact project path back ($HOME and the quote stay literal)
  const argv = spawnSync('sh', ['-c', c.command.replace(/^node /, 'printf "%s\\n" ')], { encoding: 'utf8' }).stdout.split('\n');
  assert.deepEqual(argv.slice(1, 4), ['start', '--project', p.root]);
  assert.match(runner(p.root, f, 'launch').out[0].refused, /launched at .* and is still starting/);

  const q = project({ slices: { S01: { needs: false } } });
  const g = fakes();
  runner(q.root, g, 'stop');
  assert.match(runner(q.root, g, 'launch').out[0].refused, /control file says stop/);
  runner(q.root, g, 'clear');
  const holder = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 20000)']);
  fs.writeFileSync(path.join(q.root, '.cursor', 'producer.lock'), JSON.stringify({ pid: holder.pid, host: os.hostname() }));
  assert.match(runner(q.root, g, 'launch').out[0].refused, /already holds the lock/);
  holder.kill();
  await exited(holder);
  assert.equal(g.creates().length, 0);
  // a lane answer from the director needs its text
  assert.match(runner(q.root, g, 'answer', '--id', 'q9', '--choice', 'send this answer to the lane').out[0].error, /--text/);
});

test('a runner waiting on a question survives a kill; the answer from another process is applied by the next runner', async () => {
  const p = project({ slices: { S01: { needs: true }, S02: { needs: false } }, dag: { S01: [], S02: [] } });
  const f = fakes();
  const first = runnerChild(p.root, f, 'start'); // no --once: it waits for the answer
  await until(path.join(p.root, '.cursor', 'producer-runner.json'));
  // killed once it waits: the question asked and the director told (sent, then marked notified)
  for (let i = 0; i < 200 && !runnerFile(p.root).questions[0]?.notified; i++) await new Promise((r) => setTimeout(r, 30));
  first.kill('SIGKILL');
  await exited(first);
  const second = runnerChild(p.root, f, 'start');
  let out = '';
  second.stdout.on('data', (d) => (out += d));
  for (let i = 0; i < 100 && !out.includes('"waiting":"q1"'); i++) await new Promise((r) => setTimeout(r, 30));
  assert.equal(runnerFile(p.root).questions.length, 1); // the same question, not a second one
  f.queue([]); // S02's writer then idles: the fake stops the runner
  runner(p.root, f, 'answer', '--id', 'q1', '--choice', 'skip this slice');
  await exited(second);
  assert.match(out, /"stopped":"control file says stop"/);
  assert.equal(loadProject(p.root).release.slices.S01, 'blocked');
  // the director was told once, although two runners waited on q1
  assert.equal(f.notices().length, 1);
  assert.match(f.notices()[0], /^producer-runner · runner-proj-\w+ \| q1 director_gate · S01 x \(planned\): S01 needs_director_ok and the policy line records no explicit decision/);
  assert.deepEqual(f.spawns().map((s) => s.slice), ['S02']);
});

test('judge: a fleet lane\'s worktree evidence is added to the sandbox; an unknown status is never "approved"', async () => {
  const { consult } = await import('../scripts/lib/judge.mjs');
  const st = await import('../scripts/lib/state.mjs');
  const p = project({ notes: NOTES(POLICY, '{}', '', JUDGE), slices: { S01: { needs: false, size: 'L' } } });
  const f = fakes();
  const wt = path.join(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'runner-wt-'))), 'S01-feature');
  spawnSync('git', ['-C', p.root, 'worktree', 'add', '-q', '-b', 'S01-feature', wt]);
  st.writeSliceState(p.root, 'S01', { lane: 'fleet', phase: 'fleet' });
  reply(f, { choice: 'defer', reason: 'x' });
  const saved = { ...process.env };
  Object.assign(process.env, { FAKE_DIR: f.dir, PRODUCER_RUNNER_JUDGE_CMD: path.join(f.dir, 'judge'), PRODUCER_RUNNER_CLAUDE_SETTINGS: path.join(f.dir, 'claude-settings.json'), CC_SPAWN_REGISTRY: path.join(f.dir, 'registry.jsonl') });
  try {
    const q = { id: 'q1', slice: 'S01', kind: 'unknown_status', text: 'fleet HANDOFF status "done" is not one the runner knows', options: ['treat as offer_commit', 'treat as approved', 'mark blocked', 'stop'] };
    assert.match(consult(loadProject(p.root), q).defer, /judge deferred/);
    const call = f.judgeCalls()[0];
    const ev = path.join(wt, '.cursor', 'evidence', 'tasks', 'T-S01', 'evidence');
    assert.equal(call.args[call.args.indexOf('--add-dir') + 1], ev);
    assert.match(call.input, new RegExp(`slice evidence in\\n?\\s*${ev.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}`));
    assert.match(call.input, /- treat as offer_commit\n\n/); // "treat as approved" is not offered for an unknown status
    // a quote lifted from a yaml fence is not contract prose
    const { quoted } = await import('../scripts/lib/judge.mjs');
    const pj = loadProject(p.root);
    const yamlLine = fs.readFileSync(path.join(p.root, 'MILESTONES.md'), 'utf8').match(/"v1_slice": "S01",\s*"release_slice": "S01"/)[0];
    assert.equal(quoted(pj, 'S01', yamlLine), false);
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});

test('Cursor off: one cursor_off question per run before any spawn; the answer moves every Cursor role', () => {
  const notes = NOTES(POLICY).replace('  scanner_agent: claude --model sonnet\n', '  scanner_agent: cursor --model auto\n').replace('  reviewer_agent: claude --model opus\n', '  reviewer_agent: cursor --model auto\n');
  const p = project({ notes, slices: { S01: { needs: false, size: 'L' }, S02: { needs: false } } });
  const f = fakes();
  const env = { PRODUCER_RUNNER_CURSOR: 'off' };
  const a = runner(p.root, f, 'start', '--once', { env }).out.at(-1);
  assert.deepEqual([a.waiting, a.kind], ['q1', 'cursor_off']);
  assert.match(runnerFile(p.root).questions[0].text, /Cursor roles: reviewer, scanner/);
  assert.equal(f.spawns().length, 0); // nothing started on a Cursor that cannot log in
  runner(p.root, f, 'answer', '--id', 'q1', '--choice', 'use claude --model sonnet --effort high for every Cursor role');
  f.queue([]);
  runner(p.root, f, 'start', '--once', { env });
  const sp = f.spawns();
  assert.deepEqual([sp.length, sp[0].role, sp[0].agent], [1, 'coordinator', 'claude --model sonnet']);
  assert.match(sp[0].prompt, /reviewer=claude --model sonnet --effort high scanner=claude --model sonnet --effort high .* cursor=off \(Cursor roles above already moved by the director\)/);
  assert.equal(runnerFile(p.root).cursor_substitute, 'claude --model sonnet --effort high');
  assert.equal(runnerFile(p.root).questions.filter((q) => q.kind === 'cursor_off').length, 1); // once per run
});

test('Cursor off, single lane and handoffs: asked before a spawn, retry probes again, no_cursor moves without asking, a Cursor art backend is asked', () => {
  const off = { env: { PRODUCER_RUNNER_CURSOR: 'off' } };
  const on = { env: { PRODUCER_RUNNER_CURSOR: 'on' } };
  const cursorWriter = (policy = POLICY) => NOTES(policy).replace('  writer_agent: claude --model sonnet --effort high\n', '  writer_agent: cursor --model auto\n');
  // single lane: one question before the writer; "logged in, retry" → the next runner probes again
  const p = project({ notes: cursorWriter(), slices: { S01: { needs: false } } });
  const f = fakes();
  const a = runner(p.root, f, 'start', '--once', off).out.at(-1);
  assert.deepEqual([a.kind, f.spawns().length], ['cursor_off', 0]);
  assert.match(runnerFile(p.root).questions[0].text, /Cursor roles: writer/);
  runner(p.root, f, 'answer', '--id', 'q1', '--choice', 'cursor logged in, retry');
  f.queue([]);
  runner(p.root, f, 'start', '--once', on);
  assert.deepEqual(f.spawns().map((s) => s.agent), ['cursor --model auto']);
  // policy no_cursor is the director's own decision: the writer moves, nobody is asked
  const n = project({ notes: cursorWriter(`${POLICY} no_cursor=true`), slices: { S01: { needs: false } } });
  const g = fakes();
  g.queue([]);
  runner(n.root, g, 'start', '--once');
  assert.deepEqual(g.spawns().map((s) => s.agent), ['claude --model sonnet --effort high']);
  assert.match(g.spawns()[0].prompt, /Locks already resolved \(do not open AGENT_NOTES\.md\): writer=claude --model sonnet --effort high/);
  // the Step 0-1 producer on a Cursor orchestrator: asked, not spawned
  const s01 = project({ notes: NOTES('').replace('  orchestrator_agent: claude --model sonnet       # launch spec\n', '  orchestrator_agent: cursor --model auto\n'), slices: { S01: { needs: false } } });
  const h = fakes();
  runner(s01.root, h, 'start', '--once', off);
  runner(s01.root, h, 'answer', '--id', 'q1', '--choice', 'run Step 0-1 with an LLM producer');
  const c = runner(s01.root, h, 'start', '--once', off).out.at(-1);
  assert.deepEqual([c.kind, h.spawns().length], ['cursor_off', 0]);
  assert.match(runnerFile(s01.root).questions[1].text, /Cursor roles: producer \(Step 0-1\)/);
  // a fleet with art_backend: cursor that makes art: no claude substitute for an art backend
  const artNotes = NOTES(POLICY).replace('  art_backend: antigravity\n', '  art_backend: cursor\n');
  const art = project({ notes: artNotes, slices: { S01: { needs: false, size: 'L', assets: 'hero.png' } } });
  const k = fakes();
  const d = runner(art.root, k, 'start', '--once', off).out.at(-1);
  assert.deepEqual([d.kind, k.spawns().length], ['cursor_art', 0]);
  // a lite fleet (no assets) runs no art Task: no question about the art backend
  const lite = project({ notes: artNotes, slices: { S01: { needs: false, size: 'L' } } });
  const m = fakes();
  m.queue([]);
  runner(lite.root, m, 'start', '--once', off);
  assert.deepEqual(m.spawns().map((x) => x.role), ['coordinator']);
});

test('a Cursor reviewer switch from an INFRA fallback follows the Cursor decision after a restart', () => {
  const p = project({ notes: NOTES(POLICY, '{S01: in_progress}'), slices: { S01: { needs: false } } });
  const f = fakes();
  fs.mkdirSync(path.join(p.root, '.cursor', 'evidence', 'tasks', 'T-S01'), { recursive: true });
  fs.writeFileSync(path.join(p.root, '.cursor', 'evidence', 'tasks', 'T-S01', 'producer-state.json'),
    JSON.stringify({ phase: 'spawn-reviewer', lane: 'single', writer: 'term_w', reviewer: null, reviewer_next: 'cursor --model auto', handoff_base: 0 }));
  fs.writeFileSync(path.join(p.root, '.cursor', 'producer-runner.json'), JSON.stringify({ slice: 'S01', step: 'lane', questions: [], reviewer_override: 'cursor --model auto', cursor_substitute: 'claude --model sonnet --effort high' }));
  f.queue([]);
  runner(p.root, f, 'start', '--once', { env: { PRODUCER_RUNNER_CURSOR: 'off' } });
  assert.deepEqual(f.spawns().map((x) => [x.title.split('-')[0], x.agent]), [['review', 'claude --model sonnet --effort high']]);
});
