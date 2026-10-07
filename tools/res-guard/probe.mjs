/**
 * One snapshot of the machine, in two halves: `rawSnapshot()` runs the macOS tools (ps, top, sysctl,
 * vm_stat, df) and keeps their text; `parseSnapshot(raw)` turns that text into the numbers and the
 * process families the guard decides on. Tests feed `parseSnapshot` fixture text, and
 * RES_GUARD_RAW=<file.json> makes the CLI do the same.
 */
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const run = (cmd, args, timeout = 15000) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout, maxBuffer: 32 * 1024 * 1024 });
  return r.status === 0 ? r.stdout : '';
};

/** `withTop`: footprints (compressed pages included) for the top 60 processes; costs ~1 s. */
export function rawSnapshot({ withTop = true } = {}) {
  if (process.env.RES_GUARD_RAW) return JSON.parse(fs.readFileSync(process.env.RES_GUARD_RAW, 'utf8'));
  return {
    at: new Date().toISOString(),
    ps: run('ps', ['-axww', '-o', 'pid=,ppid=,rss=,etime=,time=,tty=,command=']),
    top: withTop ? run('top', ['-l', '1', '-o', 'mem', '-n', '60', '-stats', 'pid,mem']) : '',
    sysctl: run('sysctl', ['hw.memsize', 'kern.memorystatus_level', 'kern.memorystatus_vm_pressure_level', 'vm.swapusage']),
    vmstat: run('vm_stat', []),
    df: run('df', ['-k', '/System/Volumes/Data']),
  };
}

// ------------------------------------------------------------------ parsers

/** ps etime / time: [[dd-]hh:]mm:ss[.cc] → seconds */
export function parseClock(s) {
  if (!s) return 0;
  let days = 0;
  let rest = s;
  if (s.includes('-')) [days, rest] = [Number(s.split('-')[0]), s.split('-')[1]];
  return Math.round((days * 86400 + rest.split(':').reduce((acc, part) => acc * 60 + Number(part), 0)) * 100) / 100;
}

/** top MEM column: 1005M, 2176K, 1.2G, 0B → MB */
export function parseMem(s) {
  const m = /^([\d.]+)([BKMG])\+?-?$/.exec(String(s).trim());
  if (!m) return 0;
  return Number(m[1]) * { B: 1 / 1048576, K: 1 / 1024, M: 1, G: 1024 }[m[2]];
}

export function parsePs(text) {
  const procs = [];
  for (const line of text.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(.*)$/.exec(line);
    if (!m) continue;
    procs.push({
      pid: Number(m[1]), ppid: Number(m[2]), rssMB: Number(m[3]) / 1024,
      etimeSec: parseClock(m[4]), cpuSec: parseClock(m[5]), tty: m[6], command: m[7],
    });
  }
  return procs;
}

export function parseTop(text) {
  const foot = new Map();
  let body = false;
  for (const line of text.split('\n')) {
    if (/^PID\s+MEM/.test(line)) { body = true; continue; }
    if (!body) continue;
    const m = /^\s*(\d+)\s+(\S+)/.exec(line);
    if (m) foot.set(Number(m[1]), parseMem(m[2]));
  }
  return foot;
}

function sysctlValue(text, key) {
  const m = new RegExp(`^${key.replace(/\./g, '\\.')}:\\s*(.*)$`, 'm').exec(text);
  return m ? m[1].trim() : '';
}

export function parseSwap(s) {
  const mb = (k) => { const m = new RegExp(`${k} = ([\\d.]+)([MG])`).exec(s); return m ? Number(m[1]) * (m[2] === 'G' ? 1024 : 1) : 0; };
  return { totalMB: mb('total'), usedMB: mb('used') };
}

const PRESSURE = { 1: 'normal', 2: 'warn', 4: 'critical' };

// ------------------------------------------------------------------ families

const EDITOR = /\/CocosCreator\.app\/Contents\/MacOS\/CocosCreator(\s|$)/;
const PLAYWRIGHT = /--remote-debugging-pipe|playwright_chromiumdev_profile|\/ms-playwright\//;

/** `--project <path>` from a Creator command line; paths run up to the next ` --flag`. */
export function projectArg(command) {
  const m = /--project[= ]+(.+?)(?=\s+--|$)/.exec(command);
  return m ? m[1].trim() : null;
}

function firstToken(command) {
  return command.split(/\s+/)[0] || '';
}

export function isClaude(p) {
  const t = firstToken(p.command);
  return t === 'claude' || /\/claude$/.test(t) || /\/claude\/versions\/[^/\s]+$/.test(t);
}

export function parseSnapshot(raw) {
  const procs = parsePs(raw.ps || '');
  const foot = parseTop(raw.top || '');
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const kids = new Map();
  for (const p of procs) {
    if (!kids.has(p.ppid)) kids.set(p.ppid, []);
    kids.get(p.ppid).push(p);
  }
  const tree = (pid) => {
    const out = [];
    const stack = [byPid.get(pid)].filter(Boolean);
    while (stack.length) {
      const p = stack.pop();
      out.push(p);
      stack.push(...(kids.get(p.pid) || []));
    }
    return out;
  };
  const sum = (ps) => ({
    rssMB: Math.round(ps.reduce((a, p) => a + p.rssMB, 0)),
    footMB: Math.round(ps.reduce((a, p) => a + (foot.get(p.pid) ?? p.rssMB), 0)),
  });

  const editors = procs.filter((p) => EDITOR.test(p.command)).map((p) => ({
    pid: p.pid, ppid: p.ppid, project: projectArg(p.command), agentOwned: /--nologin\b/.test(p.command),
    etimeSec: p.etimeSec, ...sum(tree(p.pid)),
  }));
  // a Playwright browser: the root process (its parent is not itself a Playwright Chrome)
  const pw = procs.filter((p) => PLAYWRIGHT.test(p.command) && /Chrom|chrome|headless_shell/.test(p.command));
  const pwPids = new Set(pw.map((p) => p.pid));
  const smoke = pw.filter((p) => !pwPids.has(p.ppid)).map((p) => ({ pid: p.pid, ppid: p.ppid, etimeSec: p.etimeSec, ...sum(tree(p.pid)) }));
  const claude = procs.filter(isClaude).map((p) => ({
    pid: p.pid, ppid: p.ppid, tty: p.tty, etimeSec: p.etimeSec, cpuSec: p.cpuSec, rssMB: Math.round(p.rssMB),
    footMB: Math.round(foot.get(p.pid) ?? p.rssMB),
  }));
  const server = procs.find((p) => /^omniroute \(v[\d.]+\)/.test(p.command));
  const supervisor = procs.find((p) => /\/bin\/omniroute(\.mjs)?(\s|$)/.test(p.command) && !/\s(stop|status|health|restart)\b/.test(p.command));
  const omniroute = server || supervisor ? {
    pid: server?.pid ?? null, supervisorPid: supervisor?.pid ?? null,
    rssMB: Math.round(server?.rssMB ?? 0), footMB: Math.round(server ? (foot.get(server.pid) ?? server.rssMB) : 0),
  } : null;
  const orca = sum(procs.filter((p) => p.command.startsWith('/Applications/Orca.app/')));

  const sc = raw.sysctl || '';
  const page = Number(/page size of (\d+) bytes/.exec(raw.vmstat || '')?.[1] || 16384);
  const pages = (label) => Number(new RegExp(`${label}:\\s+(\\d+)`).exec(raw.vmstat || '')?.[1] || 0);
  const dfLine = (raw.df || '').trim().split('\n').pop() || '';
  const dfCols = dfLine.split(/\s+/);
  const swap = parseSwap(sysctlValue(sc, 'vm.swapusage'));
  const top = [...foot.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([pid, mb]) => {
    const p = byPid.get(pid);
    return { pid, footMB: Math.round(mb), name: p ? label(p.command) : '?' };
  });

  return {
    at: raw.at || new Date().toISOString(),
    memTotalMB: Math.round(Number(sysctlValue(sc, 'hw.memsize') || 0) / 1048576),
    availPct: Number(sysctlValue(sc, 'kern.memorystatus_level') || 100),
    pressure: PRESSURE[Number(sysctlValue(sc, 'kern.memorystatus_vm_pressure_level'))] || 'normal',
    swapUsedMB: Math.round(swap.usedMB), swapTotalMB: Math.round(swap.totalMB),
    compressorMB: Math.round(pages('Pages occupied by compressor') * page / 1048576),
    wiredMB: Math.round(pages('Pages wired down') * page / 1048576),
    diskFreeGB: dfCols.length > 3 ? Math.round(Number(dfCols[3]) / 1048576) : null,
    editors, smoke, claude, omniroute, orca, top,
    procs, // full table for the reaper and lifecycle; dropped before logging
  };
}

/** Short process label for logs: the app bundle name, or the script / binary basename. */
export function label(command) {
  const apps = [...command.matchAll(/\/([^/]+?)\.app\//g)];
  if (apps.length) return apps[apps.length - 1][1].slice(0, 48); // the innermost bundle: helpers keep their own name
  if (/^omniroute \(/.test(command)) return 'omniroute';
  const [bin, arg] = command.split(/\s+/);
  const base = bin.split('/').pop();
  if (/^(node|python3?|bun|deno)$/.test(base) && arg) return `${base} ${arg.split('/').pop()}`;
  return base;
}
