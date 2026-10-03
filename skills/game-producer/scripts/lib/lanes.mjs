/**
 * Lanes (plan M4b): fill the slice prompts from reference/*-slice-prompt.md and run one slice as a
 * state machine kept in T-<Sxx>/producer-state.json, so a kill at any point resumes at the same step.
 *   single: spawn-writer → writer → spawn-reviewer → review → (fix → writer)* → accept → commit → committing → merge → done
 *   fleet:  spawn-coordinator → fleet → accept → commit → committing → merge → done
 * `merge` walks the merge journal (lib/merge.mjs).
 * Kill safety: a spawn records its intent first and is recovered from the spawn registry; a message
 * goes through the outbox (intent written with the state change, sent, marked sent), so a kill
 * delivers it at least once and never loses it. Waiting is orca-wait (never terminal-read polling);
 * an idle lane is re-checked after a pause, not in a hot loop. Anything that needs judgement returns
 * { ask } — one question with fixed options for the human (M4d hands some to a judge).
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sliceFront, sliceSize, sliceWorktrees, budgetMode, liteWhenNoAssets, isCc4, ripStudy } from './project.mjs';
import * as st from './state.mjs';
import * as io from './orca.mjs';
import { mergeStep, applyMergeAnswer, MERGE_KINDS } from './merge.mjs';
import { ready as agentReady, family } from '../../../cocos-orca-fleet/scripts/agent-ready.mjs';

const REF = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'reference');
const KNOWN = new Set(['working', 'blocked', 'ready_for_review', 'infra_blocked', 'approved', 'changes_requested', 'offer_commit', 'committed']);
const ALIASES = { ready_for_independent_review: 'ready_for_review', review_ready: 'ready_for_review', commit_offered: 'offer_commit' };
// a lane naming its current step instead of "working" (pilot 1: "implementing"): the runner only
// waits on working, so these can never trigger an action
const PROGRESS = /^(?:in[_ -]?progress|running|started|scanning|planning|implementing|integrating|reviewing|verifying|fixing|dispatched|dispatching)$/;
export const MAX_FIX_ROUNDS = 2;
export const COMMIT_TEXT = 'approved — commit';
// the fleet prompt commits on an exact match of this line only (runner and LLM producer both send it),
// so a bare "approved — commit" typed into the coordinator cannot skip Step 2d (pilot 1); a coordinator
// spawned with an older prompt still finds "approved — commit" in it
export const FLEET_COMMIT_TEXT = 'approved — commit (producer: Step 2d passed)';
// a single-lane writer's prompt says "Do not commit" and never says what the commit request asks for
// (pilot 2: S02's writer committed, left HANDOFF at approved and exited): the request carries it
const commitText = (ctx) => (ctx.lane === 'fleet' ? FLEET_COMMIT_TEXT
  : `${COMMIT_TEXT}: run /commit-guard on this checkout, then write ${handoffMain(ctx.project.root, ctx.id)} with "status": "committed" and "sha": the full sha of that commit.`);
const gitOut = (root, args) => {
  const r = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : '';
};
const GATE_PATIENCE = 10; // idle pauses after relaying a gate decision before asking again
const GATE_SETTLE = 3; // idle pauses after a relay before another pending gate becomes a question
const MISSING_RECHECKS = 5; // "terminal missing" from orca-wait while `terminal show` finds it: ask after this many
const BAD_JSON_PATIENCE = 3; // a HANDOFF caught mid-write parses on the next look
export const FALLBACK_REVIEWER = 'cursor --model auto';
export const STALL_NUDGE =
  'resume the cocos-orca-fleet Coordinator loop: `check --ack` the Delivery you last handled (bare `check` if none), ' +
  'handle the batch — including any unread messages to your Run — then keep a foreground `orca-wait coord`.';
const SINGLE_EVIDENCE = ['integration-notes.md', 'preflight.json', 'preview-startup.json', 'runtime-state.json', 'preview.png', 'stats.json', 'final-report.md'];
const FLEET_EVIDENCE = ['final-report.md', 'stats.json'];
const COORDINATOR = '@coordinator'; // outbox address resolved through run-show at send time
// a lane's own question: the director (or the judge, from the contracts) answers it in the lane
const LANE_BLOCKED_OPTIONS = ['send this answer to the lane', 'answered in the lane, continue', 'mark blocked', 'stop'];

/** HANDOFF status → one of KNOWN, or null (unknown: never acted on mechanically). */
export function normalizeStatus(s) {
  if (!s || typeof s !== 'string') return null;
  const k = s.trim().toLowerCase();
  if (KNOWN.has(k)) return k;
  if (PROGRESS.test(k)) return 'working';
  return ALIASES[k] || null;
}

export const laneFor = (project, id) => (sliceSize(sliceFront(project, id).data) === 'L' ? 'fleet' : 'single');

// ------------------------------------------------------------------ prompts

function fences(file) {
  const text = fs.readFileSync(path.join(REF, file), 'utf8');
  return [...text.matchAll(/```text\n([\s\S]*?)\n```/g)].map((m) => m[1]);
}

/** Fill <KEY> placeholders; an upper-case placeholder left over is a template the runner does not know. */
export function fill(template, values) {
  let out = template;
  for (const [k, v] of Object.entries(values)) out = out.split(`<${k}>`).join(String(v));
  const left = [...new Set(out.match(/<(?:[A-Z][A-Z_|]*|Sxx)>/g) || [])].filter((p) => p !== '<ISO>');
  if (left.length) throw new Error(`prompt template has unfilled placeholders: ${left.join(', ')}`);
  return out;
}

function previewPort(file) {
  try {
    return Number(new URL(JSON.parse(fs.readFileSync(file, 'utf8')).previewUrl).port) || null;
  } catch {
    return null;
  }
}

/** This slice's recorded preview port, else the newest one any lane of the project recorded. */
export function slicePort(root, id) {
  const own = previewPort(path.join(st.sliceDir(root, id), 'evidence', 'preview-startup.json'));
  if (own) return own;
  const base = path.join(root, '.cursor', 'evidence', 'tasks');
  let best = null;
  for (const d of fs.existsSync(base) ? fs.readdirSync(base) : []) {
    const f = path.join(base, d, 'evidence', 'preview-startup.json');
    const port = previewPort(f);
    if (port && (!best || fs.statSync(f).mtimeMs > best.t)) best = { port, t: fs.statSync(f).mtimeMs };
  }
  return best?.port || null;
}

const hasAssets = (front) =>
  Boolean(front.assets && typeof front.assets === 'object' && Object.values(front.assets).some((v) => (Array.isArray(v) ? v.length : v)));

export function promptValues(project, id) {
  const { file, data } = sliceFront(project, id);
  const f = project.fleet;
  const budget = budgetMode(project);
  const lite = liteWhenNoAssets(project) && !hasAssets(data);
  const evidence = path.join(st.sliceDir(project.root, id), 'evidence');
  const port = slicePort(project.root, id);
  return {
    PROJECT: project.root,
    Sxx: id,
    SLICE_FILE: file,
    ENGINE_LINE: isCc4(project)
      ? 'Engine: cc4 — COCOS CLI MCP and `cocos preview` on this checkout\'s pinned ports (cocos-cli-mcp.config.json).'
      : 'Engine: Cocos Creator 3.8 + Funplay MCP on this checkout\'s pinned port (funplay-cocos-mcp.config.json).',
    DIRECTOR_DECISIONS: project.policy?.directorGate || 'none recorded',
    LITE: String(lite),
    BUDGET_MODE: budget,
    FLEET_LOCKS: null, // built only for a fleet prompt (fleetLocks): it may probe Cursor
    RIP_STUDY: ripStudy(project, id, data).pin || 'none',
    CONTEXT_PACK: 'none',
    EVIDENCE_DIR: evidence,
    // no port recorded yet: the writer starts the preview and records it; the reviewer reads that file
    PORT: port ? String(port) : `(port of previewUrl in ${path.join(evidence, 'preview-startup.json')})`,
    'S|M': sliceSize(data) || 'M',
    // the specs the lanes really run on (a Cursor moved by the director shows its substitute)
    WRITER_LOCKS: `writer=${agentFor(project, f.writer_agent) || f.writer_agent} reviewer=${agentFor(project, f.reviewer_agent) || f.reviewer_agent} budget=${budget}`,
  };
}

export const CURSOR_FALLBACK = 'claude --model sonnet --effort high';
let cursorProbe = null; // once per runner process

/**
 * Is Cursor usable for this run? Policy no_cursor → off. Otherwise one `cursor-agent -p` probe per
 * runner process (agent-ready.mjs; `status` lies about the login); PRODUCER_RUNNER_CURSOR=on|off
 * overrides it. → { state: 'on'|'off', reason }
 */
export function cursorState(project) {
  if (project.policy?.tokens?.no_cursor === 'true') return { state: 'off', reason: 'policy no_cursor' };
  const forced = String(process.env.PRODUCER_RUNNER_CURSOR || '').trim().toLowerCase();
  if (forced === 'on' || forced === 'off') return { state: forced, reason: 'PRODUCER_RUNNER_CURSOR' };
  if (!cursorProbe) {
    const r = agentReady('cursor');
    cursorProbe = { state: r.usable ? 'on' : 'off', reason: r.reason };
  }
  return cursorProbe;
}

/** After the director logged Cursor in: probe again on the next spawn. */
export const resetCursorProbe = () => {
  cursorProbe = null;
};

/**
 * The agent a lane really gets. A Cursor spec while Cursor is off becomes the run's substitute:
 * CURSOR_FALLBACK under policy no_cursor (the director's own override), otherwise the director's
 * answer to the runner's one `cursor_off` question (producer-runner.json `cursor_substitute`).
 * Templates ship Cursor defaults (scanner, reviewer), so "named" and "default" cannot be told
 * apart — the director decides once per run, never per slice. → spec | null (still undecided)
 */
export function agentFor(project, spec) {
  if (family(spec) !== 'cursor' || cursorState(project).state !== 'off') return spec;
  if (project.policy?.tokens?.no_cursor === 'true') return CURSOR_FALLBACK;
  return st.readRunner(project.root).cursor_substitute || null;
}

/** A spawn on a Cursor nobody decided about: the runner turns it into its `cursor_off` question. */
export class CursorUndecided extends Error {
  constructor(roles) {
    super(`Cursor is off and undecided for: ${roles.join(', ')}`);
    this.roles = roles;
  }
}

/** The agent to spawn for a role — never a Cursor that cannot log in. Throws CursorUndecided. */
export function agentOrAsk(project, spec, role) {
  const a = agentFor(project, spec);
  if (a === null) throw new CursorUndecided([role]);
  return a;
}

/**
 * The Cursor roles a lane (or the LLM producer) would start while Cursor is off and nothing is
 * decided — including a run-wide Cursor reviewer switch from an earlier INFRA fallback. → [role]
 */
export function cursorUndecided(project, lane) {
  const f = project.fleet;
  const reviewer = st.readRunner(project.root).reviewer_override || f.reviewer_agent;
  const roles = lane === 'fleet'
    ? { coordinator: f.orchestrator_agent, writer: f.writer_agent, reviewer, scanner: f.scanner_agent || f.orchestrator_agent }
    : lane === 'producer' ? { producer: f.orchestrator_agent } : { writer: f.writer_agent, reviewer };
  return Object.entries(roles).filter(([, spec]) => spec && agentFor(project, spec) === null).map(([r]) => r);
}

/** A lite fleet slice runs no art Task (implement → integrate → review). */
export const fleetIsLite = (project, id) => liteWhenNoAssets(project) && !hasAssets(sliceFront(project, id).data);

/**
 * art_backend: cursor with Cursor off, on a slice that makes art — an art backend has no claude
 * substitute: the director picks one.
 */
export const cursorArtBlocked = (project, id) =>
  project.fleet.art_backend === 'cursor' && !fleetIsLite(project, id) && cursorState(project).state === 'off';

/** The fleet's locks line, `cursor=on|off` last so the coordinator need not probe again. */
export function fleetLocks(project, budget, lite) {
  const f = project.fleet;
  const cursor = cursorState(project);
  const pick = (spec) => agentFor(project, spec) || spec;
  const swapped = [f.writer_agent, f.reviewer_agent, f.scanner_agent || f.orchestrator_agent].some((x) => pick(x) !== x);
  return `writer=${pick(f.writer_agent)} reviewer=${pick(f.reviewer_agent)} scanner=${pick(f.scanner_agent || f.orchestrator_agent)} ` +
    `art=${f.art_backend || 'antigravity'} mesh=${f.mesh_backend || 'auto'} budget=${budget} lite=${lite} cursor=${cursor.state}` +
    (swapped ? ' (Cursor roles above already moved by the director)' : '');
}

export function prompts(project, id, pack = 'none') {
  const v = { ...promptValues(project, id), CONTEXT_PACK: pack };
  const [fleetT] = fences('fleet-slice-prompt.md');
  const [writerT, reviewerT] = fences('single-slice-prompt.md');
  return {
    values: v,
    fleet: () => fill(fleetT, { ...v, FLEET_LOCKS: fleetLocks(project, v.BUDGET_MODE, v.LITE) }),
    writer: () => fill(writerT, v),
    reviewer: (reviewPack = 'none') => fill(reviewerT, { ...v, CONTEXT_PACK: reviewPack }),
  };
}

// ------------------------------------------------------------------ files

const slug = (root) => path.basename(root).replace(/^cc4?-/, '');
const oneLine = (t) => String(t || '').replace(/\s+/g, ' ').trim();
const evidenceDir = (root, id) => path.join(st.sliceDir(root, id), 'evidence');
const handoffMain = (root, id) => path.join(evidenceDir(root, id), 'HANDOFF.json');
const mtime = (f) => {
  try {
    return fs.statSync(f).mtimeMs;
  } catch {
    return 0;
  }
};
const readJsonFile = (f) => {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return null;
  }
};
const reviewFile = st.reviewFile;

/** Last line of review.md as a verdict: `**APPROVED**`, `_APPROVED_.` and `APPROVED` are the same. */
const lastLine = (f) => {
  try {
    return fs.readFileSync(f, 'utf8').trim().split('\n').pop().trim().replace(/^[*_`#>\s]+|[*_`.!\s]+$/g, '');
  } catch {
    return '';
  }
};

/**
 * HANDOFF.json as the runner judges it. `fresh` = written since `base`; only a fresh file has a
 * `status` — an older run's file (or the previous role's write) is not news.
 */
function readHandoff(file, base) {
  const m = mtime(file);
  if (!m) return { exists: false, fresh: false, ok: false, status: null, raw: null, sha: null, detail: '' };
  const j = readJsonFile(file);
  const ok = Boolean(j && typeof j === 'object' && !Array.isArray(j));
  const fresh = m !== base;
  return {
    exists: true, mtime: m, fresh, ok, raw: ok ? j.status ?? null : null,
    status: ok && fresh ? normalizeStatus(j.status) : null, sha: ok && fresh ? j.sha || null : null, detail: ok ? String(j.detail || '') : '',
  };
}

/** A manual_required verdict anywhere in runtime-state.json (a value, or a non-empty `manual_required` field). */
export function manualRequired(v) {
  if (typeof v === 'string') return v.trim().toLowerCase() === 'manual_required';
  if (Array.isArray(v)) return v.some(manualRequired);
  if (v && typeof v === 'object') {
    return Object.entries(v).some(([k, x]) => (k.toLowerCase() === 'manual_required' ? truthy(x) : manualRequired(x)));
  }
  return false;
}
const truthy = (x) =>
  x === true || (typeof x === 'number' && x > 0) || (Array.isArray(x) && x.length > 0) ||
  (typeof x === 'string' && !/^(|false|none|no|0)$/i.test(x.trim())) || (x && typeof x === 'object' && !Array.isArray(x) && Object.keys(x).length > 0);

/**
 * What a manual_required verdict leaves to a human, as readable lines: the contents of `manual_required`
 * fields (a string, list items, or `key: value` of an object), else the path of a "manual_required" value.
 */
export function manualItems(v, at = '') {
  // `{item, reason}` (pilot 2's reviewer) reads "item — reason"
  const show = (x) => {
    if (typeof x === 'string') return x;
    const what = x && typeof x === 'object' && (x.item || x.check || x.name || x.id);
    if (typeof what === 'string') {
      const why = x.reason || x.why || x.note || x.detail;
      return typeof why === 'string' && why ? `${what} — ${why}` : what;
    }
    return JSON.stringify(x);
  };
  if (typeof v === 'string') return v.trim().toLowerCase() === 'manual_required' ? [at || 'manual_required'] : [];
  if (Array.isArray(v)) return v.flatMap((x, i) => manualItems(x, `${at}[${i}]`));
  if (!v || typeof v !== 'object') return [];
  return Object.entries(v).flatMap(([k, x]) => {
    if (k.toLowerCase() !== 'manual_required') return manualItems(x, at ? `${at}.${k}` : k);
    if (!truthy(x)) return [];
    if (Array.isArray(x)) return x.map(show);
    if (x && typeof x === 'object') return Object.entries(x).map(([kk, vv]) => `${kk}: ${show(vv)}`);
    return [typeof x === 'string' ? x : `${at ? `${at}.` : ''}manual_required: ${JSON.stringify(x)} (no details)`];
  });
}

/**
 * Step 2d APPROVED: the newest review file ends APPROVED, runtime-state.json present without
 * manual_required, evidence files present. → [{ code, detail }] in asking order (empty = approved).
 */
function approvalProblems(dir, required, verdictAccepted = false, relayedGates = [], coordinatorVerdict = false) {
  const out = [];
  const { verdict: file, lastRound } = st.reviewFiles(dir);
  const verdict = lastLine(file);
  if (verdict !== 'APPROVED' && !verdictAccepted) out.push({ code: 'approval_evidence', detail: `${path.basename(file)} ends "${verdict.slice(0, 80) || 'missing'}", not APPROVED` });
  // fleet: a final review.md that turns the last round's CHANGES_REQUESTED into APPROVED must rest on a
  // director gate decision the runner relayed (fleet prompt rule 9), not on the coordinator's say-so.
  // Not single lane: there the verdict is the runner's own fresh reviewer, checked in the review phase
  // (pilot S04: a review-r1.md kept by the reviewer stopped an approved slice for 2 h 45)
  else if (coordinatorVerdict && !verdictAccepted && lastRound && file !== lastRound && lastLine(lastRound) === 'CHANGES_REQUESTED') {
    let text = '';
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      /* unreadable: no gate named */
    }
    if (!relayedGates.some((g) => text.includes(g))) {
      out.push({
        code: 'verdict_override',
        detail: `review.md ends APPROVED but the last review round (${path.basename(lastRound)}) ended CHANGES_REQUESTED and review.md names no gate decision the director sent (${relayedGates.join(', ') || 'none sent'})`,
      });
    }
  }
  const runtime = readJsonFile(path.join(dir, 'runtime-state.json'));
  if (!runtime) out.push({ code: 'approval_evidence', detail: 'runtime-state.json is missing or unreadable' });
  else if (manualRequired(runtime)) out.push({ code: 'manual_required', detail: 'runtime-state.json says manual_required (runtime not verified)', runtime });
  const missing = required.filter((f) => !fs.existsSync(path.join(dir, f)));
  if (missing.length) out.push({ code: 'approval_evidence', detail: `evidence missing: ${missing.join(', ')}` });
  return out;
}

/** Fleet HANDOFF lives in the feature worktree once the coordinator has created it. */
export function fleetHandoff(root, id) {
  const wt = sliceWorktrees(root)[id];
  return { wt: wt || null, file: wt ? path.join(wt, '.cursor', 'evidence', 'tasks', `T-${id}`, 'evidence', 'HANDOFF.json') : handoffMain(root, id) };
}

// ------------------------------------------------------------------ state helpers

const PAUSE = { pause: true };
const ask = (s, code, detail, options, extra = {}) => {
  // `obs` fingerprints what was observed: after a "continue" answer the same observation only waits
  if (extra.obs && (s.acked || []).includes(extra.obs)) return PAUSE;
  return { ask: { code, detail, options, ...extra } };
};

function setPhase(root, id, phase, extra = {}) {
  st.writeSliceState(root, id, { phase, ...extra });
  st.log(root, id, `phase ${phase}`);
}

function resolveTo(ctx, to) {
  if (to !== COORDINATOR) return to;
  const s = st.readSliceState(ctx.project.root, ctx.id);
  const now = s.run ? io.runCoordinator(s.run) : null;
  if (now && now !== s.coordinator) {
    st.writeSliceState(ctx.project.root, ctx.id, { coordinator: now });
    st.log(ctx.project.root, ctx.id, `coordinator is now ${now} (takeover)`);
  }
  return now || s.coordinator;
}

/**
 * Send a message once per key: the intent is written together with `patch` (the phase change it
 * belongs to), then sent, then marked sent. An unsent intent is retried by flushOutbox.
 */
function sendOnce(ctx, key, to, text, patch = {}) {
  const { root } = ctx.project;
  const s = st.readSliceState(root, ctx.id);
  if (s.outbox?.[key]) {
    // already queued (or sent): the state change it belongs to still applies
    if (Object.keys(patch).length) st.writeSliceState(root, ctx.id, patch);
    return;
  }
  st.writeSliceState(root, ctx.id, { ...patch, outbox: { ...(s.outbox || {}), [key]: { to, text, sent: false } } });
  deliver(ctx, key);
}

function setEntry(ctx, key, entry) {
  const s = st.readSliceState(ctx.project.root, ctx.id);
  st.writeSliceState(ctx.project.root, ctx.id, { outbox: { ...s.outbox, [key]: entry } });
}

/** Send one queued message. A failed send (terminal gone, runtime down) is recorded, never thrown. */
function deliver(ctx, key) {
  const { root } = ctx.project;
  const entry = st.readSliceState(root, ctx.id).outbox[key];
  let handle = null;
  try {
    handle = resolveTo(ctx, entry.to);
    if (!handle) throw new Error('no terminal recorded');
    io.send(handle, entry.text);
  } catch (err) {
    setEntry(ctx, key, { ...entry, failed: String(err.message).slice(0, 200) });
    st.log(root, ctx.id, `send ${key} → ${handle || entry.to} failed: ${err.message}`);
    return false;
  }
  setEntry(ctx, key, { ...entry, to: handle, sent: true, failed: null, at: st.now() });
  st.log(root, ctx.id, `sent ${key} → ${handle}`);
  return true;
}

/** Deliver queued messages; one that cannot be delivered is a question (it would wedge the slice). */
export function flushOutbox(ctx) {
  for (const [key, e] of Object.entries(st.readSliceState(ctx.project.root, ctx.id).outbox || {})) {
    if (e.sent || e.dropped) continue;
    if (!e.failed && deliver(ctx, key)) continue;
    const s = st.readSliceState(ctx.project.root, ctx.id);
    const failed = s.outbox[key];
    // a resume lane can carry work for the writer (fix rows, preview restart, a nudge) — never the
    // commit: its prompt says "Do not commit" and it would send an approved slice back to review
    const carriable = ctx.lane === 'single' && failed.to === s.writer && /^(?:fix:|infra-restart|nudge:)/.test(key);
    const why = key.startsWith('commit')
      ? ' — the lane that must commit is gone; bring it back (or commit by hand), then retry'
      : key.startsWith('gate:') ? ' — dropping it lets the runner ask this gate again' : '';
    return ask(s, 'send_failed', `could not send "${key}" to ${failed.to}: ${failed.failed}${why}`,
      [...(carriable ? ['resume lane carries it'] : []), 'retry the send', 'drop the message', 'mark blocked', 'stop'], { ref: key });
  }
  return null;
}

const SPAWN_PHASE = { writer: 'spawn-writer', reviewer: 'spawn-reviewer', coordinator: 'spawn-coordinator' };

/**
 * Spawn a lane terminal once. The intent goes to disk first; after a kill the spawn registry gives
 * the handle back. An intent with no registry row (bootstrap killed or still running) or a prompt
 * bootstrap could not send is a question — never a blind second spawn (S07). → { handle } | { ask }
 */
function spawnOnce(ctx, key, opts) {
  const { root } = ctx.project;
  const id = ctx.id;
  const s = st.readSliceState(root, id);
  if (s[key]) return { handle: s[key] };
  const since = s[`${key}_spawning`];
  if (since) {
    const reg = io.registeredSpawn({ root, slice: id, role: opts.role, sinceIso: since });
    if (reg?.handle) {
      // bootstrap may have died with the runner before sending the prompt: one question, not a guess
      st.writeSliceState(root, id, { [key]: reg.handle, [`${key}_spawning`]: null, prompt_missing: key, prompt_unknown: true });
      st.log(root, id, `reattached ${key} ${reg.handle} from the spawn registry (prompt delivery unknown)`);
      return promptMissing(st.readSliceState(root, id));
    }
    return ask(s, 'spawn_unconfirmed', `a ${key} spawn started at ${since} was interrupted and the spawn registry has no terminal for it; check Orca for a "${opts.title}" terminal`,
      ['no lane terminal exists, spawn it', 'reattach the handle given in --text', 'mark blocked', 'stop'], { ref: key });
  }
  const intent = st.now();
  st.writeSliceState(root, id, { [`${key}_spawning`]: intent });
  let r;
  try {
    r = io.spawnLane({ root, slice: id, ...opts });
  } catch (err) {
    const reg = io.registeredSpawn({ root, slice: id, role: opts.role, sinceIso: intent });
    if (!reg?.handle) {
      st.writeSliceState(root, id, { [`${key}_spawning`]: null }); // bootstrap finished without a terminal
      throw err;
    }
    r = { handle: reg.handle, promptSent: false };
  }
  st.writeSliceState(root, id, { [key]: r.handle, [`${key}_spawning`]: null, ...(r.promptSent ? {} : { prompt_missing: key }) });
  st.log(root, id, `spawned ${key} ${r.handle} (${opts.agent}, --role ${opts.role})${r.promptSent ? '' : ' — prompt NOT sent'}`);
  return r.promptSent ? { handle: r.handle } : promptMissing(st.readSliceState(root, id));
}

const promptMissing = (s) =>
  ask(s, 'prompt_not_sent', s.prompt_unknown
    ? `the ${s.prompt_missing} terminal ${s[s.prompt_missing]} was reattached after an interrupted spawn; check whether its task prompt arrived`
    : `the ${s.prompt_missing} terminal ${s[s.prompt_missing]} was created but bootstrap did not send its prompt (shell or trust dialog?)`,
  ['prompt is in the terminal, continue', 'close it and spawn again', 'mark blocked', 'stop'], { ref: s.prompt_missing });

function orcaError(root, id, s, w) {
  if (!s.orca_errors) {
    st.writeSliceState(root, id, { orca_errors: 1 });
    st.log(root, id, `orca-error, retrying the wait once: ${w.error || ''}`);
    return PAUSE;
  }
  return ask(s, 'orca_error', `orca failed twice during a wait: ${w.error || 'no detail'}`, ['retry', 'stop']);
}

function wait(ctx, s, which, opts) {
  const w = io.waitLane({ ...opts, state: path.join(st.sliceDir(ctx.project.root, ctx.id), `wait-${which}.json`), maxMs: ctx.waitMs });
  if (w.event !== 'orca-error' && s.orca_errors) st.writeSliceState(ctx.project.root, ctx.id, { orca_errors: 0 });
  return w;
}

const parsedAgain = (root, id, s, h) => {
  if (h.ok && s.bad_handoff) st.writeSliceState(root, id, { bad_handoff: 0 });
};

/** A HANDOFF that does not parse: wait a few looks (mid-write), then ask. */
function badHandoff(root, id, s, file) {
  const n = (s.bad_handoff || 0) + 1;
  st.writeSliceState(root, id, { bad_handoff: n });
  if (n < BAD_JSON_PATIENCE) return PAUSE;
  return ask(s, 'unknown_status', `${file} is not a JSON object`, ['mark blocked', 'stop'], { obs: `bad_handoff@${mtime(file)}` });
}

/**
 * Advance one slice until it needs a human, reaches `merge`, or the control file says stop/pause.
 * ctx: { project, id, lane: 'single'|'fleet', autoCommit, autoMerge, waitMs, idleMs, sleep }
 */
export function runSlice(ctx) {
  const root = ctx.project.root;
  for (;;) {
    const c = st.readControl(root);
    if (c?.cmd === 'stop' || c?.cmd === 'pause') return { stopped: c.cmd };
    const blocked = flushOutbox(ctx);
    if (blocked) return blocked;
    const s = st.readSliceState(root, ctx.id);
    const phase = s.phase || (ctx.lane === 'fleet' ? 'spawn-coordinator' : 'spawn-writer');
    if (phase === 'done' || phase === 'blocked') return { phase };
    if (s.prompt_missing) return promptMissing(s);
    const r = phase === 'merge' ? mergeStep(ctx, s, mergeKit) : ctx.lane === 'fleet' ? fleetStep(ctx, s, phase) : singleStep(ctx, s, phase);
    if (r?.pause) ctx.sleep(ctx.idleMs);
    else if (r) return r;
  }
}

/** What the merge journal borrows from the lanes (spawn, wait and question rules stay in one place). */
const mergeKit = {
  ask, PAUSE, spawnOnce, wait, orcaError, mtime, fill, setPhase, agentOrAsk,
  worktreeOf: (root, id) => fleetHandoff(root, id).wt,
};

// ------------------------------------------------------------------ single lane

const writerOpts = (ctx) => ({ role: 'worker', agent: agentOrAsk(ctx.project, ctx.project.fleet.writer_agent, 'writer'), title: `slice-${slug(ctx.project.root)}-${ctx.id}` });

function planPack(ctx, s, P) {
  if (s.context_pack) return s.context_pack;
  const root = ctx.project.root;
  const pack = io.memoryPack('plan', ['--task', `T-${ctx.id}`, '--query-file', path.join(root, P.values.SLICE_FILE), '--out', path.join(P.values.EVIDENCE_DIR, 'memory', 'plan')], root);
  st.writeSliceState(root, ctx.id, { context_pack: pack });
  return pack;
}

export function reviewerAgent(ctx) {
  return agentOrAsk(ctx.project, st.readRunner(ctx.project.root).reviewer_override || ctx.project.fleet.reviewer_agent, 'reviewer');
}

/** Hung writer → resume lane. The phase is written first, so a kill resumes the respawn, not a wait on nothing. */
function resumeWriter(ctx, s, why) {
  setPhase(ctx.project.root, ctx.id, 'respawn-writer', { writer_prev: s.writer, respawns: (s.respawns || 0) + 1, nudged_writer: false });
  st.log(ctx.project.root, ctx.id, `writer ${s.writer} ${why}: resume lane`);
  return null;
}

function fixRound(ctx, s) {
  const rounds = s.fix_rounds || 0;
  const reviewMd = path.join(evidenceDir(ctx.project.root, ctx.id), 'review.md');
  sendOnce(ctx, `fix:${rounds + 1}`, s.writer,
    `Fix round ${rounds + 1}: apply exactly the rows of the \`## fix_routing\` table in ${reviewMd} (no other changes), re-verify, update the evidence, then set HANDOFF.json ready_for_review.`,
    { phase: 'writer', fix_rounds: rounds + 1, reviewer: null, nudged_writer: false });
  st.log(ctx.project.root, ctx.id, `fix round ${rounds + 1}`);
}

function singleStep(ctx, s, phase) {
  const { project, id } = ctx;
  const root = project.root;
  const handoff = handoffMain(root, id);
  const evidence = evidenceDir(root, id);

  if (phase === 'spawn-writer') {
    const pack = planPack(ctx, s, prompts(project, id));
    // a HANDOFF left by an older run of this slice is not news: only a write after this mtime counts
    if (s.handoff_base === undefined) st.writeSliceState(root, id, { handoff_base: mtime(handoff) });
    const r = spawnOnce(ctx, 'writer', { ...writerOpts(ctx), prompt: prompts(project, id, pack).writer() });
    if (r.ask || r.pause) return r;
    setPhase(root, id, 'writer');
    return null;
  }

  if (phase === 'respawn-writer') {
    if (s.writer && s.writer === s.writer_prev) {
      io.closeTerminal(s.writer);
      st.writeSliceState(root, id, { writer: null });
    }
    const P = prompts(project, id, s.context_pack || 'none');
    const r = spawnOnce(ctx, 'writer', {
      ...writerOpts(ctx),
      prompt: s.resume_note
        ? `${P.writer()}\n\nRESUME: a previous writer stopped before this reached it — do this, keeping everything already in ${evidence}:\n${s.resume_note}`
        : `${P.writer()}\n\nRESUME: a previous writer stopped. Finish verify + evidence only; keep everything already in ${evidence}.`,
    });
    if (r.ask || r.pause) return r;
    setPhase(root, id, 'writer', { resume_note: null });
    return null;
  }

  if (phase === 'writer') {
    if (!s.writer) return resumeWriter(ctx, s, 'has no recorded handle');
    const w = wait(ctx, s, 'writer', { handoff, handle: s.writer });
    if (w.event === 'orca-error') return orcaError(root, id, s, w);
    const h = readHandoff(handoff, s.handoff_base);
    if (h.fresh && !h.ok) return badHandoff(root, id, s, handoff);
    parsedAgain(root, id, s, h);
    const obs = (code) => `${code}@${h.mtime || 0}`;
    if (h.status === 'ready_for_review') {
      setPhase(root, id, 'spawn-reviewer', { reviewer: null, bad_handoff: 0 });
      return null;
    }
    if (w.event === 'terminal-missing' || (w.event === 'idle' && w.idle_streak >= 3)) {
      if ((s.respawns || 0) >= 1 || h.status === 'blocked') {
        return ask(s, 'lane_hung', `writer ${s.writer} stopped (${w.event}) with HANDOFF ${h.raw || 'missing'}${s.respawns ? ' after a resume lane' : ''}`,
          ['spawn another resume lane', 'mark blocked', 'stop'], { obs: obs(`lane_hung:${s.writer}`) });
      }
      return resumeWriter(ctx, s, `stopped (${w.event}, idle_streak ${w.idle_streak})`);
    }
    if (h.fresh && !h.status) {
      return ask(s, 'unknown_status', `writer HANDOFF status "${h.raw ?? '(none)'}" is not one the runner knows`, ['treat as working, keep waiting', 'treat as ready_for_review', 'mark blocked', 'stop'], { obs: obs('unknown_status') });
    }
    if (h.status === 'blocked') return ask(s, 'lane_blocked', `writer HANDOFF blocked: ${h.detail || 'no detail'}`, LANE_BLOCKED_OPTIONS, { obs: obs('lane_blocked') });
    if (w.event === 'idle' && w.idle_streak === 2 && !s.nudged_writer) {
      const text = s.fix_rounds && h.status === 'changes_requested'
        ? `Fix round ${s.fix_rounds} is still open: apply the \`## fix_routing\` rows in ${path.join(evidence, 'review.md')}, re-verify, then set HANDOFF.json ready_for_review.`
        : `Status check: HANDOFF.json is not ready_for_review yet. Finish the missing evidence files in ${evidence} (${SINGLE_EVIDENCE.join(', ')}), then set HANDOFF ready_for_review.`;
      sendOnce(ctx, `nudge:${s.writer}:${s.fix_rounds || 0}`, s.writer, text, { nudged_writer: true });
      return PAUSE;
    }
    return w.event === 'idle' ? PAUSE : null; // timeout / HANDOFF change: wait again
  }

  if (phase === 'spawn-reviewer') {
    const P = prompts(project, id, s.context_pack || 'none');
    let pack = s.review_pack || 'none';
    if (!s.reviewer && !s.reviewer_spawning) {
      // a fresh reviewer (not a reattach after a kill): its own pack, and only HANDOFF writes after now count
      pack = io.memoryPack('review', ['--task', `T-${id}`, '--acceptance', path.join(root, P.values.SLICE_FILE), '--base', 'HEAD', '--out', path.join(evidence, 'memory', 'review')], root);
      st.writeSliceState(root, id, { review_base: mtime(handoff), review_pack: pack });
    }
    // a provider switch is recorded in the slice state with the phase, then made run-wide
    if (s.reviewer_next && st.readRunner(root).reviewer_override !== s.reviewer_next) st.writeRunner(root, { reviewer_override: s.reviewer_next });
    // a Cursor switch from an earlier INFRA fallback goes through the same Cursor decision
    const agent = s.reviewer_next ? agentOrAsk(project, s.reviewer_next, 'reviewer') : reviewerAgent(ctx);
    const r = spawnOnce(ctx, 'reviewer', { role: 'worker', agent, title: `review-${slug(root)}-${id}`, prompt: P.reviewer(pack) });
    if (r.ask || r.pause) return r;
    setPhase(root, id, 'review');
    return null;
  }

  if (phase === 'review') {
    if (!s.reviewer) {
      setPhase(root, id, 'spawn-reviewer');
      return null;
    }
    const w = wait(ctx, s, 'reviewer', { handoff, handle: s.reviewer });
    if (w.event === 'orca-error') return orcaError(root, id, s, w);
    // decide on the reviewer's own HANDOFF write: review.md of an earlier round is not this verdict
    const h = readHandoff(handoff, s.review_base);
    if (h.fresh && !h.ok) return badHandoff(root, id, s, handoff);
    parsedAgain(root, id, s, h);
    const obs = (code) => `${code}@${h.mtime || 0}`;
    const verdictFile = reviewFile(evidence);
    const verdict = lastLine(verdictFile);
    if (h.status === 'infra_blocked') return infraBlocked(ctx, s);
    if (h.status === 'approved' || h.status === 'changes_requested') {
      const want = h.status === 'approved' ? 'APPROVED' : 'CHANGES_REQUESTED';
      if (verdict !== want) {
        return ask(s, 'verdict_mismatch', `HANDOFF says ${h.status} but ${path.basename(verdictFile)} ends "${verdict.slice(0, 80)}"`, ['treat as approved', 'treat as changes_requested', 'mark blocked', 'stop'], { obs: obs('verdict_mismatch') });
      }
      io.closeTerminal(s.reviewer);
      if (h.status === 'approved') {
        setPhase(root, id, 'accept', { bad_handoff: 0 });
        return null;
      }
      const rounds = s.fix_rounds || 0;
      if (rounds >= (s.max_fix_rounds || MAX_FIX_ROUNDS)) {
        return ask(s, 'changes_after_rounds', `CHANGES_REQUESTED after ${rounds} fix rounds (${verdictFile})`, ['one more fix round', 'mark blocked', 'stop'], { obs: obs('changes_after_rounds') });
      }
      fixRound(ctx, s);
      return null;
    }
    if (w.event === 'terminal-missing' || (w.event === 'idle' && w.idle_streak >= 3)) {
      return ask(s, 'reviewer_hung', `reviewer ${s.reviewer} stopped without a verdict (${w.event})`, ['spawn a fresh reviewer', 'mark blocked', 'stop'], { obs: obs(`reviewer_hung:${s.reviewer}`) });
    }
    if (h.fresh && !h.status) {
      return ask(s, 'unknown_status', `reviewer HANDOFF status "${h.raw ?? '(none)'}" is not one the runner knows`, ['treat as working, keep waiting', 'treat as approved', 'treat as changes_requested', 'mark blocked', 'stop'], { obs: obs('unknown_status') });
    }
    return w.event === 'idle' ? PAUSE : null;
  }

  if (phase === 'accept') return accept(ctx, s, evidence, SINGLE_EVIDENCE, ['spawn a fresh reviewer', 'mark blocked', 'stop']);
  if (phase === 'commit') return commit(ctx, s, s.writer);
  if (phase === 'committing') {
    const w = wait(ctx, s, 'writer', { handoff, handle: s.writer });
    return committing(ctx, s, w, readHandoff(handoff, s.commit_base));
  }
  throw new Error(`unknown single-lane phase ${phase}`);
}

/**
 * INFRA_BLOCKED is not a fix round. The runner curls the port itself: 200 → the reviewer's
 * environment cannot reach localhost. The runner launches every reviewer with bootstrap's current
 * launch command, so there is no stale launch to correct (SKILL §Policy): the review moves to
 * `cursor --model auto`, locked for the rest of the run — never the same sandboxed reviewer again.
 * Policy no_cursor, or cursor failing too → the human. Not 200 → the writer restarts the preview
 * once, then a fresh review; again → the human.
 */
function infraBlocked(ctx, s) {
  const { root } = ctx.project;
  const port = slicePort(root, ctx.id);
  if (!io.closeTerminal(s.reviewer)) st.log(root, ctx.id, `could not confirm reviewer ${s.reviewer} closed`);
  const code = port ? io.httpStatus(port) : 0;
  if (code === 200) {
    const current = s.reviewer_next || reviewerAgent(ctx);
    // the localhost fallback is Cursor: only when Cursor answers (policy no_cursor or a failed probe → ask)
    const cursorOff = cursorState(ctx.project).state === 'off';
    if (!cursorOff && current !== FALLBACK_REVIEWER) {
      st.log(root, ctx.id, `INFRA_BLOCKED while 127.0.0.1:${port} answers 200: reviewer ${current} → ${FALLBACK_REVIEWER} for the rest of the run`);
      setPhase(root, ctx.id, 'spawn-reviewer', { reviewer: null, reviewer_next: FALLBACK_REVIEWER });
      return null;
    }
    return ask(s, 'infra_blocked', `reviewer ${current} cannot reach 127.0.0.1:${port} although it answers 200${cursorOff ? ` (Cursor is off: ${cursorState(ctx.project).reason})` : ''}`, ['spawn a fresh reviewer', 'mark blocked', 'stop']);
  }
  if (!s.preview_restarts) {
    sendOnce(ctx, 'infra-restart', s.writer,
      `The reviewer found no preview at ${port ? `127.0.0.1:${port}` : 'the recorded URL'} (INFRA_BLOCKED). Restart or reuse the preview per step 4, rewrite ${path.join(evidenceDir(root, ctx.id), 'preview-startup.json')}, then set HANDOFF.json ready_for_review. Change no game files.`,
      { phase: 'writer', reviewer: null, preview_restarts: 1, nudged_writer: false });
    return null;
  }
  return ask(s, 'infra_blocked', `preview ${port ? `127.0.0.1:${port} answers ${code || 'nothing'}` : 'has no recorded port'} after the writer restarted it once`, ['writer refreshed the preview, review again', 'mark blocked', 'stop']);
}

function accept(ctx, s, dir, required, manualOptions) {
  const problems = approvalProblems(dir, required, Boolean(s.verdict_accepted), s.relayed_gates || [], ctx.lane === 'fleet');
  // under defer a manual check is not a blocker: ask about the real one first
  const p = (ctx.manualDefer && problems.find((x) => x.code !== 'manual_required')) || problems[0];
  if (!p) {
    setPhase(ctx.project.root, ctx.id, 'commit');
    return null;
  }
  // release.manual_required: defer — APPROVED with every file present and only manual checks left:
  // merge, and keep the checks for the director's sign-off before ship (manual-deferred.json, status)
  if (problems.length === 1 && p.code === 'manual_required' && ctx.manualDefer) {
    const handoff = readJsonFile(path.join(dir, 'HANDOFF.json'));
    const items = [...new Set([...manualItems(p.runtime), ...manualItems({ manual_required: handoff?.manual_required })])];
    st.writeJson(path.join(dir, 'manual-deferred.json'), { slice: ctx.id, at: st.now(), items, from: 'runtime-state.json + HANDOFF.json', policy: 'release.manual_required: defer' });
    st.log(ctx.project.root, ctx.id, `manual_required deferred (${items.length}): ${items.join(' | ').slice(0, 300)}`);
    setPhase(ctx.project.root, ctx.id, 'commit', { manual_deferred: items });
    return null;
  }
  // SKILL Step 2d: never commit or merge on manual_required or missing evidence
  if (p.code === 'manual_required') return ask(s, 'manual_required', `${p.detail} (${dir})`, manualOptions);
  if (p.code === 'verdict_override') return ask(s, 'verdict_override', `${p.detail} (${dir})`, ['treat as approved', 'evidence fixed, check again', 'mark blocked', 'stop']);
  return ask(s, 'approval_evidence', `not APPROVED by Step 2d: ${p.detail} (${dir})`, ['evidence fixed, check again', 'mark blocked', 'stop']);
}

const laneHandoff = (ctx) => (ctx.lane === 'fleet' ? fleetHandoff(ctx.project.root, ctx.id).file : handoffMain(ctx.project.root, ctx.id));

/** The commit request: the lane commits, HANDOFF says committed + sha. Main's HEAD is noted (single lane). */
function commit(ctx, s, handle) {
  if (!ctx.autoCommit) return ask(s, 'commit_approval', 'auto_commit=false: approve the commit of this slice', ['commit', 'mark blocked', 'stop']);
  // only a HANDOFF written after the commit request can say committed
  sendOnce(ctx, 'commit', handle, commitText(ctx), { phase: 'committing', ...commitMarks(ctx) });
  return null;
}

const commitMarks = (ctx) => ({
  commit_base: mtime(laneHandoff(ctx)),
  commit_idles: 0,
  ...(ctx.lane === 'single' ? { commit_head: gitOut(ctx.project.root, ['rev-parse', 'HEAD']) || null, commit_asked: st.now() } : {}),
});

/** Single lane: commits on main since the commit request, oldest first (first parent only). */
function commitsSince(ctx, s) {
  if (ctx.lane !== 'single' || !s.commit_head) return [];
  const out = gitOut(ctx.project.root, ['log', '--first-parent', '--reverse', '--format=%H %P|%ct %s', `${s.commit_head}..HEAD`]);
  return out ? out.split('\n').map((l) => {
    const [head, rest] = [l.slice(0, l.indexOf('|')), l.slice(l.indexOf('|') + 1)];
    const [sha, ...parents] = head.trim().split(' ');
    const [ct, ...subject] = rest.split(' ');
    return { sha, merge: parents.length > 1, at: Number(ct) * 1000, subject: subject.join(' ') };
  }) : [];
}

/** Does this commit name the slice — in its subject (`feat(S03)`) or a path it touches (`slices/S03-…`)? */
function namesSlice(ctx, c) {
  const id = new RegExp(`(?:^|[^A-Za-z0-9])${ctx.id}(?:[^0-9]|$)`, 'i');
  if (id.test(c.subject)) return true;
  return gitOut(ctx.project.root, ['show', '--name-only', '--format=', c.sha]).split('\n').some((f) => id.test(f));
}

function committing(ctx, s, w, h) {
  const { root } = ctx.project;
  if (w.event === 'orca-error') return orcaError(root, ctx.id, s, w);
  if (h.fresh && !h.ok) return badHandoff(root, ctx.id, s, '(lane HANDOFF.json)');
  parsedAgain(root, ctx.id, s, h);
  if (h.status === 'committed' && h.sha) {
    setPhase(root, ctx.id, 'merge', { commit_sha: h.sha });
    return null;
  }
  const lane = ctx.lane === 'fleet' ? 'coordinator' : 'writer';
  if (h.status === 'blocked') return ask(s, 'lane_blocked', `commit blocked: ${h.detail || 'no detail'}`, LANE_BLOCKED_OPTIONS, { obs: `lane_blocked@${h.mtime}` });
  // idles since the last commit request (a resend starts the count again): asked at 3
  const idles = w.event === 'idle' ? (s.commit_idles || 0) + 1 : 0;
  if (idles !== (s.commit_idles || 0)) st.writeSliceState(root, ctx.id, { commit_idles: idles });
  if (w.event === 'terminal-missing' || w.event === 'idle') {
    // the writer committed on main but did not say so (pilot 2): the only new commit since the request,
    // not a merge, made after it and naming the slice (subject or a path) is taken and logged; anything
    // else is the director's to pick
    const all = commitsSince(ctx, s);
    const c = all.length === 1 ? all[0] : null;
    if (c && !c.merge && c.at >= Date.parse(s.commit_asked || 0) - 1000 && namesSlice(ctx, c)) {
      st.log(root, ctx.id, `the writer committed ${c.sha.slice(0, 7)} ("${c.subject}") without writing HANDOFF committed: taking it as the slice commit`);
      setPhase(root, ctx.id, 'merge', { commit_sha: c.sha, commit_found: true });
      return null;
    }
    if (w.event === 'terminal-missing' || idles >= 3) {
      const found = commitsSince(ctx, s);
      // each send of the commit request is a new situation: a stall after "resend commit" is asked again
      const sends = Object.keys(s.outbox || {}).filter((k) => k === 'commit' || k.startsWith('commit:')).length;
      const list = found.length ? `; commits on main since the request: ${found.map((c) => `${c.sha.slice(0, 7)} "${c.subject}"`).join(', ')}` : '';
      return ask(s, 'commit_stalled', `${lane} ${w.handle || ''} is ${w.event} after the commit request; HANDOFF is ${h.raw || 'missing'}${h.status === 'committed' ? ' without a sha' : ''}${list}`,
        [...(found.length ? ['the newest commit is the slice, continue'] : []), 'resend commit', 'mark blocked', 'stop'],
        { obs: `commit_stalled@${h.mtime || 0}:${w.handle}:${sends}:${found.length}`, ...(found.length ? { ref: found[found.length - 1].sha } : {}) });
    }
  }
  return w.event === 'idle' ? PAUSE : null;
}

// ------------------------------------------------------------------ fleet lane

function fleetStep(ctx, s, phase) {
  const { project, id } = ctx;
  const root = project.root;

  if (phase === 'spawn-coordinator') {
    const pack = planPack(ctx, s, prompts(project, id));
    if (s.handoff_base === undefined) st.writeSliceState(root, id, { handoff_base: mtime(handoffMain(root, id)) });
    const r = spawnOnce(ctx, 'coordinator', {
      role: 'coordinator', agent: agentOrAsk(project, project.fleet.orchestrator_agent, 'coordinator'), title: `fleet-${slug(root)}-${id}`,
      prompt: prompts(project, id, pack).fleet(),
    });
    if (r.ask || r.pause) return r;
    setPhase(root, id, 'fleet');
    return null;
  }
  const { file: handoff, wt } = fleetHandoff(root, id);
  if (phase === 'accept') return accept(ctx, s, path.dirname(handoff), FLEET_EVIDENCE, ['evidence fixed, check again', 'mark blocked', 'stop']);
  if (phase === 'commit') return commit(ctx, s, COORDINATOR);
  if (phase !== 'fleet' && phase !== 'committing') throw new Error(`unknown fleet phase ${phase}`);
  if (!s.coordinator) {
    setPhase(root, id, 'spawn-coordinator');
    return null;
  }

  let run = s.run;
  if (!run) {
    run = io.runFor(s.coordinator);
    if (run) {
      st.writeSliceState(root, id, { run });
      st.log(root, id, `fleet Run ${run}`);
    }
  }
  if (wt && wt !== s.worktree) st.writeSliceState(root, id, { worktree: wt });
  // never pick the coordinator by worktree or title: the Run names it, the spawn handle until then
  const w = wait(ctx, s, 'fleet', run ? { handoff, run } : { handoff, handle: s.coordinator });
  const coordinator = w.handle || s.coordinator;
  if (w.handle && w.handle !== s.coordinator) {
    st.writeSliceState(root, id, { coordinator: w.handle });
    st.log(root, id, `coordinator is now ${w.handle} (takeover)`);
  }
  if (w.event === 'orca-error') return orcaError(root, id, s, w);

  if (w.event === 'gate') {
    const relayed = s.relayed_gates || [];
    const open = w.pending_gates.filter((g) => !relayed.includes(g.id));
    // just after a relay the coordinator is still acting on it: a gate it opened meanwhile may be the
    // same decision and get resolved by it (pilot 1: q6 was asked 1 s after q5's relay, then resolved)
    if (open.length && s.gate_settle && (s.gate_waits || 0) < GATE_SETTLE) {
      st.writeSliceState(root, id, { gate_waits: (s.gate_waits || 0) + 1 });
      return PAUSE;
    }
    if (open.length) {
      const g = open[0];
      let options = g.options;
      try {
        if (typeof options === 'string') options = JSON.parse(options);
      } catch {
        options = null;
      }
      const choices = Array.isArray(options) && options.length ? options.map(String) : ['answer with --text'];
      // every pending gate in one question; the decision is for the first, and the coordinator (who owns
      // its gates) applies it to any other that asks the same thing
      const also = open.slice(1).map((x) => x.id);
      const others = open.slice(1).map((x) => ` | ${x.id}: ${oneLine(x.question).slice(0, 300)}`).join('');
      // the producer never resolves a lane's gate: the human's choice goes to the coordinator as text
      return ask(s, 'fleet_gate', `fleet gate ${g.id}${also.length ? ` (also pending: ${also.join(', ')})` : ''}: ${g.question}${others}`, [...choices, 'stop'], { ref: g.id, also });
    }
    const waits = (s.gate_waits || 0) + 1;
    st.writeSliceState(root, id, { gate_waits: waits });
    if (waits < GATE_PATIENCE) return PAUSE;
    const ids = w.pending_gates.map((g) => g.id).join(',');
    return ask(s, 'gate_unresolved', `gate ${ids} still pending after the decision was sent`, ['continue waiting', 'stop'], { obs: `gate_unresolved@${ids}:${s.gate_unresolved_waits || 0}` });
  }
  if (s.gate_waits || s.gate_settle) st.writeSliceState(root, id, { gate_waits: 0, gate_settle: false });
  if (s.missing_rechecks && w.event !== 'terminal-missing') st.writeSliceState(root, id, { missing_rechecks: 0 });

  const missing = () => {
    // orca-wait's "missing" can be a passing `terminal wait` error (pilot 1, q3): the human is asked
    // only when Orca no longer shows the terminal, or orca-wait keeps saying so
    const alive = io.terminalAlive(coordinator);
    if (alive === null) return orcaError(root, id, s, { error: `orca-wait reported ${coordinator} missing and \`terminal show\` did not answer` });
    const rechecks = (s.missing_rechecks || 0) + 1;
    if (alive && rechecks < MISSING_RECHECKS) {
      st.writeSliceState(root, id, { missing_rechecks: rechecks });
      st.log(root, id, `orca-wait reported ${coordinator} missing but terminal show finds it (${rechecks}/${MISSING_RECHECKS}): waiting on`);
      return PAUSE;
    }
    // a fleet coordinator is never respawned: a replacement needs a run-use takeover (the human's call)
    const why = alive ? ` — orca-wait reported it missing ${rechecks} times in a row although terminal show still finds it` : '';
    return ask(s, 'coordinator_missing', `fleet coordinator ${coordinator} is gone${run ? ` (Run ${run})` : ' and no Run exists yet'}${why}`, ['taken over, continue', 'mark blocked', 'stop'], { obs: `coordinator_missing@${coordinator}` });
  };
  if (phase === 'committing') {
    const c = readHandoff(handoff, s.commit_base);
    if (w.event === 'terminal-missing' && !(c.status === 'committed' && c.sha)) return missing();
    return committing(ctx, s, w, c);
  }

  // in the feature worktree every HANDOFF is this run's; in main, only a write after the spawn
  const h = readHandoff(handoff, wt ? -1 : s.handoff_base);
  if (h.fresh && !h.ok) return badHandoff(root, id, s, handoff);
  parsedAgain(root, id, s, h);
  const obs = (code) => `${code}@${h.mtime || 0}`;
  if (h.status === 'committed' && h.sha) {
    setPhase(root, id, 'merge', { commit_sha: h.sha });
    return null;
  }
  if (h.status === 'offer_commit') {
    setPhase(root, id, 'accept', { bad_handoff: 0 });
    return null;
  }
  if (w.event === 'terminal-missing') return missing();
  if (h.fresh && !h.status) {
    return ask(s, 'unknown_status', `fleet HANDOFF status "${h.raw ?? '(none)'}" is not one the runner knows`, ['treat as working, keep waiting', 'treat as offer_commit', 'mark blocked', 'stop'], { obs: obs('unknown_status') });
  }
  if (h.status === 'blocked' || h.status === 'infra_blocked') {
    return ask(s, 'lane_blocked', `fleet HANDOFF ${h.status}: ${h.detail || 'no detail'}`, LANE_BLOCKED_OPTIONS, { obs: obs('lane_blocked') });
  }
  if (w.event === 'idle') {
    // idle with any other status: stalled (S08 lost ~3 h) → one nudge, then the human
    if (!s.nudged_stall) {
      sendOnce(ctx, `stall:${coordinator}:${h.mtime || 0}`, COORDINATOR, STALL_NUDGE, { nudged_stall: true });
      st.log(root, id, `stalled coordinator (status ${h.raw || 'none'}, unread to Run ${w.unread_to_run ?? '?'}): one nudge`);
      return PAUSE;
    }
    if (w.idle_streak < 3) return PAUSE;
    return ask(s, 'fleet_stall', `fleet coordinator idle with status ${h.raw || 'none'} after one nudge (unread to Run: ${w.unread_to_run ?? '?'})`, ['nudged again, continue', 'mark blocked', 'stop'], { obs: obs(`fleet_stall:${coordinator}`) });
  }
  if (w.event === 'handoff' && s.nudged_stall) st.writeSliceState(root, id, { nudged_stall: false });
  return null;
}

// ------------------------------------------------------------------ answers

/**
 * Carry out one answered lane question (choices other than `stop` / `mark blocked`, which the runner
 * handles for every kind). Sends go through the outbox keyed by the question, so a replay after a
 * kill does not send twice.
 */
export function applyAnswer(ctx, q) {
  const { project, id } = ctx;
  const root = project.root;
  const s = st.readSliceState(root, id);
  const choice = q.answer.choice;
  const note = q.answer.text ? ` — ${q.answer.text}` : '';
  const laneHandle = ctx.lane === 'fleet' ? COORDINATOR : s.writer;
  const ack = () => st.writeSliceState(root, id, { acked: [...(s.acked || []), q.obs].filter(Boolean) });
  st.log(root, id, `answer ${q.id} (${q.kind}): ${choice}${note}`);
  switch (`${q.kind}:${choice}`) {
    case 'unknown_status:treat as ready_for_review':
      return setPhase(root, id, 'spawn-reviewer', { reviewer: null });
    case 'unknown_status:treat as approved':
    case 'verdict_mismatch:treat as approved':
      if (s.reviewer) io.closeTerminal(s.reviewer);
      // the human read the verdict: accept still checks runtime-state and the evidence files
      return setPhase(root, id, 'accept', { verdict_accepted: true });
    case 'unknown_status:treat as changes_requested':
    case 'verdict_mismatch:treat as changes_requested':
      if (s.reviewer) io.closeTerminal(s.reviewer);
      return fixRound(ctx, s);
    case 'changes_after_rounds:one more fix round':
      st.writeSliceState(root, id, { max_fix_rounds: (s.fix_rounds || 0) + 1 });
      return fixRound(ctx, st.readSliceState(root, id));
    case 'unknown_status:treat as offer_commit':
      return setPhase(root, id, 'accept');
    case 'commit_approval:commit':
      return sendOnce(ctx, 'commit', laneHandle, commitText(ctx), { phase: 'committing', ...commitMarks(ctx) });
    case 'commit_stalled:the newest commit is the slice, continue':
      if (!/^[0-9a-f]{40}$/.test(q.ref || '')) throw new Error('no commit recorded with the question');
      ack();
      st.log(root, id, `the director took ${q.ref.slice(0, 7)} as the slice commit`);
      return setPhase(root, id, 'merge', { commit_sha: q.ref });
    case 'commit_stalled:resend commit':
      ack();
      return sendOnce(ctx, `commit:${q.id}`, laneHandle, commitText(ctx), { commit_idles: 0 });
    case 'lane_hung:spawn another resume lane':
      return resumeWriter(ctx, s, 'stopped (human: another resume lane)');
    case 'reviewer_hung:spawn a fresh reviewer':
    case 'infra_blocked:spawn a fresh reviewer':
    case 'infra_blocked:writer refreshed the preview, review again':
    case 'manual_required:spawn a fresh reviewer':
      if (s.reviewer) io.closeTerminal(s.reviewer);
      return setPhase(root, id, 'spawn-reviewer', { reviewer: null });
    case 'approval_evidence:evidence fixed, check again':
    case 'manual_required:evidence fixed, check again':
    case 'verdict_override:evidence fixed, check again':
      return setPhase(root, id, 'accept');
    case 'verdict_override:treat as approved':
      // the director read both verdicts: accept still checks runtime-state and the evidence files
      return setPhase(root, id, 'accept', { verdict_accepted: true });
    case 'orca_error:retry':
      return st.writeSliceState(root, id, { orca_errors: 0 });
    case 'spawn_unconfirmed:no lane terminal exists, spawn it':
      return st.writeSliceState(root, id, { [`${q.ref}_spawning`]: null });
    case 'spawn_unconfirmed:reattach the handle given in --text':
      if (!/^\S+$/.test(q.answer.text || '')) throw new Error('give the terminal handle with --text');
      return st.writeSliceState(root, id, { [q.ref]: q.answer.text, [`${q.ref}_spawning`]: null });
    case 'prompt_not_sent:prompt is in the terminal, continue':
      return st.writeSliceState(root, id, { prompt_missing: null, prompt_unknown: null });
    case 'prompt_not_sent:close it and spawn again':
      if (s[q.ref]) io.closeTerminal(s[q.ref]);
      // a lane terminal goes back to its spawn phase; the verifier is re-spawned inside the merge phase
      return setPhase(root, id, SPAWN_PHASE[q.ref] || s.phase, { [q.ref]: null, prompt_missing: null, prompt_unknown: null });
    case 'send_failed:retry the send':
      return st.writeSliceState(root, id, { outbox: { ...s.outbox, [q.ref]: { ...s.outbox[q.ref], failed: null } } });
    case 'send_failed:drop the message': {
      // a dropped gate decision never reached the coordinator: the gate is open again for a question
      const gate = q.ref.startsWith('gate:') ? q.ref.split(':')[1] : null;
      return st.writeSliceState(root, id, {
        outbox: { ...s.outbox, [q.ref]: { ...s.outbox[q.ref], dropped: true } },
        ...(gate ? { relayed_gates: (s.relayed_gates || []).filter((g) => g !== gate) } : {}),
      });
    }
    case 'send_failed:resume lane carries it':
      st.writeSliceState(root, id, { outbox: { ...s.outbox, [q.ref]: { ...s.outbox[q.ref], dropped: true } }, resume_note: s.outbox[q.ref].text });
      return resumeWriter(ctx, st.readSliceState(root, id), `unreachable (${s.outbox[q.ref].failed})`);
    case 'lane_blocked:send this answer to the lane': {
      if (!q.answer.text) throw new Error('give the answer with --text');
      ack();
      // one line (a newline could submit early); a judge answer says so and names its contract line
      const who = q.answer.by === 'judge' ? `Answer from the producer's judge (per the contract line "${oneLine(q.answer.quote)}")` : "Director's answer to your question";
      return sendOnce(ctx, `answer:${q.id}`, laneHandle, `${who}: ${oneLine(q.answer.text)} — continue the slice; update HANDOFF.json when your status changes.`);
    }
    case 'gate_unresolved:continue waiting':
      // another full patience window, then asked again (a bare ack waited in silence)
      ack();
      return st.writeSliceState(root, id, { gate_waits: 0, gate_unresolved_waits: (s.gate_unresolved_waits || 0) + 1 });
    case 'unknown_status:treat as working, keep waiting':
    case 'lane_blocked:answered in the lane, continue':
    case 'coordinator_missing:taken over, continue':
    case 'fleet_stall:nudged again, continue':
      return ack();
    default:
      if (MERGE_KINDS.has(q.kind)) return applyMergeAnswer(ctx, q);
      if (q.kind === 'fleet_gate') {
        const decision = oneLine(choice === 'answer with --text' ? q.answer.text : `${choice}${note}`);
        if (!decision) throw new Error('this gate needs --text with the decision');
        const who = q.answer.by === 'judge' ? `Decision for gate ${q.ref} (producer judge, per the contract line "${oneLine(q.answer.quote)}")` : `Director decision for gate ${q.ref}`;
        // the director saw the other pending gates in the question; a judge answer rests on one contract
        // line for one gate, so it is never carried over
        const also = q.also?.length && q.answer.by !== 'judge'
          ? ` Also pending when this was asked: ${q.also.join(', ')} — resolve any of them that asks the same thing with this decision and leave the others pending (I ask the director about those).`
          : '';
        return sendOnce(ctx, `gate:${q.ref}:${q.id}`, COORDINATOR, `${who}: ${decision}. Resolve your gate with it and continue.${also}`,
          { relayed_gates: [...(s.relayed_gates || []), q.ref], gate_waits: 0, gate_settle: true });
      }
      throw new Error(`no action for ${q.kind}: ${choice}`);
  }
}
