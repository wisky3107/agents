import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { project, fakes, runner, evRel, ev, approvedEvidence, commitStep, lastCommit } from './harness.mjs';

// The runner's res-guard hooks (lib/editors.mjs): the admission gate before a spawn, main's editor
// reopened for a single lane, main's editor closed once a fleet worktree exists. A fake guard
// answers from guard-verdict.json; a fake "Creator" is a shell script whose command line matches
// the pgrep the runner and the template scripts use.
const FAKE = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'res-guard-fake-')));
const GUARD = path.join(FAKE, 'guard.mjs');
fs.writeFileSync(GUARD, `import fs from 'node:fs';
fs.appendFileSync(${JSON.stringify(path.join(FAKE, 'guard.log'))}, JSON.stringify(process.argv.slice(2)) + '\\n');
process.stdout.write(fs.readFileSync(${JSON.stringify(path.join(FAKE, 'guard-verdict.json'))}, 'utf8'));
`);
const verdict = (v) => fs.writeFileSync(path.join(FAKE, 'guard-verdict.json'), typeof v === 'string' ? v : JSON.stringify(v));
const guardCalls = () => fs.readFileSync(path.join(FAKE, 'guard.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const CREATOR = path.join(FAKE, 'CocosCreator.app', 'Contents', 'MacOS', 'CocosCreator');
fs.mkdirSync(path.dirname(CREATOR), { recursive: true });
fs.writeFileSync(CREATOR, '#!/bin/sh\ntrap \'kill $! 2>/dev/null; exit 0\' TERM\nsleep 60 &\nwait\n', { mode: 0o755 });
const BOOT = path.join(FAKE, 'bootstrap.cjs');
fs.writeFileSync(BOOT, `require('fs').appendFileSync(${JSON.stringify(path.join(FAKE, 'boot.log'))}, process.argv.slice(2).join(' ') + '\\n'); process.stdout.write('{"ok":true}');`);

process.env.PRODUCER_RUNNER_ADMIT_MAX_MS = '300';
process.env.PRODUCER_RUNNER_BOOTSTRAP = BOOT;
const ed = await import('../scripts/lib/editors.mjs');
const st = await import('../scripts/lib/state.mjs');

const pgrep = (root) => spawnSync('pgrep', ['-f', `CocosCreator.app/Contents/MacOS/CocosCreator --project ${root}( |$)`]).status === 0;
const startCreator = (root) => spawn(CREATOR, ['--project', root, '--nologin'], { detached: true, stdio: 'ignore' }).unref();
async function until(fn, ms = 5000) {
  for (const t0 = Date.now(); !fn(); await new Promise((r) => setTimeout(r, 50))) if (Date.now() - t0 > ms) throw new Error('timed out');
}
/** A checkout with the template's editor scripts, stubbed: each logs, close kills the fake Creator. */
function checkout() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'res-guard-proj-')));
  const log = path.join(root, 'editor.log');
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.writeFileSync(path.join(root, 'scripts', 'close-editor.sh'), `#!/bin/bash\necho "close $1" >> ${log}\npkill -f "CocosCreator.app/Contents/MacOS/CocosCreator --project $1( |$)"\nexit 0\n`);
  fs.writeFileSync(path.join(root, 'scripts', 'open-editor.sh'), `#!/bin/bash\necho "open $1" >> ${log}\nexec ${CREATOR} --project "$1" --nologin\n`);
  const ctx = { project: { root, notes: {} }, id: 'S01' };
  return { root, ctx, editorLog: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : []), sliceLog: () => fs.readFileSync(st.sliceFiles(root, 'S01').log, 'utf8') };
}
const withGuard = (fn) => async () => {
  process.env.PRODUCER_RUNNER_RES_GUARD = GUARD;
  fs.rmSync(path.join(FAKE, 'guard.log'), { force: true });
  try { await fn(); } finally { process.env.PRODUCER_RUNNER_RES_GUARD = 'off'; }
};

test('admit: off → go without asking; a refusal holds, is logged once, then goes ahead after ADMIT_MAX_MS; a later ok clears the wait', withGuard(async () => {
  const c = checkout();
  process.env.PRODUCER_RUNNER_RES_GUARD = 'off';
  assert.equal(ed.admit(c.ctx, c.root, 'the writer spawn'), true);
  process.env.PRODUCER_RUNNER_RES_GUARD = GUARD;
  verdict({ ok: false, reasons: ['3 Cocos editors open (max 2)'] });
  assert.equal(ed.admit(c.ctx, c.root, 'the writer spawn'), false);
  assert.equal(ed.admit(c.ctx, c.root, 'the writer spawn'), false);
  assert.deepEqual(guardCalls()[0], ['gate', 'lane', '--project', c.root, '--free', '--json']);
  assert.ok(st.readSliceState(c.root, 'S01').admit_wait_since);
  assert.equal(c.sliceLog().match(/res-guard holds the writer spawn: 3 Cocos editors open \(max 2\)/g).length, 1);
  await new Promise((r) => setTimeout(r, 350));
  assert.equal(ed.admit(c.ctx, c.root, 'the writer spawn'), true);
  assert.match(c.sliceLog(), /res-guard: the writer spawn goes ahead after 0 min \(still: 3 Cocos editors open/);
  assert.equal(st.readSliceState(c.root, 'S01').admit_wait_since, null);
  // held again, then admitted: the wait is closed with its length
  assert.equal(ed.admit(c.ctx, c.root, 'the reviewer spawn'), false);
  verdict({ ok: true });
  assert.equal(ed.admit(c.ctx, c.root, 'the reviewer spawn'), true);
  assert.match(c.sliceLog(), /res-guard admitted the reviewer spawn after 0 min/);
  // a guard that answers nonsense never holds a slice
  verdict('not json');
  assert.equal(ed.admit(c.ctx, c.root, 'the writer spawn'), true);
}));

test('closeMain: closes main\'s Creator through close-editor.sh once a fleet worktree exists; nothing when it is not open', withGuard(async () => {
  const c = checkout();
  verdict({ ok: true });
  ed.closeMain(c.ctx, '/tmp/wt/s01-feature');
  assert.deepEqual(c.editorLog(), []); // no Creator on main: nothing to close
  startCreator(c.root);
  await until(() => pgrep(c.root));
  ed.closeMain(c.ctx, '/tmp/wt/s01-feature');
  assert.deepEqual(c.editorLog(), [`close ${c.root}`]);
  await until(() => !pgrep(c.root));
  assert.match(c.sliceLog(), /closed main's editor: the fleet works in s01-feature/);
  process.env.PRODUCER_RUNNER_RES_GUARD = 'off';
  startCreator(c.root);
  await until(() => pgrep(c.root));
  ed.closeMain(c.ctx, '/tmp/wt/s01-feature'); // guard off: the runner leaves editors alone
  assert.ok(pgrep(c.root));
  spawnSync('pkill', ['-f', `CocosCreator --project ${c.root}`]);
}));

test('ensureEditor: reopens main\'s Creator (open-editor.sh + wait-mcp) behind the editor gate; up already → nothing; held → false', withGuard(async () => {
  const c = checkout();
  verdict({ ok: false, reasons: ['memory pressure is critical'] });
  assert.equal(ed.ensureEditor(c.ctx, 'spawn-writer'), false);
  assert.deepEqual(guardCalls()[0], ['gate', 'editor', '--project', c.root, '--free', '--json']);
  assert.deepEqual(c.editorLog(), []);
  verdict({ ok: true });
  assert.equal(ed.ensureEditor(c.ctx, 'spawn-writer'), true);
  await until(() => pgrep(c.root));
  assert.deepEqual(c.editorLog(), [`open ${c.root}`]);
  assert.match(fs.readFileSync(path.join(FAKE, 'boot.log'), 'utf8'), new RegExp(`wait-mcp --path ${c.root} --timeout-ms 180000 --json`));
  assert.match(c.sliceLog(), /reopened main's editor for spawn-writer \(wait-mcp ok\)/);
  const calls = guardCalls().length;
  assert.equal(ed.ensureEditor(c.ctx, 'review'), true); // up: no gate, no second open
  assert.equal(guardCalls().length, calls);
  assert.deepEqual(c.editorLog(), [`open ${c.root}`]);
  spawnSync('pkill', ['-f', `CocosCreator --project ${c.root}`]);
}));

test('runner: a held writer spawn waits (no terminal), then goes ahead after ADMIT_MAX_MS and the slice runs as before', withGuard(async () => {
  const p = project({ slices: { S01: { needs: false } } });
  const f = fakes();
  const H = evRel('S01', 'HANDOFF.json');
  verdict({ ok: false, reasons: ['available memory 12% < 15%'] });
  f.queue([
    { name: 'writer ready', write: {
      [H]: { role: 'writer', status: 'ready_for_review', detail: 'd', sha: null },
      [evRel('S01', 'preview-startup.json')]: { projectPath: '/p', previewUrl: 'http://127.0.0.1:7461/', status: 'ready' },
    } },
    { name: 'review approved', write: { [H]: { role: 'reviewer', status: 'approved' }, ...approvedEvidence('S01') } },
    commitStep('S01'),
  ]);
  const out = runner(p.root, f, 'start', '--once', { env: { PRODUCER_RUNNER_RES_GUARD: GUARD, PRODUCER_RUNNER_ADMIT_MAX_MS: '300' } }).out;
  assert.deepEqual(out.find((o) => o.merged), { merged: 'S01', commit: lastCommit(f) });
  const log = fs.readFileSync(ev(p.root, 'S01', 'producer-log.md'), 'utf8');
  assert.ok(log.indexOf('res-guard holds the writer spawn: available memory 12% < 15%') < log.indexOf('spawned writer'));
  assert.match(log, /res-guard: the writer spawn goes ahead after 0 min/);
  assert.match(log, /res-guard holds the reviewer spawn/);
  assert.ok(guardCalls().every((a) => a[0] === 'gate' && a[1] === 'lane' && a[3] === p.root));
  assert.equal(f.spawns().length, 2);
}));
