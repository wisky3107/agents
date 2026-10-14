import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// orca.mjs reads KIT_MJS at import time: point it at a stub that records its argv.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-kit-'));
const stub = path.join(dir, 'kit.mjs');
fs.writeFileSync(stub, `import fs from 'node:fs';\nfs.writeFileSync(${JSON.stringify(path.join(dir, 'argv.json'))}, JSON.stringify(process.argv.slice(2)));\nconsole.log('1 feature(s) checked, 1 kept');\n`);
process.env.KIT_MJS = stub;
const io = await import('../scripts/lib/orca.mjs');
const { lessonRows } = await import('../scripts/lib/merge.mjs');

test('kitSliceCheck runs kit.mjs slice-check with the slice base and evidence dir', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-kit-proj-')), ev = path.join(root, 'ev');
  const r = io.kitSliceCheck(root, 'S04', 'abc123^', ev);
  assert.equal(r.ran, true);
  assert.equal(r.status, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'argv.json'), 'utf8')),
    ['slice-check', root, '--base', 'abc123^', '--write', ev, '--slice', 'S04']);
  assert.match(r.out, /1 kept/);
});

test('a learning candidate keeps its kit_signal in lessons.jsonl', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-kit-root-'));
  const ev = path.join(root, '.cursor/evidence/tasks/T-S04/evidence');
  fs.mkdirSync(ev, { recursive: true });
  const signal = { verdict: 'kit-possible', files: ['assets/scripts/modules/daily/DailyBonus.ts'], projects: ['cc-game'], blockers: 0 };
  fs.writeFileSync(path.join(ev, 'learning-candidates.json'), JSON.stringify([
    { id: 'kit-daily', kind: 'successful_pattern', topic: 't', finding: 'f', reuse_value: 'r', evidence: ['kit-check.json'], kit_signal: signal },
    { id: 'plain', kind: 'failure_fix', topic: 't', finding: 'f', reuse_value: 'r', evidence: ['review.md'] },
  ]));
  const rows = lessonRows(root, 'S04', {}, {}).filter((r) => r.event === 'recipe_candidate');
  assert.deepEqual(rows.find((r) => r.candidate_id.endsWith('/kit-daily')).kit_signal, signal);
  assert.equal('kit_signal' in rows.find((r) => r.candidate_id.endsWith('/plain')), false);
});
