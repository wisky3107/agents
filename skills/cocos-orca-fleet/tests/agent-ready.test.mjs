import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// agent-ready against fake CLIs on PATH: the cursor probe must not trust `status`.
const SCRIPT = new URL('../scripts/agent-ready.mjs', import.meta.url).pathname;

function bin(scripts) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-ready-'));
  for (const [name, body] of Object.entries(scripts)) fs.writeFileSync(path.join(dir, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return dir;
}
const exec = (dir, script, ...a) => spawnSync(process.execPath, [script, ...a], { encoding: 'utf8', env: { ...process.env, PATH: `${dir}:/usr/bin:/bin` } });
const run = (dir, ...a) => JSON.parse(exec(dir, SCRIPT, ...a).stdout.trim());

test('cursor: "Logged in" from status but -p asks for a login → not usable; a real answer → usable', () => {
  const out = bin({ 'cursor-agent': 'case "$1" in status) echo "Logged in"; exit 0;; -p) echo "Error: Authentication required. Please run \'agent login\' first." >&2; exit 1;; esac' });
  const a = run(out, '--agent', 'cursor --model auto');
  assert.deepEqual([a.agent, a.usable], ['cursor', false]);
  assert.match(a.reason, /^Error: Authentication required/);
  // the probe asks for the cheap model from a temp dir, and trusts it
  const args = bin({ 'cursor-agent': `echo "$@" > ${os.tmpdir()}/agent-ready-args.txt; pwd >> ${os.tmpdir()}/agent-ready-args.txt; echo ok` });
  assert.deepEqual(run(args, '--agent', 'Cursor:auto'), { agent: 'cursor', usable: true, reason: 'cursor-agent -p answered' });
  const [argv, cwd] = fs.readFileSync(path.join(os.tmpdir(), 'agent-ready-args.txt'), 'utf8').trim().split('\n');
  assert.match(argv, /-p .* --model auto --trust/);
  assert.equal(fs.realpathSync(cwd), fs.realpathSync(os.tmpdir()));
  // exit 0 with nothing printed is not an answer
  assert.deepEqual(run(bin({ 'cursor-agent': 'exit 0' }), '--agent', 'cursor'), { agent: 'cursor', usable: false, reason: 'cursor-agent -p printed no answer' });
});

test('missing or unknown CLIs, colon specs, a hung probe that ignores SIGTERM, bad usage', () => {
  const empty = bin({});
  assert.deepEqual(run(empty, '--agent', 'cursor'), { agent: 'cursor', usable: false, reason: 'cursor-agent is not on PATH' });
  const some = bin({ claude: 'exit 0', agy: 'exit 0' });
  assert.equal(run(some, '--agent', 'claude:sonnet:high').usable, true);
  assert.equal(run(some, '--agent', 'agy').agent, 'antigravity');
  assert.equal(run(some, '--agent', 'codex').usable, false);
  assert.match(run(some, '--agent', 'gemini').reason, /unknown agent "gemini"/);
  const hung = bin({ 'cursor-agent': "trap '' TERM; sleep 5" });
  const t0 = Date.now();
  assert.match(run(hung, '--agent', 'cursor', '--timeout-ms', '500').reason, /gave no answer in 500 ms/);
  assert.ok(Date.now() - t0 < 4000, 'killed, not waited out');
  assert.equal(spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' }).status, 2);
});

test('runs through a symlinked skills dir (how agents reach it)', () => {
  const link = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-ready-link-')), 'agent-ready.mjs');
  fs.symlinkSync(SCRIPT, link);
  const out = exec(bin({ claude: 'exit 0' }), link, '--agent', 'claude');
  assert.deepEqual(JSON.parse(out.stdout.trim()), { agent: 'claude', usable: true, reason: 'claude on PATH' });
});
