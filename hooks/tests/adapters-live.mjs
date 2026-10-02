#!/usr/bin/env node
/**
 * Live adapter check (plan M2.10): for each agent CLI on this machine, install the coordinator guard
 * the way bootstrap.mjs does, run one headless turn that asks for a command the guard denies
 * (`echo CC_GUARD_SELFTEST_DENY > ran.txt`, denied only under CC_GUARD_SELFTEST=1: a `sleep` would be
 * stopped by Claude Code's own sleep check before the hook), and verify it never ran and the guard
 * logged the call. Costs one short model
 * turn per CLI. A CLI that is missing or not logged in is `skip`, never `fail`. Rerun after every CLI
 * upgrade: hook formats change.
 *
 *   node hooks/tests/adapters-live.mjs [claude] [codex] [opencode] [cursor]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HOOKS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CORE = path.join(HOOKS, 'coordinator-guard.mjs');
const has = (bin) => spawnSync('which', [bin]).status === 0;

const CLIS = {
  claude: {
    available: () => has('claude'),
    install: (dir) => writeJson(dir, '.claude/settings.local.json', {
      hooks: { PreToolUse: [{ matcher: 'Bash|Edit|Write|MultiEdit', hooks: [{ type: 'command', command: `node '${CORE}' --cli claude`, timeout: 10 }] }] },
    }),
    run: (dir, prompt) => ['claude', ['-p', prompt, '--model', 'haiku', '--dangerously-skip-permissions']],
  },
  codex: {
    available: () => has('codex'),
    install: (dir) => writeJson(dir, '.codex/hooks.json', {
      hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: `node '${CORE}' --cli codex`, timeout: 10 }] }] },
    }),
    run: (dir, prompt) => ['codex', ['exec', '--dangerously-bypass-approvals-and-sandbox', '--dangerously-bypass-hook-trust', '--skip-git-repo-check', prompt]],
  },
  opencode: {
    available: () => has('opencode'),
    install: (dir) => {
      fs.mkdirSync(path.join(dir, '.opencode/plugins'), { recursive: true });
      fs.writeFileSync(path.join(dir, '.opencode/plugins/coordinator-guard.js'),
        `export { CoordinatorGuard } from ${JSON.stringify(path.join(HOOKS, 'adapters', 'opencode-plugin.js'))};\n`);
      spawnSync('opencode', ['debug', 'config'], { cwd: dir, timeout: 120000 }); // as bootstrap does: deps before the first run
    },
    // through a login-style shell, as Orca launches it: spawned straight from node, `opencode run` skipped
    // project tool hooks in testing
    run: (dir, prompt) => ['/bin/zsh', ['-c', `opencode run ${JSON.stringify(prompt)} </dev/null`]],
  },
  cursor: {
    // `status` can say "Logged in" while -p still demands auth: probe the mode the test uses
    available: () => has('cursor-agent') && !/Authentication required|not logged in/i.test(
      (r => `${r.stdout}${r.stderr}`)(spawnSync('cursor-agent', ['-p', 'reply ok', '--force'], { encoding: 'utf8', timeout: 60000 }))),
    install: (dir) => writeJson(dir, '.cursor/hooks.json', {
      version: 1, hooks: { beforeShellExecution: [{ command: `node '${CORE}' --cli cursor`, timeout: 10 }] },
    }),
    run: (dir, prompt) => ['cursor-agent', ['-p', prompt, '--force']],
  },
};

function writeJson(dir, rel, doc) {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), JSON.stringify(doc, null, 2));
}

const wanted = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(CLIS);
let failed = 0;
for (const name of wanted) {
  const cli = CLIS[name];
  if (!cli) {
    console.log(`${name}: unknown`);
    failed++;
    continue;
  }
  if (!cli.available()) {
    console.log(`${name}: skip (not installed or not logged in)`);
    continue;
  }
  // realpath: /var → /private/var, else OpenCode calls the marker path external and refuses it
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `guard-live-${name}-`)));
  spawnSync('git', ['-C', dir, 'init', '-q']);
  cli.install(dir);
  const log = path.join(dir, 'guard.jsonl');
  const marker = path.join(dir, 'ran.txt');
  const prompt = `Use your shell tool to run exactly this one command and nothing else, then reply with one line saying whether it ran: echo CC_GUARD_SELFTEST_DENY > ${marker}`;
  const [bin, args] = cli.run(dir, prompt);
  const r = spawnSync(bin, args, {
    cwd: dir, encoding: 'utf8', timeout: 240000, input: '',
    // keep TMPDIR: OpenCode resolves its plugins through it (a per-test TMPDIR silently loads none)
    env: { ...process.env, CC_ROLE: 'coordinator', CC_GUARD_MODE: 'block', CC_GUARD_LOG: log, CC_GUARD_SELFTEST: '1' },
  });
  const entries = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
  const blocked = entries.some((e) => e.cli === name && e.blocked && e.rule === 'selftest');
  const ran = fs.existsSync(marker);
  const ok = blocked && !ran;
  if (!ok) failed++;
  const reply = (r.stdout || '').trim().split('\n').filter(Boolean).slice(-1)[0] || '';
  console.log(`${name}: ${ok ? 'pass' : 'FAIL'} (guard log: ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}, blocked=${blocked}, command ran=${ran}) — model: ${reply.slice(0, 160)}`);
  if (ok) fs.rmSync(dir, { recursive: true, force: true });
  else console.log(`  kept ${dir} for inspection; exit ${r.status}; stderr: ${(r.stderr || '').slice(-300)}`);
}
process.exit(failed ? 1 : 0);
