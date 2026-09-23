import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';

// Exercise the real resolver and session sequencing with an isolated Orca/trust boundary.
const source = fs.readFileSync(new URL('../scripts/bootstrap.mjs', import.meta.url), 'utf8');
function harness({ failWait = false, failSend = false } = {}) {
  const calls = [];
  const context = vm.createContext({
    DEFAULT_AGENT: 'cursor', FORCE_BOOT: null, NON_CURSOR_BOOT_PROMPT: 'boot',
    path, fs: { existsSync: () => true }, console: { log() {}, error() {} },
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
  return { context, calls };
}
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
