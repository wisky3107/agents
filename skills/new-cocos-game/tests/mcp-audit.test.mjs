import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';

// M1a: per-checkout editor MCP pins must never live in GLOBAL agent configs.
const SCRIPT = new URL('../scripts/bootstrap.mjs', import.meta.url).pathname;
const source = fs.readFileSync(SCRIPT, 'utf8');

const CODEX = [
  'model = "gpt"',
  '# keep this comment',
  '[mcp_servers.unityMCP]',
  'url = "http://localhost:8080/mcp"',
  '',
  '',
  '[mcp_servers.funplay_cocos]',
  'url = "http://127.0.0.1:8771/"',
  '',
  '# the next server is node_repl',
  '[mcp_servers.node_repl]',
  'command = "/bin/node_repl"',
  '',
  '[mcp_servers.cocos-s01-core-dra-ab01f0] # pinned by Funplay',
  'url = "http://127.0.0.1:8773/"',
  '[mcp_servers.cocos-s01-core-dra-ab01f0.env]',
  'X = "1"',
  '',
  '[mcp_servers]',
  'inline_keep = { command = "k" }',
  'cocos-cc-x-abcdef = { url = "http://127.0.0.1:8790/" }',
  '',
  '[hooks.state]',
  'a = "b"',
  '',
].join('\n');
const CODEX_FIXED = [
  'model = "gpt"',
  '# keep this comment',
  '[mcp_servers.unityMCP]',
  'url = "http://localhost:8080/mcp"',
  '',
  '',
  '# the next server is node_repl',
  '[mcp_servers.node_repl]',
  'command = "/bin/node_repl"',
  '',
  '[mcp_servers]',
  'inline_keep = { command = "k" }',
  '',
  '[hooks.state]',
  'a = "b"',
  '',
].join('\n');

function fakeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-audit-'));
  const write = (rel, text, mode = 0o600) => {
    fs.mkdirSync(path.dirname(path.join(home, rel)), { recursive: true });
    fs.writeFileSync(path.join(home, rel), text, { mode });
  };
  write('.codex/config.toml', CODEX);
  write('.cursor/mcp.json', JSON.stringify({ mcpServers: {
    'cocos-cc-flick-sho-1bcbe0': { serverUrl: 'http://127.0.0.1:8772/' },
    'xcode-tools': { command: 'x' },
    wrangler: { url: 'http://localhost:8787/mcp' }, // port match only
  } }, null, 2));
  write('.config/opencode/opencode.json', JSON.stringify({ $schema: 's', mcp: {
    funplay_cocos: { type: 'remote', url: 'http://127.0.0.1:8778/' },
    unityMCP: { type: 'remote', url: 'https://example.com/mcp' },
  } }, null, 2));
  write('.config/opencode/opencode.jsonc', '{\n  // user notes\n  "mcp": { "funplay_cocos": { "type": "remote", "url": "http://[::1]:8779/" }, },\n}\n');
  write('.claude.json', JSON.stringify({
    numStartups: 3,
    mcpServers: { other: { command: 'y' } },
    projects: { '/w/cc-x/S01': { mcpServers: { 'cocos-s01-core-dra-ab01f0': { url: 'http://127.0.0.1:8773/' } } } },
  }, null, 2));
  return home;
}
const run = (...args) => {
  const r = spawnSync(process.execPath, [SCRIPT, 'mcp-audit', '--json', ...args], { encoding: 'utf8' });
  return { status: r.status, out: r.stdout ? JSON.parse(r.stdout) : null, err: r.stderr };
};
const names = (list) => list.map((f) => `${f.client}:${f.name}`).sort();

test('audit reports names, ports, JSONC and project-scoped entries; exit 2; changes nothing', () => {
  const home = fakeHome();
  const before = fs.readFileSync(path.join(home, '.codex/config.toml'), 'utf8');
  const { status, out } = run('--home', home);
  assert.equal(status, 2);
  assert.equal(out.ok, false);
  assert.deepEqual(names(out.findings), [
    'codex:cocos-cc-x-abcdef', 'codex:cocos-s01-core-dra-ab01f0', 'codex:funplay_cocos',
    'cursor:cocos-cc-flick-sho-1bcbe0', 'cursor:wrangler', 'opencode:funplay_cocos', 'opencode:funplay_cocos',
  ]);
  assert.equal(out.findings.find((f) => f.name === 'wrangler').fixable, false); // port-only
  assert.equal(out.findings.find((f) => f.file.endsWith('.jsonc')).fixable, false); // JSONC: by hand
  assert.deepEqual(out.projectScoped.map((p) => p.name), ['cocos-s01-core-dra-ab01f0']);
  assert.equal(fs.readFileSync(path.join(home, '.codex/config.toml'), 'utf8'), before);
  fs.rmSync(home, { recursive: true });
});

test('--fix: backups, only fixable entries removed, TOML bytes and next-table comments kept, mode kept', () => {
  const home = fakeHome();
  const { status, out } = run('--home', home, '--fix');
  assert.equal(status, 2); // wrangler (port-only) and the JSONC entry remain
  assert.deepEqual(names(out.remaining), ['cursor:wrangler', 'opencode:funplay_cocos']);
  const toml = path.join(home, '.codex/config.toml');
  assert.equal(fs.readFileSync(toml, 'utf8'), CODEX_FIXED);
  assert.equal(fs.statSync(toml).mode & 0o777, 0o600);
  const cursor = JSON.parse(fs.readFileSync(path.join(home, '.cursor/mcp.json'), 'utf8'));
  assert.deepEqual(Object.keys(cursor.mcpServers), ['xcode-tools', 'wrangler']);
  const oc = JSON.parse(fs.readFileSync(path.join(home, '.config/opencode/opencode.json'), 'utf8'));
  assert.deepEqual([Object.keys(oc.mcp), oc.$schema], [['unityMCP'], 's']);
  assert.match(fs.readFileSync(path.join(home, '.config/opencode/opencode.jsonc'), 'utf8'), /user notes/);
  const claude = JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8'));
  assert.ok(claude.projects['/w/cc-x/S01'].mcpServers['cocos-s01-core-dra-ab01f0']);
  for (const f of out.fixed) assert.match(path.basename(f.backup), /\.bak-mcp-audit-\d{8}T\d{6}$/);
  assert.equal(fs.readFileSync(out.fixed.find((f) => f.client === 'codex').backup, 'utf8'), CODEX);
  const ports = run('--home', home, '--fix', '--fix-port-matches');
  assert.deepEqual(names(ports.out.remaining), ['opencode:funplay_cocos']);
  fs.rmSync(home, { recursive: true });
});

test('--fix writes through a symlinked dotfile; bad input is reported, never silently ok', () => {
  const home = fakeHome();
  const real = path.join(home, 'dotfiles-codex.toml');
  fs.renameSync(path.join(home, '.codex/config.toml'), real);
  fs.symlinkSync(real, path.join(home, '.codex/config.toml'));
  run('--home', home, '--fix');
  assert.ok(fs.lstatSync(path.join(home, '.codex/config.toml')).isSymbolicLink());
  assert.equal(fs.readFileSync(real, 'utf8'), CODEX_FIXED);
  fs.writeFileSync(path.join(home, '.cursor/mcp.json'), '{ not json');
  const bad = run('--home', home);
  assert.equal(bad.out.ok, false);
  assert.equal(bad.out.unparsed[0].file, path.join(home, '.cursor/mcp.json'));
  assert.notEqual(run('--home').status, 0); // --home without a value must not fall back to the real home
  fs.rmSync(home, { recursive: true });
});

function loadOpencodeWriter() {
  const ctx = vm.createContext({
    fs, path, spawnSync, console: { log() {}, error() {} },
    readJsonSafe: (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } },
  });
  vm.runInContext(source.slice(source.indexOf('function writeOpencodeJson('), source.indexOf('function writeCursorMcpJson(')), ctx);
  return ctx;
}

test('writeOpencodeJson replaces only mcp.<key> and git-excludes the file, also from a repo subdirectory', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-json-'));
  spawnSync('git', ['-C', repo, 'init', '-q']);
  const dir = path.join(repo, 'games', 'cc-x');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'opencode.json'), JSON.stringify({ model: 'm', mcp: {
    mine: { type: 'local' }, funplay_cocos: { type: 'local', command: ['old'] },
  } }));
  const ctx = loadOpencodeWriter();
  ctx.writeOpencodeJson(dir, 'funplay_cocos', 'http://127.0.0.1:8790/');
  ctx.writeOpencodeJson(dir, 'funplay_cocos', 'http://127.0.0.1:8791/');
  const doc = JSON.parse(fs.readFileSync(path.join(dir, 'opencode.json'), 'utf8'));
  assert.equal(doc.model, 'm');
  assert.deepEqual(JSON.parse(JSON.stringify(doc.mcp)), {
    mine: { type: 'local' }, funplay_cocos: { type: 'remote', url: 'http://127.0.0.1:8791/' },
  });
  const exclude = fs.readFileSync(path.join(repo, '.git/info/exclude'), 'utf8');
  assert.equal(exclude.split('\n').filter((l) => l === '/games/cc-x/opencode.json').length, 1);
  assert.equal(spawnSync('git', ['-C', repo, 'status', '--porcelain']).stdout.toString(), '');
  fs.rmSync(repo, { recursive: true });
});

test('writeOpencodeJson leaves JSONC and git-tracked files alone', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-json-'));
  spawnSync('git', ['-C', dir, 'init', '-q']);
  const file = path.join(dir, 'opencode.json');
  const ctx = loadOpencodeWriter();
  fs.writeFileSync(file, '{ // comment\n "model": "m" }');
  assert.equal(ctx.writeOpencodeJson(dir, 'funplay_cocos', 'http://127.0.0.1:8790/'), null);
  assert.match(fs.readFileSync(file, 'utf8'), /comment/);
  fs.writeFileSync(file, '{"model":"m"}');
  spawnSync('git', ['-C', dir, 'add', 'opencode.json']);
  assert.equal(ctx.writeOpencodeJson(dir, 'funplay_cocos', 'http://127.0.0.1:8790/'), null);
  assert.equal(fs.readFileSync(file, 'utf8'), '{"model":"m"}');
  fs.rmSync(dir, { recursive: true });
});
