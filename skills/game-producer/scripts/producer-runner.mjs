#!/usr/bin/env node
/**
 * producer-runner.mjs — the game-producer loop as a script (plan M4): the mechanical steps of
 * game-producer/SKILL.md Step 2 run here with no model; a model is called only for judgement (judge)
 * or the steps handed to an LLM producer (Step 0–1 on a new project, Step 3).
 *
 *   producer-runner.mjs start|resume [--project <path>] [--dry-run] [--once]
 *   producer-runner.mjs status [--project <path>]
 *   producer-runner.mjs pause | stop | stop-after <Sxx> | clear   [--project <path>]
 *   producer-runner.mjs answer --id <qN> --choice <option> [--text "…"] [--project <path>]
 *
 * One runner per project (.cursor/producer.lock, shared with a manual LLM producer). Git is the truth
 * for merged slices; the AGENT_NOTES release: yaml is a cache the runner rewrites value by value.
 * Anything the runner cannot decide mechanically becomes one question with fixed options; the runner
 * waits for `answer` (polling a local file, no model), or exits with --once. It never guesses.
 * Phase 1: max_parallel=1, no slice studies.
 */
import fs from 'node:fs';
import { loadProject, sliceStatuses, nextSlice, preflight, writeRelease } from './lib/project.mjs';
import * as st from './lib/state.mjs';
import { laneFor, runSlice, applyAnswer } from './lib/lanes.mjs';

const msEnv = (k, d) => Number(process.env[k]) || d;
const WAIT_MS = msEnv('PRODUCER_RUNNER_WAIT_MS', 540000); // one orca-wait call (its own cap is 570000)
const IDLE_MS = msEnv('PRODUCER_RUNNER_IDLE_MS', 60000); // pause before re-checking an idle lane
const POLL_MS = msEnv('PRODUCER_RUNNER_POLL_MS', 5000); // answer polling
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  const v = { _: [] };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--dry-run') v.dryRun = true;
    else if (a === '--once') v.once = true;
    else if (a.startsWith('--')) {
      if (rest[i + 1] === undefined || rest[i + 1].startsWith('--')) throw new Error(`${a} needs a value`);
      v[a.slice(2)] = rest[++i];
    } else v._.push(a);
  }
  return { cmd, v };
}

const say = (obj) => process.stdout.write(`${typeof obj === 'string' ? obj : JSON.stringify(obj)}\n`);

/** Human-facing question per preflight / selection stop; options are the actions the runner can take. */
const QUESTION = {
  needs_policy: { options: ['run Step 0-1 with an LLM producer', 'stop'], text: 'No policy line: lock policy and run the director gate first.' },
  policy_conflict: { options: ['re-locked, retry', 'stop'], text: 'The policy line and AGENT_NOTES release: disagree. Re-lock the policy line, then answer.' },
  agent_conflict: { options: ['re-locked, retry', 'stop'], text: 'The policy line and AGENT_NOTES fleet: disagree on a lane agent (the runner spawns the yaml spec). Make them match, then answer.' },
  director_gate: { options: ['decided, retry', 'skip this slice', 'stop'], text: 'Record the director decision for this slice in the policy line, then answer.' },
  contract_depth: { options: ['contracts expanded, retry', 'stop'], text: 'Contracts are playable-depth; run the targeted game-brief expansion first.' },
  brief_progress: { options: ['contracts final, retry', 'stop'], text: 'game-brief is not done (brief-progress); finish the contract gate first.' },
  needs_slice_study: { options: ['study recorded, retry', 'stop'], text: 'Port slice needs a reviewed slice study (rip-port-analysis); runner phase 1 does not run studies.' },
  max_parallel: { options: ['set max_parallel=1, retry', 'stop'], text: 'Runner phase 1 runs one slice at a time.' },
  slice_file: { options: ['fixed, retry', 'stop'], text: 'The slice file is missing or unreadable.' },
  adopt: { options: ['no lane is running, start it', 'mark blocked', 'stop'], text: 'This slice is in progress but the runner did not start it; it will not spawn a second lane blind.' },
  blocked_resume: { options: ['start the slice fresh', 'mark blocked', 'stop'], text: 'The runner marked this slice blocked, but AGENT_NOTES says in_progress again.' },
  runner_error: { options: ['fixed, retry', 'stop'], text: 'The runner hit an error.' },
  stuck: { options: ['fixed, retry', 'stop'], text: 'The runner cannot pick a slice.' },
};
const NOT_STARTED = new Set(['planned', 'pending', 'todo', '']);

/** Read-only: selection + preflight. Writes nothing (dry-run and status rely on it). */
async function plan(root) {
  const project = loadProject(root);
  const statuses = sliceStatuses(project);
  const next = nextSlice(project, statuses);
  let blockers = [];
  if (next.slice) {
    // the brief-progress gate holds before the initial dispatch only (SKILL Inputs)
    const initial = Object.values(statuses).every((v) => NOT_STARTED.has(v.status));
    blockers = preflight(project, next.slice, { initial });
    // a slice the runner already dispatched is past its start gates: only runner-level locks still stop it
    if (next.resume && st.readSliceState(root, next.slice).phase) {
      blockers = blockers.filter((b) => ['needs_policy', 'policy_conflict', 'agent_conflict', 'max_parallel', 'slice_file'].includes(b.code));
    }
  }
  return { project, statuses, next, blockers };
}

async function status(root) {
  const { next, blockers, statuses } = await plan(root);
  const runner = st.readRunner(root);
  say({
    lock: st.lockHolder(root), control: st.readControl(root), runner, next, blockers,
    lane: runner.slice ? st.readSliceState(root, runner.slice) : null,
    slices: Object.fromEntries(Object.entries(statuses).map(([k, v]) => [k, v.source === 'cache' ? v.status : `${v.status} (${v.source})`])),
  });
}

/** Stop for the human: record one question (deduplicated by key) and say it once. */
function stopFor(root, slice, code, detail, extra = {}) {
  const q = QUESTION[code] || {};
  const options = extra.options || q.options || QUESTION.stuck.options;
  const key = `${slice || '-'}:${code}${extra.ref ? `:${extra.ref}` : ''}`;
  const { question, isNew } = st.ask(root, {
    key, slice, kind: code, text: `${q.text || ''} ${detail}`.trim(), options, ref: extra.ref || null, obs: extra.obs || null,
  });
  if (slice) st.log(root, slice, `blocked ${code}: ${detail}${isNew ? ` (question ${question.id})` : ''}`);
  st.writeRunner(root, { slice, step: `blocked:${code}` });
  say({ blocked: code, slice, detail, question: question.id, options: question.options, answer: `producer-runner answer --id ${question.id} --choice "<option>"` });
}

function markBlocked(root, slice, why) {
  if (!slice) return;
  writeRelease(loadProject(root), { slices: { [slice]: 'blocked' } });
  st.writeSliceState(root, slice, { phase: 'blocked', blocked_reason: why });
  st.log(root, slice, `marked blocked (${why}); lane terminals are left for the director`);
}

function freshLane(root, id, project) {
  const moved = st.archiveSliceState(root, id);
  const lane = laneFor(project, id);
  st.writeSliceState(root, id, { phase: lane === 'fleet' ? 'spawn-coordinator' : 'spawn-writer', lane, selected_at: st.now() });
  return { lane, moved };
}

/**
 * Carry out answered questions, oldest first. A question is marked applied *before* its action:
 * a kill in between loses the answer (the runner sees the same situation and asks again) instead
 * of applying it twice. → { stop } when the human chose stop.
 */
function applyAnswers(root) {
  for (const q of st.readRunner(root).questions.filter((x) => x.answer && !x.applied)) {
    const choice = q.answer.choice;
    st.markApplied(root, q.id);
    try {
      if (choice === 'stop') {
        st.writeControl(root, 'stop');
        return { stop: q.id };
      }
      if (choice === 'mark blocked' || choice === 'skip this slice') markBlocked(root, q.slice, `${q.kind}: ${choice}`);
      else if (q.kind === 'adopt' || q.kind === 'blocked_resume') {
        const { lane, moved } = freshLane(root, q.slice, loadProject(root));
        st.log(root, q.slice, `${q.kind}: ${choice} (${lane} lane)${moved.length ? `; earlier state kept as ${moved.join(', ')}` : ''}`);
      } else if (!QUESTION[q.kind]) {
        // every question the runner itself does not ask came from a lane: lanes.applyAnswer acts on it
        // (and throws on a choice it has no action for, which becomes a runner_error question)
        const project = loadProject(root);
        applyAnswer({ project, id: q.slice, lane: st.readSliceState(root, q.slice).lane || laneFor(project, q.slice) }, q);
      }
      // every other kind ("…, retry") only clears the stop: the next pass re-checks from scratch
    } catch (err) {
      stopFor(root, q.slice, 'runner_error', `applying ${q.id} (${q.kind}: ${choice}) failed: ${err.message}`);
    }
  }
  return {};
}

/** Wait for the human's answer: poll the runner file (no model, no tokens). false = stop/pause. */
function waitForAnswer(root, q) {
  say({ waiting: q.id, kind: q.kind, slice: q.slice, text: q.text, options: q.options, answer: `producer-runner answer --id ${q.id} --choice "<option>"` });
  for (;;) {
    const c = st.readControl(root);
    if (c?.cmd === 'stop' || c?.cmd === 'pause') return false;
    const now = st.readRunner(root).questions.find((x) => x.id === q.id);
    if (!now || now.answer) return true;
    sleep(POLL_MS);
  }
}

async function dryRun(root) {
  const { project, next, blockers } = await plan(root);
  if (next.done) return say({ done: next.reason });
  if (next.stuck) return say({ stuck: next.reason });
  const s = st.readSliceState(root, next.slice);
  const lane = blockers.some((b) => b.code === 'slice_file') ? null : laneFor(project, next.slice);
  const open = st.readRunner(root).questions.filter((q) => !q.answer).map((q) => q.id);
  say({
    slice: next.slice, resume: next.resume, lane, phase: s.phase || null, blockers, open_questions: open,
    would: blockers.length ? 'ask the first blocker' : next.resume ? (s.phase ? `continue at ${s.phase}` : 'ask before adopting a lane it did not start') : `mark in_progress and spawn the ${lane} lane`,
  });
}

async function start(root, { dryRun: dry, once }) {
  if (dry) return dryRun(root); // never writes: not the lock, not a question, not the release cache
  const lock = st.acquireLock(root, 'runner');
  if (!lock.ok) {
    say({ refused: 'another producer holds the lock', holder: lock.holder });
    process.exitCode = 3;
    return;
  }
  st.ensureExcluded(root);
  process.on('exit', () => st.releaseLock(root));
  if (lock.takenOver) say({ note: `took over the lock of dead pid ${lock.takenOver.pid}` });

  for (;;) {
    const control = st.readControl(root);
    if (control?.cmd === 'stop' || control?.cmd === 'pause') return say({ stopped: `control file says ${control.cmd}`, resume: 'producer-runner clear, then start' });
    if (applyAnswers(root).stop) return say({ stopped: 'the human chose stop', resume: 'producer-runner clear, then start' });
    const open = st.readRunner(root).questions.find((q) => !q.answer);
    if (open) {
      if (once) return say({ waiting: open.id, kind: open.kind, slice: open.slice, options: open.options });
      if (!waitForAnswer(root, open)) continue;
      continue;
    }

    const { project, statuses, next, blockers } = await plan(root);
    if (next.done) return say({ done: next.reason, next_step: 'Step 3 (ship / retro) is handed to an LLM producer (M4d)' });
    if (next.stuck) {
      stopFor(root, null, 'stuck', next.reason);
      continue;
    }
    if (blockers.length) {
      stopFor(root, next.slice, blockers[0].code, blockers[0].detail);
      continue;
    }
    const id = next.slice;
    // stop-after Sxx: once Sxx is merged/shipped (or blocked), start nothing new
    if (control?.cmd === 'stop-after' && control.arg && !next.resume && ['merged', 'shipped', 'blocked'].includes(statuses[control.arg]?.status)) {
      return say({ stopped: `stop-after ${control.arg}: ${control.arg} is ${statuses[control.arg].status}; not starting ${id}` });
    }

    let s = st.readSliceState(root, id);
    if (!next.resume) {
      const { lane, moved } = freshLane(root, id, project);
      s = st.readSliceState(root, id);
      writeRelease(project, { currentSlice: id, slices: { [id]: 'in_progress' } });
      st.log(root, id, `selected (${lane} lane); release.current_slice set, slice in_progress${moved.length ? `; earlier state kept as ${moved.join(', ')}` : ''}`);
    } else if (!s.phase) {
      stopFor(root, id, 'adopt', `${id} is ${statuses[id]?.cached || 'in_progress'} with no runner state (started by an LLM producer or by hand)`);
      continue;
    } else if (s.phase === 'blocked') {
      stopFor(root, id, 'blocked_resume', `${id}: ${s.blocked_reason || 'blocked'}`);
      continue;
    }
    st.writeRunner(root, { slice: id, step: 'lane' });

    const t = project.policy?.tokens || {};
    const ctx = {
      project, id, lane: s.lane || laneFor(project, id),
      autoCommit: String(t.auto_commit ?? project.release.auto_commit ?? 'true') === 'true',
      noCursor: t.no_cursor === 'true', waitMs: WAIT_MS, idleMs: IDLE_MS, sleep,
    };
    let r;
    try {
      r = runSlice(ctx);
    } catch (err) {
      stopFor(root, id, 'runner_error', err.message);
      continue;
    }
    if (r.stopped) return say({ stopped: `control file says ${r.stopped}`, slice: id });
    if (r.ask) {
      stopFor(root, id, r.ask.code, r.ask.detail, r.ask);
      continue;
    }
    if (r.phase === 'merge') {
      st.writeRunner(root, { slice: id, step: 'merge' });
      return say({ slice: id, step: 'merge', commit: st.readSliceState(root, id).commit_sha, note: 'merge + record arrive in M4c' });
    }
    // phase blocked (marked by an answer): the yaml says blocked now, the next pass picks another slice
  }
}

async function main() {
  const { cmd, v } = parseArgs(process.argv.slice(2));
  const root = fs.realpathSync(v.project || process.cwd());
  if (cmd === 'start' || cmd === 'resume') return start(root, v);
  if (cmd === 'status') return status(root);
  if (cmd === 'pause' || cmd === 'stop') return st.writeControl(root, cmd);
  if (cmd === 'stop-after') {
    if (!/^S\d{2}[a-z]?$/.test(v._[0] || '')) throw new Error('stop-after needs a slice id (S<nn>)');
    return st.writeControl(root, `stop-after ${v._[0]}`);
  }
  if (cmd === 'clear') return st.writeControl(root, null);
  if (cmd === 'answer') {
    if (!v.id || !v.choice) throw new Error('answer needs --id and --choice');
    const q = st.readRunner(root).questions.find((x) => x.id === v.id);
    if (q?.kind === 'fleet_gate' && v.choice === 'answer with --text' && !v.text) throw new Error('this gate needs --text with the decision');
    if (q?.kind === 'spawn_unconfirmed' && v.choice.startsWith('reattach') && !/^\S+$/.test(v.text || '')) throw new Error('give the terminal handle with --text');
    return say(st.answer(root, v.id, v.choice, v.text || ''));
  }
  throw new Error('usage: producer-runner.mjs start|resume|status|pause|stop|stop-after <Sxx>|clear|answer [--project <path>]');
}

main().catch((err) => {
  say({ error: err.message });
  process.exitCode = 2;
});
