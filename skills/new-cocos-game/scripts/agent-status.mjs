#!/usr/bin/env node
/**
 * agent-status.mjs — provider readiness for the new-cocos-game agent-combo step (SKILL Step 0b)
 *
 *   node agent-status.mjs [--providers claude,codex,cursor,opencode,antigravity] [--days 3] [--json]
 *
 * Per provider: CLI on PATH + version, a login probe (no model call), gateway errors from the
 * workflow scorecard over the last --days days, and the launch specs that actually spawned in the
 * last 30 days (~/.agents/logs/spawns.jsonl) — the combo step picks models from those, never
 * invents one. Read-only.
 *
 * status: ready | degraded (works, but quota / error rate seen) | unverified (installed, login not
 * probe-able) | unavailable (no CLI or not logged in — never put it in a combo).
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const DEFAULT_PROVIDERS = ['claude', 'codex', 'cursor', 'opencode', 'antigravity'];
const PROBE_TIMEOUT_MS = 20000;
const SPEC_WINDOW_DAYS = 30;
// Error share that marks a provider degraded; below MIN_CALLS the ratio is noise.
const ERROR_RATE_DEGRADED = 0.1;
const MIN_CALLS = 50;

const LOGS_DIR = path.join(os.homedir(), '.agents', 'logs');
const SCORECARD_DB = path.join(LOGS_DIR, 'scorecard.sqlite');
const SPAWNS_FILE = path.join(LOGS_DIR, 'spawns.jsonl');

// bins: first one on PATH wins. gateway: provider name in the scorecard llm_* tables (OmniRoute).
const PROVIDERS = {
  claude: { bins: ['claude'], login: ['auth', 'status'], gateway: 'claude' },
  codex: { bins: ['codex'], login: ['login', 'status'], gateway: 'codex' },
  // `cursor-agent status` can say "Logged in" with an expired token; `models` needs a working one.
  cursor: { bins: ['cursor-agent', 'agent'], login: ['models'], gateway: null },
  opencode: { bins: ['opencode'], login: ['auth', 'list'], gateway: null },
  antigravity: { bins: ['agy'], login: null, gateway: null },
};

const ANSI_RE = /\x1b\[[0-9;]*m/g;
export const stripAnsi = (s) => String(s || '').replace(ANSI_RE, '');

/** Provider id of a launch spec ("cursor-agent --model auto" → cursor). */
export function providerOf(spec) {
  const id = String(spec || '').trim().split(/\s+/)[0] || '';
  if (id === 'cursor-agent' || id === 'agent') return 'cursor';
  if (id === 'agy') return 'antigravity';
  return id;
}

/** Login verdict from a probe's exit code + output: { auth: ok|fail|unknown, detail, models? }. */
export function parseLogin(provider, { code, stdout, stderr }) {
  const out = stripAnsi(`${stdout || ''}\n${stderr || ''}`).trim();
  const firstLine = out.split('\n').find((l) => l.trim()) || '';
  if (provider === 'claude') {
    try {
      const j = JSON.parse(stdout);
      return j.loggedIn ? { auth: 'ok', detail: j.authMethod || 'logged in' } : { auth: 'fail', detail: 'not logged in' };
    } catch {
      return { auth: code === 0 ? 'unknown' : 'fail', detail: firstLine };
    }
  }
  if (provider === 'codex') {
    const ok = code === 0 && /logged in/i.test(out) && !/not logged in/i.test(out);
    return { auth: ok ? 'ok' : 'fail', detail: firstLine };
  }
  if (provider === 'cursor') {
    if (code !== 0 || /authentication required|not logged in/i.test(out)) {
      return { auth: 'fail', detail: firstLine.replace(/^Error:\s*/, '') };
    }
    const models = out
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !/^(available models|models?:)/i.test(l));
    return { auth: 'ok', detail: `${models.length} models`, models };
  }
  if (provider === 'opencode') {
    // `opencode auth list` lists stored credentials and env keys, one "●  <name>" row each.
    const creds = out
      .split('\n')
      .filter((l) => l.includes('●'))
      .map((l) => l.replace(/^[│\s]*●\s*/, '').trim());
    return creds.length
      ? { auth: 'ok', detail: creds.join(', ') }
      : { auth: 'fail', detail: firstLine || 'no credentials' };
  }
  return { auth: 'unknown', detail: 'login not probe-able' };
}

/** Launch specs seen in spawns.jsonl within `days`, grouped by provider, most used first. */
export function recentSpecs(lines, now = Date.now(), days = SPEC_WINDOW_DAYS) {
  const since = now - days * 86400000;
  const by = {};
  for (const line of lines) {
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (!e?.agentSpec || !(Date.parse(e.ts) >= since)) continue;
    const p = providerOf(e.agentSpec);
    const row = ((by[p] ||= {})[e.agentSpec] ||= { spec: e.agentSpec, spawns: 0, roles: new Set(), last: '' });
    row.spawns += 1;
    if (e.role) row.roles.add(e.role);
    if (e.ts > row.last) row.last = e.ts;
  }
  const result = {};
  for (const [p, specs] of Object.entries(by)) {
    result[p] = Object.values(specs)
      .sort((a, b) => b.spawns - a.spawns)
      .map((r) => ({ spec: r.spec, spawns: r.spawns, roles: [...r.roles].sort(), last: r.last.slice(0, 10) }));
  }
  return result;
}

/** Final status + human reasons from installed / login / gateway facts. */
export function classify({ installed, auth, authDetail, gateway }) {
  if (!installed) return { status: 'unavailable', reasons: ['CLI not on PATH'] };
  // A timed-out or crashed probe also lands here; the detail says which, so "not logged in" is never asserted blindly.
  if (auth === 'fail') return { status: 'unavailable', reasons: [authDetail ? `login probe: ${authDetail}` : 'not logged in'] };
  const reasons = [];
  if (gateway?.quotaExhausted > 0) reasons.push(`quota_exhausted ×${gateway.quotaExhausted} in ${gateway.days}d`);
  if (gateway && gateway.calls >= MIN_CALLS && gateway.errors / gateway.calls >= ERROR_RATE_DEGRADED) {
    reasons.push(`gateway errors ${Math.round((100 * gateway.errors) / gateway.calls)}% of ${gateway.calls} calls`);
  }
  if (reasons.length) return { status: 'degraded', reasons };
  if (auth === 'unknown') return { status: 'unverified', reasons: ['login not probe-able'] };
  return { status: 'ready', reasons: [] };
}

function which(cmd) {
  const r = spawnSync('/bin/sh', ['-c', `command -v ${cmd}`], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

function run(bin, args) {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: PROBE_TIMEOUT_MS, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
      resolve({ code, stdout: stdout || '', stderr: stderr || (err?.killed ? 'probe timed out' : '') });
    });
  });
}

function sqliteJson(sql) {
  const r = spawnSync('sqlite3', ['-json', SCORECARD_DB, sql], { encoding: 'utf8' });
  if (r.status !== 0) return null;
  try {
    return JSON.parse(r.stdout || '[]');
  } catch {
    return null;
  }
}

/** Per gateway provider: calls / errors / quota_exhausted over the last `days` days, plus data freshness. */
function gatewayHealth(days) {
  if (!fs.existsSync(SCORECARD_DB)) return { latestDay: null, byProvider: {} };
  const window = `date('now','-${Number(days)} day')`;
  const totals = sqliteJson(
    `select provider, sum(calls) calls, sum(errors) errors from llm_daily where day >= ${window} group by provider`,
  );
  const quota = sqliteJson(
    `select provider, sum(count) n from llm_errors where day >= ${window} and error = 'quota_exhausted' group by provider`,
  );
  const latest = sqliteJson('select max(day) day from llm_daily');
  const byProvider = {};
  for (const t of totals || []) byProvider[t.provider] = { days, calls: t.calls, errors: t.errors, quotaExhausted: 0 };
  for (const q of quota || []) (byProvider[q.provider] ||= { days, calls: 0, errors: 0, quotaExhausted: 0 }).quotaExhausted = q.n;
  return { latestDay: latest?.[0]?.day || null, byProvider };
}

export async function collectStatus({ providers = DEFAULT_PROVIDERS, days = 3 } = {}) {
  const gateway = gatewayHealth(days);
  let spawnLines = [];
  try {
    spawnLines = fs.readFileSync(SPAWNS_FILE, 'utf8').split('\n');
  } catch {}
  const specs = recentSpecs(spawnLines);

  const rows = await Promise.all(
    providers.map(async (name) => {
      const def = PROVIDERS[name];
      if (!def) return { provider: name, status: 'unavailable', reasons: ['unknown provider id'] };
      const bin = def.bins.find((b) => which(b)) || null;
      let version = null;
      let login = { auth: 'unknown', detail: 'login not probe-able' };
      if (bin) {
        const [v, l] = await Promise.all([
          run(bin, ['--version']),
          def.login ? run(bin, def.login) : Promise.resolve(null),
        ]);
        version = stripAnsi(v.stdout).trim().split('\n')[0] || null;
        if (l) login = parseLogin(name, l);
      }
      const gw = def.gateway ? gateway.byProvider[def.gateway] || null : null;
      const { status, reasons } = classify({ installed: Boolean(bin), auth: login.auth, authDetail: login.detail, gateway: gw });
      return {
        provider: name,
        status,
        reasons,
        bin,
        version,
        auth: login.auth,
        authDetail: login.detail,
        ...(login.models ? { models: login.models.slice(0, 40) } : {}),
        gateway: gw,
        recentSpecs: specs[name] || [],
      };
    }),
  );
  return { checkedAt: new Date().toISOString(), gatewayLatestDay: gateway.latestDay, days, providers: rows };
}

function printTable(result) {
  console.log(`agent-status ${result.checkedAt} (gateway window ${result.days}d, scorecard data up to ${result.gatewayLatestDay || 'n/a'})`);
  for (const r of result.providers) {
    const gw = r.gateway ? ` · gateway ${r.gateway.errors}/${r.gateway.calls} err, quota ×${r.gateway.quotaExhausted}` : '';
    const specs = (r.recentSpecs || []).slice(0, 3).map((s) => `${s.spec} ×${s.spawns}`).join('; ');
    console.log(`- ${r.provider.padEnd(12)} ${r.status.padEnd(11)} ${r.reasons.join(', ') || 'ok'}${gw}`);
    console.log(`  ${r.version || '-'} · login: ${r.auth} (${r.authDetail || '-'})${specs ? ` · recent: ${specs}` : ''}`);
  }
}

function parseArgs(argv) {
  const out = { providers: DEFAULT_PROVIDERS, days: 3, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') out.json = true;
    else if (a === '--providers') out.providers = String(argv[++i] || '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--days') out.days = Math.max(1, Number.parseInt(argv[++i], 10) || 3);
    else {
      console.error('usage: agent-status.mjs [--providers claude,codex,cursor,opencode,antigravity] [--days 3] [--json]');
      process.exit(1);
    }
  }
  return out;
}

// run as a script — also through a symlinked skills dir (import.meta.url is the resolved path)
const self = (() => {
  try {
    return Boolean(process.argv[1]) && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();
if (self) {
  const args = parseArgs(process.argv.slice(2));
  const result = await collectStatus(args);
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else printTable(result);
}
