// boot-idea: one Orca terminal in orca-global gets the boot prompt; images go to its boot inbox.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'boot-idea.mjs');
let root, env;
const run = (args) => {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env });
  return { code: r.status, json: (() => { try { return JSON.parse(r.stdout); } catch { return null; } })(), out: r.stdout };
};
const calls = () => fs.readFileSync(path.join(root, 'orca.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'boot-'));
  fs.mkdirSync(path.join(root, 'orca-global'));
  const orca = path.join(root, 'orca');
  fs.writeFileSync(orca, `#!${process.execPath}\nconst a = process.argv.slice(2);\nrequire('fs').appendFileSync(${JSON.stringify(path.join(root, 'orca.jsonl'))}, JSON.stringify(a) + '\\n');\nconsole.log(JSON.stringify({ ok: true, result: a[1] === 'create' ? { handle: 'term_boot' } : {} }));\n`, { mode: 0o755 });
  env = { ...process.env, BOOT_IDEA_ROOT: path.join(root, 'orca-global'), BOOT_IDEA_ORCA: orca, BOOT_IDEA_LOG_DIR: path.join(root, 'logs'), CC_SPAWN_REGISTRY: path.join(root, 'spawns.jsonl') };
});
after(() => fs.rmSync(root, { recursive: true, force: true }));

test('an idea: one claude terminal in orca-global, the one-line prompt once it is idle, images in the inbox, logged and registered', () => {
  const staged = path.join(root, 'staged');
  fs.mkdirSync(staged);
  fs.writeFileSync(path.join(staged, '01-ref.png'), 'x');
  const r = run(['--source', 'idea', '--text', 'runner né thiên thạch\nportrait, màu neon', '--slug', 'space-dash', '--template', 'cc4', '--brief', 'inline', '--impl-agent', 'codex', '--agent', 'claude --model opus', '--images-dir', staged]);
  assert.equal(r.code, 0, r.out);
  assert.equal(r.json.handle, 'term_boot');
  assert.match(r.json.prompt, /^\/new-cocos-game cc-space-dash: runner né thiên thạch · portrait, màu neon — tuỳ chọn: cc4 \(Cocos 4\), brief inline, end to end, deploy preview, agent codex, có hỗ trợ từ orca memory và playbook — ảnh tham chiếu của director: .*boot-inbox\/\d{8}-\d{4}-cc-space-dash$/);
  assert.ok(fs.existsSync(path.join(r.json.inbox, '01-ref.png')));
  assert.ok(!fs.existsSync(staged), 'the staging dir is gone');
  const c = calls();
  assert.deepEqual(c.map((a) => a.slice(0, 2).join(' ')), ['terminal create', 'terminal wait', 'terminal send']);
  assert.equal(c[0][c[0].indexOf('--worktree') + 1], `path:${path.join(root, 'orca-global')}`);
  assert.equal(c[0][c[0].indexOf('--command') + 1], 'claude --model opus --dangerously-skip-permissions');
  assert.equal(c[2][c[2].indexOf('--text') + 1], r.json.prompt);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'spawns.jsonl'), 'utf8')).role, 'boot');
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'logs', 'boot-idea.jsonl'), 'utf8')).ok, true);
});

test('links and the agent are checked before anything starts', () => {
  assert.equal(run(['--source', 'store', '--link', 'https://example.com/x']).code, 1);
  assert.equal(run(['--source', 'figma', '--link', 'https://www.figma.com/design/abc/x', '--dry-run']).json.prompt.startsWith('/figma-game-clone https://www.figma.com/design/abc/x — '), true);
  assert.equal(run(['--source', 'idea', '--text', 'một game xếp hình đủ dài', '--agent', 'claude; rm -rf ~']).code, 1);
  assert.equal(run(['--source', 'idea', '--text', 'ngắn']).code, 1);
});
