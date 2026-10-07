/**
 * Cocos editor lifecycle: keep the editors an agent is using or is about to use, close the ones
 * that only wait. The director's rule (2026-10-07): while a slice runs in a worktree, the primary
 * checkout's editor waits, so it closes; an editor nobody has used for a while closes too. The
 * runner opens main's editor again before a single lane needs it (game-producer lib/editors.mjs),
 * and the fleet merge's `reopen` step does the same for the verifier.
 *
 * `editorFacts(s)` gathers who uses each editor: lane agents by their CC_ROLE/CC_PROJECT env (or
 * cwd), client connections into the editor's own ports, and the producer runner's files for the
 * checkout's project. `lifecyclePlan` is the pure verdict over those facts; `closeEditor` closes
 * one the way the runner's merge step does (scripts/close-editor.sh), SIGTERM as the fallback.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { isClaude } from './probe.mjs';

const AGENT = /(^|\/)(codex|agy|cursor-agent|gemini|opencode)$/;
// roles that never drive the editor: the fleet coordinator validates, the producer and judge decide
const NO_EDITOR_ROLES = new Set(['coordinator', 'producer', 'judge']);
const FLEET_ACTIVE = new Set(['fleet', 'accept', 'commit', 'committing']);
const norm = (p) => (p ? path.resolve(p) : p);
const within = (p, dir) => !!p && !!dir && (p === dir || p.startsWith(`${dir}/`));
const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const isAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

export function isAgent(p) {
  return isClaude(p) || AGENT.test(p.command.split(/\s+/)[0] || '');
}

/** The primary checkout of `dir`: itself, or the repo a linked worktree's `.git` file points into. */
export function primaryOf(dir) {
  const dotgit = path.join(dir, '.git');
  try {
    if (fs.statSync(dotgit).isFile()) {
      const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotgit, 'utf8'));
      if (m && m[1].includes('/.git/worktrees/')) return { primary: m[1].trim().split('/.git/worktrees/')[0], isWorktree: true };
    }
  } catch { /* not a checkout, or gone */ }
  return { primary: dir, isWorktree: false };
}

/** The worktree named after a slice (`…/s03-engine`, `feature-S12-…`), the way the runner finds it. */
function sliceWorktree(primary, slice) {
  if (!slice) return null;
  const r = spawnSync('git', ['-C', primary, 'worktree', 'list', '--porcelain'], { encoding: 'utf8', timeout: 10000 });
  for (const line of (r.stdout || '').split('\n')) {
    const m = /^worktree (.+)$/.exec(line);
    const id = m && path.basename(m[1]).match(/(?:^|[-_])(s\d{2}[a-z]?)(?:[-_]|$)/i);
    if (id && id[1].toUpperCase() === slice.toUpperCase() && norm(m[1]) !== norm(primary)) return norm(m[1]);
  }
  return null;
}

/**
 * What the producer runner of `primary` is doing: { live, reopens, slice, step, phase, lane, worktree }.
 * `reopens`: the live runner reopens main's editor itself before a single lane needs it (its lock
 * says so); an older runner does not, so main's editor must stay open while it runs.
 */
export function runnerInfo(primary) {
  const dir = path.join(primary, '.cursor');
  const lock = readJson(path.join(dir, 'producer.lock'));
  const live = !!lock && (!lock.host || lock.host === os.hostname()) && isAlive(lock.pid);
  const runner = readJson(path.join(dir, 'producer-runner.json'));
  if (!runner?.slice) return { live, reopens: live && lock.reopens_editor === true };
  const s = readJson(path.join(dir, 'evidence', 'tasks', `T-${runner.slice}`, 'producer-state.json')) || {};
  const lane = s.coordinator || s.coordinator_spawning || s.phase === 'fleet' ? 'fleet' : s.writer || s.writer_spawning ? 'single' : null;
  const wt = lane === 'fleet' ? norm(s.worktree) || sliceWorktree(primary, runner.slice) : null;
  return {
    live, reopens: live && lock.reopens_editor === true, slice: runner.slice, step: runner.step,
    phase: s.phase || null, lane, worktree: wt && fs.existsSync(wt) ? wt : null,
  };
}

/** pid → { role, project, slice } from the env of each agent process (ps -E). */
function agentEnv(pids) {
  const out = new Map();
  if (!pids.length) return out;
  const r = spawnSync('ps', ['-E', '-ww', '-o', 'pid=,command=', '-p', pids.join(',')], { encoding: 'utf8', timeout: 10000, maxBuffer: 32 * 1024 * 1024 });
  for (const line of (r.stdout || '').split('\n')) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const env = (k) => new RegExp(`(?:^|\\s)${k}=(\\S+)`).exec(m[2])?.[1] ?? null;
    out.set(Number(m[1]), { role: env('CC_ROLE'), project: norm(env('CC_PROJECT')), slice: env('CC_SLICE') });
  }
  return out;
}

/** pid → cwd */
function cwds(pids) {
  const out = new Map();
  if (!pids.length) return out;
  const r = spawnSync('lsof', ['-a', '-d', 'cwd', '-Fpn', '-p', pids.join(',')], { encoding: 'utf8', timeout: 10000 });
  let pid = null;
  for (const line of (r.stdout || '').split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    else if (line.startsWith('n') && pid) out.set(pid, line.slice(1));
  }
  return out;
}

/** Established connections from outside the tree into the ports an editor listens on (Funplay MCP, preview). */
function editorClients(treePids) {
  const r = spawnSync('lsof', ['-nP', '-a', '-p', treePids.join(','), '-iTCP', '-Fn'], { encoding: 'utf8', timeout: 10000 });
  const names = (r.stdout || '').split('\n').filter((l) => l.startsWith('n')).map((l) => l.slice(1));
  const listen = new Set(names.filter((n) => !n.includes('->')).map((n) => n.split(':').pop()));
  const conns = names.filter((n) => n.includes('->'));
  const ownLocal = new Set(conns.map((n) => n.split('->')[0].split(':').pop()));
  // inbound = local side is a listening port; a remote port the tree also owns is a helper talking to main
  return new Set(conns.filter((n) => listen.has(n.split('->')[0].split(':').pop())).map((n) => n.split('->')[1].split(':').pop()).filter((p) => !ownLocal.has(p))).size;
}

/**
 * Facts per editor pid: { exists, primary, isWorktree, laneUsers, cwdUsers, worktreeLanes, clients, runner }.
 * laneUsers: agents of an editor-driving role whose CC_PROJECT is this checkout (or that sit in it
 * with such a role); worktreeLanes: the same in another worktree of this primary.
 */
export function editorFacts(s) {
  const agents = s.procs.filter(isAgent);
  const pids = agents.map((p) => p.pid);
  const env = agentEnv(pids);
  const cwd = cwds(pids);
  const lanes = agents.map((p) => {
    const e = env.get(p.pid) || {};
    const dir = norm(cwd.get(p.pid));
    return { pid: p.pid, role: e.role, slice: e.slice, project: e.project || (e.role ? dir : null), cwd: dir };
  });
  const driving = lanes.filter((l) => l.project && !NO_EDITOR_ROLES.has(l.role));
  const kids = new Map();
  for (const p of s.procs) { if (!kids.has(p.ppid)) kids.set(p.ppid, []); kids.get(p.ppid).push(p.pid); }
  const tree = (pid) => { const out = []; const st = [pid]; while (st.length) { const x = st.pop(); out.push(x); st.push(...(kids.get(x) || [])); } return out; };

  const facts = new Map();
  const runners = new Map();
  for (const ed of s.editors) {
    const dir = norm(ed.project);
    const exists = !!dir && fs.existsSync(dir);
    const { primary, isWorktree } = exists ? primaryOf(dir) : { primary: dir, isWorktree: false };
    if (exists && !runners.has(primary)) runners.set(primary, runnerInfo(primary));
    const laneUsers = driving.filter((l) => l.project === dir);
    const cwdUsers = lanes.filter((l) => !l.project && within(l.cwd, dir));
    const worktreeLanes = isWorktree ? [] : driving.filter((l) => l.project !== dir && fs.existsSync(l.project)
      && primaryOf(l.project).isWorktree && primaryOf(l.project).primary === primary);
    facts.set(ed.pid, {
      exists, primary, isWorktree, laneUsers, cwdUsers, worktreeLanes,
      clients: exists ? editorClients(tree(ed.pid)) : 0, runner: runners.get(primary) || { live: false },
    });
  }
  return facts;
}

/**
 * Verdict per editor, in rule order:
 *   gone (checkout deleted: the reaper's) · keep-listed · opened by hand (no --nologin) · the runner
 *   uses it (merge step on main, fleet worktree) · a lane agent uses it · grace (opened < graceMin
 *   ago: about to be used) · primary waits (a slice runs in one of its worktrees) · a live runner
 *   that cannot reopen main · a client is connected · idle ≥ idleMin → close.
 * `seen` is the watcher's { pid: lastUsedIso }; returns the closes, every verdict and the new `seen`.
 */
export function lifecyclePlan(s, cfg, facts, { seen = {}, now = Date.now() } = {}) {
  const verdicts = [];
  const next = {};
  const keepList = (cfg.editors.keep || []).map(norm);
  for (const ed of s.editors) {
    const f = { exists: true, laneUsers: [], cwdUsers: [], worktreeLanes: [], clients: 0, runner: { live: false }, ...facts.get(ed.pid) };
    const dir = norm(ed.project);
    const R = f.runner;
    let lastUsed = Math.max(Date.parse(seen[ed.pid] || 0) || 0, now - ed.etimeSec * 1000);
    const v = (verdict, why) => verdicts.push({ pid: ed.pid, project: ed.project, footMB: ed.footMB, verdict, why });
    const used = (why) => { lastUsed = now; v('keep', why); };
    const fleetWt = R.live && R.lane === 'fleet' && FLEET_ACTIVE.has(R.phase) && R.worktree;
    if (!f.exists) v('gone', 'checkout no longer exists (the reaper kills it)');
    else if (keepList.includes(dir)) v('keep', 'listed in config editors.keep');
    else if (!ed.agentOwned) v('keep', 'opened by hand (no --nologin)');
    else if (R.live && R.phase === 'merge' && !f.isWorktree) used(`runner ${R.slice} merge step manages main's editor`);
    else if (fleetWt && fleetWt === dir) used(`runner ${R.slice} fleet works in this worktree`);
    else if (f.laneUsers.length) used(`in use: ${f.laneUsers.map(who).join(', ')}`);
    else if (ed.etimeSec < cfg.editors.graceMin * 60) v('keep', `opened ${Math.round(ed.etimeSec / 60)} min ago (grace ${cfg.editors.graceMin} min)`);
    else if (!f.isWorktree && fleetWt) v('close', `primary waits: runner ${R.slice} fleet works in ${path.basename(fleetWt)}`);
    else if (!f.isWorktree && f.worktreeLanes.length) v('close', `primary waits: ${f.worktreeLanes.map((l) => `${who(l)} works in ${path.basename(l.project)}`).join(', ')}`);
    else if (!f.isWorktree && R.live && !R.reopens) used('the live runner (older code) uses main next and does not reopen it; restart the runner to let idle close apply');
    else if (f.clients > 0) used(`${f.clients} client connection(s) into its MCP/preview ports`);
    else {
      const idleMin = Math.round((now - lastUsed) / 60000);
      if (idleMin >= cfg.editors.idleMin) v('close', `idle ${idleMin} min: no lane agent, no client`);
      else v('keep', `idle ${idleMin} min (closes at ${cfg.editors.idleMin})${f.cwdUsers.length ? `; ${f.cwdUsers.length} session(s) sit in the checkout` : ''}`);
    }
    next[ed.pid] = new Date(lastUsed).toISOString();
  }
  const closes = verdicts.filter((x) => x.verdict === 'close').map((x) => ({ ...s.editors.find((e) => e.pid === x.pid), why: x.why }));
  return { closes, verdicts, seen: next };
}

const who = (l) => `${l.role || 'agent'}${l.slice ? ` ${l.slice}` : ''} (pid ${l.pid})`;

/** Close like the runner's merge step: the checkout's own close script first, SIGTERM as the fallback. */
export async function closeEditor(ed, kill) {
  const dir = norm(ed.project);
  const script = dir && path.join(dir, 'scripts', 'close-editor.sh');
  if (script && fs.existsSync(script)) {
    const r = spawnSync('bash', [script, dir], { cwd: dir, encoding: 'utf8', timeout: 90000, env: { ...process.env, ORCA_WORKTREE_PATH: dir } });
    if (r.status === 0) {
      for (let t = 0; t < 20 && isAlive(ed.pid); t++) await new Promise((res) => setTimeout(res, 500));
      if (!isAlive(ed.pid)) return 'closed (close-editor.sh)';
    }
  }
  return kill(ed.pid, 15000);
}
