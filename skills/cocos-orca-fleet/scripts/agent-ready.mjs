#!/usr/bin/env node
/**
 * agent-ready.mjs — can a fleet worker run on this agent CLI right now? One JSON line:
 *   {"agent":"cursor","usable":false,"reason":"Error: Authentication required. Please run 'agent login' first…"}
 * No JSON line at all means: not usable.
 *
 *   node agent-ready.mjs --agent "cursor --model auto"|cursor:auto|claude|codex|agy [--timeout-ms 45000]
 *
 * cursor: `cursor-agent status` can print "Logged in" while every run stops at "Press any key to
 * log in…" (2026-10-02: an art-manifest worker timed out at agent_readiness and the slice sat
 * infra_blocked). The probe is one tiny `cursor-agent -p --model auto` run from a temp dir (no
 * project rules or MCP): without a login it fails at once with "Authentication required" and
 * costs nothing; with one it must print an answer. Other CLIs: on PATH. Exit 0 either way.
 */
import fs from 'node:fs';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const BIN = { cursor: 'cursor-agent', claude: 'claude', codex: 'codex', antigravity: 'agy' };
const ALIAS = { 'cursor-agent': 'cursor', agent: 'cursor', agy: 'antigravity' };

const firstLine = (t) => String(t || '').split('\n').map((l) => l.trim()).find(Boolean) || '';

/** `cursor --model auto`, `cursor:auto`, `Cursor-Agent`, `agy` → the CLI family. */
export const family = (spec) => {
  const word = String(spec || '').trim().toLowerCase().split(/[\s:]+/)[0];
  return ALIAS[word] || word;
};

export function ready(spec, timeoutMs = 45000) {
  const id = family(spec);
  const bin = BIN[id];
  if (!bin) return { agent: id, usable: false, reason: `unknown agent "${spec}"` };
  if (spawnSync('which', [bin], { encoding: 'utf8' }).status !== 0) return { agent: id, usable: false, reason: `${bin} is not on PATH` };
  if (id !== 'cursor') return { agent: id, usable: true, reason: `${bin} on PATH` };
  const r = spawnSync(bin, ['-p', 'Reply with the single word ok.', '--output-format', 'text', '--model', 'auto', '--trust'], {
    encoding: 'utf8', timeout: timeoutMs, killSignal: 'SIGKILL', input: '', cwd: os.tmpdir(),
  });
  if (r.error?.code === 'ETIMEDOUT' || r.signal) return { agent: id, usable: false, reason: `cursor-agent -p gave no answer in ${timeoutMs} ms` };
  if (r.status !== 0) return { agent: id, usable: false, reason: firstLine(r.stderr) || firstLine(r.stdout) || `cursor-agent -p exited ${r.status}` };
  if (!String(r.stdout).trim()) return { agent: id, usable: false, reason: 'cursor-agent -p printed no answer' };
  return { agent: id, usable: true, reason: 'cursor-agent -p answered' };
}

// run as a script — also through a symlinked skills dir (import.meta.url is the resolved path)
const self = process.argv[1] && (() => {
  try {
    return pathToFileURL(fs.realpathSync(process.argv[1])).href === import.meta.url;
  } catch {
    return false;
  }
})();
if (self) {
  const argv = process.argv.slice(2);
  const get = (k) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : undefined);
  if (!get('--agent')) {
    process.stdout.write(`${JSON.stringify({ error: 'usage: agent-ready.mjs --agent <spec> [--timeout-ms N]' })}\n`);
    process.exit(2);
  }
  process.stdout.write(`${JSON.stringify(ready(get('--agent'), Number(get('--timeout-ms')) || 45000))}\n`);
}
