import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify, parseLogin, providerOf, recentSpecs } from '../scripts/agent-status.mjs';

test('providerOf normalizes launcher aliases', () => {
  assert.equal(providerOf('cursor-agent --model auto'), 'cursor');
  assert.equal(providerOf('agent'), 'cursor');
  assert.equal(providerOf('agy'), 'antigravity');
  assert.equal(providerOf('claude --model opus --effort high'), 'claude');
});

test('cursor: "Logged in" from status is not trusted — models probe decides', () => {
  const r = parseLogin('cursor', {
    code: 1,
    stdout: '',
    stderr: "Error: Authentication required. Run 'agent login', pass --api-key/--auth-token.",
  });
  assert.equal(r.auth, 'fail');
  assert.match(r.detail, /^Authentication required/);
  const ok = parseLogin('cursor', { code: 0, stdout: 'Available models\nauto\ngpt-5\nsonnet-4.5\n', stderr: '' });
  assert.equal(ok.auth, 'ok');
  assert.deepEqual(ok.models, ['auto', 'gpt-5', 'sonnet-4.5']);
});

test('claude / codex / opencode login parsing', () => {
  assert.equal(parseLogin('claude', { code: 0, stdout: '{"loggedIn":true,"authMethod":"oauth_token"}' }).auth, 'ok');
  assert.equal(parseLogin('claude', { code: 1, stdout: '{"loggedIn":false}' }).auth, 'fail');
  assert.equal(parseLogin('codex', { code: 0, stdout: 'Logged in using ChatGPT' }).auth, 'ok');
  assert.equal(parseLogin('codex', { code: 1, stdout: 'Not logged in' }).auth, 'fail');
  const oc = parseLogin('opencode', {
    code: 0,
    stdout: '\x1b[0m┌  Credentials\n│\n●  OpenCode Go \x1b[90mapi\n└  1 credentials\n●  OpenAI \x1b[90mOPENAI_API_KEY\n',
  });
  assert.equal(oc.auth, 'ok');
  assert.equal(oc.detail, 'OpenCode Go api, OpenAI OPENAI_API_KEY');
  assert.equal(parseLogin('opencode', { code: 0, stdout: '┌  Credentials\n└  0 credentials' }).auth, 'fail');
  assert.equal(parseLogin('antigravity', { code: 0, stdout: '' }).auth, 'unknown');
});

test('classify: missing CLI / failed login are unavailable, and the reason carries the probe detail', () => {
  assert.equal(classify({ installed: false, auth: 'ok' }).status, 'unavailable');
  assert.equal(classify({ installed: true, auth: 'fail' }).status, 'unavailable');
  assert.deepEqual(classify({ installed: true, auth: 'fail' }).reasons, ['not logged in']);
  // a timed-out probe is reported as such, not as "not logged in"
  assert.deepEqual(classify({ installed: true, auth: 'fail', authDetail: 'probe timed out' }).reasons, ['login probe: probe timed out']);
});

test('classify: quota or a high error share degrades; a small sample does not', () => {
  const quota = classify({ installed: true, auth: 'ok', gateway: { days: 3, calls: 900, errors: 5, quotaExhausted: 12 } });
  assert.equal(quota.status, 'degraded');
  assert.match(quota.reasons[0], /quota_exhausted ×12 in 3d/);
  assert.equal(classify({ installed: true, auth: 'ok', gateway: { days: 3, calls: 200, errors: 40, quotaExhausted: 0 } }).status, 'degraded');
  assert.equal(classify({ installed: true, auth: 'ok', gateway: { days: 3, calls: 10, errors: 5, quotaExhausted: 0 } }).status, 'ready');
  assert.equal(classify({ installed: true, auth: 'unknown', gateway: null }).status, 'unverified');
});

test('recentSpecs: window, grouping, most used first', () => {
  const now = Date.parse('2026-10-04T00:00:00Z');
  const lines = [
    JSON.stringify({ ts: '2026-10-03T10:00:00Z', role: 'worker', agentSpec: 'claude --model opus --effort high' }),
    JSON.stringify({ ts: '2026-10-03T11:00:00Z', role: 'judge', agentSpec: 'claude --model sonnet' }),
    JSON.stringify({ ts: '2026-10-03T12:00:00Z', role: 'judge', agentSpec: 'claude --model sonnet' }),
    JSON.stringify({ ts: '2026-08-01T00:00:00Z', role: 'worker', agentSpec: 'codex --model old' }),
    'not json',
  ];
  const r = recentSpecs(lines, now, 30);
  assert.deepEqual(Object.keys(r), ['claude']);
  assert.equal(r.claude[0].spec, 'claude --model sonnet');
  assert.equal(r.claude[0].spawns, 2);
  assert.deepEqual(r.claude[0].roles, ['judge']);
  assert.equal(r.claude[0].last, '2026-10-03');
});
