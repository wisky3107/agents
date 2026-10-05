import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { specCommands, slicePaths, outOfScope, nanUnsafe, es5Errors } from '../scripts/check-slice.mjs';

const SCRIPT = new URL('../scripts/check-slice.mjs', import.meta.url).pathname;

test('specCommands: the tsc/node lines after Run:, optional [args] and trailing (notes) dropped', () => {
  const src = `/**
 * Engine-free tests. AssistControls imports 'cc', so a stub loads first. Run:
 *   tsc tests/a.spec.ts temp/declarations/*.d.ts --outDir /tmp/s06u --module commonjs
 *   node /tmp/s06u/tests/a.spec.js [levels.json]
 *   node /tmp/s11u/pipeline.spec.js            (from the repository root; needs python3 + PIL)
 */
import x from 'y';`;
  assert.deepEqual(specCommands(src), [
    'tsc tests/a.spec.ts temp/declarations/*.d.ts --outDir /tmp/s06u --module commonjs',
    'node /tmp/s06u/tests/a.spec.js',
    'node /tmp/s11u/pipeline.spec.js',
  ]);
  assert.deepEqual(specCommands('/** no header */'), []);
});

test('slicePaths: block and inline lists, comments stripped, scene_objects ignored', () => {
  const block = `---
id: S11
paths:
  code:
    - tools/a.mjs        # new ~90
    - assets/scripts/T.ts  # edit
  art:
    - assets/art/x/**
  scene_objects: [Canvas/UI]
assets:
  2d: []
`;
  assert.deepEqual(slicePaths(block), ['tools/a.mjs', 'assets/scripts/T.ts', 'assets/art/x/**']);
  assert.deepEqual(slicePaths('paths:\n  code: [a.ts, b/c.ts]\n  art:  [d/**]\n  scene_objects: []\nnext: 1\n'), ['a.ts', 'b/c.ts', 'd/**']);
  assert.equal(slicePaths('id: S1\n'), null);
});

test('outOfScope: slice paths, their .meta, new folder .meta and the usual test/evidence places are inside', () => {
  const allowed = ['assets/scripts/game/New.ts', 'assets/art/ui/**'];
  const changed = ['assets/scripts/game/New.ts', 'assets/scripts/game/New.ts.meta', 'assets/scripts/game.meta',
    'assets/art/ui/a/b.png', 'tests/x.spec.ts', 'scripts/smoke/checks/S12-01.check.js', '.cursor/evidence/tasks/T-S12/x.md',
    'docs/flows/a.md', 'FOLLOWUPS.md', 'assets/scripts/Other.ts', 'tools/levels/x.mjs', '.gitignore'];
  assert.deepEqual(outOfScope(changed, allowed), ['assets/scripts/Other.ts', 'tools/levels/x.mjs', '.gitignore']);
});

test('nanUnsafe: negative-form guards flagged; !(…), isFinite, // finite: and cap checks are not', () => {
  const src = [
    "if (t.bandCss < LIMITS.band) fail('bandOk', 'x');",                           // 1 flagged
    "if (o.drawCalls > 6 || o.activeNodes > 6) { out.cost = false; }",            // 2 flagged
    "if (!(t.bandCss >= LIMITS.band)) fail('bandOk', 'x');",                       // 3 ok
    "if (!Number.isFinite(b) || b < 6) fail('c', 'x');",                           // 4 ok
    "if (frames > LIMITS.glideFrames) fail('glide', 'x'); // finite: loop counter", // 5 ok
    "const fail = (k, w) => { out[k] = false; if (out.failing.length < 40) out.failing.push(w); };", // 6 ok
    "if (a === b) fail('eq', 'x');",                                               // 7 ok
    "const f = (x) => x >= 3;",                                                    // 8 ok
  ].join('\n');
  assert.deepEqual(nanUnsafe(src).map((h) => h.line), [1, 2]);
});

test('es5Errors: TS2802 in assets/ only (tests run under node, not the web build)', () => {
  const lines = [
    "assets/scripts/LayerMeshBuilder.ts(135,26): error TS2802: Type 'IterableIterator<Mesh>' can only be iterated through ...",
    "tests/a.spec.ts(181,16): error TS2802: Type 'Set<string>' can only be iterated through ...",
    "assets/scripts/B.ts(1,1): error TS2307: Cannot find module 'cc'",
  ];
  assert.deepEqual(es5Errors(lines), [lines[0]]);
});

function repo() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'check-slice-'));
  const g = (...a) => spawnSync('git', a, { cwd: d, encoding: 'utf8' });
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 't@t'); g('config', 'user.name', 't');
  fs.mkdirSync(path.join(d, 'tests'));
  fs.mkdirSync(path.join(d, 'slices'));
  fs.writeFileSync(path.join(d, 'slices/S12-x.md'), 'id: S12\npaths:\n  code: [src/a.js]\n  art: []\n');
  fs.writeFileSync(path.join(d, 'tests/ok.spec.ts'), '/**\n * Run:\n *   node -e "process.exit(0)"\n */\n');
  g('add', '-A'); g('commit', '-qm', 'base');
  return { d, g };
}
const exec = (d, ...a) => spawnSync(process.execPath, [SCRIPT, '--root', d, ...a], { encoding: 'utf8' });

test('end to end: an old spec gone red fails, out-of-slice paths warn, NaN-unsafe changed checks fail', () => {
  const { d } = repo();
  let r = exec(d, '--slice', 'slices/S12-x.md');
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /SKIP tsc: no tsconfig\.json/);
  assert.match(r.stdout, /PASS specs: 1\/1 specs/);
  assert.match(r.stdout, /RESULT PASS/);

  fs.writeFileSync(path.join(d, 'tests/old.spec.ts'), '/**\n * Run:\n *   node -e "console.log(\'FAIL placement\'); process.exit(1)"\n */\n');
  fs.writeFileSync(path.join(d, 'tests/nohead.spec.ts'), '// no header\n');
  fs.mkdirSync(path.join(d, 'src')); fs.writeFileSync(path.join(d, 'src/a.js'), '1');
  fs.mkdirSync(path.join(d, 'tools')); fs.writeFileSync(path.join(d, 'tools/b.js'), '1');
  fs.mkdirSync(path.join(d, 'scripts/smoke/checks'), { recursive: true });
  fs.writeFileSync(path.join(d, 'scripts/smoke/checks/S12-01.check.js'), "if (band < 6) fail('bandOk', 'x');\n");
  r = exec(d, '--slice', 'slices/S12-x.md', '--out', '.cursor/evidence/tasks/T-S12/evidence/static-check.txt');
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stdout, /FAIL specs: 2\/3 spec\(s\) failed/);
  assert.match(r.stdout, /tests\/nohead\.spec\.ts: no `Run:` header/);
  assert.match(r.stdout, /FAIL placement/);
  assert.match(r.stdout, /WARN scope: 1 path\(s\)[^\n]*\n  tools\/b\.js\n/);
  assert.match(r.stdout, /FAIL smoke-lint[^\n]*\n  scripts\/smoke\/checks\/S12-01\.check\.js:1:/);
  assert.match(r.stdout, /RESULT FAIL \(specs, smoke-lint, scope\)/);
  assert.equal(fs.readFileSync(path.join(d, '.cursor/evidence/tasks/T-S12/evidence/static-check.txt'), 'utf8'), r.stdout);
});
