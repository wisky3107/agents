import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// orca-wait against a fake `orca` that answers from fixture files (shapes copied from orca 1.4.218).
const SCRIPT = new URL('../scripts/orca-wait.mjs', import.meta.url).pathname;

function fakeOrca(fixtures) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-orca-wait-'));
  for (const [name, body] of Object.entries(fixtures)) fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(body));
  fs.writeFileSync(path.join(dir, 'orca'), `#!/bin/sh
echo "$*" >> "${dir}/calls.log"
case "$1 $2" in
  "--version "*) echo 1.4.218 ;;
  "orchestration check") cat "${dir}/check.json" ;;
  "orchestration run-show") cat "${dir}/run-show.json" ;;
  "orchestration gate-list") cat "${dir}/gates.json" ;;
  "orchestration inbox") cat "${dir}/inbox.json" ;;
  "terminal wait") cat "${dir}/wait.json" ;;
  *) echo '{"ok":false}'; exit 1 ;;
esac
`, { mode: 0o755 });
  return dir;
}
function run(bin, args, extraEnv = {}) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, TMPDIR: bin, CC_ROLE: '', ...extraEnv },
  });
  return { status: r.status, out: JSON.parse(r.stdout.trim().split('\n').pop()), calls: fs.readFileSync(path.join(bin, 'calls.log'), 'utf8') };
}
const delivery = {
  ok: true,
  result: {
    runId: 'run_5b4c', deliveryId: 'delivery_ed98', count: 1, timedOut: false,
    messages: [{
      id: 'msg_c130', type: 'worker_done', from_handle: 'term_701f', subject: 'T-S21 scan done',
      body: 'line one\nline two\nline three is long and should be cut', read: 0,
      payload: '{"taskId":"task_54bb","dispatchId":"ctx_655c","outcome":"succeeded"}',
    }],
  },
};

test('coord: one compact line, full Delivery on disk, ack and cap passed through', () => {
  const bin = fakeOrca({ check: delivery });
  const { out, calls } = run(bin, ['coord', '--ack', 'delivery_prev']);
  assert.equal(out.delivery, 'delivery_ed98');
  assert.deepEqual(out.messages[0], {
    id: 'msg_c130', type: 'worker_done', from: 'term_701f', subject: 'T-S21 scan done',
    task: 'task_54bb', dispatch: 'ctx_655c', outcome: 'succeeded', body: 'line one / line two',
  });
  assert.equal(JSON.parse(fs.readFileSync(out.full, 'utf8')).messages[0].body, delivery.result.messages[0].body);
  assert.match(calls, /orchestration check --ack delivery_prev --wait --types worker_done,escalation,question --timeout-ms 540000 --json/);
  fs.rmSync(bin, { recursive: true });
});

test('coord: timeout is a checkpoint; bad args fail fast', () => {
  const bin = fakeOrca({ check: { ok: true, result: { count: 0, timedOut: true, messages: [] } } });
  assert.equal(run(bin, ['coord', '--max-ms', '1000']).out.timeout, true);
  const bad = run(bin, ['coord', '--ack']);
  assert.equal(bad.status, 2);
  assert.match(bad.out.error, /--ack needs a value/);
  fs.rmSync(bin, { recursive: true });
});

test('lane (fleet): re-reads the coordinator handle, reports idle, keeps idle_streak across calls', () => {
  const bin = fakeOrca({
    'run-show': { ok: true, result: { run: { id: 'run_7eb5', coordinator_handle: 'term_gen3' } } },
    gates: { ok: true, result: { gates: [{ id: 'g1', status: 'resolved', question: 'old' }] } },
    wait: { ok: true, result: { wait: { handle: 'term_gen3', condition: 'tui-idle', satisfied: true } } },
    inbox: { ok: true, result: { messages: [{ to_handle: 'run:run_7eb5', read: 0 }, { to_handle: 'run:run_7eb5', read: 1 }] } },
  });
  const handoff = path.join(bin, 'HANDOFF.json');
  fs.writeFileSync(handoff, JSON.stringify({ status: 'working', detail: 'scan', sha: null }));
  const state = path.join(bin, 'main', 'producer-state.json');
  fs.mkdirSync(path.dirname(state));
  fs.writeFileSync(state, JSON.stringify({ handle: 'term_gen2', last_mtime: fs.statSync(handoff).mtimeMs, idle_streak: 1 }));
  const a = run(bin, ['lane', '--run', 'run_7eb5', '--handoff', handoff, '--state', state, '--max-ms', '5000']).out;
  // takeover: a new coordinator handle starts its own idle streak
  assert.deepEqual([a.event, a.handle, a.handle_changed, a.status, a.idle_streak, a.unread_to_run], ['idle', 'term_gen3', true, 'working', 1, 1]);
  assert.match(fs.readFileSync(path.join(bin, 'calls.log'), 'utf8'), /terminal wait --terminal term_gen3 --for tui-idle/);
  const b = run(bin, ['lane', '--run', 'run_7eb5', '--handoff', handoff, '--state', state, '--max-ms', '5000']).out;
  assert.equal(b.idle_streak, 2); // same terminal, still idle, HANDOFF unchanged
  fs.rmSync(bin, { recursive: true });
});

test('lane: a HANDOFF written between calls and a pending gate return at once', () => {
  const bin = fakeOrca({
    'run-show': { ok: true, result: { run: { coordinator_handle: 'term_1' } } },
    gates: { ok: true, result: { gates: [] } },
    wait: { ok: true, result: { wait: { satisfied: false } } },
    inbox: { ok: true, result: { messages: [] } },
  });
  const handoff = path.join(bin, 'HANDOFF.json');
  fs.writeFileSync(handoff, JSON.stringify({ status: 'working' }));
  const state = path.join(bin, 'state.json');
  fs.writeFileSync(state, JSON.stringify({ last_mtime: 1, idle_streak: 2 }));
  const a = run(bin, ['lane', '--handle', 'term_1', '--handoff', handoff, '--state', state, '--max-ms', '5000']).out;
  assert.deepEqual([a.event, a.handoff_changed, a.idle_streak], ['handoff', true, 0]);
  assert.doesNotMatch(fs.readFileSync(path.join(bin, 'calls.log'), 'utf8'), /terminal wait/); // no wait needed
  fs.writeFileSync(path.join(bin, 'gates.json'), JSON.stringify({ ok: true, result: { gates: [{ id: 'g2', status: 'pending', question: 'Approve PLAN?', options: '["approve","revise"]' }] } }));
  const b = run(bin, ['lane', '--run', 'run_1', '--handoff', handoff, '--state', state, '--max-ms', '5000']).out;
  assert.equal(b.event, 'gate');
  assert.deepEqual(b.pending_gates.map((g) => g.id), ['g2']);
  fs.rmSync(bin, { recursive: true });
});

test('lane: a timeout is a checkpoint, never past --max-ms', () => {
  const bin = fakeOrca({
    wait: { ok: true, result: { wait: { satisfied: false } } },
    inbox: { ok: true, result: { messages: [] } },
  });
  const handoff = path.join(bin, 'missing-HANDOFF.json');
  const t0 = Date.now();
  const out = run(bin, ['lane', '--handle', 'term_1', '--handoff', handoff, '--state', path.join(bin, 's.json'), '--max-ms', '1500', '--chunk-ms', '500']).out;
  assert.equal(out.event, 'timeout');
  assert.equal(out.status, null);
  assert.ok(Date.now() - t0 < 10000);
  fs.rmSync(bin, { recursive: true });
});

test('guard self-check: the hook entry for this call counts even after a long wait; none → inactive', () => {
  const bin = fakeOrca({ check: { ok: true, result: { count: 0, timedOut: true, messages: [] } } });
  const log = path.join(bin, 'guard.jsonl');
  const env = { CC_ROLE: 'coordinator', CC_PROJECT: '/p', CC_GUARD_LOG: log };
  assert.match(run(bin, ['coord'], env).out.notes.guard, /inactive/);
  fs.writeFileSync(log, JSON.stringify({ ts: new Date(Date.now() - 20000).toISOString(), cmd: 'node orca-wait.mjs coord', project: '/p' }) + '\n');
  assert.equal(run(bin, ['coord'], env).out.notes, undefined);
  fs.rmSync(bin, { recursive: true });
});

test('a failing orca is orca-error, a stale handle is terminal-missing; --max-ms is clamped', () => {
  const bin = fakeOrca({ inbox: { ok: true, result: { messages: [] } } });
  fs.writeFileSync(path.join(bin, 'wait.json'), JSON.stringify({ ok: false, error: { code: 'runtime_unreachable', message: 'connect ECONNREFUSED' } }));
  const script = path.join(bin, 'orca');
  fs.writeFileSync(script, fs.readFileSync(script, 'utf8').replace(/("terminal wait"\) cat "[^"]+")/, '$1; exit 1'));
  const a = run(bin, ['lane', '--handle', 't1', '--handoff', path.join(bin, 'h.json'), '--state', path.join(bin, 's.json'), '--max-ms', '900000']).out;
  assert.equal(a.event, 'orca-error');
  assert.match(fs.readFileSync(path.join(bin, 'calls.log'), 'utf8'), /--timeout-ms 60000/); // chunk; the total is clamped to 570000
  fs.writeFileSync(path.join(bin, 'wait.json'), JSON.stringify({ ok: false, error: { code: 'terminal_handle_stale' } }));
  assert.equal(run(bin, ['lane', '--handle', 't1', '--handoff', path.join(bin, 'h.json'), '--state', path.join(bin, 's.json')]).out.event, 'terminal-missing');
  fs.rmSync(bin, { recursive: true });
});
