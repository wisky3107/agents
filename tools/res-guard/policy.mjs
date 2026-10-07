/**
 * The guard's decisions, as pure functions of a parsed snapshot (probe.mjs) plus the config and
 * the small state the watcher keeps between ticks. Nothing here touches the machine: res-guard.mjs
 * executes what these return, so the rules can be tested against fixture snapshots.
 */

/** Defaults sized for a 16 GB Mac; ~/.agents/run/res-guard/config.json overrides any key. */
export const DEFAULTS = {
  maxEditors: 2, // Cocos editors at once: each one is ~2–3 GB with its helpers and compressed pages
  maxSmoke: 1, // Playwright Chrome browsers at once (~1 GB each)
  minAvailPct: { editor: 20, lane: 15, smoke: 15 }, // kern.memorystatus_level, % of RAM still available
  maxSwapMB: { editor: 4096, lane: 6144, smoke: 6144 },
  minDiskGB: 15,
  gate: { pollSec: 20, maxWaitSec: 1800 }, // a waiting gate gives up (and lets the caller through) after this
  alert: { swapMB: 4096, swapCriticalMB: 8192, diskGB: 20, diskCriticalGB: 10, cooldownMin: 30 },
  omniroute: { restartMB: 1536, hardMB: 3072, idleTicks: 2, minGapMin: 60, port: 20128 },
  reap: { smokeMaxMin: 30, orphanClaudeIdleMin: 120 },
  editors: { graceMin: 10, idleMin: 20, keep: [] }, // keep: checkout paths the lifecycle never closes
  samples: { keepDays: 14 },
};

export function mergeConfig(base, over) {
  if (!over || typeof over !== 'object' || Array.isArray(over)) return over === undefined ? base : over;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = base && typeof base[k] === 'object' && !Array.isArray(base[k]) ? mergeConfig(base[k], v) : v;
  return out;
}

const samePath = (a, b) => a && b && a.replace(/\/+$/, '') === b.replace(/\/+$/, '');

// ------------------------------------------------------------------ admission gate

/**
 * May a new editor / lane / smoke browser start now? `project` is the checkout it is for: an editor
 * already open on that checkout does not count against the cap (reusing it costs nothing).
 * A lane counts as an editor: every Cocos lane opens one for its checkout.
 */
export function gate(s, kind, cfg, { project } = {}) {
  const reasons = [];
  if (s.pressure === 'critical') reasons.push('memory pressure is critical');
  const avail = cfg.minAvailPct[kind] ?? cfg.minAvailPct.lane;
  if (s.availPct < avail) reasons.push(`available memory ${s.availPct}% < ${avail}%`);
  const swap = cfg.maxSwapMB[kind] ?? cfg.maxSwapMB.lane;
  if (s.swapUsedMB > swap) reasons.push(`swap ${s.swapUsedMB} MB > ${swap} MB`);
  if (s.diskFreeGB !== null && s.diskFreeGB < cfg.minDiskGB) reasons.push(`disk free ${s.diskFreeGB} GB < ${cfg.minDiskGB} GB`);
  if (kind === 'editor' || kind === 'lane') {
    const own = project && s.editors.some((e) => samePath(e.project, project));
    const others = s.editors.filter((e) => !samePath(e.project, project)).length;
    if (!own && others >= cfg.maxEditors) reasons.push(`${others} Cocos editors open (max ${cfg.maxEditors})`);
  }
  if (kind === 'smoke' && s.smoke.length >= cfg.maxSmoke) reasons.push(`${s.smoke.length} smoke browser(s) running (max ${cfg.maxSmoke})`);
  return { ok: reasons.length === 0, reasons };
}

// ------------------------------------------------------------------ alerts

/** Keyed alert rows: a key names a state, not live numbers, so a cooldown can hold it. */
export function alerts(s, cfg) {
  const out = [];
  const a = cfg.alert;
  if (s.pressure === 'critical') out.push({ key: 'pressure:critical', level: 'critical', title: 'Memory pressure critical', body: `available ${s.availPct}%, swap ${gb(s.swapUsedMB)}` });
  if (s.swapUsedMB > a.swapCriticalMB) out.push({ key: 'swap:critical', level: 'critical', title: `Swap ${gb(s.swapUsedMB)}`, body: topLine(s) });
  else if (s.swapUsedMB > a.swapMB) out.push({ key: 'swap:high', level: 'warning', title: `Swap ${gb(s.swapUsedMB)}`, body: topLine(s) });
  if (s.diskFreeGB !== null && s.diskFreeGB < a.diskCriticalGB) out.push({ key: 'disk:critical', level: 'critical', title: `Disk free ${s.diskFreeGB} GB`, body: 'swap needs disk; free space now' });
  else if (s.diskFreeGB !== null && s.diskFreeGB < a.diskGB) out.push({ key: 'disk:low', level: 'warning', title: `Disk free ${s.diskFreeGB} GB`, body: 'keep ≥ 20 GB free for swap' });
  if (s.editors.length > cfg.maxEditors) out.push({ key: 'editors:over', level: 'warning', title: `${s.editors.length} Cocos editors open`, body: s.editors.map((e) => short(e.project)).join(', ') });
  return out;
}

/** Alerts not sent within the cooldown; returns them and the updated `sent` map. */
export function dueAlerts(rows, sent = {}, cfg, now = Date.now()) {
  const due = rows.filter((r) => !sent[r.key] || now - Date.parse(sent[r.key]) > cfg.alert.cooldownMin * 60000);
  const next = Object.fromEntries(Object.entries(sent).filter(([k]) => rows.some((r) => r.key === k))); // cleared states re-arm
  for (const r of due) next[r.key] = new Date(now).toISOString();
  return { due, sent: next };
}

// ------------------------------------------------------------------ OmniRoute

/**
 * Restart OmniRoute when its footprint passes `restartMB` and no client held a connection for
 * `idleTicks` ticks in a row, or unconditionally past `hardMB`; never twice within `minGapMin`.
 */
export function omnirouteAction(s, cfg, st = {}, { clients = 0, now = Date.now() } = {}) {
  const o = cfg.omniroute;
  const r = s.omniroute;
  const next = { ...st };
  if (!r?.pid) return { action: null, state: { ...next, idle: 0 } };
  next.idle = clients === 0 ? (st.idle || 0) + 1 : 0;
  const recent = st.lastRestart && now - Date.parse(st.lastRestart) < o.minGapMin * 60000;
  if (recent || r.footMB < o.restartMB) return { action: null, state: next };
  if (r.footMB >= o.hardMB) return { action: { why: `footprint ${r.footMB} MB ≥ hard limit ${o.hardMB} MB` }, state: next };
  if (next.idle >= o.idleTicks) return { action: { why: `footprint ${r.footMB} MB ≥ ${o.restartMB} MB, idle ${next.idle} ticks` }, state: next };
  return { action: null, state: next };
}

// ------------------------------------------------------------------ reaper

/**
 * Processes safe to kill: an editor whose checkout is gone, a Playwright browser older than
 * `smokeMaxMin`, a `claude` orphaned to launchd with no terminal whose CPU time has not moved for
 * `orphanClaudeIdleMin`. `cpu` is the watcher's { pid: { cpuSec, since } } memory of CPU time.
 */
export function reapPlan(s, cfg, { exists = () => true, cpu = {}, now = Date.now() } = {}) {
  const kills = [];
  for (const e of s.editors) {
    if (e.project && !exists(e.project)) kills.push({ pid: e.pid, family: 'editor', project: e.project, why: 'checkout no longer exists' });
  }
  for (const b of s.smoke) {
    if (b.etimeSec > cfg.reap.smokeMaxMin * 60) kills.push({ pid: b.pid, family: 'smoke', why: `Playwright browser running ${Math.round(b.etimeSec / 60)} min` });
  }
  const nextCpu = {};
  for (const c of s.claude) {
    if (c.ppid !== 1 || c.tty !== '??') continue;
    const prev = cpu[c.pid];
    const since = prev && Math.abs(prev.cpuSec - c.cpuSec) < 1 ? prev.since : new Date(now).toISOString();
    nextCpu[c.pid] = { cpuSec: c.cpuSec, since };
    const idleMin = (now - Date.parse(since)) / 60000;
    if (idleMin >= cfg.reap.orphanClaudeIdleMin) kills.push({ pid: c.pid, family: 'claude', why: `orphaned claude, no CPU for ${Math.round(idleMin)} min` });
  }
  return { kills, cpu: nextCpu };
}

// ------------------------------------------------------------------ helpers

export const gb = (mb) => `${(mb / 1024).toFixed(1)} GB`;
export const short = (p) => (p || '?').split('/').slice(-2).join('/');
const topLine = (s) => s.top.slice(0, 3).map((t) => `${t.name} ${gb(t.footMB)}`).join(', ');
