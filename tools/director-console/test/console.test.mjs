// Director console: the page is local-only (Host check, token on every /api call), reads the
// systems' real state, and runs nothing but the allowlisted CLIs, each logged.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, '..', 'server.mjs');
const REAL_RUNNER_LIB = path.join(os.homedir(), '.agents/skills/game-producer/scripts/lib');
const TOKEN = 'test-token-123';
let root, home, repo, srv, port, logs;

const call = (method, p, { token = TOKEN, host, body, type = 'application/json', headers = {} } = {}) => new Promise((resolve, reject) => {
  const data = body === undefined ? null : typeof body === 'string' ? body : JSON.stringify(body);
  const req = http.request({ host: '127.0.0.1', port, path: p, method, headers: {
    host: host ?? `127.0.0.1:${port}`, ...headers, ...(token ? { 'x-console-token': token } : {}), ...(data ? { 'content-type': type, 'content-length': Buffer.byteLength(data) } : {}),
  } }, (res) => {
    let s = '';
    res.on('data', (c) => (s += c));
    res.on('end', () => { let j = null; try { j = JSON.parse(s); } catch {} resolve({ status: res.statusCode, json: j, text: s }); });
  });
  req.on('error', reject);
  if (data) req.write(data);
  req.end();
});

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-'));
  home = path.join(root, 'om-home');
  logs = path.join(root, 'logs');
  const games = path.join(root, 'games');
  repo = path.join(games, 'cc-a');
  fs.mkdirSync(path.join(repo, '.cursor', 'evidence', 'tasks', 'T-S01', 'evidence'), { recursive: true });
  execFileSync('git', ['init', '-q', repo]);
  fs.writeFileSync(path.join(repo, '.cursor', 'producer-runner.json'), JSON.stringify({ slice: 'S01', step: 'lane', questions: [
    { id: 'q1', kind: 'fleet_gate', slice: 'S01', asked_at: '2026-10-07T00:00:00Z', text: 'gate: pick one', options: ['A: go', 'answer with --text', 'stop'], answer: null,
      key: 'S01:fleet_gate:gate_1', ref: 'gate_1', obs: null, judge: { at: '2026-10-07T00:00:10Z', defer: 'a scope call: the director decides' } },
    { id: 'q0', kind: 'verify_manual', slice: 'S01', text: 'done', options: ['ok'], answer: { choice: 'ok' } },
  ] }));
  fs.writeFileSync(path.join(repo, '.cursor', 'evidence', 'tasks', 'T-S01', 'evidence', 'manual-deferred.json'), JSON.stringify({ items: ['real device rotation'], policy: 'defer' }));
  // signed off already (Step 3 or the console): not a quest any more
  fs.mkdirSync(path.join(repo, '.cursor', 'evidence', 'tasks', 'T-S02', 'evidence'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.cursor', 'evidence', 'tasks', 'T-S02', 'evidence', 'manual-deferred.json'), JSON.stringify({ v: 2, items: ['fps on device'], signed_off: { at: '2026-10-07T00:00:00Z', by: 'director', note: 'waived: no device' } }));
  fs.mkdirSync(path.join(home, 'config'), { recursive: true });
  fs.writeFileSync(path.join(home, 'config', 'projects.json'), JSON.stringify({ projects: [{
    project_id: 'cc-a', paths: [repo], domain: 'cocos', stack: { engine_version: '3.8.8', mode: '2d', target: 'web-mobile' },
    data_owner: 'internal', memory: { mode: 'off', backend: 'local' }, evidence_dir: '.cursor/evidence',
  }], playbook_root: null, hindsight: { url: 'http://127.0.0.1:1' } }));
  // the runner's real state/project/answer modules, and a fake runner CLI that records its argv
  const runnerDir = path.join(root, 'runner');
  fs.mkdirSync(runnerDir);
  fs.symlinkSync(REAL_RUNNER_LIB, path.join(runnerDir, 'lib'));
  fs.writeFileSync(path.join(runnerDir, 'producer-runner.mjs'), `import fs from 'node:fs';\nfs.appendFileSync(${JSON.stringify(path.join(root, 'runner-argv.jsonl'))}, JSON.stringify(process.argv.slice(2)) + '\\n');\nconsole.log(JSON.stringify({ ok: true }));\n`);
  const orca = path.join(root, 'orca');
  fs.writeFileSync(orca, '#!/bin/sh\necho \'{"result":{"terminals":[]}}\'\n', { mode: 0o755 });
  // stands in for `claude -p` in the runner's translate.mjs: one Vietnamese entry per option
  const translator = path.join(root, 'translate');
  fs.writeFileSync(translator, `#!${process.execPath}\nlet s = '';\nprocess.stdin.on('data', (c) => (s += c)).on('end', () => {\n  const n = Number(s.match(/exactly (\\d+) entries/)[1]);\n  console.log(JSON.stringify({ structured_output: { summary: 'Cổng: chọn một hướng', why: 'Đây là quyết định phạm vi', options: Array.from({ length: n }, (_, i) => ({ n: i + 1, text: 'Lựa chọn ' + (i + 1) + ' đầy đủ', label: 'Lựa chọn ' + (i + 1) })) } }));\n});\n`, { mode: 0o755 });
  const playbook = path.join(root, 'playbook');
  fs.mkdirSync(path.join(playbook, 'recipes'), { recursive: true });
  fs.writeFileSync(path.join(playbook, 'registry.json'), JSON.stringify({ recipes: [{ id: 'r1', status: 'candidate', path: 'recipes/r1.md', summary: 'one recipe' }] }));
  fs.writeFileSync(path.join(playbook, 'recipes', 'r1.md'), '# r1\n');
  fs.writeFileSync(path.join(root, 'secret.md'), 'outside');
  // res-guard: no watcher state until the resources test writes one; a fake CLI records its argv
  fs.writeFileSync(path.join(root, 'res-guard.mjs'), `import fs from 'node:fs';\nfs.appendFileSync(${JSON.stringify(path.join(root, 'rg-argv.jsonl'))}, JSON.stringify(process.argv.slice(2)) + '\\n');\nconsole.log('closed');\n`);
  port = 17000 + Math.floor(Math.random() * 2000);
  srv = spawn(process.execPath, [SERVER], { env: { ...process.env, ORCA_MEMORY_HOME: home, CONSOLE_PORT: String(port), CONSOLE_TOKEN: TOKEN, CONSOLE_GAMES_ROOT: games, CONSOLE_RUNNER_DIR: runnerDir, CONSOLE_ORCA_BIN: orca, CONSOLE_PLAYBOOK: playbook, CONSOLE_LOG_DIR: logs, CONSOLE_RES_GUARD_HOME: path.join(root, 'rg'), CONSOLE_RES_GUARD_CLI: path.join(root, 'res-guard.mjs'), PRODUCER_RUNNER_TRANSLATE_CMD: translator, CC_SPAWN_REGISTRY: path.join(root, 'spawns.jsonl'), CONSOLE_TAILNET_HOST: 'mac.tail0.ts.net', CONSOLE_TAILNET_USERS: 'me@example.com' }, stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((resolve) => srv.stdout.once('data', resolve));
});

after(() => {
  srv?.kill();
  fs.rmSync(root, { recursive: true, force: true });
});

test('local only: a foreign Host is refused, every /api call needs the token, the page itself does not', async () => {
  assert.equal((await call('GET', '/api/overview', { host: 'evil.example:80' })).status, 403);
  assert.equal((await call('GET', '/api/overview', { token: null })).status, 401);
  assert.equal((await call('GET', '/api/overview', { token: 'wrong' })).status, 401);
  const page = await call('GET', '/', { token: null });
  assert.equal(page.status, 200);
  assert.match(page.text, /Director Console/);
  assert.equal((await call('GET', '/scorecard', { token: null })).status, 401);
});

test('page: assets come only from the allowlist, under a CSP with no inline script', async () => {
  const page = await call('GET', '/', { token: null });
  assert.doesNotMatch(page.text, /<script>(?!<\/script>)[^<]/, 'no inline script body');
  assert.match(page.text, /<script src="\/assets\/app\.js"><\/script>/);
  for (const f of ['app.css', 'app.js', 'graph.js']) assert.equal((await call('GET', `/assets/${f}`, { token: null })).status, 200, f);
  for (const f of ['server.mjs', '..%2Fserver.mjs', 'index.html', 'evil.js']) assert.equal((await call('GET', `/assets/${f}`, { token: null })).status, 404, f);
  const csp = await new Promise((resolve) => http.get({ host: '127.0.0.1', port, path: '/', headers: { host: `127.0.0.1:${port}` } }, (res) => { res.resume(); resolve(res.headers['content-security-policy']); }));
  assert.match(csp, /script-src 'self'/);
  assert.match(csp, /frame-ancestors 'none'/);
});

test('tailnet: through tailscale serve only the listed login gets in, and the token is still required', async () => {
  const tn = { host: 'mac.tail0.ts.net' };
  assert.equal((await call('GET', '/api/overview', tn)).status, 403, 'tailnet host without a login header');
  assert.equal((await call('GET', '/api/overview', { ...tn, headers: { 'tailscale-user-login': 'other@example.com' } })).status, 403);
  assert.equal((await call('GET', '/api/overview', { ...tn, headers: { 'tailscale-user-login': 'ME@example.com' } })).status, 200);
  assert.equal((await call('GET', '/api/overview', { ...tn, token: null, headers: { 'tailscale-user-login': 'me@example.com' } })).status, 401);
  assert.equal((await call('GET', '/', { host: 'mac.tail0.ts.net:443', token: null, headers: { 'tailscale-user-login': 'me@example.com' } })).status, 200);
  assert.equal((await call('GET', '/api/overview', { headers: { 'tailscale-user-login': 'other@example.com' } })).status, 403, 'a forwarded login on the local host is checked too');
  assert.equal((await call('GET', '/api/overview', { host: 'other.tail0.ts.net' })).status, 403);
});

test('overview: projects with memory mode and runner state; pending holds only open questions, with note rules', async () => {
  const r = await call('GET', '/api/overview');
  assert.equal(r.status, 200);
  const [p] = r.json.projects;
  assert.deepEqual([p.id, p.mode, p.runner.slice, p.runner.step, p.runner.open_questions], ['cc-a', 'off', 'S01', 'lane', 1]);
  const q = r.json.pending.questions;
  assert.deepEqual(q.map((x) => x.id), ['q1']);
  assert.deepEqual(q[0].options.map((o) => [o.choice, o.note]), [['A: go', 'optional'], ['answer with --text', 'required'], ['stop', null]]);
  assert.deepEqual(r.json.pending.manual_deferred, [{ project: 'cc-a', slice: 'S01', items: ['real device rotation'] }]);
});

test('runner question: everything the dialog shows, and a Vietnamese translation through the runner\'s own translate code', async () => {
  let q = (await call('GET', '/api/pending')).json.questions[0];
  assert.deepEqual([q.key, q.ref, q.judge.defer, q.also], ['S01:fleet_gate:gate_1', 'gate_1', 'a scope call: the director decides', []]);
  assert.ok(q.context[0].startsWith('cc-a'), 'where the run stands, from the runner\'s questionContext');
  // English until the background translation lands, then Vietnamese from q.lang
  for (let i = 0; i < 50 && !q.vi; i++) {
    await new Promise((r) => setTimeout(r, 100));
    q = (await call('GET', '/api/pending')).json.questions[0];
  }
  assert.equal(q.vi_state, 'ok');
  assert.deepEqual([q.vi.summary, q.vi.why], ['Cổng: chọn một hướng', 'Đây là quyết định phạm vi']);
  assert.deepEqual(q.options.map((o) => [o.choice, o.vi_label, o.vi_text]), [['A: go', 'Lựa chọn 1', 'Lựa chọn 1 đầy đủ'], ['answer with --text', 'Lựa chọn 2', 'Lựa chọn 2 đầy đủ'], ['stop', 'Lựa chọn 3', 'Lựa chọn 3 đầy đủ']]);
  // cached on the question like the runner's dialog does, so neither asks again
  const stored = JSON.parse(fs.readFileSync(path.join(repo, '.cursor', 'producer-runner.json'), 'utf8')).questions.find((x) => x.id === 'q1');
  assert.equal(stored.lang.summary, 'Cổng: chọn một hướng');
  assert.equal((await call('GET', '/api/attention')).json.items.find((x) => x.kind === 'runner').body, 'Cổng: chọn một hướng');
});

test('attention: one keyed row per thing that needs the director; a stopped runner is not "down"', async () => {
  assert.equal((await call('GET', '/api/attention', { token: null })).status, 401);
  const r = await call('GET', '/api/attention');
  assert.equal(r.status, 200);
  const byKey = Object.fromEntries(r.json.items.map((x) => [x.key, x]));
  assert.deepEqual(Object.keys(byKey).sort(), ['runner-down:cc-a:S01:', 'runner:cc-a:q1']);
  assert.deepEqual([byKey['runner:cc-a:q1'].level, byKey['runner:cc-a:q1'].quest, byKey['runner:cc-a:q1'].href], ['critical', 'runner', '#quests']);
  assert.equal(byKey['runner-down:cc-a:S01:'].href, '#worlds/cc-a');
  assert.ok(!r.json.items.some((x) => x.kind === 'manual'), 'deferred manual checks wait for ship, not for a decision');
  // the overview carries the same rows, so a visible tab needs no second call
  assert.deepEqual((await call('GET', '/api/overview')).json.attention.map((x) => x.key).sort(), Object.keys(byKey).sort());
  const control = path.join(repo, '.cursor', 'producer.control');
  fs.writeFileSync(control, 'stop\n');
  try {
    assert.deepEqual((await call('GET', '/api/attention')).json.items.map((x) => x.key), ['runner:cc-a:q1']);
  } finally {
    fs.rmSync(control);
  }
});

test('actions: only allowlisted, JSON only; runner.answer runs the runner CLI with the same argv and is logged', async () => {
  assert.equal((await call('POST', '/api/action/shell.exec', { body: {} })).status, 404);
  assert.equal((await call('POST', '/api/action/runner.answer', { body: 'id=q1', type: 'text/plain' })).status, 415);
  assert.equal((await call('POST', '/api/action/runner.answer', { body: { project: 'cc-x', id: 'q1', choice: 'A: go' } })).status, 400, 'an unknown project');
  const r = await call('POST', '/api/action/runner.answer', { body: { project: 'cc-a', id: 'q1', choice: 'A: go', text: 'ship it' } });
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  const argv = fs.readFileSync(path.join(root, 'runner-argv.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(argv.at(-1), ['answer', '--project', repo, '--id', 'q1', '--choice', 'A: go', '--text', 'ship it']);
  await call('POST', '/api/action/runner.control', { body: { project: 'cc-a', cmd: 'stop-after', slice: 'S02' } });
  assert.deepEqual(fs.readFileSync(path.join(root, 'runner-argv.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).at(-1), ['stop-after', 'S02', '--project', repo]);
  assert.equal((await call('POST', '/api/action/runner.control', { body: { project: 'cc-a', cmd: 'rm -rf' } })).status, 400);
  // a manual sign-off goes through the runner's sign-off; the note must say done or waived
  assert.equal((await call('POST', '/api/action/manual.signoff', { body: { project: 'cc-a', slice: 'S01', how: 'maybe', note: 'x' } })).status, 400);
  assert.equal((await call('POST', '/api/action/manual.signoff', { body: { project: 'cc-a', slice: 'S01', how: 'done' } })).status, 400, 'a note is required');
  await call('POST', '/api/action/manual.signoff', { body: { project: 'cc-a', slice: 'S01', how: 'done', note: 'iPhone 13 ok' } });
  assert.deepEqual(fs.readFileSync(path.join(root, 'runner-argv.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).at(-1), ['sign-off', 'S01', '--note', 'done: iPhone 13 ok', '--project', repo]);
  const log = fs.readFileSync(path.join(logs, 'director-console.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(log.map((l) => l.action), ['runner.answer', 'runner.control', 'manual.signoff']);
});

test('memory.mode goes through the orca-memory CLI: a missing note is refused, a real switch is audited', async () => {
  assert.equal((await call('POST', '/api/action/memory.mode', { body: { project: 'cc-a', mode: 'shadow' } })).status, 400);
  const r = await call('POST', '/api/action/memory.mode', { body: { project: 'cc-a', mode: 'shadow', note: 'from the console' } });
  assert.equal(r.json.ok, true, JSON.stringify(r.json));
  assert.deepEqual([r.json.out.from, r.json.out.to], ['off', 'shadow']);
  const modeLog = fs.readFileSync(path.join(home, 'config', 'mode-log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(modeLog.at(-1).note, 'from the console');
  assert.equal((await call('GET', '/api/overview')).json.projects[0].mode, 'shadow');
});

test('files: a judge draft must live in the drafts dir; a recipe must live in the playbook', async () => {
  const bad = await call('POST', '/api/action/draft.apply', { body: { file: path.join(root, 'secret.md'), rows: [] } });
  assert.equal(bad.status, 400);
  assert.equal((await call('GET', '/api/recipe?path=recipes/r1.md')).json.text, '# r1\n');
  assert.equal((await call('GET', `/api/recipe?path=${encodeURIComponent('../secret.md')}`)).status, 400);
});

test('agent-written files: deferred checks and round counts in every shape become plain values', async () => {
  const { deferredItems, rounds } = await import('../lib.mjs');
  assert.deepEqual(deferredItems({ items: ['a', ' ', 'b'] }), ['a', 'b']);
  assert.deepEqual(deferredItems({ items: [{ item: 'V5 landscape', reason: 'emulated' }, { row: 'feel rows' }, { other: 1 }] }), ['V5 landscape (emulated)', 'feel rows', '{"other":1}']);
  assert.deepEqual(deferredItems({ items: { status: 'manual', items: ['real device'] } }), ['real device']);
  assert.deepEqual(deferredItems({ v: 2, items: ['{"row":"fps on device","reason":"no device"}', '{not json'] }), ['fps on device (no device)', '{not json']);
  assert.deepEqual(deferredItems(null), []);
  assert.deepEqual([rounds(2), rounds([{ round: 1 }, { round: 2 }]), rounds({ count: 3 }), rounds('x'), rounds(null)], [2, 2, 3, null, null]);
});

test('resources: res-guard state becomes the resources payload and live attention rows; editor.close runs only its CLI with an absolute path', async () => {
  const rg = path.join(root, 'rg');
  fs.mkdirSync(path.join(rg, 'run', 'res-guard'), { recursive: true });
  fs.mkdirSync(path.join(rg, 'logs', 'res-guard'), { recursive: true });
  const now = new Date().toISOString();
  const last = { at: now, availPct: 38, pressure: 'warn', swapUsedMB: 4700, compressorMB: 6000, diskFreeGB: 58, editors: [{ pid: 9, project: '/g/cc-a', footMB: 2300 }], claude: { n: 3, footMB: 900 }, omniroute: { pid: 5, footMB: 1000 }, top: [] };
  const state = { lastTick: now, last, alerts: [{ key: 'swap:high', level: 'warning', title: 'Swap 4.6 GB', body: 'CocosCreator 0.5 GB' }],
    editorVerdicts: [{ pid: 9, project: '/g/cc-a', footMB: 2300, verdict: 'keep', why: 'in use: worker S07 (pid 1)' }] };
  fs.writeFileSync(path.join(rg, 'run', 'res-guard', 'state.json'), JSON.stringify(state));
  fs.writeFileSync(path.join(rg, 'logs', 'res-guard', `samples-${now.slice(0, 10)}.jsonl`), [JSON.stringify({ ...last, at: new Date(Date.now() - 60000).toISOString() }), JSON.stringify(last)].join('\n') + '\n');
  fs.writeFileSync(path.join(rg, 'logs', 'res-guard.jsonl'), JSON.stringify({ at: now, kind: 'editor_close', project: '/g/cc-b', why: 'idle 21 min' }) + '\n');
  const r = (await call('GET', '/api/resources')).json;
  assert.equal(r.stale, false);
  assert.deepEqual(r.trend.map((p) => [p.availPct, p.swapGB, p.editors]), [[38, 4.6, 1], [38, 4.6, 1]]);
  assert.equal(r.editors[0].verdict, 'keep');
  assert.equal(r.events[0].kind, 'editor_close');
  const keys = (await call('GET', '/api/attention')).json.items.map((i) => i.key);
  assert.ok(keys.includes('res-guard:swap:high'));
  // a watcher that stopped ticking is one warning row, not stale numbers
  fs.writeFileSync(path.join(rg, 'run', 'res-guard', 'state.json'), JSON.stringify({ ...state, lastTick: '2026-10-07T00:00:00Z' }));
  const rows = (await call('GET', '/api/attention')).json.items.filter((i) => i.key.startsWith('res-guard:'));
  assert.deepEqual(rows.map((i) => [i.key, i.level, i.href]), [['res-guard:stale', 'warning', '#resources']]);
  assert.equal((await call('POST', '/api/action/editor.close', { body: { project: 'relative/path' } })).status, 400);
  assert.equal((await call('POST', '/api/action/editor.close', { body: { project: '/g/cc-a' } })).json.ok, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'rg-argv.jsonl'), 'utf8').trim()), ['close-editor', '--project', '/g/cc-a', '--reason', 'director console']);
  fs.rmSync(path.join(rg, 'run'), { recursive: true });
});
