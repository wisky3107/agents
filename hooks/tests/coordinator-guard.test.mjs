import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { classify, emptyState, guard, inputFromPayload, stripHeredocs } from '../coordinator-guard.mjs';

// Commands marked (real) are copied from producer / fleet-coordinator transcripts, 2026-09-24..10-01
// (Claude and Codex), with ids shortened.
const CORE = new URL('../coordinator-guard.mjs', import.meta.url).pathname;

/** Run commands in order through one session; return the verdict + rule of each. */
function session(role, ...commands) {
  let st = emptyState();
  return commands.map((command) => {
    const r = classify({ command }, role, st);
    st = r.state;
    return `${r.verdict}${r.rule ? `:${r.rule}` : ''}`;
  });
}
const one = (role, command) => session(role, command)[0];

test('allowlist: the protocol commands pass for a coordinator', () => {
  for (const cmd of [
    'orca orchestration check --wait --types worker_done,escalation,question --timeout-ms 540000 --json 2>/dev/null', // (real)
    'orca orchestration check --ack delivery_05e1 --wait --types worker_done,escalation,question --timeout-ms 540000 --json',
    'orca orchestration check --ack delivery_093 --run run_ad65 --json 2>/dev/null >/dev/null', // (real) ack without wait
    'orca orchestration check --peek --json',
    'orca orchestration check --all --json',
    'orca orchestration inbox --json',
    'orca orchestration run-show --id run_7eb5 --json',
    'orca orchestration run-list --json',
    'orca orchestration gate-list --run run_7eb5 --json',
    'orca terminal list --json',
    'orca terminal send --terminal term_1 --text "approved — commit" --enter --json',
    'orca terminal wait --terminal term_1 --for tui-idle --timeout-ms 540000 --json >/dev/null', // producer SKILL as written
    'node ~/.agents/skills/cocos-orca-fleet/scripts/orca-wait.mjs coord --ack delivery_1',
    'node ~/.agents/skills/new-cocos-game/scripts/bootstrap.mjs wait-mcp --path /w --timeout-ms 180000',
    'sleep 5',
    'git -C /p merge --no-ff feat/S01',
  ]) assert.equal(one('coordinator', cmd), 'allow', cmd);
});

test('wake-up protocol: one bare check after a wait is fine, a second is polling', () => {
  assert.deepEqual(session('coordinator',
    'orca orchestration check --wait --types worker_done --timeout-ms 540000 --json',
    'orca orchestration check --json', // after "You have N orchestration message(s)…"
    'orca orchestration check --run run_5482 --json 2>&1', // (real) second bare check
    'orca orchestration check --ack d1 --wait --timeout-ms 540000 --json',
    'orca orchestration check --json',
  ), ['allow', 'allow', 'deny:check-polling', 'allow', 'allow']);
});

test('terminal read: bounded, first look free, again only after a wait or send (a timed-out wait counts)', () => {
  assert.equal(one('coordinator', 'orca terminal read --terminal term_d474 --limit 120 --json'), 'deny:read-unbounded'); // (real)
  assert.equal(one('coordinator', 'orca terminal read --terminal term_8d4b --json | python3 -c "import json,sys; print(1)"'), 'allow'); // piped
  assert.deepEqual(session('producer',
    'orca terminal read --terminal term_1 --limit 40 --json',
    'sleep 2; orca terminal read --terminal term_1 --limit 40 --json | jq -r ".result.terminal.tail[]"', // (real)
    'orca terminal wait --terminal term_1 --for tui-idle --timeout-ms 90000 --json', // may time out: recipe B then reads
    'orca terminal read --terminal term_1 --screen --json',
    'orca terminal send --terminal term_1 --text "resume" --enter --json',
    'orca terminal read --terminal term_1 --limit 30 --json',
    'orca terminal read --terminal term_2 --limit 30 --json', // another terminal: first look
  ), ['allow', 'deny:read-without-wait', 'allow', 'allow', 'allow', 'allow', 'allow']);
  assert.deepEqual(session('producer',
    'node orca-wait.mjs lane --run run_1 --handoff h.json --state s.json',
    'orca terminal read --terminal term_9 --limit 40 --json',
  ), ['allow', 'allow']);
});

test('sleeps and sleep loops (real HANDOFF watchers) are polling', () => {
  assert.equal(one('producer', 'sleep 45 && echo "wait complete"'), 'deny:long-sleep'); // (real)
  assert.equal(one('producer',
    'W=/w/T-S20/evidence/HANDOFF.json; for i in $(seq 1 57); do s=$(python3 -c "print(1)" $W); case "$s" in *ready*) break;; esac; sleep 20; done'), // (real)
  'deny:sleep-loop');
  assert.equal(one('coordinator',
    'for i in $(seq 1 24); do OUT=$(node .cursor/skills/vibe-game-director/scripts/probe.mjs --only funplay 2>&1); echo "$OUT" | grep -q true && break; sleep 5; done'), // (real) parity retry
  'deny:sleep-loop');
  // a message that merely says "while" and "sleep" is not a loop
  assert.equal(one('coordinator', 'orca terminal send --terminal t --text "while the writer sleeps, keep waiting" --enter --json'), 'allow');
});

test('detached and over-cap waits', () => {
  assert.equal(one('coordinator',
    'orca orchestration check --wait --types worker_done,escalation,question --timeout-ms 540000 --run run_2fd9 --json > /tmp/s08-fix-specs/wait-f6.json 2>&1; echo DONE_$?'), // (real, cap lowered)
  'deny:detached-wait');
  assert.equal(one('coordinator', 'nohup orca orchestration check --wait --timeout-ms 540000 --json &'), 'deny:detached-wait');
  assert.equal(one('coordinator', 'orca orchestration check --run run_669e --wait --types worker_done --timeout-ms 900000 --json'), 'deny:wait-over-cap'); // (real)
  assert.equal(one('producer', 'orca terminal wait --terminal term_b996 --for tui-idle --timeout-ms 600000 --json 2>&1'), 'deny:wait-over-cap'); // (real)
  // another command's redirect on the same line is not the wait's
  assert.equal(one('coordinator',
    'H=$(orca terminal create --worktree id:w --title impl --command "claude" --json | jq -er .result.handle); echo "$H" > .cursor/evidence/h.txt; orca terminal wait --terminal "$H" --for tui-idle --timeout-ms 90000 --json'),
  'allow');
});

test('--help: once per subcommand per session, then the cheatsheet', () => {
  assert.deepEqual(session('coordinator',
    'orca orchestration task-create --help 2>&1 | head -60', // (real)
    'orca orchestration task-create --help',
    'orca orchestration worker-start --help',
  ), ['warn:help-first', 'deny:help-repeat', 'warn:help-first']);
});

test('producer never mutates a lane Run; prompt text and --help do not count', () => {
  for (const cmd of [
    'orca orchestration gate-resolve --id gate_2844 --resolution "accept_deviation: row 6"', // (real)
    'orca orchestration run-use --run run_2fd9 --json 2>&1 | head -40', // (real)
    'orca orchestration send --run run_2fd9 --to "run:run_2fd9" --subject "Correction" --type "decision_gate" --body "x"', // (real)
    'SPEC=$(cat /tmp/spec.txt) orca orchestration task-create --spec "$SPEC" --run run_2fd9 --from term_c226', // (real)
    'orca orchestration worker-start --task task_3845 --terminal term_4487 --run run_2fd9 --from term_c226', // (real)
  ]) assert.equal(one('producer', cmd), 'deny:producer-lane-run', cmd);
  assert.equal(one('coordinator', 'orca orchestration gate-resolve --id g1 --resolution approve'), 'allow'); // the coordinator's own gate
  assert.equal(one('producer', 'orca orchestration worker-show --dispatch ctx_1 --json'), 'allow'); // read-only
  assert.equal(one('producer', "MSG='You are the fleet COORDINATOR. Run orca orchestration run-use --takeover-legacy first.'; orca terminal send --terminal t --text \"$MSG\" --enter"), 'allow'); // (real shape)
  assert.equal(one('producer', 'orca orchestration gate-resolve --help'), 'warn:help-first');
});

test('global MCP configs: every role; reads, mcp-audit and per-checkout files are fine', () => {
  for (const role of ['worker', 'coordinator', 'producer']) {
    assert.equal(one(role, "python3 - <<'EOF'\nimport json\nd=json.load(open('/Users/u/.config/opencode/opencode.json'))\nopen('/Users/u/.config/opencode/opencode.json','w').write('{}')\nEOF"), 'allow',
      'heredoc body is data; the open(...,"w") inside it is not seen — documented limit');
    assert.equal(one(role, 'cp ~/.config/opencode/opencode.json ~/.config/opencode/opencode.json.S08-backup'), 'allow'); // (real) a backup only reads it
    assert.equal(one(role, 'cp /tmp/oc.json ~/.config/opencode/opencode.json'), 'deny:global-mcp-config');
    assert.equal(one(role, 'echo x > "$HOME/.cursor/mcp.json"'), 'deny:global-mcp-config');
    assert.equal(one(role, 'grep install ~/.codex/config.toml'), 'allow');
    assert.equal(one(role, "sed -i '' 's/8771/8778/' ~/.codex/config.toml"), 'deny:global-mcp-config');
    assert.equal(one(role, 'codex mcp add funplay_cocos --url http://127.0.0.1:8778/'), 'deny:global-mcp-config');
    assert.equal(classify({ filePath: path.join(os.homedir(), '.cursor', 'mcp.json') }, role).rule, 'global-mcp-config');
    assert.equal(one(role, 'cat ~/.codex/config.toml'), 'allow');
    assert.equal(one(role, 'node ~/.agents/skills/new-cocos-game/scripts/bootstrap.mjs mcp-audit --fix'), 'allow');
    assert.equal(classify({ filePath: '/w/cc-x/.cursor/mcp.json' }, role).verdict, 'allow');
  }
  assert.equal(one('worker', 'sleep 300'), 'allow'); // wait rules are for producer / coordinator only
});

test('heredoc bodies are data, not commands', () => {
  const spec = "cat > .cursor/evidence/tasks/T-S02/specs/review2.md <<'EOF'\norca orchestration check --wait --timeout-ms 900000 --json > /tmp/x.json &\nsleep 600\nEOF";
  assert.equal(stripHeredocs(spec), "cat > .cursor/evidence/tasks/T-S02/specs/review2.md <<'EOF'");
  assert.equal(one('coordinator', spec), 'allow'); // (real shape)
});

test('guard(): CC_ROLE gate, shadow vs block vs off, log line', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-'));
  const env = { CC_GUARD_LOG: path.join(tmp, 'g.jsonl'), TMPDIR: tmp };
  const old = { CC_GUARD_LOG: process.env.CC_GUARD_LOG, TMPDIR: process.env.TMPDIR };
  Object.assign(process.env, env);
  try {
    const cmd = { command: 'sleep 90' };
    assert.deepEqual(guard('claude', 's0', cmd, {}), { block: false, message: '' }); // no CC_ROLE: inert
    assert.equal(guard('claude', 's1', cmd, { CC_ROLE: 'coordinator' }).block, false); // shadow default
    const b = guard('claude', 's2', cmd, { CC_ROLE: 'coordinator', CC_GUARD_MODE: 'block' });
    assert.equal(b.block, true);
    assert.match(b.message, /coordinator-guard \(long-sleep\)/);
    assert.equal(guard('claude', 's3', cmd, { CC_ROLE: 'coordinator', CC_GUARD_MODE: 'off' }).block, false);
    const lines = fs.readFileSync(env.CC_GUARD_LOG, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(lines.map((l) => [l.session_id, l.verdict, l.blocked]), [['s1', 'deny', false], ['s2', 'deny', true]]);
  } finally {
    for (const [k, v] of Object.entries(old)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    fs.rmSync(tmp, { recursive: true });
  }
});

test('adapters: payload mapping and CLI I/O (claude/codex exit 2 + stderr; cursor JSON)', () => {
  const codexPayload = { session_id: 'c1', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'sleep 99' } }; // codex 0.160 shape
  assert.deepEqual(inputFromPayload('codex', codexPayload), { sessionId: 'c1', input: { command: 'sleep 99', background: false } });
  assert.equal(inputFromPayload('codex', { session_id: 'c', tool_name: 'apply_patch', tool_input: { command: 'sleep 45' } }).input, null); // not a shell tool
  assert.equal(inputFromPayload('claude', { session_id: 'c', tool_name: 'Bash', tool_input: { command: 'x', run_in_background: true } }).input.background, true);
  assert.deepEqual(inputFromPayload('claude', { session_id: 'a', tool_name: 'Write', tool_input: { file_path: '/x/y' } }), { sessionId: 'a', input: { filePath: '/x/y' } });
  assert.deepEqual(inputFromPayload('cursor', { conversation_id: 'k', command: 'ls' }), { sessionId: 'k', input: { command: 'ls' } });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-cli-'));
  const env = { ...process.env, CC_ROLE: 'coordinator', CC_GUARD_MODE: 'block', CC_GUARD_LOG: path.join(tmp, 'g.jsonl'), TMPDIR: tmp };
  const run = (cli, payload) => spawnSync(process.execPath, [CORE, '--cli', cli], { input: JSON.stringify(payload), encoding: 'utf8', env });
  const denied = run('codex', codexPayload);
  assert.equal(denied.status, 2);
  assert.match(denied.stderr, /long-sleep/);
  assert.equal(run('claude', { session_id: 'a2', tool_name: 'Bash', tool_input: { command: 'ls' } }).status, 0);
  const cur = run('cursor', { conversation_id: 'k2', command: 'sleep 99' });
  assert.equal(JSON.parse(cur.stdout).permission, 'deny');
  assert.equal(JSON.parse(run('cursor', { conversation_id: 'k3', command: 'ls' }).stdout).permission, 'allow');
  assert.equal(spawnSync(process.execPath, [CORE, '--cli', 'claude'], { input: 'not json', encoding: 'utf8', env }).status, 0); // fail open
  fs.rmSync(tmp, { recursive: true });
});

test('review round 1: quoted text, arguments and comments are data; nested commands and tool flags count', () => {
  for (const [role, cmds] of [
    ['coordinator', ['orca terminal send --terminal t --text "do x; orca terminal read --terminal t2" --enter']],
    ['coordinator', ['orca terminal send --terminal t --text "a\norca orchestration check --json" --enter', 'orca terminal send --terminal t --text "b\norca orchestration check --json" --enter']],
    ['coordinator', ['orca terminal send --terminal t --text "run orca worker-start --help" --enter', 'orca terminal send --terminal t --text "run orca worker-start --help" --enter']],
    ['producer', ['orca terminal send --terminal t --text "You are the coordinator.\norca orchestration run-use --id r1" --enter']],
    ['producer', ['echo "- blocked sleep 45" >> producer-log.md']],
    ['coordinator', ['rg "sleep 45" skills/', 'git commit -m "replace sleep 60 loop"', 'for f in a b; do echo $f; done; sleep 2']],
    ['producer', ['orca orchestration dispatch-show --task t1 --json']],
    ['coordinator', ['orca terminal read --terminal t --cursor 120 --json']],
    ['coordinator', ['orca terminal read --terminal w1 --limit 20 --json', 'orca orchestration check --wait --timeout-ms 540000 --json', 'orca terminal read --terminal w1 --limit 20 --json']],
    ['coordinator', ['ls # orca orchestration check --json; sleep 99']],
  ]) assert.ok(session(role, ...cmds).every((v) => v === 'allow'), `${role}: ${cmds.join(' ‖ ')}`);
  assert.deepEqual(session('coordinator', 'R=$(orca orchestration check --json)', 'R=$(orca orchestration check --json)'), ['allow', 'deny:check-polling']);
  assert.equal(one('producer', 'for i in 1; do orca orchestration send --to run:r --body x; done'), 'deny:producer-lane-run');
  assert.equal(one('coordinator', 'sleep 1m'), 'deny:long-sleep');
  assert.equal(one('coordinator', 'orca terminal wait --terminal t --for tui-idle --timeout-ms 500000 &> /tmp/w.json'), 'deny:detached-wait');
  assert.equal(one('coordinator', 'orca orchestration check --wait \\\n  --timeout-ms 900000 --json'), 'deny:wait-over-cap');
  assert.equal(classify({ command: 'orca orchestration check --wait --timeout-ms 540000 --json', background: true }, 'coordinator').rule, 'detached-wait');
});

test('linear time on hostile input; stale state expires', () => {
  let t = Date.now();
  classify({ command: 'for a do sleep 1 '.repeat(500) }, 'coordinator');
  classify({ command: 'echo x; '.repeat(60000) }, 'coordinator');
  assert.ok(Date.now() - t < 2000, `took ${Date.now() - t} ms`);
  const old = { ...emptyState(), bareChecks: 1, updated: new Date(Date.now() - 13 * 3600 * 1000).toISOString() };
  assert.equal(classify({ command: 'orca orchestration check --json' }, 'coordinator', old).verdict, 'allow');
});
