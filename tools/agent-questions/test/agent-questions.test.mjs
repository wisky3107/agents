// agent-questions: the hook records what a Claude agent asks in an Orca terminal and closes it when
// the chat answers; `answer` types the director's answer into that terminal (fake orca here).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { quickReplies } from '../store.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, '..', 'agent-questions.mjs');
let root, env;

const run = (args, input, extra = {}) => {
  const r = spawnSync(process.execPath, [CLI, ...args], { input, encoding: 'utf8', env: { ...env, ...extra } });
  return { code: r.status, out: r.stdout, json: (() => { try { return JSON.parse(r.stdout); } catch { return null; } })(), err: r.stderr };
};
const hook = (payload, extra = {}) => run(['hook'], JSON.stringify(payload), { ORCA_TERMINAL_HANDLE: 'term_1', CLAUDE_CODE_ENTRYPOINT: 'cli', ...extra });
const list = (all = false) => run(['list', ...(all ? ['--all'] : [])]).json.questions;
const orcaCalls = () => fs.readFileSync(path.join(root, 'orca.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'aq-'));
  const orca = path.join(root, 'orca');
  // records its argv; `terminal show` says connected unless the handle is term_gone
  fs.writeFileSync(orca, `#!${process.execPath}\nconst fs = require('fs');\nconst a = process.argv.slice(2);\nfs.appendFileSync(${JSON.stringify(path.join(root, 'orca.jsonl'))}, JSON.stringify(a) + '\\n');\nif (a[1] === 'show') { const h = a[a.indexOf('--terminal') + 1]; console.log(JSON.stringify({ ok: true, result: { terminal: { handle: h, connected: h !== 'term_gone' } } })); }\nelse console.log(JSON.stringify({ ok: true, result: {} }));\n`, { mode: 0o755 });
  fs.mkdirSync(path.join(root, 'proj', '.git'), { recursive: true });
  fs.writeFileSync(path.join(root, 'proj', 'shot.png'), 'png');
  env = { ...process.env, AGENT_QUESTIONS_HOME: path.join(root, 'store'), AGENT_QUESTIONS_LOG: path.join(root, 'aq.jsonl'), AGENT_QUESTIONS_ORCA: orca, AGENT_QUESTIONS_WORKSPACES: path.join(root, 'ws'), AGENT_QUESTIONS_GAMES_ROOT: path.join(root, 'games') };
});
after(() => fs.rmSync(root, { recursive: true, force: true }));

const ASK = { questions: [{ header: 'Scope', question: 'Ship S05 now?', multiSelect: false, options: [{ label: 'Yes', description: 'merge it' }, { label: 'No', description: 'see shot.png first' }] }] };

test('hook: an AskUserQuestion becomes one open question with its options and images; the chat answer closes it', () => {
  const r = hook({ hook_event_name: 'PreToolUse', session_id: 's1', tool_name: 'AskUserQuestion', tool_use_id: 'tu1', tool_input: ASK, cwd: path.join(root, 'proj') });
  assert.equal(r.code, 0);
  assert.equal(r.out, '', 'a hook prints nothing (UserPromptSubmit stdout would become context)');
  const [q] = list();
  assert.deepEqual([q.kind, q.project, q.handle, q.questions[0].options.map((o) => o.label)], ['ask', 'proj', 'term_1', ['Yes', 'No']]);
  assert.deepEqual(q.images, [path.join(root, 'proj', 'shot.png')]);
  hook({ hook_event_name: 'PostToolUse', session_id: 's1', tool_name: 'AskUserQuestion', tool_use_id: 'tu1', tool_response: { answers: { 'Ship S05 now?': 'Yes' } } });
  assert.equal(list().length, 0);
  const done = list(true).find((x) => x.id === q.id);
  assert.deepEqual([done.status, done.answer.via], ['answered', 'chat']);
});

test('hook: a turn that ends on a question is one; a statement is not; the next prompt answers it; runner lanes and sessions outside Orca are skipped', () => {
  hook({ hook_event_name: 'Stop', session_id: 's2', last_assistant_message: 'Done. All tests pass.', cwd: root });
  hook({ hook_event_name: 'Stop', session_id: 's2', last_assistant_message: 'Bạn chọn Vàng (ghi chú: test). Let me know if you need more.', cwd: root });
  assert.equal(list().length, 0);
  hook({ hook_event_name: 'Stop', session_id: 's2', last_assistant_message: 'Plan ready (see `a?b`).\n\nBạn muốn mình chia 3 slice hay 4 slice?', cwd: root });
  const [q] = list();
  assert.equal(q.kind, 'stop');
  hook({ hook_event_name: 'UserPromptSubmit', session_id: 's2', prompt: '3 slice' });
  assert.equal(list().length, 0);
  assert.equal(list(true).find((x) => x.id === q.id).answer.text, '3 slice');
  hook({ hook_event_name: 'Stop', session_id: 's3', last_assistant_message: 'Should I merge?' }, { CC_ROLE: 'worker' });
  hook({ hook_event_name: 'Stop', session_id: 's4', last_assistant_message: 'Should I merge?' }, { ORCA_TERMINAL_HANDLE: '' });
  hook({ hook_event_name: 'Stop', session_id: 's5', last_assistant_message: 'Should I merge?' }, { CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' });
  assert.equal(list().length, 0);
});

test('answer: an open dialog is closed with Esc, then the picks go in as one chat message; a closed question is refused', () => {
  hook({ hook_event_name: 'PreToolUse', session_id: 's6', tool_name: 'AskUserQuestion', tool_use_id: 'tu6', tool_input: ASK, cwd: root });
  const [q] = list();
  assert.equal(run(['answer', '--id', q.id, '--pick', '1=Maybe']).code, 1, 'not an option');
  const r = run(['answer', '--id', q.id, '--pick', '1=Yes', '--text', 'after the\nsmoke run']);
  assert.equal(r.code, 0, r.out);
  const c = orcaCalls().slice(-6);
  assert.deepEqual(c.map((a) => a.slice(0, 2).join(' ')), ['terminal show', 'terminal send', 'terminal wait', 'terminal read', 'terminal send', 'terminal send']);
  assert.equal(c[1][c[1].indexOf('--text') + 1], '\u001b', 'a raw Esc closes the dialog');
  // Orca keeps the pane marked blocked after the Esc: the answer is typed raw, then a raw Enter
  assert.match(c[4][c[4].indexOf('--text') + 1], /\(1\) Scope: Yes · Ghi chú: after the \/ smoke run/);
  assert.ok(!c[4].includes('--enter'));
  assert.equal(c[5][c[5].indexOf('--text') + 1], '\r');
  // our own keystrokes fire UserPromptSubmit: the console answer stays the answer
  hook({ hook_event_name: 'UserPromptSubmit', session_id: 's6', prompt: 'x' });
  assert.equal(list(true).find((x) => x.id === q.id).answer.via, 'console');
  assert.equal(run(['answer', '--id', q.id, '--pick', '1=Yes']).code, 1);
});

test('answer: a plain question gets the text without an interrupt; a gone terminal closes the question; dismiss needs a note', () => {
  hook({ hook_event_name: 'Stop', session_id: 's7', last_assistant_message: 'OK không?' });
  const [q] = list();
  const before = orcaCalls().length;
  assert.equal(run(['answer', '--id', q.id, '--text', 'ok, làm đi']).code, 0);
  assert.ok(!orcaCalls().slice(before).some((a) => a.includes('\u001b')));
  hook({ hook_event_name: 'Stop', session_id: 's8', last_assistant_message: 'Bạn chọn A hay B?' }, { ORCA_TERMINAL_HANDLE: 'term_gone' });
  const [g] = list();
  assert.equal(run(['answer', '--id', g.id, '--text', 'A']).code, 1);
  assert.equal(list(true).find((x) => x.id === g.id).status, 'gone');
  hook({ hook_event_name: 'Stop', session_id: 's9', last_assistant_message: 'Bạn chọn A hay B?' });
  const [d] = list();
  assert.equal(run(['dismiss', '--id', d.id]).code, 1);
  assert.equal(run(['dismiss', '--id', d.id, '--note', 'đã nói qua chat']).json.status, 'dismissed');
});

test('install-hook: adds each event once, keeps other hooks and a backup', () => {
  const f = path.join(root, 'settings.json');
  fs.writeFileSync(f, JSON.stringify({ model: 'x', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'other' }] }] } }));
  assert.deepEqual(run(['install-hook', '--settings', f]).json.added, ['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Stop', 'UserPromptSubmit', 'SessionEnd']);
  assert.deepEqual(run(['install-hook', '--settings', f]).json.added, []);
  const s = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert.equal(s.model, 'x');
  assert.equal(s.hooks.Stop.length, 2);
  assert.equal(s.hooks.PreToolUse[0].matcher, 'AskUserQuestion');
  assert.ok(fs.existsSync(`${f}.bak-agent-questions`));
});

test('quick replies: the action it names, the options it lists, short "A hay B" sides, yes/no; none for a statement or an open question', () => {
  const labels = (t) => quickReplies(t).map((r) => r.label);
  assert.deepEqual(labels('Xong rồi. Bạn có muốn mình commit không?'), ['Commit đi', 'Chưa, để sau']);
  assert.deepEqual(labels('Should I push and deploy to prod?'), ['Push đi', 'Deploy đi', 'Chưa, để sau']);
  assert.deepEqual(labels('Chia mấy slice?\n1. 3 slice\n2. 4 slice'), ['1. 3 slice', '2. 4 slice']);
  assert.equal(quickReplies('Chia mấy slice?\n1. 3 slice\n2. 4 slice')[1].text, 'Chọn 2: 4 slice');
  assert.deepEqual(labels('Mình nên dùng Spine hay sprite sheet?'), ['Spine', 'sprite sheet']);
  assert.deepEqual(labels('OK không?'), ['Có, làm đi', 'Không']);
  assert.deepEqual(labels('Đã xong, tất cả test pass.'), []);
  assert.deepEqual(labels('Bạn muốn đặt tên con mèo là gì?'), []);
});
