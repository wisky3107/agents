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
 *   producer-runner.mjs launch [--project <path>]      (a visible Orca terminal running `start`)
 *   producer-runner.mjs handoff-reset [--project <path>] (forget the Step 0–1 / Step 3 LLM handoffs)
 *
 * One runner per project (.cursor/producer.lock; an LLM producer must not loop while it is held). Git is the truth
 * for merged slices; the AGENT_NOTES release: yaml is a cache the runner rewrites value by value.
 * Anything the runner cannot decide mechanically becomes one question with fixed options; a judge
 * (`judge_agent`, claude -p) may answer the few kinds the contracts settle, the rest wait for `answer`
 * (polling a local file, no model), or the runner exits with --once. It never guesses. Step 0–1 and
 * Step 3 are handed to an LLM producer (reference/producer-step01-prompt.md, -step3-prompt.md).
 * Phase 1: max_parallel=1, no slice studies.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadProject, sliceStatuses, nextSlice, preflight, writeRelease } from './lib/project.mjs';
import * as st from './lib/state.mjs';
import { laneFor, runSlice, applyAnswer, cursorUndecided, cursorState, resetCursorProbe, agentOrAsk, cursorArtBlocked, CursorUndecided, CURSOR_FALLBACK } from './lib/lanes.mjs';
import { currentBranch, appendLessons, lessonRows, readJournal } from './lib/merge.mjs';
import { consult, judgeSpec, JUDGE_KINDS, MAX_JUDGED } from './lib/judge.mjs';
import * as io from './lib/orca.mjs';
import { fileURLToPath } from 'node:url';

const RUNNER = fileURLToPath(import.meta.url);
const REF = new URL('../reference/', import.meta.url);

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
  cursor_off: { options: [`use ${CURSOR_FALLBACK} for every Cursor role`, 'cursor logged in, retry', 'stop'], text: 'Cursor is not usable on this machine and this lane would start it.' },
  cursor_art: { options: ['art_backend changed, retry', 'cursor logged in, retry', 'stop'], text: 'art_backend is cursor but Cursor cannot log in; an art backend has no claude substitute — set fleet.art_backend to antigravity or gpt-image-gen.' },
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
  const s = st.writeSliceState(root, slice, { phase: 'blocked', blocked_reason: why });
  // Notes discipline: a blocked slice's costs and candidates are collected too
  const added = appendLessons(root, lessonRows(root, slice, s, readJournal(root, slice) || {}));
  st.log(root, slice, `marked blocked (${why}); ${added} lessons row(s); lane terminals are left for the director`);
}

/**
 * The runner's current slice when git already shows it merged but the runner's own commit/merge is
 * not finished (a single-lane commit lands on main; a kill can fall after the merge). Earlier phases
 * merged by git mean a human finished the slice: git wins there.
 */
function unfinished(root, statuses) {
  const id = st.readRunner(root).slice;
  if (!id || statuses[id]?.status !== 'merged') return null;
  return ['committing', 'merge'].includes(st.readSliceState(root, id).phase) ? id : null;
}

/**
 * One judge consult, never fatal. A lane that keeps asking does not get the judge forever: after
 * MAX_JUDGED judge answers for this slice and kind, or a question text it already judged, the
 * director answers.
 */
function judgeOnce(root, project, open) {
  const earlier = st.readRunner(root).questions.filter((x) => x.id !== open.id && x.slice === open.slice && x.kind === open.kind && x.judge);
  if (earlier.some((x) => x.text === open.text)) return { defer: 'the judge already saw this exact question: the director decides' };
  if (earlier.filter((x) => x.answer?.by === 'judge').length >= MAX_JUDGED) return { defer: `the judge answered ${MAX_JUDGED} ${open.kind} questions for ${open.slice} already: the director decides` };
  try {
    return consult(project, open);
  } catch (err) {
    return { defer: `judge error: ${err.message}` };
  }
}

function freshLane(root, id, project) {
  const moved = st.archiveSliceState(root, id);
  const lane = laneFor(project, id);
  // the branch main is on now is where this slice merges back (asked when main moved on meanwhile)
  st.writeSliceState(root, id, { phase: lane === 'fleet' ? 'spawn-coordinator' : 'spawn-writer', lane, selected_at: st.now(), base_branch: currentBranch(root) });
  return { lane, moved };
}

/**
 * Step 0–1 or Step 3 to an LLM producer, once (Step 3 once per goal: extending a playable run to
 * end_to_end gets its own). Spawned like a lane: intent first, a registry row recovers the handle
 * after a kill, an intent with no row is never re-spawned blind (bootstrap may still create it), and
 * a prompt bootstrap could not send is reported. `handoff-reset` forgets the handoffs.
 * → { handle, again, prompt_sent } | { unconfirmed }
 */
function handToLlm(root, step) {
  const project = loadProject(root);
  const key = step === 'step3' ? `step3:${project.policy?.tokens.goal || project.release.goal || 'end_to_end'}` : step;
  const r = st.readRunner(root);
  const rec = r.llm?.[key];
  const save = (v) => st.writeRunner(root, { llm: { ...(st.readRunner(root).llm || {}), [key]: v } });
  if (rec?.handle) return { handle: rec.handle, again: true, prompt_sent: rec.prompt_sent };
  if (rec?.spawning) {
    const reg = io.registeredSpawn({ root, slice: null, role: 'producer', sinceIso: rec.spawning });
    if (!reg?.handle) return { unconfirmed: true, since: rec.spawning };
    save({ handle: reg.handle, at: st.now(), prompt_sent: 'unknown' });
    return { handle: reg.handle, again: true, prompt_sent: 'unknown' };
  }
  if (!project.fleet.orchestrator_agent) throw new Error('AGENT_NOTES fleet.orchestrator_agent is empty: no agent for the LLM producer');
  const agent = agentOrAsk(project, project.fleet.orchestrator_agent, 'producer');
  const file = step === 'step01' ? 'producer-step01-prompt.md' : 'producer-step3-prompt.md';
  const tpl = fs.readFileSync(new URL(file, REF), 'utf8').match(/```text\n([\s\S]*?)\n```/)[1];
  const prompt = tpl.replace(/<PROJECT>/g, () => root).replace(/<RUNNER>/g, () => RUNNER);
  // the filled prompt on disk: what the director pastes when bootstrap could not send it
  fs.mkdirSync(path.join(root, '.cursor'), { recursive: true });
  fs.writeFileSync(path.join(root, '.cursor', `producer-handoff-${step}.md`), `${prompt}\n`);
  const slug = root.split('/').pop().replace(/^cc4?-/, '');
  const intent = st.now();
  save({ spawning: intent });
  let res;
  try {
    res = io.spawnLane({ root, agent, role: 'producer', slice: null, title: `producer-${step}-${slug}`, prompt });
  } catch (err) {
    const reg = io.registeredSpawn({ root, slice: null, role: 'producer', sinceIso: intent });
    if (!reg?.handle) {
      save(undefined); // bootstrap finished without a terminal: nothing to recover
      throw err;
    }
    res = { handle: reg.handle, promptSent: false };
  }
  save({ handle: res.handle, at: st.now(), prompt_sent: res.promptSent });
  return { handle: res.handle, again: false, prompt_sent: res.promptSent };
}

/** The runner's report of a handoff, with what the director must do when it did not fully land. */
function handoffReport(step, h, extra = {}) {
  const file = `.cursor/producer-handoff-${step}.md`;
  if (h.unconfirmed) {
    return { ...extra, handed_to_llm: step, unconfirmed: true, next: `a ${step} producer spawn started at ${h.since} was interrupted: look for a producer-${step} terminal in Orca; \`producer-runner.mjs handoff-reset\` lets the runner spawn a new one` };
  }
  const next = h.prompt_sent === false ? `the terminal exists but its prompt was not sent: paste ${file} into it, or \`handoff-reset\` and run again`
    : h.prompt_sent === 'unknown' ? `reattached after an interrupted spawn: check that the prompt from ${file} reached ${h.handle}`
    : h.again ? `already handed to ${h.handle}; if that producer is gone, \`producer-runner.mjs handoff-reset\` and run again` : undefined;
  return { ...extra, handed_to_llm: step, handle: h.handle, again: h.again, ...(next ? { next } : {}) };
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
      else if (q.kind === 'cursor_off' || q.kind === 'cursor_art') {
        // once per run: every later spawn (lanes, coordinator, verifier, LLM producer) uses it
        if (choice.startsWith('use ')) st.writeRunner(root, { cursor_substitute: CURSOR_FALLBACK });
        else resetCursorProbe();
      } else if (q.kind === 'needs_policy' && choice === 'run Step 0-1 with an LLM producer') {
        let h;
        try {
          h = handToLlm(root, 'step01');
        } catch (err) {
          if (!(err instanceof CursorUndecided)) throw err;
          stopFor(root, null, 'cursor_off', `${cursorState(loadProject(root)).reason} — Cursor roles: producer (Step 0-1); answer, then pick the LLM producer again`);
          return {};
        }
        return { exit: handoffReport('step01', h, h.handle && h.prompt_sent !== false ? { note: 'the LLM producer launches the runner when the policy line is written' } : {}) };
      } else if (q.kind === 'adopt' || q.kind === 'blocked_resume') {
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

/**
 * Tell the director a question waits — once per question, also across restarts: a terminal bell
 * (stderr, so stdout stays JSON lines) and a desktop notification (macOS osascript, or
 * PRODUCER_RUNNER_NOTIFY_CMD <title> <body>; PRODUCER_RUNNER_NOTIFY=0 turns it off). Best effort.
 */
function notify(root, q) {
  if (q.notified) return;
  st.setQuestion(root, q.id, { notified: st.now() });
  process.stderr.write('\x07');
  if (process.env.PRODUCER_RUNNER_NOTIFY === '0') return;
  const title = `producer-runner · ${path.basename(root)}`;
  const body = `${q.id} ${q.kind}${q.slice ? ` ${q.slice}` : ''}: ${String(q.text).replace(/\s+/g, ' ').slice(0, 180)}`;
  try {
    if (process.env.PRODUCER_RUNNER_NOTIFY_CMD) spawnSync(process.env.PRODUCER_RUNNER_NOTIFY_CMD, [title, body], { timeout: 10000 });
    else if (process.platform === 'darwin') spawnSync('osascript', ['-e', `display notification ${JSON.stringify(body)} with title ${JSON.stringify(title)} sound name "Glass"`], { timeout: 10000 });
  } catch {
    /* a missed notification never stops the runner */
  }
}

/** Wait for the human's answer: poll the runner file (no model, no tokens). false = stop/pause. */
function waitForAnswer(root, q) {
  say({ waiting: q.id, kind: q.kind, slice: q.slice, text: q.text, options: q.options, answer: `producer-runner answer --id ${q.id} --choice "<option>"` });
  notify(root, q);
  for (;;) {
    const c = st.readControl(root);
    if (c?.cmd === 'stop' || c?.cmd === 'pause') return false;
    const now = st.readRunner(root).questions.find((x) => x.id === q.id);
    if (!now || now.answer) return true;
    sleep(POLL_MS);
  }
}

async function dryRun(root) {
  const { project, statuses, next, blockers } = await plan(root);
  const finishing = unfinished(root, statuses);
  if (finishing) return say({ slice: finishing, resume: true, phase: st.readSliceState(root, finishing).phase, would: 'finish its merge journal (verify, record) first' });
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
    const applied = applyAnswers(root);
    if (applied.stop) return say({ stopped: 'the human chose stop', resume: 'producer-runner clear, then start' });
    if (applied.exit) return say(applied.exit);
    const open = st.readRunner(root).questions.find((q) => !q.answer);
    if (open && !open.judge && JUDGE_KINDS.has(open.kind)) {
      // the judge first, once per question: an answer is applied like the director's, a defer waits for them
      const project = loadProject(root);
      if (judgeSpec(project)) {
        const v = judgeOnce(root, project, open);
        const q = st.judgeVerdict(root, open.id, v);
        if (open.slice) st.log(root, open.slice, `judge on ${open.id} (${open.kind}): ${v.choice ? `${v.choice} — ${v.reason}${q.judge.superseded ? ' (superseded: the director answered first)' : ''}` : v.defer}`);
        say({ judge: open.id, ...(v.choice ? { choice: v.choice, reason: v.reason } : { deferred: v.defer }) });
        continue;
      }
    }
    if (open) {
      if (once) return say({ waiting: open.id, kind: open.kind, slice: open.slice, options: open.options });
      if (!waitForAnswer(root, open)) continue;
      continue;
    }

    const { project, statuses, next, blockers } = await plan(root);
    // a slice git already shows merged (single-lane commit on main, or a merge done before a kill)
    // finishes its journal — verify, record — before anything else is selected or reported done
    const finishing = unfinished(root, statuses);
    if (!finishing) {
      if (next.done) {
        // runner mode owns the whole run: release and retro go to an LLM producer, once
        if (project.release.producer_mode !== 'runner') return say({ done: next.reason, next_step: 'Step 3 (ship / retro): run game-producer Step 3, or set release.producer_mode: runner' });
        try {
          return say(handoffReport('step3', handToLlm(root, 'step3'), { done: next.reason }));
        } catch (err) {
          if (!(err instanceof CursorUndecided)) throw err;
          stopFor(root, null, 'cursor_off', `${cursorState(project).reason} — Cursor roles: producer (Step 3)`);
          continue;
        }
      }
      if (next.stuck) {
        stopFor(root, null, 'stuck', next.reason);
        continue;
      }
      if (blockers.length) {
        stopFor(root, next.slice, blockers[0].code, blockers[0].detail);
        continue;
      }
    }
    const id = finishing || next.slice;
    const resume = Boolean(finishing) || next.resume;
    // stop-after Sxx: once Sxx is merged/shipped (or blocked), start nothing new
    if (control?.cmd === 'stop-after' && control.arg && !resume && ['merged', 'shipped', 'blocked'].includes(statuses[control.arg]?.status)) {
      return say({ stopped: `stop-after ${control.arg}: ${control.arg} is ${statuses[control.arg].status}; not starting ${id}` });
    }

    let s = st.readSliceState(root, id);
    if (!resume) {
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
    // a lane that would start Cursor while Cursor cannot log in: the director decides once for the run
    const lane = s.lane || laneFor(project, id);
    const undecided = cursorUndecided(project, lane);
    if (undecided.length) {
      stopFor(root, id, 'cursor_off', `${cursorState(project).reason} — Cursor roles: ${undecided.join(', ')}`);
      continue;
    }
    if (lane === 'fleet' && cursorArtBlocked(project, id)) {
      stopFor(root, id, 'cursor_art', cursorState(project).reason);
      continue;
    }
    st.writeRunner(root, { slice: id, step: 'lane' });

    const t = project.policy?.tokens || {};
    const ctx = {
      project, id, lane,
      autoCommit: String(t.auto_commit ?? project.release.auto_commit ?? 'true') === 'true',
      autoMerge: String(t.auto_merge ?? project.release.auto_merge ?? 'true') === 'true',
      waitMs: WAIT_MS, idleMs: IDLE_MS, sleep,
    };
    let r;
    try {
      r = runSlice(ctx);
    } catch (err) {
      // a spawn that would start a Cursor nobody decided about (e.g. Cursor logged out mid-run)
      if (err instanceof CursorUndecided) stopFor(root, id, 'cursor_off', `${cursorState(project).reason} — Cursor roles: ${err.roles.join(', ')}`);
      else stopFor(root, id, 'runner_error', err.message);
      continue;
    }
    if (r.stopped) return say({ stopped: `control file says ${r.stopped}`, slice: id });
    if (r.ask) {
      stopFor(root, id, r.ask.code, r.ask.detail, r.ask);
      continue;
    }
    if (r.phase === 'done') {
      st.writeRunner(root, { slice: id, step: 'done' });
      say({ merged: id, commit: st.readSliceState(root, id).commit_sha });
    }
    // done → the next pass picks the next slice; blocked (marked by an answer) → the yaml says blocked
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
  if (cmd === 'handoff-reset') return say({ forgot: Object.keys(st.readRunner(root).llm || {}), llm: st.writeRunner(root, { llm: {} }).llm });
  if (cmd === 'launch') {
    const holder = st.lockHolder(root);
    if (holder?.alive) return say({ refused: 'a producer already holds the lock', holder });
    const control = st.readControl(root);
    if (control?.cmd === 'stop' || control?.cmd === 'pause') return say({ refused: `the control file says ${control.cmd}: \`producer-runner.mjs clear\` first` });
    // a runner launched moments ago may not hold the lock yet: no second terminal
    const last = st.readRunner(root).launched;
    if (last && Date.now() - Date.parse(last.at) < 120000) return say({ refused: `a runner was launched at ${last.at} (${last.handle}) and is still starting`, status: 'producer-runner.mjs status' });
    const handle = io.launchRunner(root, RUNNER);
    if (!handle) throw new Error('orca terminal create gave no handle');
    st.writeRunner(root, { launched: { handle, at: st.now() } });
    return say({ launched: handle, command: `producer-runner.mjs start --project ${root}` });
  }
  if (cmd === 'answer') {
    if (!v.id || !v.choice) throw new Error('answer needs --id and --choice');
    const q = st.readRunner(root).questions.find((x) => x.id === v.id);
    if (q?.kind === 'fleet_gate' && v.choice === 'answer with --text' && !v.text) throw new Error('this gate needs --text with the decision');
    if (q?.kind === 'spawn_unconfirmed' && v.choice.startsWith('reattach') && !/^\S+$/.test(v.text || '')) throw new Error('give the terminal handle with --text');
    if (v.choice === 'send this answer to the lane' && !v.text) throw new Error('give the answer for the lane with --text');
    return say(st.answer(root, v.id, v.choice, v.text || ''));
  }
  throw new Error('usage: producer-runner.mjs start|resume|status|pause|stop|stop-after <Sxx>|clear|answer|launch|handoff-reset [--project <path>]');
}

main().catch((err) => {
  say({ error: err.message });
  process.exitCode = 2;
});
