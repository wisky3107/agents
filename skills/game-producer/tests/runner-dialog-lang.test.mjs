import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { NOTES, POLICY, project, fakes, env } from './harness.mjs';

// Pilot 8 (cc-love-train, 2026-10-06): the director could not read the question and its options, which
// the dialog's list rows cut off, and asked for them in Vietnamese. release.question_lang: vi → one
// translate call per question; the full options sit in the prompt, short numbered rows in the list, the
// pick maps back to the exact English option, and the last row opens the whole question.
const DIALOG = new URL('../scripts/answer-dialog.mjs', import.meta.url).pathname;
const OPTS = ['A: one-line // @ts-nocheck header (no logic change) on those 9 files, noted in FOLLOWUPS', 'B: add the kit/template folders to tsconfig exclude (widens the tsconfig edit beyond strict:true)', 'stop'];
const Q = { id: 'q1', key: 'S01:fleet_gate:g1', kind: 'fleet_gate', slice: 'S01', text: 'fleet gate g1: tsconfig strict:true gives 161 tsc errors outside the slice paths. Which option?', options: OPTS, ref: 'g1', answer: null, judge: { defer: 'judge deferred: the contracts rule out every option.' } };
const VI_TEXT = {
  summary: 'Bật strict cho tsconfig sinh ra 161 lỗi tsc nằm ngoài phạm vi slice. Chọn phương án nào?',
  why: 'Contract loại trừ mọi phương án.',
  options: ['A: thêm một dòng // @ts-nocheck (không đổi logic) vào 9 file đó, ghi vào FOLLOWUPS', 'B: thêm thư mục kit/template vào exclude của tsconfig (sửa tsconfig rộng hơn strict:true)', 'dừng'],
  labels: ['A: thêm // @ts-nocheck vào 9 file', 'B: exclude thư mục kit/template trong tsconfig, rộng hơn mức cho phép ban đầu', 'dừng'],
};
const VI = { summary: VI_TEXT.summary, why: VI_TEXT.why, options: VI_TEXT.options.map((text, i) => ({ n: i + 1, text, label: VI_TEXT.labels[i] })) };

// osascript stand-in: logs each run and answers with the next line of osa-replies (none left → cancel)
const FAKE_OSA = `#!/usr/bin/env node
const fs = require('fs'), path = require('path');
const D = process.env.FAKE_DIR, a = process.argv.slice(2);
const script = a.filter((x, i) => a[i - 1] === '-e').join('\\n');
const args = a.filter((x, i) => x !== '-e' && a[i - 1] !== '-e');
fs.appendFileSync(path.join(D, 'osa.log'), JSON.stringify({ kind: script.includes('choose from list') ? 'choose' : 'note', args }) + '\\n');
const f = path.join(D, 'osa-replies');
const left = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : [];
if (!left.length) process.exit(1);
fs.writeFileSync(f, JSON.stringify(left.slice(1)));
process.stdout.write(left[0] + '\\n');
`;
// claude -p stand-in: counts calls, keeps the prompt, prints translate-reply as claude's JSON envelope
const FAKE_TRANSLATE = `#!/usr/bin/env node
const fs = require('fs'), path = require('path');
const D = process.env.FAKE_DIR;
fs.writeFileSync(path.join(D, 'translate-prompt.txt'), fs.readFileSync(0, 'utf8'));
fs.appendFileSync(path.join(D, 'translate.log'), 'call\\n');
const f = path.join(D, 'translate-reply');
if (!fs.existsSync(f)) process.exit(1);
process.stdout.write(JSON.stringify({ is_error: false, result: '', structured_output: JSON.parse(fs.readFileSync(f, 'utf8')) }));
`;

function setup({ lang = 'vi', reply = VI, replies = [], question = {} } = {}) {
  const p = project({ notes: NOTES(POLICY, '{}', lang ? `  question_lang: ${lang}\n` : ''), slices: { S01: { needs: false } } });
  fs.mkdirSync(path.join(p.root, '.cursor'), { recursive: true });
  fs.writeFileSync(path.join(p.root, '.cursor', 'producer-runner.json'), JSON.stringify({ slice: 'S01', step: 'blocked:x', questions: [{ ...Q, ...question }] }));
  const f = fakes();
  for (const [name, body] of [['osascript-fake', FAKE_OSA], ['translate-fake', FAKE_TRANSLATE]]) fs.writeFileSync(path.join(f.dir, name), body, { mode: 0o755 });
  fs.writeFileSync(path.join(f.dir, 'opener'), `#!/bin/sh\ncp "$1" "${f.dir}/opened.txt"\n`, { mode: 0o755 });
  if (reply) fs.writeFileSync(path.join(f.dir, 'translate-reply'), JSON.stringify(reply));
  fs.writeFileSync(path.join(f.dir, 'osa-replies'), JSON.stringify(replies));
  return { p, f };
}
const run = ({ p, f }) => spawnSync(process.execPath, [DIALOG, '--project', p.root, '--id', 'q1'], {
  encoding: 'utf8', timeout: 20000,
  env: { ...env(p.root, f), PRODUCER_RUNNER_OSASCRIPT: path.join(f.dir, 'osascript-fake'), PRODUCER_RUNNER_TRANSLATE_CMD: path.join(f.dir, 'translate-fake'), PRODUCER_RUNNER_OPEN: path.join(f.dir, 'opener') },
});
const osaRuns = (f) => (fs.existsSync(path.join(f.dir, 'osa.log')) ? fs.readFileSync(path.join(f.dir, 'osa.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
const translateCalls = (f) => (fs.existsSync(path.join(f.dir, 'translate.log')) ? fs.readFileSync(path.join(f.dir, 'translate.log'), 'utf8').trim().split('\n').length : 0);
const q1 = (p) => JSON.parse(fs.readFileSync(path.join(p.root, '.cursor', 'producer-runner.json'), 'utf8')).questions[0];

test('question_lang vi: translated prompt with every option in full, numbered short rows, pick → exact English option', () => {
  const s = setup({ replies: ['1. A: thêm // @ts-nocheck vào 9 file', 'chỉ 9 file đó'] });
  assert.equal(run(s).status, 0);
  const [choose, note] = osaRuns(s.f);
  const [, prompt, ok, later, ...rows] = choose.args;
  assert.deepEqual([ok, later], ['Trả lời', 'Để sau']);
  assert.ok(prompt.includes(`\nq1 · fleet_gate · S01\n${VI.summary}\n\nVì sao judge để bạn quyết: ${VI.why}\n\nCác lựa chọn:\n1. ${VI_TEXT.options[0]}\n2. ${VI_TEXT.options[1]}\n3. dừng`));
  // list rows are short; a long label is cut there, never in the prompt
  assert.equal(rows[0], '1. A: thêm // @ts-nocheck vào 9 file');
  assert.ok(rows[1].length <= 70 && rows[1].endsWith('…'));
  assert.equal(rows.at(-1), 'Xem toàn văn (tiếng Việt + tiếng Anh)');
  assert.match(note.args[1], /^Ghi chú cho "1\. A: thêm \/\/ @ts-nocheck vào 9 file" \(không bắt buộc/);
  assert.deepEqual(note.args.slice(2), ['Bỏ qua', 'Gửi']);
  const a = q1(s.p).answer;
  assert.deepEqual([a.choice, a.text, a.via], [OPTS[0], 'chỉ 9 file đó', 'dialog']);
  // the translator saw the question, the judge's reason and every option word for word
  const sent = fs.readFileSync(path.join(s.f.dir, 'translate-prompt.txt'), 'utf8');
  for (const t of [Q.text, Q.judge.defer, ...OPTS]) assert.ok(sent.includes(t), t);
});

test('question_lang vi: the last row opens the whole question (Vietnamese + English), then the list comes back', () => {
  const s = setup({ replies: ['Xem toàn văn (tiếng Việt + tiếng Anh)'] });
  run(s);
  const opened = fs.readFileSync(path.join(s.f.dir, 'opened.txt'), 'utf8');
  // kept out of git by the existing .cursor/producer* exclude
  assert.ok(fs.existsSync(path.join(s.p.root, '.cursor', 'producer-questions', 'q1.txt')));
  for (const t of [VI.summary, ...VI_TEXT.options, Q.text, Q.judge.defer, ...OPTS]) assert.ok(opened.includes(t), t);
  const runs = osaRuns(s.f);
  assert.equal(runs.length, 2);
  assert.equal(runs[1].kind, 'choose');
  // cancelled the second time: no answer, and the translation is cached for the next dialog
  assert.equal(q1(s.p).answer, null);
  run(s);
  assert.equal(translateCalls(s.f), 1);
});

test('question_lang vi: a failed or incomplete translation leaves the dialog in English, and is not retried', () => {
  const s = setup({ reply: { ...VI, options: VI.options.slice(0, 2) }, replies: ['stop'] });
  run(s);
  const [choose] = osaRuns(s.f);
  assert.deepEqual(choose.args.slice(2), ['Answer', 'Later', ...OPTS, 'Show the whole question']);
  assert.ok(choose.args[1].includes(Q.text));
  assert.equal(q1(s.p).answer.choice, 'stop');
  assert.ok(q1(s.p).lang.failed);
});

test('no question_lang: no translate call, English dialog', () => {
  const s = setup({ lang: '', replies: [] });
  run(s);
  assert.equal(translateCalls(s.f), 0);
  assert.deepEqual(osaRuns(s.f)[0].args.slice(2, 4), ['Answer', 'Later']);
});

test('question_lang vi: options the model reordered are rejected (the pick maps by position)', () => {
  const s = setup({ reply: { ...VI, options: [VI.options[2], VI.options[0], VI.options[1]] }, replies: ['stop'] });
  run(s);
  assert.deepEqual(osaRuns(s.f)[0].args.slice(4), [...OPTS, 'Show the whole question']);
  assert.equal(q1(s.p).answer.choice, 'stop');
});

test('question_lang vi: a question rewritten under the same id is translated again; a recent failure is not retried, an old one is', () => {
  const s = setup({ replies: [] });
  run(s);
  assert.equal(translateCalls(s.f), 1);
  // the runner refreshed q1: other options, same id → the cached translation no longer applies
  const file = path.join(s.p.root, '.cursor', 'producer-runner.json');
  const r = JSON.parse(fs.readFileSync(file, 'utf8'));
  r.questions[0].options = ['stop', ...OPTS.slice(0, 2)];
  fs.writeFileSync(file, JSON.stringify(r));
  fs.rmSync(path.join(s.f.dir, 'translate-reply'));
  run(s);
  assert.equal(translateCalls(s.f), 2);
  assert.ok(q1(s.p).lang.failed);
  // English while the failure is recent
  assert.deepEqual(osaRuns(s.f).at(-1).args.slice(2, 4), ['Answer', 'Later']);
  run(s);
  assert.equal(translateCalls(s.f), 2);
  const r2 = JSON.parse(fs.readFileSync(file, 'utf8'));
  r2.questions[0].lang.at = new Date(Date.now() - 11 * 60 * 1000).toISOString();
  fs.writeFileSync(file, JSON.stringify(r2));
  run(s);
  assert.equal(translateCalls(s.f), 3);
});

test('question_lang vi: very long options are cut in the prompt (the whole text stays one row away)', () => {
  const long = (c) => c.repeat(1200);
  const reply = { ...VI, options: VI.options.map((o) => ({ ...o, text: long('x') })) };
  const s = setup({ reply, replies: [] });
  run(s);
  const prompt = osaRuns(s.f)[0].args[1];
  assert.ok(prompt.length < 2600 + 1000, String(prompt.length));
  assert.ok(prompt.includes(`1. ${'x'.repeat(296)}…`));
});
