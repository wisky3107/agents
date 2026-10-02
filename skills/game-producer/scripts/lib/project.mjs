/**
 * Read-only view of a producer project, plus the one write the runner makes to AGENT_NOTES.md: the
 * `release:` cache (current_slice, slices.<Sxx>). Git is the truth for "merged"; the yaml is a cache.
 * Parsing reuses game-brief's lib (YAML via its `yaml` dependency); nothing is guessed — unreadable
 * input throws, and the runner turns that into a `blocked` stop.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GAME_BRIEF = path.resolve(HERE, '..', '..', '..', 'game-brief');
const lib = await import(path.join(GAME_BRIEF, 'scripts', 'lib.mjs'));
const YAML = createRequire(path.join(GAME_BRIEF, 'package.json'))('yaml');

export const SLICE_ID = /^S\d{2}[a-z]?$/;
/** `s08` / `S14A` → `S08` / `S14a` (branch and folder names are not consistent about case). */
export const normId = (raw) => `S${raw.slice(1, 3)}${raw.slice(3).toLowerCase()}`;
const FENCE = /```ya?ml\s*\n([\s\S]*?)\n```/;
const DONE = new Set(['merged', 'shipped']);
/** Cache values that mean "not dispatched yet". Anything else that is not done/blocked is in flight
 * (in_progress, changes_requested, approved, or a value the runner does not know). */
const NOT_STARTED = new Set(['planned', 'pending', 'todo', '']);

const statusOf = (v) => (typeof v === 'string' ? v : v && typeof v === 'object' ? v.status : undefined);

/** Top-level parenthetical groups of a line (balanced, so `(… (2026-09-23) …)` stays one group). */
export function parenGroups(raw) {
  const out = [];
  let depth = 0;
  let start = -1;
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === '(') {
      if (!depth++) start = i;
    } else if (raw[i] === ')' && depth) {
      if (!--depth) out.push({ start, end: i + 1, text: raw.slice(start + 1, i) });
    }
  }
  if (depth) out.push({ start, end: raw.length, text: raw.slice(start + 1) }); // unclosed: to the end
  return out;
}

const stripParens = (raw) => {
  let out = raw;
  for (const g of parenGroups(raw).reverse()) out = `${out.slice(0, g.start)} ${out.slice(g.end)}`;
  return out;
};

/** `policy:` line of the producer Notes (`- policy: …` or `policy: …`), parsed into key=value tokens. */
export function parsePolicy(text) {
  const afterYaml = text.slice((text.match(FENCE)?.index ?? 0) + (text.match(FENCE)?.[0].length ?? 0));
  const m = afterYaml.match(/^\s*(?:-\s*)?policy:\s*(.+)$/m);
  if (!m) return null;
  const raw = m[1].trim();
  const tokens = {};
  for (const t of stripParens(raw).split(/[\s·]+/)) {
    const kv = t.match(/^([a-z_]+)=(.+)$/);
    if (kv) tokens[kv[1]] = kv[2].replace(/[,;]$/, '');
  }
  // the director's words for the lanes: every parenthetical that names the director, else the
  // text after a bare `director gate:` / `director mandate:` label
  const groups = parenGroups(raw).map((g) => g.text.trim()).filter((t) => /director/i.test(t));
  const bare = stripParens(raw).match(/director\s+(?:gate|mandate|decisions?)\s*:\s*(.+)$/i);
  return { raw, tokens, directorGate: groups.length ? groups.join(' | ') : bare ? bare[1].trim() : '' };
}

const AGENT_KEYS = {
  orchestrator: 'orchestrator_agent', coordinator: 'orchestrator_agent', scanner: 'scanner_agent',
  planner: 'planner_agent', writer: 'writer_agent', reviewer: 'reviewer_agent',
};

/** `claude --model opus --effort high` | `claude:opus:high` | `codex` → `claude|opus|high` (missing parts empty). */
export function normSpec(spec) {
  const s = String(spec || '').trim();
  if (!s) return '';
  if (!/\s/.test(s)) return [...s.split(':'), '', ''].slice(0, 3).join('|');
  const words = s.split(/\s+/);
  const opt = (flag) => (words.includes(flag) ? words[words.indexOf(flag) + 1] || '' : '');
  return [words[0], opt('--model'), opt('--effort')].join('|');
}

/** Same CLI; model and effort must agree wherever both sides name one. */
export function sameSpec(a, b) {
  const [x, y] = [normSpec(a).split('|'), normSpec(b).split('|')];
  return x[0] === y[0] && x.slice(1).every((v, i) => !v || !y[i + 1] || v === y[i + 1]);
}

/**
 * Agent specs the policy line locks as `key=spec` outside parentheses (`writer=claude --model sonnet`,
 * `reviewer=codex:gpt-6.1-sol`, `scanner/planner/writer=…`) → { writer_agent: spec, … }.
 */
export function policyAgents(raw) {
  const out = {};
  const text = stripParens(String(raw || ''));
  for (const m of text.matchAll(/(?:^|[\s·,;])((?:[a-z_-]+\/)*[a-z_-]+)=([a-z][\w.-]*(?::[\w.-]+)*(?:\s+--(?:model|effort)\s+[\w.:-]+)*)/g)) {
    for (const k of m[1].split('/')) if (AGENT_KEYS[k]) out[AGENT_KEYS[k]] = m[2];
  }
  return out;
}

const yamlKey = (project, k) => project.release[k] ?? project.fleet[k];

/**
 * `<BUDGET_MODE>` for the lanes: the policy `budget=` token, else SCOPE.md `budget_mode`, else
 * `advisory` (a legacy `bump=`/`budget_auto_bump=` alone is advisory). → `advisory` | `gate:<pct>` | null
 * (null: a budget token the runner cannot read).
 */
export function budgetMode(project) {
  const pct = Number(yamlKey(project, 'budget_auto_bump_pct')) || 15;
  const asMode = (v) => (v === 'advisory' ? v : v === 'gate' ? `gate:${pct}` : /^gate:\d+$/.test(v) ? v : null);
  const t = project.policy?.tokens || {};
  if (t.budget !== undefined) return asMode(t.budget);
  let scope = null;
  try {
    scope = fs.readFileSync(path.join(project.root, 'SCOPE.md'), 'utf8').match(/^\s*budget_mode:\s*(advisory|gate)\b/m)?.[1];
  } catch {
    /* no SCOPE.md: default */
  }
  return asMode(scope || yamlKey(project, 'budget_mode') || 'advisory');
}

/** `lite_when_no_assets` lock: policy `lite=` / `lite_when_no_assets=`, else the yaml key, else true. */
export function liteWhenNoAssets(project) {
  const t = project.policy?.tokens || {};
  const v = t.lite_when_no_assets ?? t.lite ?? yamlKey(project, 'fleet_lite_when_no_assets');
  return v === undefined ? true : String(v) === 'true';
}

const YES = /^(?:given|approved?|accept(?:ed)?)$/i;
// negation, and future / conditional wording (`S09 will be approved when reached`, `needs approved plan`)
const NO = /^(?:not|no|pending|rejected|deferred|later|tbd|hold|will|to|be|when|once|until|if|needs?|awaiting|before|should|must)$/i;

/**
 * Does the policy text record a director decision for this slice? Only an explicit one: the slice
 * id followed within three words by GIVEN / approved / accept (`S03 approved 2026-09-23`,
 * `S08 gate gate_9b5d approved`, `S02=accept proposed …`), with no `not`/`pending`/`TBD` in between
 * and before the next `;` or slice id. A range counts only with the decision word right after it
 * (`S02-S07 GIVEN`); a mention (`S04–S08 gate when reached`, `S05 NOT approved`) never does.
 */
export function gateDecides(text, sliceId) {
  if (!text) return false;
  const n = Number(sliceId.slice(1, 3));
  for (const m of text.matchAll(/\bS(\d{2})([a-z]?)(?:\s*(?:-|–|\.\.)\s*S(\d{2})[a-z]?)?\b/g)) {
    const range = Boolean(m[3]);
    const hit = range ? n >= Number(m[1]) && n <= Number(m[3]) : `S${m[1]}${m[2]}` === sliceId;
    if (!hit) continue;
    // the window ends at the next clause or the next slice id: `S04 TBD; S05 approved` is not S04's
    const rest = text.slice(m.index + m[0].length).split(/[;|·]|\bS\d{2}/)[0];
    const words = rest.split(/[\s=:,]+/).filter(Boolean).slice(0, range ? 1 : 4);
    for (const w of words) {
      const word = w.replace(/[^\w-]/g, '');
      if (NO.test(word)) break;
      if (YES.test(word)) return true;
    }
  }
  return false;
}

function git(root, args) {
  const r = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  return r.status === 0 ? r.stdout : '';
}

/**
 * Slices git shows as merged on HEAD: conventional `feat(Sxx)` / `fix(Sxx)` scopes, or a merge of a
 * branch named `Sxx-…`. Free-text mentions ("docs: S15 build plan") never count.
 */
export function gitMergedSlices(root) {
  const out = new Set();
  for (const s of git(root, ['log', '--format=%s', 'HEAD']).split('\n')) {
    const scoped = s.match(/^(?:feat|fix)\((S\d{2}[a-z]?)\)/);
    if (scoped) out.add(scoped[1]);
    const merge = s.match(/^Merge branch '([sS]\d{2}[a-zA-Z]?)[-_]/);
    if (merge) out.add(normId(merge[1]));
  }
  return out;
}

/** Live Orca/git worktrees named after a slice (`…/S21-moving-ice`) → { Sxx: path }. */
export function sliceWorktrees(root) {
  const out = {};
  for (const line of git(root, ['worktree', 'list', '--porcelain']).split('\n')) {
    const m = line.match(/^worktree (.+)$/);
    const id = m && path.basename(m[1]).match(/^(s\d{2}[a-z]?)[-_]/i);
    if (id && path.resolve(m[1]) !== path.resolve(root)) out[normId(id[1])] = m[1];
  }
  return out;
}

export function loadProject(root) {
  root = fs.realpathSync(root);
  const notesFile = path.join(root, 'AGENT_NOTES.md');
  if (!fs.existsSync(notesFile)) throw new Error('AGENT_NOTES.md missing');
  const notesText = fs.readFileSync(notesFile, 'utf8');
  const notes = lib.notes(root);
  if (!notes?.release) throw new Error('AGENT_NOTES.md yaml has no release: block');
  const msFile = path.join(root, 'MILESTONES.md');
  if (!fs.existsSync(msFile)) throw new Error('MILESTONES.md missing (run game-brief first)');
  const milestones = lib.fence(fs.readFileSync(msFile, 'utf8'), 'MILESTONES.md');
  if (!Array.isArray(milestones.slices) || !milestones.slices.length) throw new Error('MILESTONES.md yaml has no slices list');
  const sliceFiles = {};
  for (const f of lib.files(root, 'slices')) {
    const m = f.match(/^slices\/(S\d{2}[a-z]?)-.+\.md$/);
    if (m) sliceFiles[m[1]] = f;
  }
  return {
    root, notesFile, notesText, notes, release: notes.release, fleet: notes.fleet || {}, brief: notes.brief || {},
    ripPort: notes.rip_port || null, policy: parsePolicy(notesText), milestones, sliceFiles,
  };
}

/** cc4 checkout (same test as bootstrap's isCc4Project, plus the Notes `bootstrap.engine`). */
export function isCc4(project) {
  if (project.notes.bootstrap?.engine === 'cocos-cli') return true;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(project.root, 'package.json'), 'utf8'));
    if (String(pkg.creator?.version || '').startsWith('4.')) return true;
  } catch {
    /* fall through */
  }
  return fs.existsSync(path.join(project.root, 'scripts', 'open-mcp.sh')) && !fs.existsSync(path.join(project.root, 'extensions'));
}

/** rip-port analysis path: rip_port.analysis_path → brief.rip_port_path → reference/<slug>/rip-port. */
export function analysisPath(project) {
  const slug = path.basename(project.root).replace(/^cc4?-/, '');
  return String(project.ripPort?.analysis_path || project.brief.rip_port_path || `reference/${slug}/rip-port`).replace(/\/$/, '');
}

/**
 * Slice study of a port slice: needed when the project ports a rip (rip_port) unless the slice
 * declares `rip_study: []`, or when a non-port slice lists rip_study entries. → { needed, pin }
 * where pin is the lane's `<RIP_STUDY>` text, only for a `status: reviewed` study with its sha256.
 */
export function ripStudy(project, id, front) {
  const declared = Array.isArray(front.rip_study) ? front.rip_study : null;
  const port = Boolean(project.ripPort) && project.ripPort.enabled !== false;
  const needed = port ? !(declared && declared.length === 0) : Boolean(declared?.length);
  const rec = project.ripPort?.slice_studies?.[id];
  const pin = rec && rec.status === 'reviewed' && rec.sha256 ? `${analysisPath(project)}/slices/${id}/ sha256=${rec.sha256}` : null;
  return { needed, pin, status: rec?.status || null };
}

/**
 * game-brief progress gate, read-only (brief-progress --watch writes docs/brief-watch.json):
 * phase done and the contract hash still current. → null (no marker) | 'done' | a reason.
 */
export function briefGate(project) {
  const f = path.join(project.root, 'docs', 'brief-progress.json');
  if (!fs.existsSync(f)) return null;
  let s;
  try {
    s = JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return 'docs/brief-progress.json is unreadable';
  }
  if (s.phase !== 'done') return `phase ${s.phase}`;
  return s.contractHash === lib.reviewHash(project.root) ? 'done' : 'gate_stale (contracts changed since the gate)';
}

/** Slice `size:` (S | M | L); older slices may say `task_size:`. */
export const sliceSize = (front) => String(front.size ?? front.task_size ?? '').trim().toUpperCase();

export function sliceFront(project, id) {
  const rel = project.sliceFiles[id];
  if (!rel) throw new Error(`slice file for ${id} missing under slices/`);
  return { file: rel, data: lib.front(fs.readFileSync(path.join(project.root, rel), 'utf8'), rel) };
}

/**
 * Effective status per slice: git merged wins over the cache; a live slice worktree means
 * in_progress; a cache value that is neither not-started, done nor blocked (changes_requested,
 * approved, a typo) is in flight too — it is reattached or adopted, never dispatched afresh.
 */
export function sliceStatuses(project) {
  const merged = gitMergedSlices(project.root);
  const live = sliceWorktrees(project.root);
  const cache = project.release.slices || {};
  const out = {};
  // slices the cache, a worktree or slices/ know about but MILESTONES does not: reported, never run
  const ids = new Set([...project.milestones.slices, ...Object.keys(cache), ...Object.keys(live)]);
  for (const id of ids) {
    const cached = statusOf(cache[id]) || 'planned';
    if (merged.has(id) && !DONE.has(cached)) out[id] = { status: 'merged', source: 'git', cached };
    // a blocked slice keeps its worktree for the director: still blocked, not in progress
    else if (live[id] && !DONE.has(cached) && cached !== 'blocked') out[id] = { status: 'in_progress', source: 'worktree', cached, worktree: live[id] };
    else if (!NOT_STARTED.has(cached) && !DONE.has(cached) && cached !== 'blocked') out[id] = { status: 'in_progress', source: 'cache', cached };
    else out[id] = { status: cached, source: 'cache', cached };
  }
  return out;
}

/** Runnable order: topological over `dag`, ties by `slices` order. */
export function runnableOrder(milestones) {
  const order = [];
  const seen = new Set();
  const dag = milestones.dag || {};
  const visit = (id, stack = new Set()) => {
    if (seen.has(id)) return;
    if (stack.has(id)) throw new Error(`MILESTONES dag cycle at ${id}`);
    stack.add(id);
    for (const dep of dag[id] || []) visit(dep, stack);
    stack.delete(id);
    seen.add(id);
    order.push(id);
  };
  for (const id of milestones.slices) visit(id);
  return order;
}

/**
 * Next step of the loop (Step 2a): an in-progress slice resumes first; otherwise the first slice in
 * runnable order whose deps are done and whose status is not merged/shipped/blocked.
 * → { slice, resume } | { done: true, reason } | { stuck: true, reason }
 */
export function nextSlice(project, statuses = sliceStatuses(project)) {
  const ms = project.milestones;
  const goal = project.policy?.tokens.goal || project.release.goal;
  const order = runnableOrder(ms);
  // a slice already in flight is reattached before any stop condition (SKILL §Resuming)
  const outside = Object.keys(statuses).filter((id) => !order.includes(id) && statuses[id].status === 'in_progress');
  if (outside.length) return { stuck: true, reason: `${outside.join(', ')} in progress but not in MILESTONES.slices: update MILESTONES.md (game-brief) before the runner takes over` };
  const live = order.filter((id) => statuses[id]?.status === 'in_progress');
  if (live.length > 1) return { stuck: true, reason: `more than one slice in progress: ${live.join(', ')}` };
  if (live.length) return { slice: live[0], resume: true };
  if (goal === 'playable' && ms.v1_slice && DONE.has(statuses[ms.v1_slice]?.status)) return { done: true, reason: `goal=playable and ${ms.v1_slice} is merged` };
  for (const id of order) {
    const st = statuses[id]?.status;
    if (DONE.has(st) || st === 'blocked') continue;
    if ((ms.dag?.[id] || []).every((d) => DONE.has(statuses[d]?.status))) return { slice: id, resume: false };
  }
  const rel = ms.release_slice;
  if (rel && DONE.has(statuses[rel]?.status)) return { done: true, reason: `release slice ${rel} is ${statuses[rel].status}` };
  const blocked = order.filter((id) => statuses[id]?.status === 'blocked');
  return { stuck: true, reason: blocked.length ? `nothing runnable; blocked: ${blocked.join(', ')}` : 'nothing runnable' };
}

/**
 * Preflight gates before (re)dispatching a slice → list of { code, detail }. Empty = go.
 * Mirrors game-producer SKILL Inputs / Step 0–1; anything it cannot decide mechanically blocks.
 */
export function preflight(project, id, { initial = false } = {}) {
  const out = [];
  const add = (code, detail) => out.push({ code, detail });
  if (!project.policy) add('needs_policy', 'no policy line in ## Notes — game-producer: Step 0–1 has not run');
  const t = project.policy?.tokens || {};
  // the policy line is the lock; a yaml value changed since (director re-lock) must be re-locked, not guessed
  for (const k of ['goal', 'auto_commit', 'auto_merge', 'deploy']) {
    const y = project.release[k];
    if (t[k] !== undefined && y !== undefined && String(y) !== t[k]) add('policy_conflict', `policy line ${k}=${t[k]} but AGENT_NOTES release.${k}=${y}: re-lock the policy line`);
  }
  if (t.max_parallel && t.max_parallel !== '1') add('max_parallel', `policy max_parallel=${t.max_parallel}; runner phase 1 runs one slice at a time`);
  if (budgetMode(project) === null) add('policy_conflict', `policy budget=${t.budget} is neither advisory nor gate[:<pct>]`);
  // the lanes spawn the yaml specs: a policy line that locked another agent must be re-locked by the human
  for (const [k, spec] of Object.entries(policyAgents(project.policy?.raw))) {
    if (project.fleet[k] && !sameSpec(spec, project.fleet[k])) {
      add('agent_conflict', `policy line locks ${k.replace(/_agent$/, '')}=${spec} but AGENT_NOTES fleet.${k} is "${project.fleet[k]}"`);
    }
  }
  let front;
  try {
    front = sliceFront(project, id).data;
  } catch (err) {
    add('slice_file', err.message);
    return out;
  }
  if (!/^[SML]$/.test(sliceSize(front))) add('slice_file', `${id} size is "${front.size}", not S, M or L`);
  for (const k of ['writer_agent', 'reviewer_agent', ...(sliceSize(front) === 'L' ? ['orchestrator_agent'] : [])]) {
    if (!project.fleet[k]) add('agent_conflict', `AGENT_NOTES fleet.${k} is empty`);
  }
  const depth = project.brief.contract_depth || 'full';
  const goal = t.goal || project.release.goal;
  if (depth === 'playable' && !(goal === 'playable' && id === project.milestones.v1_slice)) {
    add('contract_depth', `brief.contract_depth=playable allows only ${project.milestones.v1_slice} under goal=playable; route a game-brief expansion first`);
  }
  const needsOk = front.needs_director_ok === true || tableNeedsOk(project, id);
  if (needsOk && !gateDecides(project.policy?.raw, id)) add('director_gate', `${id} needs_director_ok and the policy line records no explicit decision for it (e.g. "${id} GIVEN")`);
  const study = ripStudy(project, id, front);
  if (study.needed && !study.pin) {
    add('needs_slice_study', `${id} needs a reviewed slice study (rip_port.slice_studies.${id} is ${study.status || 'missing'}; rip-port-analysis § Slice study)`);
  }
  // SKILL: the brief gate holds before the initial dispatch only; lanes later edit PLAYTEST/FOLLOWUPS
  if (initial) {
    const g = briefGate(project);
    if (g && g !== 'done') add('brief_progress', `brief-progress: ${g}; contracts are not final`);
  }
  return out;
}

function tableNeedsOk(project, id) {
  const ms = fs.readFileSync(path.join(project.root, 'MILESTONES.md'), 'utf8');
  for (const t of lib.tables(ms)) {
    const head = t[0].map((h) => h.trim().toLowerCase());
    const col = head.indexOf('needs_director_ok');
    if (col < 0) continue;
    for (const r of t.slice(2)) if (r[0].trim() === id) return /^true$/i.test(r[col].trim());
  }
  return false;
}

// ------------------------------------------------------------------ the release: cache (write)

function scalarText(node, value) {
  if (node?.type === 'QUOTE_DOUBLE') return JSON.stringify(value);
  if (node?.type === 'QUOTE_SINGLE') return `'${String(value).replace(/'/g, "''")}'`;
  return value === '' ? '""' : String(value);
}

/**
 * Set release.current_slice and/or release.slices.<Sxx> by replacing only the value bytes in the
 * yaml fence of AGENT_NOTES.md: comments, alignment and flow/block style stay as they are.
 */
export function editRelease(text, { currentSlice, slices = {} }) {
  const m = FENCE.exec(text);
  if (!m) throw new Error('AGENT_NOTES.md has no yaml fence');
  const bodyStart = m.index + m[0].indexOf(m[1]);
  const body = m[1];
  const doc = YAML.parseDocument(body, { keepSourceTokens: true });
  if (doc.errors.length) throw new Error(`AGENT_NOTES.md yaml: ${doc.errors[0].message}`);
  const release = doc.get('release', true);
  if (!YAML.isMap(release)) throw new Error('AGENT_NOTES.md yaml: release is not a map');
  const edits = [];
  const pairOf = (map, key) => map.items.find((p) => String(p.key?.value ?? p.key) === key);
  if (currentSlice !== undefined) {
    const p = pairOf(release, 'current_slice');
    if (!p?.value?.range) throw new Error('release.current_slice missing');
    edits.push({ at: p.value.range[0], end: p.value.range[1], text: scalarText(p.value, currentSlice) });
  }
  const ids = Object.keys(slices);
  if (ids.length) {
    const sp = pairOf(release, 'slices');
    const map = sp?.value;
    if (!YAML.isMap(map)) throw new Error('release.slices is not a map');
    const src = body.slice(map.range[0], map.range[1]);
    const first = map.items[0];
    const quotedKeys = first?.key?.type === 'QUOTE_DOUBLE';
    const valueNode = first?.value || { type: quotedKeys ? 'QUOTE_DOUBLE' : 'PLAIN' };
    const missing = [];
    for (const id of ids) {
      const p = pairOf(map, id);
      if (p) {
        if (!YAML.isScalar(p.value)) throw new Error(`release.slices.${id} is not a plain status; edit it by hand`);
        edits.push({ at: p.value.range[0], end: p.value.range[1], text: scalarText(p.value, slices[id]) });
      } else missing.push(id);
    }
    if (missing.length) {
      const fmt = (id) => `${quotedKeys ? JSON.stringify(id) : id}${/":"/.test(src) ? ':' : ': '}${scalarText(valueNode, slices[id])}`;
      if (map.flow) {
        const close = map.range[0] + src.lastIndexOf('}');
        // compact JSON style (`{"S01":"merged"}`) keeps its no-space separators
        const comma = /,"/.test(src) || (quotedKeys && /":"/.test(src)) ? ',' : ', ';
        edits.push({ at: close, end: close, text: (map.items.length ? comma : '') + missing.map(fmt).join(comma) });
      } else {
        const last = map.items[map.items.length - 1];
        const lineEnd = body.indexOf('\n', last.value.range[1]);
        const indent = ' '.repeat(last.key.range[0] - body.lastIndexOf('\n', last.key.range[0]) - 1);
        const lines = missing.map((id) => `${indent}${fmt(id)}`);
        // after the last entry's line (its trailing comment included); the fence body may end on it
        if (lineEnd === -1) edits.push({ at: body.length, end: body.length, text: `\n${lines.join('\n')}` });
        else edits.push({ at: lineEnd + 1, end: lineEnd + 1, text: `${lines.join('\n')}\n` });
      }
    }
  }
  let next = body;
  for (const e of edits.sort((a, b) => b.at - a.at)) next = next.slice(0, e.at) + e.text + next.slice(e.end);
  const check = YAML.parse(next).release;
  if (currentSlice !== undefined && check.current_slice !== currentSlice) throw new Error('release.current_slice edit did not take');
  for (const id of ids) if (statusOf(check.slices?.[id]) !== slices[id]) throw new Error(`release.slices.${id} edit did not take`);
  return text.slice(0, bodyStart) + next + text.slice(bodyStart + body.length);
}

export function writeRelease(project, change) {
  const text = fs.readFileSync(project.notesFile, 'utf8');
  const next = editRelease(text, change);
  if (next === text) return false;
  const tmp = `${project.notesFile}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, next);
  fs.renameSync(tmp, project.notesFile);
  return true;
}
