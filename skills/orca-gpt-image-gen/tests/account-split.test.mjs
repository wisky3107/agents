import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chooseSet, plan, setPattern } from '../scripts/account-split.mjs';

const row = (label, usable, remaining = 120) => ({ label, verdict: { usable, remaining: usable ? remaining : 0 } });
const conn = (email, isActive, expiresAt = '2026-10-23T00:00:00Z') => ({ id: 'id-' + email, email, isActive, expiresAt });

test('chooseSet: keeps usable members and replaces a limited one with the best usable other', () => {
  const rows = [row('gpt-1', false), row('gpt-2', true, 80), row('gpt-3', true, 120), row('gpt-4', true, 120), row('gpt-5', true, 40)];
  assert.deepEqual(chooseSet(rows, ['gpt-1', 'gpt-2'], 2), ['gpt-2', 'gpt-3']);
});

test('chooseSet: fewer usable profiles than the size gives a smaller set; none gives an empty one', () => {
  assert.deepEqual(chooseSet([row('gpt-1', false), row('gpt-2', true)], ['gpt-1'], 2), ['gpt-2']);
  assert.deepEqual(chooseSet([row('gpt-1', false)], ['gpt-1'], 2), []);
});

test('plan: ChatGPT accounts go inactive in Codex, the others active', () => {
  const steps = plan([conn('a@x', true), conn('b@x', false), conn('c@x', false)], ['a@x'], {});
  assert.deepEqual(steps.map((s) => [s.email, s.from, s.to]), [['a@x', 'active', 'inactive'], ['b@x', 'inactive', 'active'], ['c@x', 'inactive', 'active']]);
});

test('plan: a held (revoked) connection stays inactive until its token is renewed after the hold', () => {
  const held = { 'f@x': { at: '2026-10-13T12:00:00Z', expiresAt: '2026-10-23T03:47:38Z' } };
  assert.equal(plan([conn('f@x', false, '2026-10-23T03:47:38Z')], [], held)[0].to, 'inactive');
  assert.equal(plan([conn('F@x', false, '2026-10-23T15:59:30Z')], [], held)[0].to, 'active', 're-login moved expiresAt; email case ignored');
});

test('setPattern: the set as an exact label pattern', () => {
  assert.equal(setPattern({ set: ['gpt-2', 'gpt-3'] }), '^(gpt-2|gpt-3)$');
  assert.equal(setPattern({ set: [] }), null);
});
