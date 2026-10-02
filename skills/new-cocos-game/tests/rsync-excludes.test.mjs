import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// The template → project copy (cmdNew) must leave per-checkout and per-run files behind.
const source = fs.readFileSync(new URL('../scripts/bootstrap.mjs', import.meta.url), 'utf8');
const start = source.indexOf('const RSYNC_EXCLUDES = [');
// the array ends at the first line that is exactly `];` (a comment inside cannot end it)
const RSYNC_EXCLUDES = new Function(`return ${source.slice(start + 'const RSYNC_EXCLUDES = '.length, source.indexOf('\n];', start) + 2)}`)();

test('rsync excludes: producer runner state, guard hooks and MCP pins stay out of a new project', () => {
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'tpl-'));
  const dst = fs.mkdtempSync(path.join(os.tmpdir(), 'new-'));
  const files = {
    left: ['.cursor/producer.lock', '.cursor/producer.control', '.cursor/producer-runner.json', '.cursor/producer-handoff-step01.md',
      '.cursor/producer-runner.json.tmp-123', '.cursor/producer.lock.dead-1-2',
      '.claude/settings.local.json', '.codex/hooks.json', '.cursor/hooks.json', '.opencode/plugins/coordinator-guard.js',
      'funplay-cocos-mcp.config.json', 'opencode.json', 'temp/x.log'],
    copied: ['AGENT_NOTES.md', '.cursor/rules/00-guardrails.mdc', '.cursor/skills/x/SKILL.md', 'docs/producer-runner.json', '.opencode/plugins/other.js',
      '.cursor/skills/game-producer/SKILL.md', 'docs/.cursor/producer.lock'],
  };
  for (const f of [...files.left, ...files.copied]) {
    fs.mkdirSync(path.dirname(path.join(src, f)), { recursive: true });
    fs.writeFileSync(path.join(src, f), 'x');
  }
  const r = spawnSync('rsync', ['-a', ...RSYNC_EXCLUDES.flatMap((e) => ['--exclude', e]), `${src}/`, `${dst}/`], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  for (const f of files.left) assert.equal(fs.existsSync(path.join(dst, f)), false, f);
  for (const f of files.copied) assert.equal(fs.existsSync(path.join(dst, f)), true, f); // only the anchored paths are dropped
  fs.rmSync(src, { recursive: true });
  fs.rmSync(dst, { recursive: true });
});
