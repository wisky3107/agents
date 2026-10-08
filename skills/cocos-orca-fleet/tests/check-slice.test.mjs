import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { specCommands, slicePaths, outOfScope, nanUnsafe, es5Errors, sliceFacts, evidenceRe, section, classifyErrors, assumptionNotes } from '../scripts/check-slice.mjs';

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

test('sliceFacts / evidenceRe / section: ids, named evidence paths and their matchers', () => {
  const src = `---\nid: S12\nacceptance:\n  - text: "A-12-01 / GP-3 the pack loads"\n    evidence: GIVEN\n  - text: "no id on this row"\n    evidence: ASSUMPTION\nplaytest:\n  - "capture docs/evidence/S12/V1-<id>.png and docs/evidence/S12/after/Vn-start|win.png, then docs/evidence/S12/perf.md."\n---\n`;
  const f = sliceFacts(src);
  assert.deepEqual([f.id, f.rows], ['S12', ['A-12-01', '#2']]);
  assert.deepEqual(f.evidence, ['docs/evidence/S12/V1-<id>.png', 'docs/evidence/S12/after/Vn-start', 'docs/evidence/S12/perf.md']);
  assert.ok(evidenceRe('docs/evidence/S12/V1-<id>.png').test('docs/evidence/S12/V1-L54.png'));
  assert.ok(!evidenceRe('docs/evidence/S12/V1-<id>.png').test('docs/evidence/S12/V2-L54.png'));
  assert.ok(evidenceRe('docs/evidence/S12/after/Vn-start').test('docs/evidence/S12/after/V3-start.png'));
  assert.ok(evidenceRe('docs/evidence/S12/**').test('docs/evidence/S12/a/b.json'));
  assert.equal(section('# N\n## Gaps\n- a\n## Next\nx', 'gaps'), '- a');
  assert.equal(section('# N\n', 'gaps'), null);
});

test('evidence + notes: missing named evidence fails unless deferred; stale evidence warns; notes sections enforced', () => {
  const { d, g } = repo();
  fs.writeFileSync(path.join(d, 'slices/S12-x.md'), `---\nid: S12\npaths:\n  code: [src/a.js]\nacceptance:\n  - text: "A-12-01 loads"\n    evidence: GIVEN\n  - text: "A-12-02 saves"\n    evidence: GIVEN\nplaytest:\n  - "write docs/evidence/S12/perf.md and docs/evidence/S12/V1-<id>.png"\n---\n`);
  g('add', '-A'); g('commit', '-qm', 'slice');
  const notes = path.join(d, '.cursor/evidence/tasks/T-S12/evidence/integration-notes.md');
  fs.mkdirSync(path.dirname(notes), { recursive: true });
  fs.writeFileSync(notes, '# notes\n## acceptance map\n| row | check |\n|---|---|\n| A-12-01 | tests/ok.spec.ts |\n## gaps\n- L57 off-playfield at V2\n');
  fs.mkdirSync(path.join(d, 'docs/evidence/S12'), { recursive: true });
  fs.writeFileSync(path.join(d, 'docs/evidence/S12/perf.md'), 'perf');
  const old = new Date(Date.now() - 60000);
  fs.utimesSync(path.join(d, 'docs/evidence/S12/perf.md'), old, old);
  fs.mkdirSync(path.join(d, 'src')); fs.writeFileSync(path.join(d, 'src/a.js'), '1');
  fs.mkdirSync(path.join(d, 'scripts/smoke/checks'), { recursive: true });
  fs.writeFileSync(path.join(d, 'scripts/smoke/checks/S12-01-load.check.js'), "if (!(n >= 1)) fail('x');\n");
  let r = exec(d, '--slice', 'slices/S12-x.md', '--only', 'evidence,notes');
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stdout, /FAIL evidence: 1 named evidence path\(s\) missing[^\n]*\n  missing: docs\/evidence\/S12\/V1-<id>\.png\n  older than src\/a\.js/);
  assert.match(r.stdout, /acceptance map: A-12-02 has no check named/);
  assert.match(r.stdout, /gap without a disposition[^\n]*L57 off-playfield/);
  assert.match(r.stdout, /no `## negative controls` section/);

  fs.writeFileSync(notes, '# notes\n## acceptance map\n| A-12-01 | tests/ok.spec.ts |\n| A-12-02 | manual: phone |\n## gaps\n- L57 off-playfield at V2 → followup F-14\n## negative controls\n- S12-01-load: n = NaN → FAIL\n## evidence deferred\n- docs/evidence/S12/V1-<id>.png: phone capture, manual_required\n');
  fs.writeFileSync(path.join(d, 'docs/evidence/S12/perf.md'), 'perf again');
  r = exec(d, '--slice', 'slices/S12-x.md', '--only', 'evidence,notes');
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /PASS evidence: 2 named path\(s\) present/);
  assert.match(r.stdout, /PASS notes: 2 acceptance row\(s\) mapped, 1 negative control\(s\)/);
  assert.match(exec(d, '--slice', 'slices/S12-x.md', '--skip', 'evidence,notes,specs').stdout, /^(?![\s\S]*evidence:)[\s\S]*RESULT/);
});

test('specCommands: // headers with "Run from …:" and indented shell lines (cc-block-out form)', () => {
  const src = `// S01 scenario tests.
//
// Run from the project root (no node_modules needed; temp/ is git-ignored):
//   printf '%s' '{"compilerOptions":{"types":["./declarations/cc"]}}' > temp/tsconfig.s01.json
//   rm -rf temp/s01-tests && tsc -p temp/tsconfig.s01.json && node --test temp/s01-tests/tests/S01.spec.js
// Game modules are loaded with require() after 'cc' is swapped for a shim.

declare const require: any;`;
  assert.deepEqual(specCommands(src), [
    `printf '%s' '{"compilerOptions":{"types":["./declarations/cc"]}}' > temp/tsconfig.s01.json`,
    'rm -rf temp/s01-tests && tsc -p temp/tsconfig.s01.json && node --test temp/s01-tests/tests/S01.spec.js',
  ]);
  assert.deepEqual(specCommands('/**\n * Run: node .cursor/run-unit.js   (compiles with the global tsc)\n */'), ['node .cursor/run-unit.js']);
});

test('classifyErrors: changed file → own, other project file → old, extensions / engine d.ts / temp → ignored', () => {
  const c = classifyErrors([
    'assets/scripts/A.ts(1,2): error TS2322: x',
    'assets/scripts/B.ts(3,4): error TS2322: y',
    'extensions/shader-graph/x.ts(72,46): error TS2345: z',
    '../../../../Applications/Cocos/Creator/3.8.8/cc.d.ts(6020,9): error TS1165: w',
    'temp/review/x.ts(1,1): error TS1: v',
    'error TS5023: Unknown compiler option',
  ], ['assets/scripts/A.ts']);
  assert.deepEqual([c.own.length, c.old.length, c.ignored], [2, 1, 3]);
  assert.match(c.own[1], /TS5023/);
});

test('end to end: an older spec with no Run: header is WARN, not a block', () => {
  const { d, g } = repo();
  fs.writeFileSync(path.join(d, 'tests/legacy.spec.ts'), '// legacy, run by hand\nexport {};\n');
  g('add', '-A'); g('commit', '-qm', 'legacy');
  const r = exec(d, '--only', 'specs');
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /WARN specs: 1\/1 specs pass, 1 not run[^\n]*\n  not run[^\n]*\n    tests\/legacy\.spec\.ts\n/);
});

test('assumptions: a "tune on the preview" note in a changed source file is a WARN, not a block', () => {
  assert.deepEqual(assumptionNotes('a\n// ASSUMPTION, Tune On The Preview\n').map((h) => h.line), [2]);
  assert.deepEqual(assumptionNotes('const wheelY = 40; // measured from the arch\n'), []);
  const { d } = repo();
  fs.mkdirSync(path.join(d, 'src'));
  fs.writeFileSync(path.join(d, 'src/ServiceConfig.ts'), 'export const WHEEL_Y = -40; // ASSUMPTION, tune on the preview\n');
  for (const f of ['tests/x.json', '.cursor/x.json', 'slices/x.json', 'producer-state.json']) {
    fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true });
    fs.writeFileSync(path.join(d, f), '{"q": "tune on the preview"}\n');
  }
  const r = exec(d, '--only', 'assumptions');
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /WARN assumptions: 1 value\(s\)[^\n]*\n  src\/ServiceConfig\.ts:1:/);
  assert.match(r.stdout, /RESULT WARN \(assumptions\)/);
});
