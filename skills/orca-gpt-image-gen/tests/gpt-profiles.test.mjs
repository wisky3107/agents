import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verdict, rank, resetTime, maskEmail } from '../scripts/gpt-profiles.mjs';

const NOW = Date.parse('2026-10-12T15:00:00Z');
const live = (remaining, extra = {}) => ({ signedIn: true, imageGen: { remaining, resetAfter: '2026-10-13T00:00:00Z' }, ...extra });

test('verdict: signed in with quota is usable', () => {
  assert.deepEqual(verdict(live(120), {}, NOW), { usable: true, reason: 'ok', until: null, remaining: 120 });
});

test('verdict: zero image_gen left is limited until reset_after', () => {
  const v = verdict(live(0), {}, NOW);
  assert.equal(v.usable, false);
  assert.equal(v.reason, 'limited');
  assert.equal(v.until, '2026-10-13T00:00:00Z');
});

test('verdict: a UI limit mark wins over a stale quota count, and expires', () => {
  assert.equal(verdict(live(50), { limitedUntil: '2026-10-12T16:00:00Z' }, NOW).reason, 'limited');
  assert.equal(verdict(live(50), { limitedUntil: '2026-10-12T14:00:00Z' }, NOW).usable, true);
});

test('verdict: signed out or blocked is not usable', () => {
  assert.equal(verdict({ signedIn: false }, {}, NOW).reason, 'signed-out');
  assert.equal(verdict(live(9, { blocked: ['image_gen'] }), {}, NOW).reason, 'blocked');
  assert.equal(verdict({ signedIn: false, error: 'x' }, {}, NOW).reason, 'probe-failed');
});

test('verdict: unknown quota counts as usable', () => {
  assert.equal(verdict({ signedIn: true, imageGen: null }, {}, NOW).usable, true);
});

const row = (label, v) => ({ label, verdict: v });
test('rank: prefers a profile that covers the whole batch, then most left, then label order', () => {
  const rows = [
    row('gpt-1', { usable: true, remaining: 3 }),
    row('gpt-2', { usable: true, remaining: 10 }),
    row('gpt-10', { usable: true, remaining: 10 }),
    row('gpt-3', { usable: false, remaining: 0 }),
  ];
  assert.equal(rank(rows, 4).label, 'gpt-2');
  assert.equal(rank(rows.slice(0, 1), 4).label, 'gpt-1');
  assert.equal(rank([rows[3]], 1), null);
});

test('resetTime: minutes or ISO, default a few hours', () => {
  assert.equal(resetTime('30', NOW), '2026-10-12T15:30:00.000Z');
  assert.equal(resetTime('2026-10-13T01:02:03Z', NOW), '2026-10-13T01:02:03.000Z');
  assert.equal(resetTime(true, NOW), '2026-10-12T18:00:00.000Z');
  assert.throws(() => resetTime('tomorrow', NOW));
});

test('maskEmail', () => {
  assert.equal(maskEmail('alexis@gmail.com'), 'a***@gmail.com');
  assert.equal(maskEmail(null), null);
});

import { phase, LIMIT_RE } from '../scripts/chatgpt-page.mjs';
test('phase: busy, done, idle, limited, signed out', () => {
  assert.equal(phase({ busy: true, images: 0 }), 'busy');
  assert.equal(phase({ busy: false, images: 1 }, 0), 'done');
  assert.equal(phase({ busy: false, images: 1 }, 1), 'idle');
  assert.equal(phase({ busy: false, images: 0, lastText: "You've hit the plus plan limit for image generations requests. You can create more images when the limit resets in 23 hours." }), 'limited');
  assert.equal(phase({ signedOut: true }), 'signed-out');
});
test('LIMIT_RE ignores ordinary replies', () => {
  assert.equal(LIMIT_RE.test('Here is your capybara coin icon with a transparent background.'), false);
  assert.equal(LIMIT_RE.test("You've reached your image creation limit"), true);
});
