/**
 * Editors and machine load around a slice (director 2026-10-07: the 16 GB Mac froze or reset after
 * long runs with many agents and Creator instances). tools/res-guard watches the machine and closes
 * editors that only wait; these are the runner's three hooks into it:
 *   admit()        the res-guard gate before a lane terminal spawns or an editor opens. Not now →
 *                  the step pauses and asks again next idle tick (stop/pause still reach the runner);
 *                  after ADMIT_MAX_MS it goes ahead anyway — the gate slows a slice, never blocks it.
 *   ensureEditor() a single lane works in main and assumes main's Creator is open, but res-guard may
 *                  have closed it while the runner waited (the runner's lock says `reopens_editor`):
 *                  reopen it (open-editor.sh + wait-mcp, as merge's `reopen` step does) before a
 *                  writer or reviewer is spawned.
 *   closeMain()    once a fleet worktree exists, main's editor only waits: close it. The merge's
 *                  `close_editors` step finds it closed; its `reopen` step opens it for the verifier.
 * PRODUCER_RUNNER_RES_GUARD=<res-guard.mjs> picks the guard, `off` turns all three off.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as st from './state.mjs';
import * as io from './orca.mjs';
import { isCc4 } from './project.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_GUARD = path.resolve(HERE, '..', '..', '..', '..', 'tools', 'res-guard', 'res-guard.mjs');
const ADMIT_MAX_MS = Number(process.env.PRODUCER_RUNNER_ADMIT_MAX_MS) || 30 * 60000;

function guard() {
  const g = process.env.PRODUCER_RUNNER_RES_GUARD || DEFAULT_GUARD;
  return g === 'off' || !fs.existsSync(g) ? null : g;
}

export const editorRunning = (checkout) =>
  spawnSync('pgrep', ['-f', `CocosCreator.app/Contents/MacOS/CocosCreator --project ${checkout}( |$)`]).status === 0;

/**
 * May `what` start now for `checkout`? true = go. A refusal is logged once, its start kept in the
 * slice state (`admit_wait_since`) so the wait survives a runner restart; a guard that fails to
 * answer never holds a slice.
 */
export function admit(ctx, checkout, what, kind = 'lane') {
  const g = guard();
  if (!g) return true;
  const { root } = ctx.project;
  const id = ctx.id;
  const r = spawnSync(process.execPath, [g, 'gate', kind, '--project', checkout, '--free', '--json'], { encoding: 'utf8', timeout: 180000 });
  let v = null;
  try {
    v = JSON.parse(r.stdout);
  } catch {
    return true;
  }
  const s = st.readSliceState(root, id);
  const waited = s.admit_wait_since ? Math.round((Date.now() - Date.parse(s.admit_wait_since)) / 60000) : 0;
  if (v.ok) {
    if (s.admit_wait_since) {
      st.writeSliceState(root, id, { admit_wait_since: null });
      st.log(root, id, `res-guard admitted ${what} after ${waited} min`);
    }
    return true;
  }
  const reasons = (v.reasons || []).join('; ');
  if (!s.admit_wait_since) {
    st.writeSliceState(root, id, { admit_wait_since: st.now() });
    st.log(root, id, `res-guard holds ${what}: ${reasons}`);
    return false;
  }
  if (Date.now() - Date.parse(s.admit_wait_since) < ADMIT_MAX_MS) return false;
  st.writeSliceState(root, id, { admit_wait_since: null });
  st.log(root, id, `res-guard: ${what} goes ahead after ${waited} min (still: ${reasons})`);
  return true;
}

/**
 * Main's Creator up before a single-lane step that uses it. true = up (or nothing to do here);
 * false = the gate holds the reopen, pause and ask again. cc4 lanes start their own MCP server.
 */
export function ensureEditor(ctx, why) {
  if (!guard()) return true;
  const { project, id } = ctx;
  const root = project.root;
  if (isCc4(project) || editorRunning(root)) return true;
  const script = path.join(root, 'scripts', 'open-editor.sh');
  if (!fs.existsSync(script)) return true;
  if (!admit(ctx, root, `reopening main's editor (${why})`, 'editor')) return false;
  // open-editor.sh ends in `exec Creator`: run it detached, like merge's reopen step
  spawn('bash', [script, root], { cwd: root, detached: true, stdio: 'ignore', env: { ...process.env, ORCA_WORKTREE_PATH: root } }).unref();
  const w = spawnSync(process.execPath, [io.BOOTSTRAP, 'wait-mcp', '--path', root, '--timeout-ms', '180000', '--json'], { encoding: 'utf8', timeout: 240000 });
  st.log(root, id, `reopened main's editor for ${why} (wait-mcp ${w.status === 0 ? 'ok' : `exit ${w.status}: ${(w.stderr || w.stdout || '').trim().slice(-160)}`})`);
  return true;
}

/** A fleet worktree now exists: main's editor (Creator, or the cc4 MCP server) only waits — close it. */
export function closeMain(ctx, wt) {
  if (!guard()) return;
  const { project, id } = ctx;
  const root = project.root;
  const cc4 = isCc4(project);
  if (!cc4 && !editorRunning(root)) return;
  const script = path.join(root, 'scripts', cc4 ? 'close-mcp.sh' : 'close-editor.sh');
  if (!fs.existsSync(script)) return;
  const r = spawnSync('bash', cc4 ? [script, '--kill'] : [script, root], {
    cwd: root, encoding: 'utf8', timeout: 90000, env: { ...process.env, ORCA_WORKTREE_PATH: root },
  });
  st.log(root, id, `closed main's editor: the fleet works in ${path.basename(wt)}${r.status === 0 ? '' : ` (close script exited ${r.status})`}`);
}
