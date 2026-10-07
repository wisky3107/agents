import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseClock, parseMem, parseSwap, projectArg, label, parseSnapshot } from '../probe.mjs';
import { DEFAULTS, mergeConfig, gate, alerts, dueAlerts, omnirouteAction, reapPlan } from '../policy.mjs';
import { lifecyclePlan, runnerInfo, primaryOf } from '../lifecycle.mjs';

const CLI = new URL('../res-guard.mjs', import.meta.url).pathname;
const tmp = (p) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));
const MIN = 60;

// ------------------------------------------------------------------ fixture snapshot

const CC = '/Applications/Cocos/Creator/3.8.8/CocosCreator.app';
const psRow = (pid, ppid, rssKB, etime, time, tty, cmd) => `${pid} ${ppid} ${rssKB} ${etime} ${time} ${tty} ${cmd}`;
const RAW = {
  at: '2026-10-07T15:00:00.000Z',
  ps: [
    psRow(99101, 1, 600000, '01:02:03', '5:00.00', '??', `${CC}/Contents/MacOS/CocosCreator --project /games/cc-a --nologin`),
    psRow(99102, 99101, 400000, '01:02:00', '1:00.00', '??', `${CC}/Contents/Frameworks/CocosCreator Helper (Renderer).app/Contents/MacOS/CocosCreator Helper (Renderer) --type=renderer`),
    psRow(99103, 1, 500000, '20:00', '0:10.00', '??', `${CC}/Contents/MacOS/CocosCreator --project /wt/cc-a/s03-x`),
    psRow(99201, 99200, 200000, '45:00', '0:30.00', '??', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --disable-field-trial-config --remote-debugging-pipe --user-data-dir=/tmp/playwright_chromiumdev_profile-x'),
    psRow(99202, 99201, 150000, '44:59', '0:20.00', '??', '/Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Versions/1/Helpers/Google Chrome Helper (GPU).app/Contents/MacOS/Google Chrome Helper (GPU) --type=gpu-process --user-data-dir=/tmp/playwright_chromiumdev_profile-x'),
    psRow(99300, 1, 14000, '05:00', '0:01.00', '??', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
    psRow(99401, 99400, 300000, '30:00', '1:00.00', 'ttys001', 'claude --dangerously-skip-permissions'),
    psRow(99402, 1, 60000, '3-01:00:00', '0:05.00', '??', '/Users/u/.local/share/claude/versions/2.1.292'),
    psRow(99501, 99500, 700000, '2:00:00', '3:00.00', 'ttys002', 'omniroute (v16.3.5)'),
    psRow(99500, 99499, 80000, '2:00:00', '0:10.00', 'ttys002', 'node /Users/u/.local/bin/omniroute'),
    psRow(99600, 1, 300000, '2:00:00', '1:00.00', '??', '/Applications/Orca.app/Contents/MacOS/Orca'),
  ].join('\n'),
  top: 'Processes: 700 total\n\nPID    MEM\n99101  1005M\n99102  1.2G\n99501  1600M\n99401  250M+\n99600  2176K\n',
  sysctl: 'hw.memsize: 17179869184\nkern.memorystatus_level: 38\nkern.memorystatus_vm_pressure_level: 2\nvm.swapusage: total = 5120.00M  used = 4608.25M  free = 511.75M  (encrypted)\n',
  vmstat: 'Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages wired down:                             141525.\nPages occupied by compressor:                 241833.\n',
  df: 'Filesystem 1024-blocks Used Available Capacity iused ifree %iused Mounted on\n/dev/disk3s1 482797652 406000000 18874368 96% 4000000 500000000 1% /System/Volumes/Data\n',
};

test('parsers: ps clocks, top MEM units, swap, --project, labels', () => {
  assert.equal(parseClock('05:07'), 307);
  assert.equal(parseClock('01:02:03'), 3723);
  assert.equal(parseClock('3-01:00:00'), 3 * 86400 + 3600);
  assert.equal(parseClock('1:38.74'), 98.74);
  assert.deepEqual(['1005M', '2176K', '1.5G', '0B', '250M+'].map(parseMem), [1005, 2.125, 1536, 0, 250]);
  assert.deepEqual(parseSwap('total = 1024.00M  used = 692.25M  free = 331.75M  (encrypted)'), { totalMB: 1024, usedMB: 692.25 });
  assert.equal(projectArg(`${CC}/Contents/MacOS/CocosCreator --project /games/My Game --nologin`), '/games/My Game');
  assert.equal(projectArg(`${CC}/Contents/MacOS/CocosCreator --project /games/cc-a`), '/games/cc-a');
  assert.equal(label(`${CC}/Contents/Frameworks/CocosCreator Helper (Renderer).app/Contents/MacOS/CocosCreator Helper (Renderer) --type=renderer`), 'CocosCreator Helper (Renderer)');
  assert.equal(label('node /Users/u/.local/bin/omniroute'), 'node omniroute');
  assert.equal(label('omniroute (v16.3.5)'), 'omniroute');
});

test('parseSnapshot: memory numbers, editors with their helpers, the Playwright browser root only, claude, OmniRoute', () => {
  const s = parseSnapshot(RAW);
  assert.deepEqual([s.memTotalMB, s.availPct, s.pressure, s.swapUsedMB, s.swapTotalMB, s.diskFreeGB], [16384, 38, 'warn', 4608, 5120, 18]);
  assert.equal(s.compressorMB, Math.round(241833 * 16384 / 1048576));
  assert.deepEqual(s.editors.map((e) => [e.pid, e.project, e.agentOwned]), [[99101, '/games/cc-a', true], [99103, '/wt/cc-a/s03-x', false]]);
  assert.equal(s.editors[0].footMB, 1005 + 1229); // main + helper footprints (1.2G → 1228.8)
  assert.deepEqual(s.smoke.map((b) => [b.pid, b.etimeSec]), [[99201, 45 * MIN]]); // the GPU helper is part of it; plain Chrome is not
  assert.deepEqual(s.claude.map((c) => [c.pid, c.ppid, c.tty]), [[99401, 99400, 'ttys001'], [99402, 1, '??']]);
  assert.deepEqual(s.omniroute, { pid: 99501, supervisorPid: 99500, rssMB: 684, footMB: 1600 });
  assert.equal(s.top[0].name, 'omniroute');
});

test('gate: caps editors (the caller\'s own editor is free), smoke browsers, memory, swap, disk; config overrides merge', () => {
  const s = parseSnapshot(RAW);
  const cfg = mergeConfig(DEFAULTS, { minDiskGB: 10, maxSwapMB: { editor: 8192 } });
  assert.equal(cfg.maxSwapMB.lane, 6144); // untouched siblings survive the merge
  assert.deepEqual(gate(s, 'editor', cfg, { project: '/games/cc-b' }).reasons, ['2 Cocos editors open (max 2)']);
  assert.deepEqual(gate(s, 'editor', cfg, { project: '/games/cc-a' }), { ok: true, reasons: [] });
  assert.deepEqual(gate(s, 'smoke', cfg).reasons, ['1 smoke browser(s) running (max 1)']);
  const tight = { ...s, pressure: 'critical', availPct: 10, swapUsedMB: 9000, diskFreeGB: 5, editors: [], smoke: [] };
  assert.deepEqual(gate(tight, 'lane', cfg).reasons, ['memory pressure is critical', 'available memory 10% < 15%', 'swap 9000 MB > 6144 MB', 'disk free 5 GB < 10 GB']);
});

test('alerts: keyed states with a cooldown; a cleared state re-arms', () => {
  const s = parseSnapshot(RAW);
  const rows = alerts(s, DEFAULTS);
  assert.deepEqual(rows.map((r) => [r.key, r.level]), [['swap:high', 'warning'], ['disk:low', 'warning']]);
  const t0 = Date.parse('2026-10-07T15:00:00Z');
  const a = dueAlerts(rows, {}, DEFAULTS, t0);
  assert.equal(a.due.length, 2);
  assert.equal(dueAlerts(rows, a.sent, DEFAULTS, t0 + 10 * 60000).due.length, 0);
  assert.equal(dueAlerts(rows, a.sent, DEFAULTS, t0 + 31 * 60000).due.length, 2);
  const cleared = dueAlerts([rows[0]], a.sent, DEFAULTS, t0 + 60000);
  assert.deepEqual(Object.keys(cleared.sent), ['swap:high']);
  assert.equal(dueAlerts(rows, cleared.sent, DEFAULTS, t0 + 120000).due.map((r) => r.key).join(), 'disk:low');
});

test('omnirouteAction: restart past restartMB once idle for idleTicks, at once past hardMB, never twice within minGapMin', () => {
  const s = parseSnapshot(RAW); // 1600 MB
  const t = Date.parse('2026-10-07T15:00:00Z');
  let r = omnirouteAction(s, DEFAULTS, {}, { clients: 3, now: t });
  assert.equal(r.action, null);
  r = omnirouteAction(s, DEFAULTS, r.state, { clients: 0, now: t });
  assert.equal(r.action, null); // idle 1 of 2
  r = omnirouteAction(s, DEFAULTS, r.state, { clients: 0, now: t });
  assert.match(r.action.why, /idle 2 ticks/);
  const big = { ...s, omniroute: { ...s.omniroute, footMB: 3500 } };
  assert.match(omnirouteAction(big, DEFAULTS, {}, { clients: 5, now: t }).action.why, /hard limit/);
  assert.equal(omnirouteAction(big, DEFAULTS, { lastRestart: new Date(t - 10 * 60000).toISOString() }, { clients: 0, now: t }).action, null);
  assert.equal(omnirouteAction({ ...s, omniroute: { ...s.omniroute, footMB: 900 } }, DEFAULTS, { idle: 9 }, { now: t }).action, null);
});

test('reapPlan: an editor on a deleted checkout, a Playwright browser past smokeMaxMin, an orphan claude idle past orphanClaudeIdleMin', () => {
  const s = parseSnapshot(RAW);
  const t = Date.parse('2026-10-07T15:00:00Z');
  const exists = (p) => p !== '/wt/cc-a/s03-x';
  let r = reapPlan(s, DEFAULTS, { exists, now: t });
  assert.deepEqual(r.kills.map((k) => [k.family, k.pid]), [['editor', 99103], ['smoke', 99201]]);
  assert.deepEqual(Object.keys(r.cpu), ['99402']); // only the orphan (ppid 1, no tty) is tracked
  r = reapPlan(s, DEFAULTS, { exists, cpu: r.cpu, now: t + 119 * 60000 });
  assert.ok(!r.kills.some((k) => k.family === 'claude'));
  r = reapPlan(s, DEFAULTS, { exists, cpu: r.cpu, now: t + 121 * 60000 });
  assert.match(r.kills.find((k) => k.family === 'claude').why, /no CPU for 121 min/);
  // CPU moved: the idle clock restarts
  const busy = { ...s, claude: s.claude.map((c) => (c.pid === 99402 ? { ...c, cpuSec: c.cpuSec + 5 } : c)) };
  assert.ok(!reapPlan(busy, DEFAULTS, { exists, cpu: r.cpu, now: t + 200 * 60000 }).kills.some((k) => k.family === 'claude'));
});

test('lifecyclePlan: the rule order — runner use, lane agents, grace, primary waits, clients, idle', () => {
  const t = Date.parse('2026-10-07T15:00:00Z');
  const E = (pid, project, etimeSec, agentOwned = true) => ({ pid, project, etimeSec, agentOwned, footMB: 2000 });
  const s = {
    editors: [E(1, '/gone', 3600), E(2, '/keep', 3600), E(3, '/hand', 3600, false), E(4, '/p', 3600), E(5, '/p/wt-s03', 3600),
      E(6, '/q', 3600), E(7, '/r', 120), E(8, '/s', 3600), E(9, '/t', 3600), E(10, '/u', 3600), E(11, '/v', 3600), E(12, '/w', 3600),
      E(13, '/x', 3600), E(14, '/y', 3600)],
  };
  const fleet = { live: true, lane: 'fleet', phase: 'fleet', slice: 'S03', worktree: '/p/wt-s03' };
  const facts = new Map([
    [1, { exists: false }],
    [4, { isWorktree: false, runner: fleet }],
    [5, { isWorktree: true, runner: fleet }],
    [6, { laneUsers: [{ pid: 50, role: 'worker', slice: 'S07' }] }],
    [7, { isWorktree: false, worktreeLanes: [{ pid: 51, role: 'worker', project: '/r/s01' }] }],
    [8, { isWorktree: false, worktreeLanes: [{ pid: 52, role: 'worker', slice: 'S01', project: '/s/s01-x' }], clients: 2 }],
    [9, { clients: 1 }],
    [10, {}],
    [11, { cwdUsers: [{ pid: 53 }] }],
    [12, { isWorktree: false, runner: { live: true, lane: 'fleet', phase: 'merge', slice: 'S02' } }],
    [13, { isWorktree: false, runner: { live: true, reopens: false, lane: 'single', phase: 'writer', slice: 'S04' } }],
    [14, { isWorktree: false, runner: { live: true, reopens: true, lane: 'single', phase: 'done', slice: 'S04' } }],
  ]);
  const cfg = mergeConfig(DEFAULTS, { editors: { keep: ['/keep'] } });
  const { verdicts, closes, seen } = lifecyclePlan(s, cfg, facts, { seen: { 11: new Date(t - 5 * 60000).toISOString() }, now: t });
  const by = Object.fromEntries(verdicts.map((v) => [v.pid, `${v.verdict}: ${v.why}`]));
  assert.match(by[1], /^gone/);
  assert.match(by[2], /^keep: listed in config/);
  assert.match(by[3], /^keep: opened by hand/);
  assert.match(by[4], /^close: primary waits: runner S03 fleet works in wt-s03/);
  assert.match(by[5], /^keep: runner S03 fleet works in this worktree/);
  assert.match(by[6], /^keep: in use: worker S07 \(pid 50\)/);
  assert.match(by[7], /^keep: opened 2 min ago \(grace 10 min\)/); // grace beats "primary waits"
  assert.match(by[8], /^close: primary waits: worker S01 \(pid 52\) works in s01-x/); // primary rule beats clients
  assert.match(by[9], /^keep: 1 client connection/);
  assert.match(by[10], /^close: idle 60 min/);
  assert.match(by[11], /^keep: idle 5 min \(closes at 20\); 1 session\(s\) sit in the checkout/);
  assert.match(by[12], /^keep: runner S02 merge step manages main's editor/);
  assert.match(by[13], /^keep: the live runner \(older code\) uses main next/); // it would not reopen a closed main
  assert.match(by[14], /^close: idle 60 min/); // this runner reopens main before its next single lane
  assert.deepEqual(closes.map((c) => c.pid), [4, 8, 10, 14]);
  assert.equal(seen[9], new Date(t).toISOString()); // used now
  assert.equal(seen[10], new Date(t - 3600 * 1000).toISOString()); // never used: since it started
});

test('primaryOf + runnerInfo: a linked worktree points at its primary; a live fleet runner names its slice worktree', () => {
  const root = tmp('rg-primary-');
  const g = (...a) => spawnSync('git', ['-C', root, ...a], { encoding: 'utf8' });
  g('init', '-q');
  g('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-qm', 'init');
  const wt = path.join(tmp('rg-wts-'), 's03-engine');
  g('worktree', 'add', '-q', '-b', 's03-engine', wt);
  assert.deepEqual(primaryOf(wt), { primary: root, isWorktree: true });
  assert.deepEqual(primaryOf(root), { primary: root, isWorktree: false });
  assert.deepEqual(runnerInfo(root), { live: false, reopens: false });
  const cur = path.join(root, '.cursor');
  fs.mkdirSync(path.join(cur, 'evidence', 'tasks', 'T-S03'), { recursive: true });
  fs.writeFileSync(path.join(cur, 'producer-runner.json'), JSON.stringify({ slice: 'S03', step: 'lane', questions: [] }));
  fs.writeFileSync(path.join(cur, 'producer.lock'), JSON.stringify({ pid: process.pid, host: os.hostname() }));
  fs.writeFileSync(path.join(cur, 'evidence', 'tasks', 'T-S03', 'producer-state.json'), JSON.stringify({ phase: 'fleet', coordinator: 'term_1' }));
  // no `worktree` recorded yet: found by the slice token in the folder name, like the runner does
  assert.deepEqual(runnerInfo(root), { live: true, reopens: false, slice: 'S03', step: 'lane', phase: 'fleet', lane: 'fleet', worktree: fs.realpathSync(wt) });
  fs.writeFileSync(path.join(cur, 'producer.lock'), JSON.stringify({ pid: process.pid, host: os.hostname(), reopens_editor: true }));
  assert.equal(runnerInfo(root).reopens, true);
  fs.writeFileSync(path.join(cur, 'producer.lock'), JSON.stringify({ pid: 999999, host: os.hostname() }));
  assert.equal(runnerInfo(root).live, false);
});

// ------------------------------------------------------------------ CLI

const cli = (args, env = {}) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', timeout: 60000, env: { ...process.env, RES_GUARD_NOTIFY: '0', ...env } });

test('CLI on a fixture snapshot: status --json, gate exit codes, a dry tick writes a sample, events and the live alert rows', () => {
  const home = tmp('rg-home-');
  const raw = path.join(home, 'raw.json');
  // high pids that are not running: lsof / ps -E find nothing for them
  fs.writeFileSync(raw, JSON.stringify({ ...RAW, at: new Date().toISOString() }));
  const env = { RES_GUARD_HOME: home, RES_GUARD_RAW: raw };
  const s = JSON.parse(cli(['status', '--json'], env).stdout);
  assert.equal(s.editors.length, 2);
  assert.equal(s.procs, undefined);
  let r = cli(['gate', 'editor', '--project', '/games/cc-b', '--json'], env);
  assert.equal(r.status, 75);
  assert.deepEqual(JSON.parse(r.stdout).reasons, ['swap 4608 MB > 4096 MB', '2 Cocos editors open (max 2)']);
  r = cli(['gate', 'lane', '--project', '/games/cc-a'], env);
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), 'go');
  r = cli(['tick', '--dry-run'], env);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /alerts: swap:high, disk:low/);
  const day = new Date().toISOString().slice(0, 10);
  const sample = JSON.parse(fs.readFileSync(path.join(home, 'logs', 'res-guard', `samples-${day}.jsonl`), 'utf8').trim());
  assert.equal(sample.claude.n, 2);
  const events = fs.readFileSync(path.join(home, 'logs', 'res-guard.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(events.map((e) => e.kind), ['gate_deny', 'alert', 'alert', 'reap', 'reap', 'reap']);
  assert.deepEqual(events.filter((e) => e.kind === 'reap').map((e) => e.family), ['editor', 'editor', 'smoke']); // the fixture's checkouts do not exist here
  assert.ok(events.filter((e) => e.kind === 'reap').every((e) => e.result === 'dry-run'));
  const state = JSON.parse(fs.readFileSync(path.join(home, 'run', 'res-guard', 'state.json'), 'utf8'));
  assert.deepEqual(state.alerts.map((a) => a.key), ['swap:high', 'disk:low']);
  // a second tick inside the cooldown sends nothing new
  cli(['tick', '--dry-run'], env);
  assert.equal(fs.readFileSync(path.join(home, 'logs', 'res-guard.jsonl'), 'utf8').trim().split('\n').filter((l) => l.includes('"alert"')).length, 2);
});

test('CLI on the live machine: editors shows a fake agent-owned Creator; close-editor closes it through close-editor.sh', async () => {
  const fake = tmp('rg-creator-');
  const bin = path.join(fake, 'CocosCreator.app', 'Contents', 'MacOS', 'CocosCreator');
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  fs.writeFileSync(bin, '#!/bin/sh\ntrap \'kill $! 2>/dev/null; exit 0\' TERM\nsleep 60 &\nwait\n', { mode: 0o755 });
  const proj = tmp('rg-proj-');
  fs.mkdirSync(path.join(proj, 'scripts'));
  fs.writeFileSync(path.join(proj, 'scripts', 'close-editor.sh'), `#!/bin/bash\necho "close $1" >> ${proj}/editor.log\npkill -f "CocosCreator.app/Contents/MacOS/CocosCreator --project $1( |$)"\n`);
  // double fork, so launchd reaps it like a real editor (this process blocks in spawnSync meanwhile)
  spawnSync('/bin/sh', ['-c', `nohup "${bin}" --project "${proj}" --nologin >/dev/null 2>&1 &`]);
  const up = () => spawnSync('pgrep', ['-f', `CocosCreator.app/Contents/MacOS/CocosCreator --project ${proj}( |$)`]).status === 0;
  for (let i = 0; i < 100 && !up(); i++) await new Promise((r) => setTimeout(r, 50));
  const home = tmp('rg-home-');
  const v = JSON.parse(cli(['editors', '--json'], { RES_GUARD_HOME: home }).stdout).find((x) => x.project === proj);
  assert.equal(v.verdict, 'keep');
  assert.match(v.why, /opened 0 min ago \(grace 10 min\)/);
  const r = cli(['close-editor', '--project', proj, '--reason', 'test'], { RES_GUARD_HOME: home });
  assert.match(r.stdout, /^closed \(close-editor.sh\): editor \d+ on /);
  assert.equal(fs.readFileSync(path.join(proj, 'editor.log'), 'utf8').trim(), `close ${proj}`);
  assert.ok(!up());
  assert.match(fs.readFileSync(path.join(home, 'logs', 'res-guard.jsonl'), 'utf8'), /"kind":"editor_close".*"why":"test"/);
});
