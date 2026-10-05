import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseQuotaEvents, parseInvalidEvents, logFacts, relaunchCommand, signedOut } from '../rotate.mjs';
import { rankAccounts } from '../slot.mjs';

// Shape copied from a real agy log (cli-20261005_021641.log), trace ids trimmed.
const QUOTA_429 = `I1005 02:23:33.091751   14297 http_helpers.go:315] URL: https://daily-cloudcode-pa.googleapis.com/v1internal:generateContent Trace: 0x8a
E1005 02:23:33.092018   14297 generate_image.go:167] error generating image: failed to generate content: 429 Too Many Requests, body: {
  "error": {
    "code": 429,
    "message": "You have exhausted your capacity on this model. Your quota will reset after 4h54m56s.",
    "status": "RESOURCE_EXHAUSTED",
    "details": [
      {
        "@type": "type.googleapis.com/google.rpc.ErrorInfo",
        "reason": "QUOTA_EXHAUSTED",
        "domain": "cloudcode-pa.googleapis.com",
        "metadata": {
          "uiMessage": "true",
          "model": "gemini-3.1-flash-image",
          "quotaResetDelay": "4h54m56.87563923s",
          "quotaResetTimeStamp": "2026-10-05T00:18:30Z"
        }
      }
    ]
  }
}
I1005 02:23:35.884380   14653 http_helpers.go:315] URL: https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse
`;

test('a QUOTA_EXHAUSTED 429 yields model, reset stamp and its local log time', () => {
  const { events, consumed } = parseQuotaEvents(QUOTA_429, { year: 2026 });
  assert.equal(events.length, 1);
  assert.equal(events[0].model, 'gemini-3.1-flash-image');
  assert.equal(events[0].resetAt, '2026-10-05T00:18:30.000Z');
  assert.equal(events[0].at, new Date(2026, 9, 5, 2, 23, 33).toISOString());
  assert.equal(consumed, QUOTA_429.length);
});

test('without a reset stamp the delay is added to the log time', () => {
  const text = QUOTA_429.replace(/\n {10}"quotaResetTimeStamp"[^\n]*/, '').replace('"4h54m56.87563923s",', '"1h0m0s"');
  const { events } = parseQuotaEvents(text, { year: 2026 });
  assert.equal(events[0].resetAt, new Date(2026, 9, 5, 3, 23, 33).toISOString());
});

test('a 429 whose body is cut off at the chunk end is left for the next pass', () => {
  const cut = QUOTA_429.slice(0, QUOTA_429.indexOf('"metadata"'));
  const { events, consumed } = parseQuotaEvents(cut, { year: 2026 });
  assert.equal(events.length, 0);
  assert.equal(consumed, cut.indexOf('E1005'));
});

test('a 429 that is not QUOTA_EXHAUSTED (rate limit) is ignored', () => {
  const { events } = parseQuotaEvents(QUOTA_429.replace('QUOTA_EXHAUSTED', 'RATE_LIMIT_EXCEEDED'), { year: 2026 });
  assert.equal(events.length, 0);
});

test('logFacts takes the last signed-in email and the last active conversation', () => {
  const text = [
    'I1005 11:49:19.185063       1 server_oauth.go:203] OAuth: authenticated successfully as a@x.com',
    'I1005 11:52:21.390132     636 server.go:1263] Created conversation 0d4c1753-96ab-4f40-80b5-cd062d3c9ef0',
    'I1005 11:59:21.390132     636 server.go:1263] OAuth: authenticated successfully as b@x.com',
    'I1005 11:59:22.390339     636 server.go:3133] GetConversationDetail: found conversation 101e95b6-a98d-4833-97ec-5b96360ee43d (active=true)',
  ].join('\n');
  assert.deepEqual(logFacts(text), { email: 'b@x.com', conversation: '101e95b6-a98d-4833-97ec-5b96360ee43d' });
});

test('relaunch keeps safe flags, drops prompts and old conversation flags, quotes the cwd', () => {
  assert.equal(
    relaunchCommand('agy --dangerously-skip-permissions --model gemini-3.8-flash-high -c', 'abc', '/Users/w/orca/workspaces/cc-lego-stack/s11-model-pack-2'),
    'cd /Users/w/orca/workspaces/cc-lego-stack/s11-model-pack-2 && agy --dangerously-skip-permissions --model gemini-3.8-flash-high --conversation abc',
  );
  assert.equal(
    relaunchCommand('agy --effort=high -i do things --conversation old', 'new', "/tmp/it's here"),
    "cd '/tmp/it'\\''s here' && agy --effort=high --conversation new",
  );
  assert.equal(relaunchCommand('agy --dangerously-skip-permissions', 'abc', null), 'agy --dangerously-skip-permissions --conversation abc');
});

test('a "verify your account" 403 is an invalid event; the bare JSON reason line is not double counted', () => {
  const text = [
    '    "status": "PERMISSION_DENIED",',
    '        "reason": "VALIDATION_REQUIRED",',
    'W1005 12:05:47.564214     360 cache.go:135] Cache(retrieveUserQuotaSummary): Singleflight refresh failed: PERMISSION_DENIED (code 403): Verify your account to continue.',
    'I1005 12:05:48.000000     360 server.go:1] fine',
  ].join('\n');
  assert.deepEqual(parseInvalidEvents(text, { year: 2026 }), [{ at: new Date(2026, 9, 5, 12, 5, 47).toISOString() }]);
});

test('"Account ineligible" (age / location) is an invalid event too', () => {
  const text = 'W1005 13:06:13.747841     360 server_oauth.go:106] Account ineligible: Your current account is not eligible for Antigravity, because it is not currently available in your location.';
  assert.deepEqual(parseInvalidEvents(text, { year: 2026 }), [{ at: new Date(2026, 9, 5, 13, 6, 13).toISOString() }]);
});

test('a relaunch without a conversation starts fresh; bin picks the agy to run', () => {
  assert.equal(relaunchCommand('/Users/w/.local/bin/agy --dangerously-skip-permissions', null, null, '/Users/w/.agents/tools/agy-account/bin/agy'),
    '/Users/w/.agents/tools/agy-account/bin/agy --dangerously-skip-permissions');
});

test('signedOut: a young log stuck on "not logged into Antigravity", not one that signed in or is too new/old', () => {
  const file = '/x/cli-20261005_122556.log';
  const start = new Date(2026, 9, 5, 12, 25, 56).getTime();
  const out = 'E1005 12:25:56.873763      75 errorreport.go:224] error getting token source: You are not logged into Antigravity.';
  const ok = `${out}\nI1005 12:25:57.440022     151 server_oauth.go:203] OAuth: authenticated successfully as hanptn@gmail.com`;
  assert.equal(signedOut(file, start + 60_000, out), true);
  assert.equal(signedOut(file, start + 60_000, ok), false);
  assert.equal(signedOut(file, start + 10_000, out), false); // still starting
  assert.equal(signedOut(file, start + 3600_000, out), false); // an old session is not a fresh terminal
});

test('rankAccounts skips disabled, token-less, blocked and still-exhausted accounts, then prefers clean, unloaded, priority', () => {
  const now = Date.parse('2026-10-05T05:00:00Z');
  const accounts = [
    { email: 'p1@x', active: true, refreshToken: 'r' },
    { email: 'p2@x', active: false, refreshToken: 'r' },
    { email: 'p3@x', active: true, refreshToken: null },
    { email: 'p4@x', active: true, refreshToken: 'r' },
    { email: 'p5@x', active: true, refreshToken: 'r' },
  ];
  const state = { exhausted: {
    'p1@x': { 'gemini-3.1-flash-image': '2026-10-05T06:00:00Z' },
    'p4@x': { 'gemini-3.1-flash-image': '2026-10-05T04:00:00Z', 'gemini-3.8-flash': '2026-10-05T09:00:00Z' },
  }, invalid: {} };
  const emails = (opts) => rankAccounts(accounts, state, { now, ...opts }).map((a) => a.email);
  // p4's image reset passed but it is still out for gemini-3.8-flash, so clean p5 goes first.
  assert.deepEqual(emails({ model: 'gemini-3.1-flash-image' }), ['p5@x', 'p4@x']);
  assert.deepEqual(emails({ model: 'gemini-3.8-flash' }), ['p5@x', 'p1@x']);
  // Any model: clean first; among clean ones the account fewer live slots hold.
  assert.deepEqual(emails({}), ['p5@x', 'p1@x', 'p4@x']);
  state.exhausted = {};
  assert.deepEqual(emails({ slots: [{ live: true, email: 'p1@x' }, { live: false, email: 'p4@x' }] }), ['p4@x', 'p5@x', 'p1@x']);
  state.invalid = { 'p1@x': '2026-10-06T00:00:00Z' };
  assert.deepEqual(emails({}), ['p4@x', 'p5@x']);
});
