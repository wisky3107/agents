import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseCards, loadCards, placeholders, fill, clean, parts, render } from '../scripts/spec-templates.mjs';

// The real role cards: every role the fleet driver dispatches must have a body and only known placeholders.
const BASE = { EVIDENCE_ROOT: '.cursor/evidence/tasks/T-S06/evidence', FEATURE: 'S06-spider-forest', ROLE: 'implement', TASK_ID: 'T-S06', WORKTREE_PATH: '/w/S06', ART_PATHS: 'assets/Arts/forest' };

test('real cards: header + every driver role parse, implement skips its boot prompt', () => {
  const cards = loadCards();
  assert.match(cards.header, /^Project rules are binding/);
  for (const role of ['scan', 'implement', 'integrate', 'review', 'fix', 'art-manifest', 'art-import-<stem>', 'art-concept-<stem>', 'art-mesh-<stem>', 'art-anim-<stem>', 'art / art-2d', 'art'])
    assert.ok(cards.byKey.get(role)?.fences.length, `no spec block for ${role}`);
  const implement = parts(cards, 'implement');
  assert.equal(implement.length, 2);
  assert.match(implement[1], /^ROLE: writer\./);
  assert.ok(!implement.some(t => t.includes('AGENTS.md loaded — workspace rules understood')));
});

test('real cards: render implement fills everything; evidence root line names the evidence dir', () => {
  const out = render('implement', BASE);
  assert.match(out, /Evidence root \.cursor\/evidence\/tasks\/T-S06\/evidence\/ \(every path written evidence\/x/);
  assert.match(out, /docs\/plans\/S06-spider-forest\.md/);
  assert.deepEqual(placeholders(out), []);
  assert.match(out, /"updatedAt":"<ISO>"/, 'worker-fill placeholders stay');
  assert.match(out, /`## work order` subsection for your role/);
});

test('real cards: a stem role resolves to its <stem> card; animated adds the addendum; a missing value throws', () => {
  const cards = loadCards();
  assert.throws(() => render('art-mesh-truck', BASE, {}, cards), /unfilled placeholders: .*STEM/);
  const plain = parts(cards, 'art-concept-cat'), anim = parts(cards, 'art-concept-cat', { animated: true });
  assert.equal(anim.length, plain.length + 1);
  assert.match(anim.at(-1), /This concept feeds an auto-rig/);
});

test('real cards: art-2d takes the backend block; unknown backend throws', () => {
  const cards = loadCards();
  const out = parts(cards, 'art-2d', { backend: 'antigravity' });
  assert.match(out[1], /^ROLE: writer \(assets\) — 2D textures\/sprites only/);
  assert.equal(out.length, 3);
  assert.equal(parts(cards, 'art-2d', { backend: 'codex-image', uiKit: true }).length, 4);
  assert.throws(() => parts(cards, 'art-2d', { backend: 'nope' }), /no art-2d block for backend nope/);
});

test('parseCards: headings, addendum marker, fences outside text ignored', () => {
  const md = ['# T', '```text', 'HDR <TASK_ID>', '```', '## a-<stem> (x)', '```text', 'body <STEM>', '```',
    '**Animated addendum** (append)', '```text', 'extra', '```', '```bash', 'not a spec', '```', '### b / c', '```text', 'bc', '```'].join('\n');
  const s = parseCards(md);
  assert.deepEqual(s.map(x => x.key), ['', 'a-<stem>', 'b / c']);
  assert.deepEqual(s[1].fences.map(f => f.addendum), [false, true]);
  assert.equal(s[0].fences[0].text, 'HDR <TASK_ID>');
});

test('fill: aliases, unknown lower-case stays, clean strips the clean_spec.py set', () => {
  assert.equal(fill('<feature> <row forward> <n>', { FEATURE: 'f', ROW_FORWARD: '+Z' }), 'f +Z <n>');
  assert.throws(() => fill('<row expect_dims>', {}), /ROW_EXPECT_DIMS/);
  assert.equal(clean('.cur‍sor­﻿⁦x'), '.cursorx');
});

test('cli: render writes the spec; list --json names roles', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-tpl-'));
  fs.writeFileSync(path.join(dir, 'v.json'), JSON.stringify(BASE));
  const script = new URL('../scripts/spec-templates.mjs', import.meta.url).pathname;
  const r = spawnSync(process.execPath, [script, 'render', '--role', 'review', '--values', path.join(dir, 'v.json')], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Task id T-S06/);
  const l = spawnSync(process.execPath, [script, 'list', '--json'], { encoding: 'utf8' });
  assert.ok(JSON.parse(l.stdout)['art-mesh-<stem>'].includes('TRI_BUDGET'));
});
