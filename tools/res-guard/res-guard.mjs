#!/usr/bin/env node
/**
 * Resource guard for agent sessions + Cocos editors on a 16 GB Mac.
 *
 *   node res-guard.mjs status [--json]                    # memory, swap, disk, editors, smoke, claude, OmniRoute
 *   node res-guard.mjs gate <editor|lane|smoke> [--project <checkout>] [--free] [--wait] [--max-wait <sec>] [--json]
 *                                                         # exit 0 = go; 75 = not now. --free closes waiting
 *                                                         # editors once before saying no; --wait polls, then
 *                                                         # gives up after --max-wait and lets the caller through.
 *   node res-guard.mjs tick [--dry-run]                   # one watcher pass (launchd, every 60 s): sample log,
 *                                                         # alerts, reaper, editor lifecycle, OmniRoute restart
 *   node res-guard.mjs editors [--json]                   # each editor: checkout, users, the lifecycle verdict
 *   node res-guard.mjs close-editor --project <checkout> [--reason <text>] [--if-unused]
 *   node res-guard.mjs reap [--dry-run]
 *   node res-guard.mjs install-launchd | uninstall-launchd
 *
 * probe.mjs reads the machine, policy.mjs decides, lifecycle.mjs judges editors; this file executes.
 * Files: config ~/.agents/run/res-guard/config.json (overrides policy.DEFAULTS), state
 * ~/.agents/run/res-guard/state.json, events ~/.agents/logs/res-guard.jsonl, one sample per tick in
 * ~/.agents/logs/res-guard/samples-<day>.jsonl. RES_GUARD_HOME moves all of them (tests).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { rawSnapshot, parseSnapshot } from './probe.mjs';
import { DEFAULTS, mergeConfig, gate, alerts, dueAlerts, omnirouteAction, reapPlan, gb, short } from './policy.mjs';
import { editorFacts, lifecyclePlan, closeEditor } from './lifecycle.mjs';

const HOME = process.env.RES_GUARD_HOME || path.join(os.homedir(), '.agents');
const RUN_DIR = path.join(HOME, 'run', 'res-guard');
const LOG_DIR = path.join(HOME, 'logs', 'res-guard');
const EVENTS = path.join(HOME, 'logs', 'res-guard.jsonl');
const STATE = path.join(RUN_DIR, 'state.json');
const CONFIG = path.join(RUN_DIR, 'config.json');
const LABEL = 'com.agents.res-guard';
const PLIST = path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
export const EX_TEMPFAIL = 75;

const readJson = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } };
const config = () => mergeConfig(DEFAULTS, readJson(CONFIG, {}));
const loadState = () => readJson(STATE, {});
function saveState(st) {
  fs.mkdirSync(RUN_DIR, { recursive: true });
  const tmp = `${STATE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(st, null, 2)}\n`);
  fs.renameSync(tmp, STATE);
}
export function event(row) {
  fs.mkdirSync(path.dirname(EVENTS), { recursive: true });
  fs.appendFileSync(EVENTS, `${JSON.stringify({ at: new Date().toISOString(), ...row })}\n`);
}

function notify(title, body, level = 'warning') {
  if (process.env.RES_GUARD_NOTIFY === '0') return;
  if (process.env.RES_GUARD_NOTIFY_CMD) {
    spawnSync(process.env.RES_GUARD_NOTIFY_CMD, [title, body, level], { stdio: 'ignore', timeout: 10000 });
    return;
  }
  const sound = level === 'critical' ? ' sound name "Basso"' : '';
  spawnSync('osascript', ['-e', `display notification ${JSON.stringify(body)} with title ${JSON.stringify(`Res guard · ${title}`)}${sound}`], { stdio: 'ignore', timeout: 10000 });
}

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** SIGTERM, then SIGKILL after `graceMs` if it is still there. */
export async function kill(pid, graceMs = 10000) {
  if (!alive(pid)) return 'gone';
  try { process.kill(pid, 'SIGTERM'); } catch { return 'gone'; }
  for (let t = 0; t < graceMs; t += 500) { await sleep(500); if (!alive(pid)) return 'terminated'; }
  try { process.kill(pid, 'SIGKILL'); } catch { /* exited meanwhile */ }
  return 'killed';
}

function snapshot(withTop = true) {
  return parseSnapshot(rawSnapshot({ withTop }));
}

/** The snapshot as logged: the full process table stays out. */
function slim(s) {
  const { procs, ...rest } = s;
  return { ...rest, claude: { n: s.claude.length, footMB: s.claude.reduce((a, c) => a + c.footMB, 0) } };
}

// ------------------------------------------------------------------ OmniRoute

/** Connections from other processes into OmniRoute's port. */
function omniClients(port, serverPid) {
  const r = spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:ESTABLISHED', '-Fp'], { encoding: 'utf8', timeout: 10000 });
  const pids = new Set((r.stdout || '').split('\n').filter((l) => l.startsWith('p')).map((l) => Number(l.slice(1))));
  pids.delete(serverPid);
  return pids.size;
}

async function restartOmniroute(s, cfg, why, dry) {
  event({ kind: 'omniroute_restart', why, footMB: s.omniroute.footMB, dry });
  if (dry) return;
  notify('Restarting OmniRoute', why);
  const bin = process.env.RES_GUARD_OMNIROUTE_BIN || path.join(os.homedir(), '.local', 'bin', 'omniroute');
  spawnSync(bin, ['stop'], { stdio: 'ignore', timeout: 30000 });
  for (const pid of [s.omniroute.pid, s.omniroute.supervisorPid].filter(Boolean)) if (alive(pid)) await kill(pid, 5000);
  fs.mkdirSync(path.join(HOME, 'logs'), { recursive: true });
  const out = fs.openSync(path.join(HOME, 'logs', 'omniroute.out'), 'a');
  // same command the director starts by hand (`omniroute` = serve), detached from this tick
  const child = spawn(process.execPath, [bin], { cwd: os.homedir(), detached: true, stdio: ['ignore', out, out] });
  child.unref();
  for (let t = 0; t < 60; t += 2) {
    await sleep(2000);
    const r = spawnSync('curl', ['-s', '-m', '2', '-o', '/dev/null', '-w', '%{http_code}', `http://127.0.0.1:${cfg.omniroute.port}/api/health`], { encoding: 'utf8' });
    if (r.stdout === '200') { event({ kind: 'omniroute_up', pid: child.pid, after_s: t + 2 }); return; }
  }
  event({ kind: 'omniroute_down', pid: child.pid });
  notify('OmniRoute did not come back', `no /api/health 200 after 60 s; see ${path.join(HOME, 'logs', 'omniroute.out')}`, 'critical');
}

// ------------------------------------------------------------------ passes

async function reap(s, cfg, st, dry) {
  const { kills, cpu } = reapPlan(s, cfg, { exists: fs.existsSync, cpu: st.cpu || {} });
  st.cpu = cpu;
  for (const k of kills) {
    const result = dry ? 'dry-run' : await kill(k.pid);
    event({ kind: 'reap', ...k, result });
    if (!dry) notify(`Reaped ${k.family} ${k.pid}`, `${k.why}${k.project ? ` (${short(k.project)})` : ''}`);
  }
  return kills;
}

async function lifecycle(s, cfg, st, dry, only) {
  const facts = editorFacts(s);
  const { closes, seen, verdicts } = lifecyclePlan(s, cfg, facts, { seen: st.editorsSeen || {} });
  st.editorsSeen = seen;
  st.editorVerdicts = verdicts; // the director console shows these
  const done = [];
  for (const c of closes) {
    if (only && !only(c)) continue;
    const result = dry ? 'dry-run' : await closeEditor(c, kill);
    event({ kind: 'editor_close', pid: c.pid, project: c.project, why: c.why, result });
    if (!dry) notify(`Closed editor ${short(c.project)}`, c.why, 'info');
    done.push({ ...c, result });
  }
  return done;
}

function pruneSamples(cfg) {
  if (!fs.existsSync(LOG_DIR)) return;
  const cutoff = Date.now() - cfg.samples.keepDays * 86400000;
  for (const f of fs.readdirSync(LOG_DIR)) {
    const m = /^samples-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(f);
    if (m && Date.parse(m[1]) < cutoff) fs.rmSync(path.join(LOG_DIR, f));
  }
}

async function tick(dry) {
  const cfg = config();
  const st = loadState();
  const s = snapshot(true);
  fs.mkdirSync(LOG_DIR, { recursive: true });
  fs.appendFileSync(path.join(LOG_DIR, `samples-${s.at.slice(0, 10)}.jsonl`), `${JSON.stringify(slim(s))}\n`);

  const rows = alerts(s, cfg);
  const { due, sent } = dueAlerts(rows, st.alertsSent, cfg);
  st.alertsSent = sent;
  st.alerts = rows; // the director console reads the live rows from here
  for (const a of due) { event({ kind: 'alert', ...a }); if (!dry) notify(a.title, a.body, a.level); }

  await reap(s, cfg, st, dry);
  await lifecycle(s, cfg, st, dry);

  const clients = s.omniroute?.pid ? omniClients(cfg.omniroute.port, s.omniroute.pid) : 0;
  const om = omnirouteAction(s, cfg, st.omniroute, { clients });
  st.omniroute = om.state;
  if (om.action) {
    st.omniroute.lastRestart = new Date().toISOString();
    await restartOmniroute(s, cfg, om.action.why, dry);
  }
  st.lastTick = s.at;
  st.last = slim(s);
  saveState(st);
  if (new Date().getMinutes() === 0) pruneSamples(cfg);
  return { s, rows, due };
}

/**
 * `free`: on a denial, close the editors that only wait (never the caller's own) and look again —
 * once per call. `wait`: poll until admitted or `maxWait`, then let the caller through. The runner
 * calls `--free` without `--wait` and re-asks each idle tick, so stop/pause still reach it.
 */
async function runGate(kind, { project, wait, free, maxWait, json }) {
  const cfg = config();
  const started = Date.now();
  const limit = (maxWait ?? cfg.gate.maxWaitSec) * 1000;
  let freed = !(free || wait);
  for (;;) {
    const s = snapshot(false);
    const g = gate(s, kind, cfg, { project });
    if (g.ok) {
      if (Date.now() - started > 1000) event({ kind: 'gate_pass', gate: kind, project, waited_s: Math.round((Date.now() - started) / 1000) });
      return out({ ok: true, gate: kind, waited_s: Math.round((Date.now() - started) / 1000) }, 0);
    }
    if (!freed) {
      freed = true;
      const st = loadState();
      const closed = await lifecycle(s, cfg, st, false, (c) => !project || path.resolve(c.project) !== project);
      saveState(st);
      if (closed.length) { event({ kind: 'gate_freed', gate: kind, project, reasons: g.reasons, closed: closed.map((c) => c.project) }); continue; }
    }
    if (!wait) {
      event({ kind: 'gate_deny', gate: kind, project, reasons: g.reasons });
      return out({ ok: false, gate: kind, reasons: g.reasons }, EX_TEMPFAIL);
    }
    if (Date.now() - started >= limit) {
      event({ kind: 'gate_timeout', gate: kind, project, reasons: g.reasons });
      notify(`Gate ${kind}: proceeding after ${Math.round(limit / 60000)} min`, g.reasons.join('; '));
      return out({ ok: true, gate: kind, timedOut: true, reasons: g.reasons }, 0);
    }
    if (!json) process.stderr.write(`res-guard: ${kind} waits — ${g.reasons.join('; ')}\n`);
    await sleep(cfg.gate.pollSec * 1000);
  }
  function out(obj, code) {
    process.stdout.write(json ? `${JSON.stringify(obj)}\n` : `${obj.ok ? 'go' : 'wait'}${obj.timedOut ? ' (timed out)' : ''}${obj.reasons ? ` — ${obj.reasons.join('; ')}` : ''}\n`);
    return code;
  }
}

function printStatus(s, cfg, json) {
  if (json) { process.stdout.write(`${JSON.stringify(slim(s), null, 2)}\n`); return; }
  const lines = [
    `memory  ${s.availPct}% available, pressure ${s.pressure}, compressor ${gb(s.compressorMB)}, wired ${gb(s.wiredMB)} of ${gb(s.memTotalMB)}`,
    `swap    ${gb(s.swapUsedMB)} used`,
    `disk    ${s.diskFreeGB} GB free`,
    `editors ${s.editors.length}/${cfg.maxEditors}${s.editors.map((e) => `\n  pid ${e.pid} ${gb(e.footMB)} ${Math.round(e.etimeSec / 60)} min ${e.project}`).join('')}`,
    `smoke   ${s.smoke.length}/${cfg.maxSmoke}${s.smoke.map((b) => `\n  pid ${b.pid} ${gb(b.footMB)} ${Math.round(b.etimeSec / 60)} min`).join('')}`,
    `claude  ${s.claude.length} sessions, ${gb(s.claude.reduce((a, c) => a + c.footMB, 0))}`,
    `omni    ${s.omniroute?.pid ? `pid ${s.omniroute.pid} ${gb(s.omniroute.footMB)}` : 'not running'}`,
    `orca    ${gb(s.orca.footMB)}`,
    `top     ${s.top.slice(0, 6).map((t) => `${t.name} ${gb(t.footMB)}`).join(', ')}`,
  ];
  process.stdout.write(`${lines.join('\n')}\n`);
}

function plist() {
  const script = new URL(import.meta.url).pathname;
  const out = path.join(os.homedir(), '.agents', 'logs', 'res-guard.log');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${process.execPath}</string>
    <string>--no-warnings</string>
    <string>${script}</string>
    <string>tick</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${path.join(os.homedir(), '.local', 'bin')}:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <!-- res-guard: sample, alert, reap, close waiting Cocos editors, restart a bloated OmniRoute. -->
  <key>RunAtLoad</key><true/>
  <key>StartInterval</key><integer>60</integer>
  <key>Nice</key><integer>5</integer>
  <key>StandardOutPath</key><string>${out}</string>
  <key>StandardErrorPath</key><string>${out}</string>
</dict>
</plist>
`;
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const flag = (name) => rest.includes(name);
  const opt = (name) => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : undefined; };
  const json = flag('--json');
  const dry = flag('--dry-run') || process.env.RES_GUARD_DRY === '1';

  if (cmd === 'status' || !cmd) {
    printStatus(snapshot(true), config(), json);
  } else if (cmd === 'gate') {
    const kind = rest.find((a) => !a.startsWith('--') && a !== opt('--project') && a !== opt('--max-wait'));
    if (!['editor', 'lane', 'smoke'].includes(kind)) throw new Error('usage: res-guard.mjs gate <editor|lane|smoke> [--project <checkout>] [--wait] [--max-wait <sec>]');
    const project = opt('--project') && path.resolve(opt('--project'));
    process.exitCode = await runGate(kind, { project, wait: flag('--wait'), free: flag('--free'), maxWait: opt('--max-wait') && Number(opt('--max-wait')), json });
  } else if (cmd === 'tick') {
    const { rows } = await tick(dry);
    if (process.stdout.isTTY || dry) process.stdout.write(`tick ok${rows.length ? `; alerts: ${rows.map((r) => r.key).join(', ')}` : ''}\n`);
  } else if (cmd === 'editors') {
    const s = snapshot(true);
    const cfg = config();
    const facts = editorFacts(s);
    const { verdicts } = lifecyclePlan(s, cfg, facts, { seen: loadState().editorsSeen || {} });
    if (json) process.stdout.write(`${JSON.stringify(verdicts, null, 2)}\n`);
    else for (const v of verdicts) process.stdout.write(`${v.verdict.padEnd(5)} pid ${v.pid} ${gb(v.footMB)} ${v.project}\n      ${v.why}\n`);
    if (!verdicts.length) process.stdout.write('no Cocos editors open\n');
  } else if (cmd === 'close-editor') {
    const project = opt('--project') && path.resolve(opt('--project'));
    if (!project) throw new Error('usage: res-guard.mjs close-editor --project <checkout> [--reason <text>] [--if-unused]');
    const s = snapshot(false);
    const ed = s.editors.find((e) => e.project && path.resolve(e.project) === project);
    if (!ed) { process.stdout.write(`no editor open on ${project}\n`); return; }
    if (flag('--if-unused')) {
      const f = editorFacts(s).get(ed.pid);
      if (f?.laneUsers.length) { process.stdout.write(`kept: ${f.laneUsers.length} lane agent(s) use ${project}\n`); return; }
    }
    const why = opt('--reason') || 'closed on request';
    const result = dry ? 'dry-run' : await closeEditor({ ...ed, why }, kill);
    event({ kind: 'editor_close', pid: ed.pid, project, why, result });
    process.stdout.write(`${result}: editor ${ed.pid} on ${project}\n`);
  } else if (cmd === 'reap') {
    const st = loadState();
    const kills = await reap(snapshot(false), config(), st, dry);
    saveState(st);
    process.stdout.write(kills.length ? kills.map((k) => `${dry ? 'would kill' : 'killed'} ${k.family} ${k.pid}: ${k.why}`).join('\n') + '\n' : 'nothing to reap\n');
  } else if (cmd === 'install-launchd') {
    fs.mkdirSync(path.dirname(PLIST), { recursive: true });
    fs.writeFileSync(PLIST, plist());
    try { spawnSync('launchctl', ['bootout', `gui/${process.getuid()}`, PLIST], { stdio: 'ignore' }); } catch { /* not loaded */ }
    const r = spawnSync('launchctl', ['bootstrap', `gui/${process.getuid()}`, PLIST], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`launchctl bootstrap failed: ${r.stderr}`);
    process.stdout.write(`installed ${PLIST} (tick every 60 s)\n`);
  } else if (cmd === 'uninstall-launchd') {
    spawnSync('launchctl', ['bootout', `gui/${process.getuid()}`, PLIST], { stdio: 'ignore' });
    fs.rmSync(PLIST, { force: true });
    process.stdout.write(`removed ${PLIST}\n`);
  } else {
    throw new Error(`unknown command "${cmd}" (status | gate | tick | editors | close-editor | reap | install-launchd | uninstall-launchd)`);
  }
}

main().catch((e) => { process.stderr.write(`res-guard: ${e.message}\n`); process.exitCode = 1; });
