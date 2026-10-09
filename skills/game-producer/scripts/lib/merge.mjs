/**
 * Merge journal (plan M4c, SKILL Step 2d.2–5): after the slice commit, bring it into the main
 * checkout and record it. One T-<Sxx>/merge-journal.json holds every step; a step checks the real
 * state first (ancestor of main, worktree present, Editor up), so a kill at any point resumes without
 * a second merge or rm.
 *   fleet:  memory_review (only when the coordinator wrote no review pack) → harvest → merge (close +
 *           probe both Editors on every attempt) → evidence → worktree_rm → reopen → verify → record
 *   single: harvest → record (the commit is on main — checked — and the reviewer verified it there)
 * Nothing is merged with an Editor open or into a branch the slice did not start from; a worktree is
 * removed only when its commit is in main and its evidence copied; nothing is recorded merged before
 * main is verified (unless the human overrides). Everything else is a question.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { withSystem } from './attribution.mjs';
import { loadProject, writeRelease, writeSliceNote, editRelease, editSliceNote, isCc4 } from './project.mjs';
import * as st from './state.mjs';
import * as io from './orca.mjs';

const RUNNER_FILES = ['producer-state.json', 'producer-log.md', 'merge-journal.json', 'wait-*.json', '*.prev-*.json'];
const COMMIT_TIMEOUT_MS = Number(process.env.PRODUCER_RUNNER_COMMIT_TIMEOUT_MS) || 120000; // the bookkeeping commit's hooks
const RUNNER_FILE_RE = /^(?:producer-state\.json|producer-log\.md|merge-journal\.json|wait-.*\.json|.*\.prev-.*\.json)$/;

// The producer writes the planner pack in main (Step 2c hook plan --out). A worktree copy is never
// newer: in lego-stack T-S13 a 5-byte "none" stub there overwrote the real pack at merge.
const PRODUCER_OWNED = ['/evidence/memory/plan/'];

/**
 * Untracked review captures (worktree-relative paths from `git status`), worktree → main's ignored
 * `.cursor/evidence/tasks/T-<id>/captures/<same path>`, so removing the worktree loses none. → null | error text
 */
function copyCaptures(root, wt, id, files, prefix) {
  if (!files.length) return null;
  const top = git(wt, ['rev-parse', '--show-toplevel']).stdout.trim();
  const to = path.join(root, '.cursor', 'evidence', 'tasks', `T-${id}`, 'captures');
  try {
    for (const f of files) {
      // the project-relative part, never path math on wt: a symlinked worktree path (/tmp → /private/tmp)
      // would put the copy outside captures/ and then lose it with the worktree
      const dest = path.join(to, f.slice(prefix.length));
      if (!f.startsWith(prefix) || path.relative(to, dest).startsWith('..')) return `captures: ${f} is outside the project`;
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(path.join(top, f), dest);
    }
    return null;
  } catch (e) {
    return `captures: ${e.message}`;
  }
}

/** The slice's evidence, worktree → main (no PNGs, no runner files, no producer-owned pack). → null | error text */
function copyEvidence(root, wt, id) {
  const from = path.join(wt, '.cursor', 'evidence', 'tasks', `T-${id}`) + '/';
  const to = path.join(root, '.cursor', 'evidence', 'tasks', `T-${id}`) + '/';
  if (!fs.existsSync(from)) return null;
  fs.mkdirSync(to, { recursive: true });
  const r = spawnSync('rsync', ['-a', '--exclude', '*.png', ...[...RUNNER_FILES, ...PRODUCER_OWNED].flatMap((x) => ['--exclude', x]), from, to], { encoding: 'utf8' });
  return r.status === 0 ? null : (r.stderr || '').trim().slice(-200) || `rsync exit ${r.status}`;
}

/** Every path `git status` reports in a checkout (untracked files listed one by one; a rename gives both). */
function changedPaths(wt) {
  const entries = git(wt, ['status', '--porcelain', '-z', '--untracked-files=all']).stdout.split('\0');
  const out = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (!e) continue;
    out.push(e.slice(3));
    if (e[0] === 'R' || e[0] === 'C') out.push(entries[++i]);
  }
  return out;
}
export const MERGE_KINDS = new Set(['evidence_copy_failed', 'editors_open', 'main_detached', 'main_branch', 'merge_blocked', 'merge_conflict',
  'merge_source_missing', 'commit_not_on_main', 'reopen_failed', 'verify_manual', 'verify_failed', 'verifier_hung', 'merge_by_director']);
const EDITORS_NOTE = ' (both Editors are closed: reopen main with scripts/open-editor.sh if you stop here)';

// LC_ALL=C: the runner reads git's messages (conflict, untracked files)
const git = (cwd, args) => spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C', LANG: 'C' } });
const journalFile = (root, id) => st.sliceFiles(root, id).journal;
export const readJournal = (root, id) => st.readJson(journalFile(root, id), null);
function writeJournal(root, id, patch) {
  const j = { ...(readJournal(root, id) || {}), ...patch, updated: st.now() };
  st.writeJson(journalFile(root, id), j);
  return j;
}
function stepDone(root, id, step, result = {}) {
  const j = readJournal(root, id);
  writeJournal(root, id, { steps: { ...j.steps, [step]: { ...result, done_at: st.now() } } });
  st.log(root, id, `merge: ${step} done${result.note ? ` (${result.note})` : ''}`);
}
const evidenceRel = (id) => path.join('.cursor', 'evidence', 'tasks', `T-${id}`, 'evidence');
export const isAncestor = (root, sha) => Boolean(sha) && git(root, ['merge-base', '--is-ancestor', sha, 'HEAD']).status === 0;
export const currentBranch = (root) => {
  const r = git(root, ['symbolic-ref', '--short', 'HEAD']);
  return r.status === 0 ? r.stdout.trim() : null;
};
const slug = (root) => path.basename(root).replace(/^cc4?-/, '');

/** `budget_bump: 650→680` (or `->`) in the integration notes or the newest review; the last one wins. */
function budgetBump(dir) {
  let found = null;
  for (const f of [path.join(dir, 'integration-notes.md'), st.reviewFile(dir)]) {
    let text = '';
    try {
      text = fs.readFileSync(f, 'utf8');
    } catch {
      continue;
    }
    for (const m of text.matchAll(/budget_bump:\s*(\d+)\s*(?:→|->)\s*(\d+)/g)) found = { from: Number(m[1]), to: Number(m[2]) };
  }
  return found;
}

// ------------------------------------------------------------------ editors

const PROBE = path.join('.cursor', 'skills', 'vibe-game-director', 'scripts', 'probe.mjs');

/** Is this checkout's Editor (3.8 Creator + Funplay, or the cc4 MCP server) still up? null = cannot tell. */
function editorUp(checkout, cc4) {
  const probe = path.join(checkout, PROBE);
  if (!fs.existsSync(probe)) return null;
  // probe.mjs reads the pinned port and the expected project from its cwd
  const r = spawnSync(process.execPath, [probe, '--only', cc4 ? 'cocos-cli' : 'funplay'], { cwd: checkout, encoding: 'utf8', timeout: 60000 });
  let j = null;
  try {
    j = JSON.parse(r.stdout);
  } catch {
    return null;
  }
  const mcp = cc4 ? j.cocos_cli : j.funplay;
  if (!mcp || typeof mcp.reachable !== 'boolean') return null;
  if (mcp.reachable) return true;
  if (cc4) return false;
  // Funplay can be down while Creator still holds the project open
  return spawnSync('pgrep', ['-f', `CocosCreator.app/Contents/MacOS/CocosCreator --project ${checkout}( |$)`]).status === 0;
}

function closeEditor(checkout, cc4) {
  const script = path.join(checkout, 'scripts', cc4 ? 'close-mcp.sh' : 'close-editor.sh');
  if (!fs.existsSync(script)) return `${path.relative(checkout, script)} missing`;
  const r = spawnSync('bash', cc4 ? [script, '--kill'] : [script, checkout], {
    cwd: checkout, encoding: 'utf8', timeout: 90000, env: { ...process.env, ORCA_WORKTREE_PATH: checkout },
  });
  return r.status === 0 ? null : `${path.basename(script)} exited ${r.status}: ${(r.stderr || r.stdout).trim().slice(-200)}`;
}

/** Close both Editors and confirm each by probe. → null | the reason it cannot be confirmed. */
function closeBoth(j, root, cc4) {
  for (const checkout of [j.wt, root].filter((c) => c && fs.existsSync(c))) {
    const err = closeEditor(checkout, cc4);
    const up = err ? null : editorUp(checkout, cc4);
    if (err || up !== false) {
      return `${checkout === root ? 'main' : 'the worktree'}: ${err || (up === null ? 'the probe cannot tell whether it is closed' : 'it is still running')}`;
    }
  }
  return null;
}

function reopenEditor(root, cc4) {
  const script = path.join(root, 'scripts', cc4 ? 'open-mcp.sh' : 'open-editor.sh');
  if (!fs.existsSync(script)) return `${path.relative(root, script)} missing`;
  if (cc4) {
    const r = spawnSync('bash', [script], { cwd: root, encoding: 'utf8', timeout: 60000, env: { ...process.env, ORCA_WORKTREE_PATH: root } });
    if (r.status !== 0) return `open-mcp.sh exited ${r.status}: ${(r.stderr || r.stdout).trim().slice(-200)}`;
  } else {
    // open-editor.sh ends in `exec Creator`: run it detached, like setup-orca-worktree.sh does
    spawn('bash', [script, root], { cwd: root, detached: true, stdio: 'ignore', env: { ...process.env, ORCA_WORKTREE_PATH: root } }).unref();
  }
  const w = spawnSync(process.execPath, [io.BOOTSTRAP, 'wait-mcp', '--path', root, '--timeout-ms', '180000', '--json'], { encoding: 'utf8', timeout: 240000 });
  let j = null;
  try {
    j = JSON.parse(w.stdout);
  } catch {
    /* reported below */
  }
  if (w.status === 0 && j?.ok !== false) return null;
  return `wait-mcp exited ${w.status}: ${j?.mcp?.error || j?.mcp?.hint || (w.stderr || '').trim().slice(-200)}`;
}

// ------------------------------------------------------------------ merge

const listAfter = (text, marker) => {
  const i = text.indexOf(marker);
  if (i < 0) return [];
  return text.slice(i + marker.length).split('\n').slice(1).filter((l) => /^\t/.test(l)).map((l) => l.trim());
};

/** rename, or copy + remove across volumes (/tmp may be another one). */
function move(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  try {
    fs.renameSync(from, to);
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
    fs.copyFileSync(from, to);
    fs.rmSync(from);
  }
}

const mergeHead = (root) => {
  const r = git(root, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']);
  return r.status === 0 ? r.stdout.trim() : null;
};

/** Abort a half merge the runner itself started. → null | why it could not be aborted */
function abortHalfMerge(root) {
  if (!mergeHead(root)) return null;
  const a = git(root, ['merge', '--abort']);
  return a.status === 0 ? null : `merge --abort failed: ${(a.stderr || a.stdout).trim().slice(-200)}`;
}

/**
 * A merge already in progress in main. Only the runner's own — `merge_attempt` is set only while its
 * git merge runs, so it survives only a kill mid-merge — and only when MERGE_HEAD is the slice commit
 * is aborted to start over; anyone else's half merge (the director resolving a conflict by hand) is
 * left alone. → null | { ask }
 */
function pendingMerge(ctx, j, kit, s) {
  const { root } = ctx.project;
  const pending = mergeHead(root);
  if (!pending) {
    // git killed before it wrote MERGE_HEAD (inside a hook) leaves only the staged merge result:
    // undo it when the index is exactly that result (AUTO_MERGE); anything else stays for the human
    const auto = git(root, ['rev-parse', '-q', '--verify', 'AUTO_MERGE^{tree}']);
    if (j.merge_attempt && auto.status === 0 && git(root, ['write-tree']).stdout.trim() === auto.stdout.trim() && git(root, ['diff', '--cached', '--quiet']).status !== 0) {
      const r = git(root, ['reset', '--merge']);
      if (r.status !== 0) return kit.ask(s, 'merge_blocked', `the runner's interrupted merge could not be undone: ${(r.stderr || r.stdout).trim().slice(-200)}`, ['cleaned by hand, retry', 'mark blocked', 'stop']);
      restoreStash(root, ctx.id);
      st.log(root, ctx.id, 'merge: undid the staged result of an interrupted merge (no MERGE_HEAD); merging again');
    }
    return null;
  }
  const tip = git(root, ['rev-parse', '-q', '--verify', `refs/heads/${j.branch}`]).stdout.trim();
  if (j.merge_attempt && (pending === j.sha || pending === tip)) {
    const err = abortHalfMerge(root);
    if (err) return kit.ask(s, 'merge_blocked', `the runner's interrupted merge could not be aborted: ${err}`, ['cleaned by hand, retry', 'mark blocked', 'stop']);
    restoreStash(root, ctx.id);
    st.log(root, ctx.id, 'merge: aborted the half merge an interrupted runner left behind; merging again');
    return null;
  }
  return kit.ask(s, 'merge_blocked', `main has a merge in progress (MERGE_HEAD ${pending.slice(0, 7)}) that the runner did not start: finish or abort it first`, ['cleaned by hand, retry', 'mark blocked', 'stop']);
}

/** git merge --no-ff of the slice branch. → { ok } | { ask }; never leaves a half merge behind. */
function doMerge(ctx, j, kit, s) {
  const { root } = ctx.project;
  const id = ctx.id;
  const run = () => git(root, ['merge', '--no-ff', '--no-edit', j.branch]);
  let r = run();
  let out = `${r.stdout}\n${r.stderr}`;
  const untracked = listAfter(out, 'untracked working tree files would be overwritten by merge:');
  if (r.status !== 0 && untracked.length) {
    // SKILL: a stray untracked file (usually docs/plans/<Sxx>.md) goes to /tmp/<Sxx>-stash/, merge, diff, drop if identical
    const stash = path.join('/tmp', `${id}-stash`, `${slug(root)}-${Date.now()}`);
    writeJournal(root, id, { stash: { dir: stash, files: untracked } });
    for (const f of untracked) if (fs.existsSync(path.join(root, f))) move(path.join(root, f), path.join(stash, f));
    st.log(root, id, `merge: moved ${untracked.length} untracked file(s) that the merge would overwrite to ${stash}`);
    r = run();
    out = `${r.stdout}\n${r.stderr}`;
  }
  if (r.status === 0) return { ok: true };
  const conflict = /CONFLICT|Automatic merge failed/.test(out);
  // MERGE_HEAD was absent before this attempt (pendingMerge), so any now is this attempt's own
  const abortErr = abortHalfMerge(root);
  const restored = restoreStash(root, id);
  const tail = `${restored.length ? `; stray files put back: ${restored.join(', ')}` : ''}${abortErr ? `; ${abortErr}` : ''}${EDITORS_NOTE}`;
  if (conflict) {
    return kit.ask(s, 'merge_conflict', `merging ${j.branch} into main conflicts (merge aborted): ${out.match(/CONFLICT[^\n]*/g)?.slice(0, 3).join('; ') || 'see git'}${tail}`,
      ['resolved by hand, continue', 'mark blocked', 'stop']);
  }
  const dirty = listAfter(out, 'Your local changes to the following files would be overwritten by merge:');
  const why = dirty.length ? `main has local changes the merge would overwrite: ${dirty.join(', ')}` : `git merge ${j.branch} failed: ${out.trim().slice(-300)}`;
  return kit.ask(s, 'merge_blocked', `${why}${tail}`, ['cleaned by hand, retry', 'mark blocked', 'stop']);
}

/** A merge that did not happen: stashed stray files go back where they were. */
function restoreStash(root, id) {
  const j = readJournal(root, id);
  if (!j.stash) return [];
  const back = [];
  for (const f of j.stash.files) {
    const kept = path.join(j.stash.dir, f);
    if (fs.existsSync(kept) && !fs.existsSync(path.join(root, f))) {
      move(kept, path.join(root, f));
      back.push(f);
    }
  }
  writeJournal(root, id, { stash: null });
  return back;
}

/** After the merge: stashed files identical to the merged ones are dropped; the rest are reported. */
function settleStash(root, id) {
  const j = readJournal(root, id);
  if (!j.stash) return j.stash_differs || [];
  const differ = [];
  for (const f of j.stash.files) {
    const kept = path.join(j.stash.dir, f);
    if (!fs.existsSync(kept)) continue;
    const merged = path.join(root, f);
    if (fs.existsSync(merged) && Buffer.compare(fs.readFileSync(kept), fs.readFileSync(merged)) === 0) fs.rmSync(kept);
    else differ.push(f);
  }
  writeJournal(root, id, { stash_differs: differ, stash_dir: differ.length ? j.stash.dir : null, stash: null });
  return differ;
}

function mergeDone(root, id, j, extra) {
  settleStash(root, id); // first: a kill after the step is marked done must not skip it
  stepDone(root, id, 'merge', { into: currentBranch(root), head: git(root, ['rev-parse', 'HEAD']).stdout.trim(), conflict: Boolean(j.conflict_resolved), ...extra });
}

// ------------------------------------------------------------------ verify on main

const VERIFY_STATUSES = new Set(['verified', 'manual_required', 'failed']);

function verifyPrompt(ctx, j, fill) {
  const text = fs.readFileSync(new URL('../../reference/verify-main-prompt.md', import.meta.url), 'utf8');
  const tpl = text.match(/```text\n([\s\S]*?)\n```/)[1];
  return fill(tpl, { PROJECT: ctx.project.root, Sxx: ctx.id, EVIDENCE_DIR: path.join(ctx.project.root, evidenceRel(ctx.id)), BRANCH: j.branch, SHA: j.sha });
}

function verify(ctx, s, j, kit) {
  const { root } = ctx.project;
  const id = ctx.id;
  const cc4 = isCc4(ctx.project);
  if (cc4 || !fs.existsSync(path.join(root, 'funplay-cocos-mcp.config.json'))) {
    // plan phase 1: no Funplay (cc4, playable) → the runner cannot verify main; the director decides
    return kit.ask(s, 'verify_manual', `main verification after the merge needs a human: ${cc4 ? 'cc4 checkout' : 'no Funplay config'} (runner phase 1 verifies 3.8 + Funplay only)`,
      ['verified by hand, record', 'stop']);
  }
  const file = path.join(root, evidenceRel(id), 'verify-main.json');
  if (!s.verifier && !s.verifier_spawning) writeJournal(root, id, { verify_base: kit.mtime(file) });
  const sp = kit.spawnOnce(ctx, 'verifier', { role: 'worker', agent: kit.agentOrAsk(ctx.project, ctx.project.fleet.writer_agent, 'verifier'), title: `verify-${slug(root)}-${id}`, prompt: verifyPrompt(ctx, j, kit.fill) });
  if (sp.ask || sp.pause) return sp;
  const verdict = () => {
    const fresh = kit.mtime(file) !== readJournal(root, id).verify_base;
    const v = fresh ? st.readJson(file, null) : null;
    return { fresh, v, status: v && VERIFY_STATUSES.has(v.status) ? v.status : null };
  };
  // a verdict written while the runner was down is read first; otherwise wait for one
  let { fresh, v, status } = verdict();
  let w = { event: 'handoff' };
  if (!status) {
    w = kit.wait(ctx, st.readSliceState(root, id), 'verifier', { handoff: file, handle: sp.handle });
    if (w.event === 'orca-error') return kit.orcaError(root, id, s, w);
    ({ fresh, v, status } = verdict());
  }
  if (status === 'verified') {
    io.closeTerminal(sp.handle);
    stepDone(root, id, 'verify', { status, by: 'verifier' });
    return null;
  }
  if (status === 'manual_required') {
    return kit.ask(s, 'verify_manual', `verify-main.json says manual_required: ${v.detail || 'no detail'}`, ['verified by hand, record', 'fixed by hand, verify again', 'stop'], { obs: `verify_manual@${kit.mtime(file)}` });
  }
  const override = 'record merged anyway (verify=failed)';
  if (status === 'failed') {
    // the merge is in git already: fix main, or record it with the failure written into the Notes line
    return kit.ask(s, 'verify_failed', `main failed verification after the merge: ${v.detail || 'see verify-main.json'}`, ['fixed by hand, verify again', override, 'stop'], { obs: `verify_failed@${kit.mtime(file)}` });
  }
  if (fresh && v && !status) {
    return kit.ask(s, 'verify_failed', `verify-main.json status "${v.status}" is not verified|manual_required|failed`, ['fixed by hand, verify again', override, 'stop'], { obs: `verify_failed@${kit.mtime(file)}` });
  }
  if (w.event === 'terminal-missing' || (w.event === 'idle' && w.idle_streak >= 3)) {
    return kit.ask(s, 'verifier_hung', `verifier ${sp.handle} stopped without verify-main.json (${w.event})`, ['spawn a fresh verifier', 'verified by hand, record', 'stop'], { obs: `verifier_hung@${sp.handle}` });
  }
  return w.event === 'idle' ? kit.PAUSE : null;
}

// ------------------------------------------------------------------ lessons

const LESSONS = (root) => path.join(root, '.cursor', 'evidence', 'lessons.jsonl');

/** Append lessons rows once: cost rows deduped by content (minus `at` and `system`), candidates by
 * candidate_id. Cost rows get their `system` here (lib/attribution.mjs). */
export function appendLessons(root, rows) {
  const f = LESSONS(root);
  let text = '';
  try {
    text = fs.readFileSync(f, 'utf8');
  } catch {
    /* first lessons of the project */
  }
  const existing = text.split('\n').flatMap((l) => {
    try {
      return l.trim() ? [JSON.parse(l)] : [];
    } catch {
      return [];
    }
  });
  // `system` stays out of the key: a row recorded before S1 has none and must not come back twice
  const key = (r) => (r.candidate_id ? `c:${r.candidate_id}` : JSON.stringify({ ...r, at: undefined, system: undefined }));
  const seen = new Set(existing.map(key));
  const fresh = rows.map(withSystem).filter((r) => !seen.has(key(r)) && seen.add(key(r)));
  if (fresh.length) {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.appendFileSync(f, `${text && !text.endsWith('\n') ? '\n' : ''}${fresh.map((r) => JSON.stringify(r)).join('\n')}\n`);
  }
  return fresh.length;
}

/** Cost rows from the lane state (+ the journal's merge facts) and the slice's learning candidates. */
export function lessonRows(root, id, s, j = {}) {
  const at = st.now();
  const ev = evidenceRel(id);
  const rows = [];
  const cost = (event, extra) => rows.push({ slice: id, event, ...extra, fix_target: 'none', evidence: `${ev}/review.md`, at });
  const fixRounds = j.fix_rounds ?? s.fix_rounds ?? 0;
  if (fixRounds > 0) cost('fix_round', { count: fixRounds, cost: `${fixRounds} fix round(s)`, cause: 'review CHANGES_REQUESTED' });
  if (s.reviewer_next || s.preview_restarts) cost('infra_blocked', { count: 1, cost: 'extra review', cause: s.reviewer_next ? `reviewer could not reach localhost → ${s.reviewer_next}` : 'preview down, writer restarted it' });
  if (s.respawns) cost('respawn', { count: s.respawns, cost: `${s.respawns} resume lane(s)`, cause: 'writer stopped' });
  if (j.steps?.merge?.conflict) cost('merge_conflict', { count: 1, cost: 'resolved by hand', cause: `merge of ${j.branch}` });
  // a lane that ran and was blocked costs something; a slice skipped before it ran does not
  if (s.phase === 'blocked' && (s.writer || s.coordinator)) cost('other', { count: 1, cost: 'slice blocked', cause: `blocked: ${s.blocked_reason || 'by the director'}` });
  if (j.bump) rows.push({ slice: id, event: 'budget_bump', from: j.bump.from, to: j.bump.to, ratio: Number((j.bump.to / j.bump.from).toFixed(3)), fix_target: 'none', evidence: `${ev}/integration-notes.md`, at });
  // learning candidates (evidence paths are relative to the candidate file → project-relative)
  const candidates = st.readJson(path.join(root, ev, 'learning-candidates.json'), []);
  for (const c of Array.isArray(candidates) ? candidates : []) {
    if (!c?.id) continue;
    rows.push({
      event: 'recipe_candidate', candidate_id: `${path.basename(root)}/T-${id}/${c.id}`, slice: id, at, kind: c.kind, context: c.context,
      finding: c.finding, reuse_value: c.reuse_value, existing_recipe: c.existing_recipe ?? null,
      evidence: (c.evidence || []).map((p) => path.join(ev, p)), limitations: c.limitations || [],
    });
  }
  return rows;
}

// ------------------------------------------------------------------ record

function record(ctx, s, j) {
  const { root } = ctx.project;
  const id = ctx.id;
  writeRelease(loadProject(root), { currentSlice: '', slices: { [id]: 'merged' } });
  const kept = j.steps?.worktree_rm?.kept;
  const blockers = [
    kept ? `worktree kept: ${kept}` : null,
    j.stash_differs?.length ? `stash differs: ${j.stash_differs.join(',')}` : null,
    j.steps?.harvest?.failed ? 'memory harvest failed' : null,
    j.steps?.evidence?.not_copied ? 'evidence=not copied' : null,
    j.steps?.verify?.status && !['verified', undefined].includes(j.steps.verify.status) ? `verify=${j.steps.verify.status}` : null,
    s.manual_deferred?.length ? `manual_deferred=${s.manual_deferred.length}` : null,
  ].filter(Boolean);
  const bump = j.bump ? `${j.bump.from}→${j.bump.to}` : 'none';
  const noteLine = `- ${id} ${ctx.lane} merged fix_rounds=${j.fix_rounds ?? '?'} bump=${bump} commit=${String(j.sha).slice(0, 7)} merged=y ${blockers.join('; ') || '-'}`;
  writeSliceNote(loadProject(root), id, noteLine);
  const added = appendLessons(root, lessonRows(root, id, s, j));
  // Step 2d.5: release the lane terminal (reviewer and verifier were closed at their verdicts)
  io.closeTerminal(ctx.lane === 'fleet' ? s.coordinator : s.writer);
  stepDone(root, id, 'record', { note: `${added} lessons row(s)`, note_line: noteLine });
}

// ------------------------------------------------------------------ the journal

/** What the harvest really did: the hook exits 0 for off and nothing too, so the note reads its status line. */
export function harvestNote(h) {
  if (h.status !== 0) return 'failed: the worktree will be kept';
  if (h.memory === 'harvested') {
    // orca-memory refreshes the corpus after a harvest, so the next slice's packs see these lessons
    const rf = h.refresh;
    if (!rf || rf.skipped) return 'archived';
    return rf.ok ? `archived, refreshed (${rf.records ?? '?'} records)` : `archived; refresh failed at ${rf.failed_step}: packs miss it until the daily refresh`;
  }
  if (h.memory === 'off') return h.unregistered ? `off: ${h.unregistered} is not registered with orca-memory` : `off: ${h.reason || 'memory mode off'}`;
  if (h.memory === 'nothing') return `nothing archived: ${h.reason || 'no evidence'}`;
  return h.memory ? `exit 0, status ${h.memory}` : 'exit 0, no status line';
}

const CODE = /\.(?:ts|tsx|js|mjs|cjs)$/;
const TEST = /(?:^|\/)tests?\/|\.(?:test|spec)\.[cm]?[jt]sx?$/;

/**
 * Fleet lane: the coordinator owns the reviewer's `hook review` and skipped it on every pilot slice
 * (block-out S19–S21, lego-stack S09), so the runner records one before the harvest unless a pack is
 * already there. In shadow this is the measurement; an assist pack written now reaches no reviewer.
 * Advisory: nothing here blocks the merge.
 */
export function fleetMemoryReview(ctx, j) {
  const { root } = ctx.project;
  const rel = path.join(evidenceRel(ctx.id), 'memory', 'review', 'memory-context.json');
  if ([j.wt, root].some((d) => d && fs.existsSync(path.join(d, rel)))) return { note: 'coordinator wrote the review pack' };
  const slice = ctx.project.sliceFiles?.[ctx.id];
  if (!slice || !j.sha) return { note: !slice ? 'no slice file: review pack skipped' : 'no commit: review pack skipped' };
  const files = git(root, ['diff', '--name-only', `${j.sha}^`, j.sha]).stdout.split('\n').filter(Boolean);
  const code = files.filter((f) => CODE.test(f) && !TEST.test(f));
  const changed = code.length ? code : files;
  const h = io.memoryReview(`T-${ctx.id}`, path.join(root, slice), changed, path.join(root, evidenceRel(ctx.id), 'memory', 'review'), root);
  if (!h.ran) return { note: 'no orca-memory launcher' };
  if (h.status !== 0) return { status: h.status, memory: h.memory, note: `failed (exit ${h.status}): ${h.reason || 'see the hook log'}` };
  const note = h.memory === 'off' ? harvestNote(h) : `recorded after the lane: ${h.memory ?? 'no status line'}, ${changed.length} changed files`;
  return { status: 0, memory: h.memory, note };
}

/**
 * One pass over the merge journal. → null (progress, call again) | PAUSE | { ask } | { phase: 'done' }.
 * kit: lane helpers from lanes.mjs (ask, PAUSE, spawnOnce, wait, orcaError, mtime, fill, setPhase).
 */
export function mergeStep(ctx, s, kit) {
  const { root } = ctx.project;
  const id = ctx.id;
  let j = readJournal(root, id);
  if (!j) {
    // everything the later steps need, captured while the worktree still exists
    const wt = ctx.lane === 'fleet' ? s.worktree || kit.worktreeOf(root, id) : null;
    const dir = wt ? path.join(wt, evidenceRel(id)) : path.join(root, evidenceRel(id));
    const handoff = st.readJson(path.join(dir, 'HANDOFF.json'), {});
    const fix = ctx.lane === 'fleet' ? String(handoff.detail || '').match(/fix_rounds=(\d+)/)?.[1] : s.fix_rounds || 0;
    const branch = wt ? git(wt, ['symbolic-ref', '--short', 'HEAD']).stdout.trim() || null : null; // a detached worktree has none
    j = writeJournal(root, id, {
      lane: ctx.lane, sha: s.commit_sha, wt, branch, fix_rounds: fix === undefined ? null : Number(fix), bump: budgetBump(dir), steps: {}, started: st.now(),
    });
    st.log(root, id, `merge journal started (${ctx.lane}, commit ${String(s.commit_sha).slice(0, 7)}${wt ? `, worktree ${wt}, branch ${branch || '(detached)'}` : ''})`);
  }
  const done = (step) => Boolean(j.steps?.[step]);
  const cc4 = isCc4(ctx.project);
  const short = String(j.sha).slice(0, 7);

  if (ctx.lane === 'fleet' && !done('memory_review')) {
    stepDone(root, id, 'memory_review', fleetMemoryReview(ctx, j));
    return null;
  }

  if (!done('harvest')) {
    const h = io.memoryHarvest(j.wt || root, `T-${id}`, root);
    stepDone(root, id, 'harvest', h.ran ? { status: h.status, failed: h.status !== 0, memory: h.memory, note: harvestNote(h) } : { note: 'no orca-memory launcher' });
    if (h.ran && h.status === 0 && h.memory !== 'harvested') st.log(root, id, `memory harvest: ${harvestNote(h)}`);
    return null;
  }

  if (ctx.lane === 'single') {
    // the writer committed in the main checkout: the commit must really be there before it is recorded
    if (!done('record') && !isAncestor(root, j.sha)) {
      return kit.ask(s, 'commit_not_on_main', `the lane reported commit ${short}, but it is not in the main checkout's HEAD`, ['committed by hand, check again', 'mark blocked', 'stop']);
    }
  } else {
    if (!done('merge')) {
      if (isAncestor(root, j.sha)) {
        // merged already (a human, the director, or a kill after the merge): no Editor is touched
        mergeDone(root, id, j, { note: 'already in main' });
        return null;
      }
      if (!ctx.autoMerge) {
        return kit.ask(s, 'merge_by_director', `auto_merge=false: merge ${j.branch || short} (commit ${short}) into main yourself, then answer`, ['merged by director, record', 'mark blocked', 'stop']);
      }
      if (!j.branch || git(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${j.branch}`]).status !== 0) {
        return kit.ask(s, 'merge_source_missing', `commit ${short} is not in main and has no branch to merge (${j.branch ? `${j.branch} is gone` : 'the worktree was on a detached HEAD'})`, ['merged by hand, continue', 'mark blocked', 'stop']);
      }
      const head = currentBranch(root);
      if (!head) return kit.ask(s, 'main_detached', 'the main checkout is on a detached HEAD: check out the base branch', ['checked out, retry', 'mark blocked', 'stop']);
      const base = j.merge_into || s.base_branch;
      if (head !== base) {
        // the slice started from `base`: merging into whatever main has checked out now could land it on a feature branch
        return kit.ask(s, 'main_branch', `main is on ${head}${base ? `, but ${id} started from ${base}` : ` and the runner did not record which branch ${id} started from`}`,
          [`merge into ${head}`, 'checked out, retry', 'mark blocked', 'stop']);
      }
      const pending = pendingMerge(ctx, j, kit, s);
      if (pending) return pending;
      // SKILL Step 2d.3: both Editors closed and confirmed on every attempt (a retry can come hours later)
      const open = closeBoth(j, root, cc4);
      if (open) return kit.ask(s, 'editors_open', `cannot confirm the Editor is closed on ${open}`, ['closed by hand, check again', 'mark blocked', 'stop']);
      stepDone(root, id, 'close_editors', { note: cc4 ? 'cc4 MCP servers stopped' : 'both Creators closed' });
      // merge_attempt marks a runner merge in flight: only a kill can leave it set (see pendingMerge)
      writeJournal(root, id, { merge_attempt: st.now() });
      const m = doMerge(ctx, j, kit, s);
      writeJournal(root, id, { merge_attempt: null });
      if (!m.ok) return m;
      if (!isAncestor(root, j.sha)) {
        return kit.ask(s, 'merge_blocked', `git merge ${j.branch} succeeded but commit ${short} is not in main afterwards${EDITORS_NOTE}`, ['cleaned by hand, retry', 'mark blocked', 'stop']);
      }
      mergeDone(root, id, j, { note: `merged ${j.branch} into ${head}` });
      return null;
    }

    if (!done('evidence')) {
      // after the merge and before any rm: copy over whatever the commit did not carry (gitignored evidence)
      if (!j.wt || !fs.existsSync(j.wt)) {
        // removed by hand before the runner copied it: say so in the Notes line unless main has it anyway
        const inMain = fs.existsSync(st.reviewFile(path.join(root, evidenceRel(id))));
        stepDone(root, id, 'evidence', { not_copied: !inMain, note: inMain ? 'worktree gone; main has the evidence' : 'worktree gone before the copy: evidence not copied' });
        return null;
      }
      const err = copyEvidence(root, j.wt, id);
      if (err) return kit.ask(s, 'evidence_copy_failed', `rsync of the T-${id} evidence failed: ${err}`, ['copied by hand, continue', 'mark blocked', 'stop']);
      stepDone(root, id, 'evidence', { note: fs.existsSync(path.join(j.wt, '.cursor', 'evidence', 'tasks', `T-${id}`)) ? 'rsync worktree → main (no PNGs)' : 'the worktree has no evidence dir' });
      return null;
    }

    if (!ctx.autoMerge) {
      // auto_merge=false: the director merged and owns the finish (worktree, Editor, main check)
      for (const step of ['worktree_rm', 'reopen', 'verify']) if (!done(step)) stepDone(root, id, step, { skipped: true, note: 'auto_merge=false: left to the director' });
      j = readJournal(root, id);
    }

    if (!done('worktree_rm')) {
      if (!j.wt || !fs.existsSync(j.wt)) {
        stepDone(root, id, 'worktree_rm', { note: 'already gone' });
        return null;
      }
      let kept = j.steps.harvest?.failed ? 'harvest_failed' : null;
      if (!kept && !isAncestor(root, j.sha)) kept = 'commit_not_in_main'; // never: merge is done; belt and braces
      // the fleet commits its evidence dir and then rewrites HANDOFF.json (committed + sha), so a fleet
      // worktree is never clean (pilot 1): changes only under this slice's evidence dir, already copied
      // to main by the evidence step, may go; anything else keeps the worktree
      let force = false;
      let captures = [];
      const prefix = git(j.wt, ['rev-parse', '--show-prefix']).stdout.trim();
      if (!kept) {
        const changed = changedPaths(j.wt);
        if (changed.length) {
          const ev = `${prefix}.cursor/evidence/tasks/T-${id}/`;
          // only what copyEvidence carries: a PNG or a runner file there would be lost by --force
          const carried = (f) => f.startsWith(ev) && !/\.png$/i.test(f) && !RUNNER_FILE_RE.test(path.basename(f));
          // review captures nobody commits (PLAYTEST: docs/evidence/<Sxx>/*.png; a PNG in the evidence
          // dir): copied to main's ignored evidence dir below, so they never keep the worktree
          // (cc-firefighter-kids S01/S02 worktrees stayed forever over 6–7 MB of untracked PNGs)
          const untracked = new Set(git(j.wt, ['ls-files', '--others', '--exclude-standard', '-z']).stdout.split('\0').filter(Boolean).map((f) => prefix + f));
          const capture = (f) => untracked.has(f) && (f.startsWith(`${prefix}docs/evidence/${id}/`) || (f.startsWith(ev) && /\.png$/i.test(f)));
          captures = changed.filter(capture);
          if (j.steps.evidence?.not_copied || !changed.every((f) => carried(f) || capture(f))) kept = 'dirty';
          else force = true;
        }
        // PNGs in an ignored evidence dir never show as changes and the evidence copy skips them: keep them too
        if (!kept) {
          const ignored = git(j.wt, ['ls-files', '--others', '--ignored', '--exclude-standard', '-z', '--', `.cursor/evidence/tasks/T-${id}/`]).stdout.split('\0');
          for (const f of ignored) if (/\.png$/i.test(f) && !captures.includes(prefix + f)) captures.push(prefix + f);
        }
      }
      if (!kept) {
        // copy again right before the removal: a file written after the evidence step (a resume hours
        // later, the coordinator still writing) reaches main too — ignored files go with the worktree
        const err = copyEvidence(root, j.wt, id) || copyCaptures(root, j.wt, id, captures, prefix);
        if (err) kept = `evidence copy failed: ${err}`;
      }
      if (!kept) {
        const r = io.orca(['worktree', 'rm', '--worktree', `path:${j.wt}`, '--run-hooks', ...(force ? ['--force'] : [])]);
        if (r.status !== 0 || r.parsed?.ok === false) kept = `rm failed: ${r.parsed?.error?.code || r.parsed?.error?.message || r.status}`;
      }
      stepDone(root, id, 'worktree_rm', kept ? { kept, note: `worktree kept (${kept})` }
        : { note: force ? `removed: only its evidence files had changed, copied to main first${captures.length ? ` (${captures.length} capture(s) → .cursor/evidence/tasks/T-${id}/captures/)` : ''} (branch kept)` : 'removed (branch kept)', ...(captures.length ? { captures: captures.length } : {}) });
      return null;
    }

    if (!done('reopen')) {
      const err = reopenEditor(root, cc4);
      if (err) return kit.ask(s, 'reopen_failed', `the main Editor did not come back: ${err}`, ['editor opened by hand, check again', 'stop']);
      stepDone(root, id, 'reopen', { note: cc4 ? 'cc4 MCP up' : 'Creator + Funplay up (wait-mcp)' });
      return null;
    }

    if (!done('verify')) return verify(ctx, s, j, kit);
  }

  if (!done('record')) {
    record(ctx, s, j);
    return null;
  }
  if (!done('notes_commit')) {
    notesCommit(ctx, s, j);
    return null;
  }
  kit.setPhase(root, id, 'done');
  return { phase: 'done' };
}

/**
 * The runner commits its own bookkeeping on main (director 2026-10-02): AGENT_NOTES.md (release cache
 * and Notes line), the slice's tracked evidence the evidence step refreshed (the fleet rewrites
 * HANDOFF.json after its commit) and a tracked lessons.jsonl. By path: those files go in whole, except
 * AGENT_NOTES.md: when it holds more than this slice's own two edits (a director's unstaged Step-3 line or
 * policy edit; pilots 15–16) only HEAD + those edits is committed, from a scratch index, and the work
 * tree keeps the rest uncommitted. Every other file, untracked files (an Editor's new .meta) and runner state files stay out. Not under
 * auto_commit=false / auto_merge=false (the director commits and finishes), not off the slice's base
 * branch, not when a listed file has staged changes (someone is composing a commit). Idempotent after
 * a kill (nothing changed → nothing to commit); a failed commit (a hook, no identity, a timeout) is
 * logged and left for the director — the next slice's step retries it — never a stop.
 */
function notesCommit(ctx, s, j) {
  const { root } = ctx.project;
  const id = ctx.id;
  const skip = (note) => stepDone(root, id, 'notes_commit', { skipped: true, note });
  if (!ctx.autoCommit || !ctx.autoMerge) return skip(`auto_commit=${ctx.autoCommit} auto_merge=${ctx.autoMerge}: bookkeeping left for the director`);
  const z = (args) => git(root, args).stdout.split('\0').filter(Boolean);
  const paths = ['AGENT_NOTES.md', evidenceRel(id), path.join('.cursor', 'evidence', 'lessons.jsonl')];
  // -z: names as they are (no quoting of non-ASCII); --no-renames: a moved file is its two paths
  const files = z(['diff', '--name-only', '-z', '--no-renames', '--relative', 'HEAD', '--', ...paths]).filter((f) => !RUNNER_FILE_RE.test(path.basename(f)));
  if (!files.length) return stepDone(root, id, 'notes_commit', { note: 'nothing to commit' });
  const branch = currentBranch(root);
  if (!branch) return skip('main is detached: bookkeeping left uncommitted');
  const want = j.steps?.merge?.into || s.base_branch; // the branch the slice was merged into (the director may have picked it)
  if (want && branch !== want) return skip(`main is on ${branch}, not ${want}: bookkeeping left uncommitted`);
  const staged = z(['diff', '--cached', '--name-only', '-z', '--no-renames', '--relative', '--', ...files]);
  if (staged.length) return skip(`${staged.join(', ')} has staged changes: bookkeeping left uncommitted`);
  const body = `Producer runner, after merging ${id} (commit ${String(j.sha || '').slice(0, 7)}): ${files.join(', ')}`;
  const own = ownNotes(root, id, readJournal(root, id) || j);
  if (own) return notesCommitOwn(root, id, j, files, branch, own, body);
  // a hook may hang (an interactive pre-commit): bounded, never --no-verify; SIGTERM so git removes its
  // index.lock (a SIGKILL leaves it and every later git write on main fails)
  const r = spawnSync('git', ['-C', root, 'commit', '-q', '-m', `chore(producer): record ${id} merge — notes, evidence`, '-m', body, '--', ...files],
    { encoding: 'utf8', timeout: COMMIT_TIMEOUT_MS, killSignal: 'SIGTERM', env: { ...process.env, LC_ALL: 'C', LANG: 'C' } });
  if (r.status !== 0) {
    const why = r.error ? `git commit ${r.error.code === 'ETIMEDOUT' ? `timed out after ${COMMIT_TIMEOUT_MS / 1000} s` : r.error.message}` : (r.stderr || r.stdout).trim().split('\n').slice(-1)[0] || `exit ${r.status}`;
    st.log(root, id, `bookkeeping commit failed (left uncommitted for the director): ${why}`);
    return stepDone(root, id, 'notes_commit', { failed: true, files, note: `commit failed: ${why.slice(0, 200)}` });
  }
  const sha = git(root, ['rev-parse', 'HEAD']).stdout.trim();
  st.log(root, id, `committed the bookkeeping on ${branch} as ${sha.slice(0, 7)}: ${files.join(', ')}`);
  stepDone(root, id, 'notes_commit', { sha, files, note: `committed ${files.length} file(s)` });
}

/**
 * The AGENT_NOTES.md text the runner alone would leave: HEAD + this slice's release cache edit + its Notes
 * line. → null when the work tree already is exactly that (the plain by-path commit is right) or it cannot be built.
 */
function ownNotes(root, id, j) {
  const line = j.steps?.record?.note_line;
  if (!line || !fs.existsSync(path.join(root, 'AGENT_NOTES.md'))) return null;
  const head = git(root, ['show', 'HEAD:AGENT_NOTES.md']);
  if (head.status !== 0) return null;
  try {
    const text = editSliceNote(editRelease(head.stdout, { currentSlice: '', slices: { [id]: 'merged' } }), id, line).text;
    return text === fs.readFileSync(path.join(root, 'AGENT_NOTES.md'), 'utf8') ? null : text;
  } catch {
    return null;
  }
}

/** The bookkeeping commit with a scratch index: AGENT_NOTES.md as `own`, the other files from the work tree. Real index and work tree untouched but for the committed paths' index entries. */
function notesCommitOwn(root, id, j, files, branch, own, body) {
  const gitDir = git(root, ['rev-parse', '--git-dir']).stdout.trim();
  const idx = path.join(path.resolve(root, gitDir), `producer-index-${process.pid}`);
  const env = { ...process.env, GIT_INDEX_FILE: idx, LC_ALL: 'C', LANG: 'C' };
  const run = (args, opts = {}) => spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', env, timeout: COMMIT_TIMEOUT_MS, killSignal: 'SIGTERM', ...opts });
  const fail = (why) => {
    fs.rmSync(idx, { force: true });
    st.log(root, id, `bookkeeping commit failed (left uncommitted for the director): ${why}`);
    return stepDone(root, id, 'notes_commit', { failed: true, files, note: `commit failed: ${String(why).slice(0, 200)}` });
  };
  const blob = spawnSync('git', ['-C', root, 'hash-object', '-w', '--stdin'], { encoding: 'utf8', input: own });
  if (blob.status !== 0) return fail(blob.stderr.trim());
  const others = files.filter((f) => f !== 'AGENT_NOTES.md');
  const steps = [['read-tree', 'HEAD'], ['update-index', '--add', '--cacheinfo', `100644,${blob.stdout.trim()},AGENT_NOTES.md`], ...(others.length ? [['add', '-u', '--', ...others]] : []),
    ['commit', '-q', '-m', `chore(producer): record ${id} merge — notes, evidence`, '-m', `${body}\n\nAGENT_NOTES.md: only this slice's own edits; other uncommitted changes in it were left in the work tree.`]];
  for (const a of steps) {
    const r = run(a);
    if (r.status !== 0) return fail(r.error ? `git ${a[0]} ${r.error.code === 'ETIMEDOUT' ? 'timed out' : r.error.message}` : (r.stderr || r.stdout).trim().split('\n').slice(-1)[0] || `exit ${r.status}`);
  }
  fs.rmSync(idx, { force: true });
  git(root, ['reset', '-q', '--', ...files]); // the real index follows the new HEAD; the work tree keeps the director's edits
  const sha = git(root, ['rev-parse', 'HEAD']).stdout.trim();
  st.log(root, id, `committed the bookkeeping on ${branch} as ${sha.slice(0, 7)}: ${files.join(', ')} (AGENT_NOTES.md: this slice's edits only; the rest stays uncommitted)`);
  stepDone(root, id, 'notes_commit', { sha, files, note: `committed ${files.length} file(s), AGENT_NOTES.md own edits only` });
}

/**
 * Answers to the merge questions (stop / mark blocked are the runner's). A "check again" answer needs
 * no state: the step re-runs on the next pass and re-checks the real state (ancestor, probe, wait-mcp).
 */
export function applyMergeAnswer(ctx, q) {
  const { root } = ctx.project;
  const id = ctx.id;
  const j = readJournal(root, id) || { steps: {} };
  const s = st.readSliceState(root, id);
  const choice = q.answer.choice;
  const done = (step, extra) => writeJournal(root, id, { steps: { ...j.steps, [step]: { ...extra, done_at: st.now() } } });
  const closeVerifier = () => s.verifier && io.closeTerminal(s.verifier);
  if (q.kind === 'main_branch' && choice.startsWith('merge into ')) return writeJournal(root, id, { merge_into: choice.slice('merge into '.length) });
  switch (`${q.kind}:${choice}`) {
    case 'evidence_copy_failed:copied by hand, continue':
      return done('evidence', { by: 'human' });
    case 'merge_conflict:resolved by hand, continue':
      // the merge step re-checks that the commit is now an ancestor of main; the lessons get the cost
      return writeJournal(root, id, { conflict_resolved: true });
    case 'editors_open:closed by hand, check again':
    case 'merge_blocked:cleaned by hand, retry':
    case 'main_detached:checked out, retry':
    case 'main_branch:checked out, retry':
    case 'merge_source_missing:merged by hand, continue':
    case 'merge_by_director:merged by director, record':
    case 'commit_not_on_main:committed by hand, check again':
    case 'reopen_failed:editor opened by hand, check again':
      return null;
    case 'verify_manual:verified by hand, record':
    case 'verifier_hung:verified by hand, record':
      closeVerifier();
      return done('verify', { status: 'verified', by: 'human' });
    case 'verify_failed:record merged anyway (verify=failed)':
      closeVerifier();
      return done('verify', { status: 'failed', by: 'human override' });
    case 'verify_manual:fixed by hand, verify again':
    case 'verify_failed:fixed by hand, verify again':
    case 'verifier_hung:spawn a fresh verifier':
      closeVerifier();
      return st.writeSliceState(root, id, { verifier: null, verifier_spawning: null });
    default:
      throw new Error(`no action for ${q.kind}: ${choice}`);
  }
}
