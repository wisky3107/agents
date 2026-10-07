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

const call = (method, p, { token = TOKEN, host, body, type = 'application/json' } = {}) => new Promise((resolve, reject) => {
  const data = body === undefined ? null : typeof body === 'string' ? body : JSON.stringify(body);
  const req = http.request({ host: '127.0.0.1', port, path: p, method, headers: {
    host: host ?? `127.0.0.1:${port}`, ...(token ? { 'x-console-token': token } : {}), ...(data ? { 'content-type': type, 'content-length': Buffer.byteLength(data) } : {}),
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
    { id: 'q1', kind: 'fleet_gate', slice: 'S01', asked_at: '2026-10-07T00:00:00Z', text: 'gate: pick one', options: ['A: go', 'answer with --text', 'stop'], answer: null },
    { id: 'q0', kind: 'verify_manual', slice: 'S01', text: 'done', options: ['ok'], answer: { choice: 'ok' } },
  ] }));
  fs.writeFileSync(path.join(repo, '.cursor', 'evidence', 'tasks', 'T-S01', 'evidence', 'manual-deferred.json'), JSON.stringify({ items: ['real device rotation'], policy: 'defer' }));
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
  const playbook = path.join(root, 'playbook');
  fs.mkdirSync(path.join(playbook, 'recipes'), { recursive: true });
  fs.writeFileSync(path.join(playbook, 'registry.json'), JSON.stringify({ recipes: [{ id: 'r1', status: 'candidate', path: 'recipes/r1.md', summary: 'one recipe' }] }));
  fs.writeFileSync(path.join(playbook, 'recipes', 'r1.md'), '# r1\n');
  fs.writeFileSync(path.join(root, 'secret.md'), 'outside');
  port = 17000 + Math.floor(Math.random() * 2000);
  srv = spawn(process.execPath, [SERVER], { env: { ...process.env, ORCA_MEMORY_HOME: home, CONSOLE_PORT: String(port), CONSOLE_TOKEN: TOKEN, CONSOLE_GAMES_ROOT: games, CONSOLE_RUNNER_DIR: runnerDir, CONSOLE_ORCA_BIN: orca, CONSOLE_PLAYBOOK: playbook, CONSOLE_LOG_DIR: logs }, stdio: ['ignore', 'pipe', 'inherit'] });
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
  const log = fs.readFileSync(path.join(logs, 'director-console.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(log.map((l) => l.action), ['runner.answer', 'runner.control']);
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
  assert.deepEqual(deferredItems(null), []);
  assert.deepEqual([rounds(2), rounds([{ round: 1 }, { round: 2 }]), rounds({ count: 3 }), rounds('x'), rounds(null)], [2, 2, 3, null, null]);
});
