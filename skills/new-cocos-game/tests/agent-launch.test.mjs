import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import os from 'node:os';

// Exercise the real resolver and session sequencing with an isolated Orca/trust boundary.
const source = fs.readFileSync(new URL('../scripts/bootstrap.mjs', import.meta.url), 'utf8');
function harness({ failWait = false, failSend = false, files = {} } = {}) {
  const calls = [];
  const appended = [];
  const fakeFs = {
    existsSync: () => true,
    readFileSync: (file) => {
      if (!(file in files)) throw new Error(`ENOENT ${file}`);
      return files[file];
    },
    mkdirSync() {},
    appendFileSync: (file, text) => appended.push([file, text]),
  };
  const context = vm.createContext({
    DEFAULT_AGENT: 'cursor', FORCE_BOOT: null, NON_CURSOR_BOOT_PROMPT: 'boot',
    path, fs: fakeFs, os: { homedir: () => '/home/u' }, console: { log() {}, error() {} },
    GUARD_HOOKS_DIR: '/nonexistent-hooks', readJsonSafe: () => null, ensureGitIgnored() {},
    which: x => `/bin/${x}`, resolveOrcaBin: () => 'orca',
    die: msg => { throw new Error(msg); }, ensureOrcaReady() {},
    ensureAgentWorkspacesTrusted: () => ({}), isCc4Project: () => false,
    readPinnedFunplayPort: () => 8765,
    orcaJson: (_bin, args) => { calls.push(args); return { status: 0, parsed: { ok: true, result: { handle: 'term_test' } } }; },
    waitForTuiIdle: () => ({ status: failWait ? 1 : 0, parsed: { ok: !failWait } }),
    sendTerminalText: (_bin, _handle, text) => { calls.push(['send', text]); return { status: failSend ? 1 : 0, parsed: { ok: !failSend, result: {} } }; },
  });
  vm.runInContext(source.slice(source.indexOf('function parseAgentSpec('), source.indexOf('/** stdout is reserved')), context);
  vm.runInContext(source.slice(source.indexOf('async function createAgentSession('), source.indexOf('function cmdResolve(')), context);
  return { context, calls, appended };
}

// ---- launch roles (M1 of the coordinator token plan) ----
const PROJECT_TOML = '[mcp_servers.funplay_cocos]\nurl = "http://127.0.0.1:8775/"\n';
const GLOBAL_TOML = [
  'model = "x"',
  '[mcp_servers.unityMCP]', 'url = "http://localhost:8080/mcp"',
  '[mcp_servers.node_repl]', 'command = "/bin/node_repl"',
  '[mcp_servers.node_repl.env]', 'A = "1"',
  '[mcp_servers.computer-use]', 'command = "./cu"',
  '[hooks.state]', 'url = "http://127.0.0.1:1/"',
].join('\n');
const ROLE_FILES = {
  '/project/.codex/config.toml': PROJECT_TOML,
  '/home/u/.codex/config.toml': GLOBAL_TOML,
  '/project/opencode.json': JSON.stringify({ mcp: { funplay_cocos: { type: 'remote', url: 'http://127.0.0.1:8775/' } } }),
  '/home/u/.config/opencode/opencode.json': JSON.stringify({ mcp: { unityMCP: { type: 'remote', url: 'http://localhost:8080/mcp' }, docs: { type: 'local', command: ['x'] } } }),
};
test('no --role keeps every launch command byte-identical', () => {
  const { context: c } = harness({ files: ROLE_FILES });
  for (const id of ['claude', 'codex', 'cursor', 'opencode', 'antigravity']) {
    const base = c.resolveAgentLaunchCommand(id);
    assert.equal(c.applyLaunchRole(base, id, { projectPath: '/project' }).command, base);
  }
});
test('coordinator: env prefix and editor MCP dropped per provider', () => {
  const { context: c } = harness({ files: ROLE_FILES });
  const claude = c.applyLaunchRole(c.resolveAgentLaunchCommand('claude --model sonnet'), 'claude --model sonnet',
    { role: 'coordinator', slice: 'S03', projectPath: '/project' });
  assert.equal(claude.command,
    'CC_ROLE=coordinator CC_PROJECT=/project CC_SLICE=S03 claude --model sonnet --dangerously-skip-permissions --strict-mcp-config');
  const codex = c.applyLaunchRole(c.resolveAgentLaunchCommand('codex'), 'codex', { role: 'coordinator', projectPath: '/project' });
  assert.deepEqual([...codex.mcp.servers], ['funplay_cocos', 'unityMCP']); // stdio node_repl / computer-use stay
  // the checkout server restates its url: a bare enabled=false for an unloaded server stops codex
  assert.ok(codex.command.endsWith(
    `-c 'mcp_servers.funplay_cocos.url="http://127.0.0.1:8775/"' -c mcp_servers.funplay_cocos.enabled=false`
    + ' -c mcp_servers.unityMCP.enabled=false --dangerously-bypass-hook-trust')); // M2: project guard hook must run
  const oc = c.applyLaunchRole('opencode', 'opencode', { role: 'coordinator', projectPath: '/project' });
  assert.equal(oc.env.OPENCODE_CONFIG_CONTENT,
    '{"mcp":{"funplay_cocos":{"enabled":false},"unityMCP":{"enabled":false},"docs":{"enabled":false}}}');
  assert.ok(oc.command.startsWith(`CC_ROLE=coordinator CC_PROJECT=/project OPENCODE_CONFIG_CONTENT='{"mcp"`));
  const cursor = c.applyLaunchRole(c.resolveAgentLaunchCommand('cursor'), 'cursor', { role: 'coordinator', projectPath: '/project' });
  assert.equal(cursor.mcp.mode, 'unsupported');
  assert.equal(cursor.command, 'CC_ROLE=coordinator CC_PROJECT=/project cursor-agent --yolo --model auto');
});
test('producer and worker keep MCP; paths with spaces are quoted; bad role/slice rejected', () => {
  const { context: c } = harness({ files: ROLE_FILES });
  const p = c.applyLaunchRole('claude --dangerously-skip-permissions', 'claude', { role: 'producer', projectPath: '/My Games/x' });
  assert.equal(p.command, "CC_ROLE=producer CC_PROJECT='/My Games/x' claude --dangerously-skip-permissions");
  assert.equal(p.mcp.mode, 'kept');
  assert.equal(c.applyLaunchRole('codex', 'codex', { role: 'worker', projectPath: '/project' }).mcp.servers.length, 0);
  assert.throws(() => c.applyLaunchRole('claude', 'claude', { role: 'boss', projectPath: '/p' }));
  assert.throws(() => c.applyLaunchRole('claude', 'claude', { role: 'worker', slice: 'slice-3', projectPath: '/p' }));
  assert.equal(c.applyLaunchRole('claude', 'claude', { role: 'worker', slice: 'S14a', projectPath: '/p' }).env.CC_SLICE, 'S14a');
});
test('codex TOML scan: comments, quoted keys, array tables, local hosts; quoted keys stay one shell word', () => {
  const toml = [
    '[mcp_servers."f.g"] # dotted name', "url = 'http://[::1]:9/'",
    "[mcp_servers.'a b']", 'url = "http://0.0.0.0:1/mcp"',
    '[[profiles]]', 'url = "http://127.0.0.1:2/"', // must not attach to the server above
    '[mcp_servers.stdio_only]', 'command = "x"',
  ].join('\n');
  const { context: c } = harness({ files: { '/p/.codex/config.toml': '', '/home/u/.codex/config.toml': toml } });
  const servers = c.codexMcpServers('/home/u/.codex/config.toml');
  assert.deepEqual(JSON.parse(JSON.stringify(servers.map((s) => [s.name, s.url]))), // vm realm → plain arrays
    [['f.g', 'http://[::1]:9/'], ['a b', 'http://0.0.0.0:1/mcp'], ['stdio_only', '']]);
  const r = c.applyLaunchRole('codex', 'codex', { role: 'coordinator', projectPath: '/p' });
  assert.deepEqual([...r.mcp.servers], ['f.g', 'a b']);
  assert.ok(r.command.includes(`-c 'mcp_servers."f.g".enabled=false' -c 'mcp_servers."a b".enabled=false'`));
  // a checkout server without a url is left alone (no bare override)
  const { context: c2 } = harness({ files: { '/p/.codex/config.toml': '[mcp_servers.x]\ncommand = "y"\n' } });
  assert.equal(c2.applyLaunchRole('codex', 'codex', { role: 'coordinator', projectPath: '/p' }).command,
    'CC_ROLE=coordinator CC_PROJECT=/p codex --dangerously-bypass-hook-trust');
});
test('teams wrapper is flagged unverified; --slice needs --role; unparsable opencode config strips nothing', () => {
  const { context: c } = harness({ files: { '/p/opencode.json': '{ // jsonc\n }' } });
  assert.equal(c.applyLaunchRole('orca claude-teams', 'claude-agent-teams', { role: 'coordinator', projectPath: '/p' }).mcp.mode,
    'stripped-all-unverified');
  assert.throws(() => c.applyLaunchRole('claude', 'claude', { slice: 'S01', projectPath: '/p' }), /--slice needs --role/);
  assert.deepEqual([...c.applyLaunchRole('opencode', 'opencode', { role: 'coordinator', projectPath: '/p' }).mcp.servers], []);
});
test('a failing spawn registry never breaks the launch', async () => {
  const { context: c, calls } = harness({ files: ROLE_FILES });
  c.fs.appendFileSync = () => { throw new Error('EACCES'); };
  const session = await c.createAgentSession({ projectPath: '/project', agent: 'codex', prompt: 'task', role: 'worker', slice: 'S02' });
  assert.equal(session.ready, true);
  assert.equal(session.promptSent, true);
  assert.equal(calls.filter((x) => x[0] === 'terminal').length, 1);
});
test('agent-session launches the role command once and writes one registry line', async () => {
  const { context: c, calls, appended } = harness({ files: ROLE_FILES });
  const session = await c.createAgentSession({
    projectPath: '/project', agent: 'claude --model sonnet', prompt: 'task', role: 'coordinator', slice: 'S03',
  });
  assert.equal(calls.filter((x) => x[0] === 'terminal').length, 1);
  assert.ok(calls[0].join(' ').includes('CC_ROLE=coordinator CC_PROJECT=/project CC_SLICE=S03 claude --model sonnet'));
  assert.equal(session.mcpLaunch.mode, 'stripped-all');
  assert.equal(appended.length, 1);
  assert.equal(appended[0][0], '/home/u/.agents/logs/spawns.jsonl');
  const row = JSON.parse(appended[0][1]);
  assert.deepEqual([row.role, row.slice, row.handle, row.cwd], ['coordinator', 'S03', 'term_test', '/project']);
});
test('all seven settings providers retain launch permissions and identity', () => {
  const { context: c } = harness();
  const cases = {
    claude: 'claude --dangerously-skip-permissions',
    'claude-agent-teams': 'orca claude-teams --dangerously-skip-permissions',
    codex: 'codex --dangerously-bypass-approvals-and-sandbox',
    cursor: 'cursor-agent --yolo --model auto',
    gemini: 'gemini --yolo', opencode: 'opencode',
    antigravity: 'agy --dangerously-skip-permissions',
  };
  for (const [id, expected] of Object.entries(cases)) {
    assert.equal(c.resolveAgentLaunchCommand(id), expected);
    assert.equal(c.agentSpecString(c.parseAgentSpec(id)), id);
  }
});
test('model/effort survive permission mapping and explicit overrides win', () => {
  const { context: c } = harness();
  assert.equal(c.resolveAgentLaunchCommand('codex --model old --effort low', 'new', 'high'), 'codex --dangerously-bypass-approvals-and-sandbox --model new -c model_reasoning_effort="high"');
  assert.equal(c.resolveAgentLaunchCommand('claude-agent-teams --model opus --effort high'), 'orca claude-teams --model opus --effort high --dangerously-skip-permissions');
  assert.equal(c.resolveAgentLaunchCommand('cursor --model auto --effort high'), 'cursor-agent --yolo --model auto');
  assert.throws(() => c.resolveAgentLaunchCommand('gemini --model unsupported'));
  assert.throws(() => c.resolveAgentLaunchCommand('codex --unknown value'));
});
test('native rules skip boot; task receives intended command and worktree', async () => {
  const { context: c, calls } = harness();
  const session = await c.createAgentSession({ projectPath: '/project', agent: 'codex --model requested', prompt: 'task' });
  assert.equal(session.ready, true);
  assert.equal(session.promptSent, true);
  assert.equal(session.bootPromptSent, false);
  assert.ok(calls[0].includes('path:/project'));
  assert.ok(calls[0].includes('codex --dangerously-bypass-approvals-and-sandbox --model requested'));
  assert.deepEqual(calls[1], ['send', 'task']);
});
test('readiness failure preserves handle and does not send a prompt', async () => {
  const { context: c, calls } = harness({ failWait: true });
  const session = await c.createAgentSession({ projectPath: '/project', agent: 'codex', prompt: 'task' });
  assert.equal(session.handle, 'term_test');
  assert.equal(session.ready, false);
  assert.equal(session.promptSent, false);
  assert.equal(calls.length, 1);
});
test('send failure is visible for caller recovery without duplicate launch', async () => {
  const { context: c, calls } = harness({ failSend: true });
  const session = await c.createAgentSession({ projectPath: '/project', agent: 'codex', prompt: 'task' });
  assert.equal(session.promptSent, false);
  assert.equal(calls.filter(x => x[0] === 'terminal').length, 1);
});
test('non-native agent boots before task; native boot-only session stays ready', async () => {
  const { context: c, calls } = harness();
  const session = await c.createAgentSession({ projectPath: '/project', agent: 'antigravity', prompt: 'task' });
  assert.equal(session.bootPromptSent, true);
  assert.deepEqual(calls.slice(1), [['send', 'boot'], ['send', 'task']]);
  assert.equal((await c.createAgentSession({ projectPath: '/project', agent: 'codex' })).ready, true);
});
test('prompt send strips zero-width characters that block Claude submit', () => {
  const calls = [];
  const context = vm.createContext({
    console: { log() {}, error() {} },
    orcaJson: (_bin, args) => { calls.push(args); return { status: 0, parsed: { ok: true } }; },
  });
  vm.runInContext(source.slice(source.indexOf('const INVISIBLE_CHARS'), source.indexOf('async function httpProbe(')), context);
  context.sendTerminalText('orca', 'term_test', 'open .c\u200dursor/ \u200bnow\ufeff');
  assert.equal(calls[0][calls[0].indexOf('--text') + 1], 'open .cursor/ now');
});

test('guarded roles install the checkout guard hook for their CLI, idempotently, keeping other hooks', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-install-'));
  const hooks = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-core-'));
  fs.mkdirSync(path.join(hooks, 'adapters'));
  fs.writeFileSync(path.join(hooks, 'coordinator-guard.mjs'), '');
  const excluded = [];
  const warmed = [];
  const ctx = vm.createContext({
    path, fs, os, console: { log() {}, error() {} }, DEFAULT_AGENT: 'cursor', die: (m) => { throw new Error(m); },
    which: () => '/bin/x', resolveOrcaBin: () => 'orca', GUARD_HOOKS_DIR: hooks,
    readJsonSafe: (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } },
    ensureGitIgnored: (_p, rel) => excluded.push(rel),
    spawnSync: (bin, args) => { warmed.push([bin, ...args].join(' ')); return { status: 0 }; },
  });
  vm.runInContext(source.slice(source.indexOf('function parseAgentSpec('), source.indexOf('/** stdout is reserved')), ctx);
  fs.mkdirSync(path.join(dir, '.claude'));
  fs.writeFileSync(path.join(dir, '.claude/settings.local.json'), JSON.stringify({
    enabledMcpjsonServers: ['funplay_cocos'],
    hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'other-hook' }] }] },
  }));
  ctx.installGuardHooks(dir, 'claude --model sonnet');
  ctx.installGuardHooks(dir, 'claude --model sonnet'); // twice: still one guard entry
  const claude = JSON.parse(fs.readFileSync(path.join(dir, '.claude/settings.local.json'), 'utf8'));
  assert.deepEqual(claude.enabledMcpjsonServers, ['funplay_cocos']);
  assert.equal(claude.hooks.PreToolUse.length, 2);
  assert.equal(claude.hooks.PreToolUse[0].hooks[0].command, 'other-hook');
  assert.match(claude.hooks.PreToolUse[1].hooks[0].command, /coordinator-guard\.mjs'? --cli claude$/);
  assert.equal(claude.hooks.PreToolUse[1].matcher, 'Bash|Edit|Write|MultiEdit');
  ctx.installGuardHooks(dir, 'codex');
  assert.match(JSON.parse(fs.readFileSync(path.join(dir, '.codex/hooks.json'), 'utf8')).hooks.PreToolUse[0].hooks[0].command, /--cli codex$/);
  ctx.installGuardHooks(dir, 'cursor');
  const cursor = JSON.parse(fs.readFileSync(path.join(dir, '.cursor/hooks.json'), 'utf8'));
  assert.equal(cursor.version, 1);
  assert.match(cursor.hooks.beforeShellExecution[0].command, /--cli cursor$/);
  ctx.installGuardHooks(dir, 'opencode');
  assert.match(fs.readFileSync(path.join(dir, '.opencode/plugins/coordinator-guard.js'), 'utf8'),
    /export \{ CoordinatorGuard \} from ".*adapters\/opencode-plugin\.js";/);
  assert.deepEqual(warmed, ['opencode debug config']); // first-start plugin deps installed up front
  assert.equal(ctx.installGuardHooks(dir, 'antigravity').installed.length, 0); // no adapter: layer 1 only
  assert.deepEqual([...new Set(excluded)].sort(), ['.claude/settings.local.json', '.codex/hooks.json', '.cursor/hooks.json',
    '.opencode/plugins/coordinator-guard.js']);
  fs.rmSync(dir, { recursive: true });
  fs.rmSync(hooks, { recursive: true });
});

test('agent-session retries the create without --focus when Orca times out adopting the focused tab', async () => {
  const { context, calls } = harness();
  context.orcaJson = (_bin, args) => {
    calls.push(args);
    if (args[0] === 'terminal' && args[1] === 'create' && args.includes('--focus')) {
      return { status: 1, stdout: '', stderr: '', parsed: { ok: false, error: { code: 'runtime_error', message: 'Timed out waiting for terminal handle after creation' } } };
    }
    return { status: 0, parsed: { ok: true, result: { terminal: { handle: 'term_unfocused' } } } };
  };
  const res = await context.createAgentSession({ projectPath: '/project', agent: 'codex', prompt: 'task', role: 'worker', slice: 'S12' });
  const creates = calls.filter(a => a[0] === 'terminal' && a[1] === 'create');
  assert.equal(creates.length, 2);
  assert.ok(creates[0].includes('--focus'));
  assert.ok(!creates[1].includes('--focus'));
  assert.equal(JSON.stringify(res).includes('term_unfocused'), true);
});
