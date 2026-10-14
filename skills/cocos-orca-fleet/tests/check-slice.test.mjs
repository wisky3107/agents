import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { specCommands, slicePaths, outOfScope, nanUnsafe, es5Errors, sliceFacts, evidenceRe, section, classifyErrors, assumptionNotes, errorKey, splitAgainstBaseline, renameMap, defaultBase, smokeVerdict, smokePort, parseKnownRed, reusableSmoke, smokeArgs, smokeEstimateMs, smokeGroups, sceneFindings, textWidth } from '../scripts/check-slice.mjs';

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
const exec = (d, ...a) => spawnSync(process.execPath, [SCRIPT, '--root', d, ...a], { encoding: 'utf8', env: { ...process.env, CHECK_SLICE_CACHE_DIR: path.join(d, '.cache-baseline') } });

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

test('errorKey / splitAgainstBaseline: line numbers, the checkout root and quoted object types ignored; a duplicate is new', () => {
  const roots = ['/p/proj'];
  const a = "assets/A.ts(10,3): error TS2339: Property 'X' does not exist on type '{ a: string; }'.";
  const b = "assets/A.ts(99,7): error TS2339: Property 'X' does not exist on type '{ a: string; b: number; }'.";
  assert.equal(errorKey(a, roots), errorKey(b, roots));
  assert.equal(errorKey("assets/A.ts(1,1): error TS2719: Type 'import(\"/p/proj/assets/m\").T' is not assignable", roots),
    errorKey("assets/A.ts(2,1): error TS2719: Type 'import(\"/q/wt/assets/m\").T' is not assignable".replace('/q/wt', '/p/proj'), roots));
  assert.notEqual(errorKey(a, roots), errorKey(a.replace('TS2339', 'TS2322'), roots));
  assert.notEqual(errorKey(a, roots), errorKey(a.replace('assets/A.ts', 'assets/B.ts'), roots));
  assert.equal(errorKey('error TS5023: Unknown compiler option', roots), null);
  const s = splitAgainstBaseline([a, b, 'assets/A.ts(5,1): error TS2322: other'], [a], roots);
  assert.deepEqual([s.pre, s.fresh], [[a], [b, 'assets/A.ts(5,1): error TS2322: other']]);
});

// a stand-in tsc: `// ERR TSnnnn message` lines in assets/*.ts become errors, `// ES5 message` ones (TS2802) only with --target es5;
// ROOT in a message is the cwd; a missing extended config is TS5083 like the real one
const FAKE_TSC = `#!/usr/bin/env node
const fs = require('fs'); const path = require('path');
const cfg = JSON.parse(fs.readFileSync('tsconfig.json', 'utf8'));
if (cfg.extends && !fs.existsSync(cfg.extends)) { console.log('error TS5083: Cannot read file ' + cfg.extends); process.exit(1); }
const es5 = process.argv.includes('es5');
let n = 0;
for (const f of fs.readdirSync('assets').sort()) {
  fs.readFileSync(path.join('assets', f), 'utf8').split('\\n').forEach((l, i) => {
    const m = l.match(/\\/\\/ (ERR (TS\\d+)|ES5) (.*)$/);
    if (!m || (m[1] === 'ES5' && !es5)) return;
    n++; console.log('assets/' + f + '(' + (i + 1) + ',1): error ' + (m[2] || 'TS2802') + ': ' + m[3].split('ROOT').join(process.cwd()));
  });
}
process.exit(n ? 2 : 0);
`;

test('end to end: tsc / es5 FAIL only for errors new against the slice base; pre-existing ones in touched files are WARN', () => {
  const { d, g } = repo();
  const w = (f, txt) => fs.writeFileSync(path.join(d, f), txt);
  fs.mkdirSync(path.join(d, 'assets')); fs.mkdirSync(path.join(d, 'temp')); fs.mkdirSync(path.join(d, 'node_modules/.bin'), { recursive: true });
  w('.gitignore', 'temp/\nnode_modules/\n.cache-baseline/\n');
  w('tsconfig.json', '{ "extends": "./temp/tsconfig.cocos.json" }\n');
  w('temp/tsconfig.cocos.json', JSON.stringify({ compilerOptions: { paths: { 'db://assets/*': [`${d}/assets/*`] } } }));
  w('node_modules/.bin/tsc', FAKE_TSC); fs.chmodSync(path.join(d, 'node_modules/.bin/tsc'), 0o755);
  const HOTKEY = "Property 'HOTKEY' does not exist on type '{ A: string; }'.";
  w('assets/a.ts', `export {};\n// ERR TS2339 ${HOTKEY}\n// ERR TS2719 Two types named T: import("ROOT/assets/m").T\n// ES5 Type 'Set<string>' can only be iterated\n`);
  w('assets/b.ts', 'export {};\n// ERR TS2322 elsewhere, never touched\n');
  g('add', '-A'); g('commit', '-qm', 'legacy code with errors');
  g('checkout', '-qb', 'slice');
  // the slice edits a.ts: lines move, the object type in a message grows, the other errors stay
  w('assets/a.ts', `export {};\nexport const x = 1;\n\n// ERR TS2339 Property 'HOTKEY' does not exist on type '{ A: string; GUEST_ID: string; }'.\n// ERR TS2719 Two types named T: import("ROOT/assets/m").T\n// ES5 Type 'Set<string>' can only be iterated\n`);
  g('commit', '-qam', 'slice work');
  const live = () => spawnSync('git', ['worktree', 'list'], { cwd: d, encoding: 'utf8' }).stdout.trim().split('\n').length;

  let r = exec(d, '--only', 'tsc,es5');
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /WARN tsc: 2 pre-existing error\(s\) in touched files, 0 new; 1 more in files this slice did not change/);
  assert.match(r.stdout, /WARN es5: 1 pre-existing iteration\(s\) the ES5 web build breaks in touched files, 0 new/);
  assert.match(r.stdout, /RESULT WARN \(tsc, es5\)/);
  assert.equal(live(), 1, 'the baseline worktree is removed');

  // a new error in the touched file, a duplicate of an old one, a new iteration
  w('assets/a.ts', `${fs.readFileSync(path.join(d, 'assets/a.ts'), 'utf8')}// ERR TS2339 Property 'NEW' does not exist on type 'Foo'.\n// ERR TS2719 Two types named T: import("ROOT/assets/m").T\n// ES5 Type 'Map<string>' can only be iterated\n`);
  r = exec(d, '--only', 'tsc,es5');
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stdout, /FAIL tsc: 2 new error\(s\) in files this slice changed; 2 pre-existing in touched files not counted/);
  assert.match(r.stdout, /assets\/a\.ts\(7,1\): error TS2339: Property 'NEW'/);
  assert.match(r.stdout, /assets\/a\.ts\(8,1\): error TS2719/);
  assert.match(r.stdout, /FAIL es5: 1 new iteration\(s\)[^\n]*\(use Array\.from \/ forEach\)/);
  assert.equal(live(), 1);

  // no usable base: the old rule (every error in a changed file) applies, and the note says so
  r = exec(d, '--only', 'tsc', '--base', 'no-such-ref');
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stdout, /FAIL tsc: 4 error\(s\) in files this slice changed \(no baseline: no merge-base of no-such-ref and HEAD; every error in a changed file counts\)/);
});

test('baseline: a config error at the base is no baseline (old rule + note), and nothing is left behind', () => {
  const { d, g } = repo();
  const w = (f, txt) => fs.writeFileSync(path.join(d, f), txt);
  fs.mkdirSync(path.join(d, 'assets')); fs.mkdirSync(path.join(d, 'node_modules/.bin'), { recursive: true });
  w('.gitignore', 'node_modules/\n.cache-baseline/\n');
  w('tsconfig.json', '{ "extends": "./tsconfig.base.json" }\n');
  w('node_modules/.bin/tsc', FAKE_TSC); fs.chmodSync(path.join(d, 'node_modules/.bin/tsc'), 0o755);
  w('assets/a.ts', 'export {};\n// ERR TS2339 old\n');
  g('add', '-A'); g('commit', '-qm', 'legacy; tsconfig.base.json does not exist at the base'); g('checkout', '-qb', 'slice');
  w('tsconfig.base.json', '{}\n'); // the extended config exists in the checkout only, so tsc at the base fails with TS5083
  w('assets/a.ts', 'export {};\nexport const x = 1;\n// ERR TS2339 old\n');
  const r = exec(d, '--only', 'tsc');
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stdout, /FAIL tsc: 1 error\(s\) in files this slice changed \(no baseline: tsc at \w+ reported a config error \(error TS5083/);
  assert.equal(spawnSync('git', ['worktree', 'list'], { cwd: d, encoding: 'utf8' }).stdout.trim().split('\n').length, 1);
});

test('errorKey: a TS2719 row that embeds the checkout path matches its baseline twin (<root>, either spelling of the root); a moved file keys under its new path', () => {
  const long = (r, f) => `assets/scripts/ViewManager.ts(40,9): error TS2719: Type 'import("${r}/assets/abstract/Group").Group<T, import("${r}/assets/abstract/ScrollAdapter").ScrollAdapter<T>>' is not assignable to type 'import("${r}/assets/abstract/Group").Group<T, import("${r}/assets/abstract/ScrollAdapter").ScrollAdapter<T>>'. Two different types with this name exist, but they are unrelated.`.replace('ViewManager.ts', f);
  const roots = ['/Users/x/proj', '/private/Users/x/proj']; // the checkout, its realpath
  const base = long('<root>', 'ViewManager.ts'); // baseline lines come back with the worktree as <root>
  for (const r of roots) assert.equal(errorKey(long(r, 'ViewManager.ts'), roots), errorKey(base, roots), r);
  assert.equal(splitAgainstBaseline([long(roots[1], 'ViewManager.ts')], [base], roots).fresh.length, 0);
  // moved: baseline path → current path; without the map the same error is new
  const moved = new Map([['assets/Telegram/Ton.ts', 'assets/managers/Ton.ts']]);
  const oldLine = "assets/Telegram/Ton.ts(3,1): error TS2322: Type 'null' is not assignable to type 'X'.";
  const newLine = "assets/managers/Ton.ts(9,1): error TS2322: Type 'null' is not assignable to type 'X'.";
  assert.equal(splitAgainstBaseline([newLine], [oldLine], roots).fresh.length, 1);
  const s = splitAgainstBaseline([newLine, newLine], [oldLine], roots, moved);
  assert.deepEqual([s.pre.length, s.fresh.length], [1, 1]); // multiset: the second copy is new
});

test('renameMap: staged and untracked moves are found; the real index and the work tree stay as they were', () => {
  const { d, g } = repo();
  const body = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n');
  fs.mkdirSync(path.join(d, 'assets/Telegram'), { recursive: true }); fs.mkdirSync(path.join(d, 'assets/managers'));
  fs.writeFileSync(path.join(d, 'assets/Telegram/Ton.ts'), body);
  fs.writeFileSync(path.join(d, 'assets/Telegram/Wallet.ts'), `${body}\nwallet`);
  fs.writeFileSync(path.join(d, 'assets/keep.ts'), 'keep');
  g('add', '-A'); g('commit', '-qm', 'before');
  const from = g('rev-parse', 'HEAD').stdout.trim();
  fs.renameSync(path.join(d, 'assets/Telegram/Ton.ts'), path.join(d, 'assets/managers/Ton.ts')); // untracked at the new path
  fs.appendFileSync(path.join(d, 'assets/managers/Ton.ts'), '\nmore');
  g('mv', 'assets/Telegram/Wallet.ts', 'assets/managers/Wallet.ts'); // staged
  const status = g('status', '--short').stdout;
  const m = renameMap(d, from);
  assert.deepEqual([...m], [['assets/Telegram/Ton.ts', 'assets/managers/Ton.ts'], ['assets/Telegram/Wallet.ts', 'assets/managers/Wallet.ts']]);
  assert.equal(g('status', '--short').stdout, status);
  assert.deepEqual([...renameMap(d, 'no-such-ref')], []);
});

test('end to end: a file the slice moved keeps its pre-existing errors as pre-existing (base HEAD, move left untracked)', () => {
  const { d, g } = repo();
  const w = (f, txt) => fs.writeFileSync(path.join(d, f), txt);
  fs.mkdirSync(path.join(d, 'assets')); fs.mkdirSync(path.join(d, 'node_modules/.bin'), { recursive: true });
  w('.gitignore', 'node_modules/\n.cache-baseline/\n');
  w('tsconfig.json', '{}\n');
  w('node_modules/.bin/tsc', FAKE_TSC); fs.chmodSync(path.join(d, 'node_modules/.bin/tsc'), 0o755);
  const pad = Array.from({ length: 25 }, (_, i) => `export const v${i} = ${i};`).join('\n');
  w('assets/TonOld.ts', `${pad}\n// ERR TS2322 Type 'null' is not assignable to type 'X'.\n// ERR TS2339 Property 'p' does not exist on type 'Q'.\n`);
  g('add', '-A'); g('commit', '-qm', 'legacy');
  fs.renameSync(path.join(d, 'assets/TonOld.ts'), path.join(d, 'assets/TonNew.ts'));
  let r = exec(d, '--only', 'tsc', '--base', 'HEAD');
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /WARN tsc: 2 pre-existing error\(s\) in touched files, 0 new/);
  fs.appendFileSync(path.join(d, 'assets/TonNew.ts'), "// ERR TS2322 Type 'string' is not assignable to type 'X'.\n");
  r = exec(d, '--only', 'tsc', '--base', 'HEAD');
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stdout, /FAIL tsc: 1 new error\(s\) in files this slice changed; 2 pre-existing in touched files not counted/);
  assert.equal(spawnSync('git', ['worktree', 'list'], { cwd: d, encoding: 'utf8' }).stdout.trim().split('\n').length, 1);
});

test('defaultBase: main / master; else a linked worktree takes the main checkout\'s branch; else HEAD with a note; detached → none', () => {
  const { d, g } = repo();
  assert.deepEqual(defaultBase(d), { ref: 'main', note: '' });
  g('branch', '-m', 'trunk'); // this project's base branch is neither main nor master (cc-capytal-war: reskin/pirate-cat)
  const nb = defaultBase(d);
  assert.equal(nb.ref, 'HEAD');
  assert.match(nb.note, /^no main\/master: only uncommitted work/);
  assert.match(exec(d, '--only', 'scope').stdout, /^check-slice \S+ slice=- base=HEAD \(no main\/master: only uncommitted work/);
  // a fleet lane: its own branch in a linked worktree; committed branch work must stay visible, so the base is trunk, not HEAD
  const wt = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'check-slice-lane-')), 'wt');
  g('worktree', 'add', '-q', '-b', 'lane', wt);
  assert.deepEqual(defaultBase(wt), { ref: 'trunk', note: "the main checkout's branch trunk" });
  fs.writeFileSync(path.join(wt, 'committed.js'), 'x');
  spawnSync('git', ['add', 'committed.js'], { cwd: wt }); spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'lane work'], { cwd: wt });
  fs.writeFileSync(path.join(wt, 'slices/S12-x.md'), 'id: S12\npaths:\n  code: [src/a.js]\n  art: []\n');
  assert.match(exec(wt, '--slice', 'slices/S12-x.md', '--only', 'scope').stdout, /WARN scope:[^\n]*\n[^\n]*committed\.js/);
  spawnSync('git', ['checkout', '-q', '--detach'], { cwd: d });
  assert.equal(defaultBase(d), null);
});

const pass = (id) => ({ id, file: `${id}.check.js`, status: 'PASS' });
const fail = (id, actual) => ({ id, file: `${id}.check.js`, status: 'FAIL', note: 'n', actual });

test('smokeVerdict: an unlisted red FAILs, a listed one is known; ledger rows added, without followup, green or unknown WARN', () => {
  const full = { checks: [pass('S01-a'), fail('S02-b', { x: 1 }), fail('S03-c'), pass('S04-d')] };
  let r = smokeVerdict(full, [], {}, {});
  assert.equal(r.status, 'FAIL');
  assert.equal(r.lines.filter((l) => l.startsWith('red:')).length, 2);
  assert.match(r.lines[0], /^red: S02-b FAIL — n · actual \{"x":1\}/);

  const known = { 'S02-b': { since: 'S10', followup: 'F-3' }, 'S03-c.check.js': { since: 'S11', followup: 'F-4' } };
  r = smokeVerdict(full, [], known, known);
  assert.equal(r.status, 'PASS', JSON.stringify(r));
  assert.match(r.note, /4 checks, 2 red \(2 known\), 0 new\/changed run on a fresh page/);

  const now = { ...known, 'S04-d': { reason: 'flaky' }, 'gone-check': { followup: 'F-9' } };
  r = smokeVerdict(full, [], now, known);
  assert.equal(r.status, 'WARN');
  assert.deepEqual(r.lines, [
    'known-red now green, drop it from scripts/smoke/known-red.json: S04-d',
    'added to scripts/smoke/known-red.json by this slice (reviewer rules): S04-d — flaky',
    'scripts/smoke/known-red.json S04-d has no followup id',
    'added to scripts/smoke/known-red.json by this slice (reviewer rules): gone-check',
    'scripts/smoke/known-red.json gone-check names no check in the corpus',
  ]);
});

test('smokeVerdict: a check red on a fresh page but green in the full run FAILs; infra is a WARN, never a block', () => {
  const full = { checks: [pass('S12-a'), pass('S12-b')] };
  const cold = [{ file: 'S12-a.check.js', report: { checks: [fail('S12-a', { found: false })] } },
    { file: 'S12-b.check.js', report: { checks: [pass('S12-b')] } }];
  let r = smokeVerdict(full, cold, {}, {});
  assert.equal(r.status, 'FAIL');
  assert.match(r.lines[0], /red on a fresh page with its slice's earlier checks, green in the full run[^\n]*S12-a FAIL/);
  r = smokeVerdict(full, [{ file: 'S12-a.check.js', report: { ok: false, infra_error: 'page never ready' } }], {}, {});
  assert.equal(r.status, 'WARN');
  assert.match(r.lines[0], /S12-a\.check\.js on a fresh page did not run: page never ready/);
  r = smokeVerdict({ ok: false, infra_error: 'page never ready' }, [], {}, {});
  assert.equal(r.status, 'WARN');
  assert.match(r.note, /smoke did not run: page never ready/);
});

test('smokePort / parseKnownRed: --port wins, else previewUrl of the slice evidence; bad ledger is empty', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'check-slice-port-'));
  assert.equal(smokePort(d, { port: 7460 }, 'S12'), '7460');
  assert.equal(smokePort(d, {}, 'S12'), null);
  const ev = path.join(d, '.cursor/evidence/tasks/T-S12/evidence');
  fs.mkdirSync(ev, { recursive: true });
  fs.writeFileSync(path.join(ev, 'preview-startup.json'), JSON.stringify({ previewUrl: 'http://localhost:7458/', status: 'ready' }));
  assert.equal(smokePort(d, {}, 'S12'), '7458');
  assert.deepEqual(parseKnownRed('{"a": {"followup": "F-1"}}'), { a: { followup: 'F-1' } });
  assert.deepEqual(parseKnownRed('[1]'), {});
  assert.deepEqual(parseKnownRed('not json'), {});
  assert.deepEqual(parseKnownRed(null), {});
});

test('end to end: smoke runs the corpus and each changed check alone through the runner; ledger rows at the base are not "added"', () => {
  const { d, g } = repo();
  // fake run-smoke: RED is red; COLD is red without S01-old in the run (another slice's state); NEEDS:<f> is red without <f>
  const fake = path.join(d, 'fake-smoke.mjs');
  fs.writeFileSync(fake, `import fs from 'node:fs';
const a = process.argv.slice(2); const dir = a[a.indexOf('--checks') + 1];
if (a[a.indexOf('--port') + 1] !== '7458') { console.log(JSON.stringify({ ok: false, infra_error: 'wrong port' })); process.exit(2); }
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.check.js')).sort();
const checks = files.map((f) => { const t = fs.readFileSync(dir + '/' + f, 'utf8');
  const need = (t.match(/NEEDS:(\\S+)/) || [])[1];
  const bad = t.includes('RED') || (t.includes('COLD') && !files.includes('S01-old.check.js')) || (need && !files.includes(need));
  return { id: f.replace('.check.js', ''), file: f, status: bad ? 'FAIL' : 'PASS' }; });
fs.appendFileSync(process.env.FAKE_LOG, a.filter((x) => !x.startsWith('/')).join(' ') + ' | ' + files.join(',') + '\\n');
console.log(JSON.stringify({ ok: checks.every((c) => c.status === 'PASS'), checks }));`);
  const env = { ...process.env, CHECK_SLICE_SMOKE_RUNNER: fake, CHECK_SLICE_CACHE_DIR: path.join(d, '.cache-baseline'), FAKE_LOG: path.join(d, 'fake.log') };
  const run = (...a) => spawnSync(process.execPath, [SCRIPT, '--root', d, '--only', 'smoke', ...a], { encoding: 'utf8', env });
  fs.mkdirSync(path.join(d, 'scripts/smoke/checks'), { recursive: true });
  fs.writeFileSync(path.join(d, 'scripts/smoke/checks/S01-old.check.js'), '// RED since S05\n');
  fs.writeFileSync(path.join(d, 'scripts/smoke/known-red.json'), JSON.stringify({ 'S01-old': { since: 'S05', followup: 'F-2' } }));
  g('add', '-A'); g('commit', '-qm', 'S05');

  let r = run('--slice', 'slices/S12-x.md');
  assert.match(r.stdout, /SKIP smoke: no preview port/);  // no --port, no preview-startup.json
  assert.equal(r.status, 0);

  fs.writeFileSync(path.join(d, 'scripts/smoke/checks/S12-new.check.js'), '// COLD: reads what S01 left\n');
  fs.writeFileSync(path.join(d, 'scripts/smoke/checks/S12-two.check.js'), '// step 2 of 2 NEEDS:S12-new.check.js\n');
  fs.writeFileSync(path.join(d, 'scripts/smoke/run-args.json'), JSON.stringify(['--delay', '50', '--viewport', '1080x1920', '--port', '9999']));
  const out = '.cursor/evidence/tasks/T-S12/evidence/static-check.txt';
  r = run('--slice', 'slices/S12-x.md', '--port', '7458', '--out', out);
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stdout, /FAIL smoke: 3 checks, 1 red \(1 known\), 2 new\/changed run on a fresh page/);
  assert.match(r.stdout, /red on a fresh page with its slice's earlier checks[^\n]*S12-new FAIL/);
  assert.doesNotMatch(r.stdout, /S12-two FAIL/);  // step 2 ran with step 1 on its page
  const log = fs.readFileSync(path.join(d, 'fake.log'), 'utf8').trim().split('\n');
  assert.equal(log.length, 2);  // the corpus, then one page for the S12 group
  assert.match(log[0], /--port 7458 --channel chrome --quiet --checks --delay 50 --viewport 1080x1920 \| S01-old/);  // the project's flags, never its --port
  assert.match(log[1], /\| S12-new\.check\.js,S12-two\.check\.js$/);
  assert.doesNotMatch(r.stdout, /added to/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(d, path.dirname(out), 'static-smoke.json'), 'utf8')).checks.length, 3);

  fs.writeFileSync(path.join(d, 'scripts/smoke/checks/S12-new.check.js'), '// fixed\n');
  r = run('--slice', 'slices/S12-x.md', '--port', '7458');
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /PASS smoke: 3 checks, 1 red \(1 known\)/);
});

test('reusableSmoke: the newest full-corpus report written after the last change; stale, partial or infra reports are not', () => {
  const ev = fs.mkdtempSync(path.join(os.tmpdir(), 'check-slice-reuse-'));
  const corpus = ['a.check.js', 'b.check.js'];
  const put = (f, j, ageS) => { fs.writeFileSync(path.join(ev, f), JSON.stringify(j)); const t = Date.now() / 1000 - ageS; fs.utimesSync(path.join(ev, f), t, t); };
  put('smoke.json', { checks: [{ file: 'a.check.js', status: 'PASS' }, { file: 'b.check.js', status: 'FAIL' }] }, 100);
  put('smoke-only-a.json', { checks: [{ file: 'a.check.js', status: 'PASS' }] }, 10);
  put('review-smoke.json', { ok: false, infra_error: 'page never ready' }, 5);
  put('static-smoke.json', { checks: [{ file: 'a.check.js' }, { file: 'b.check.js' }] }, 1);  // our own output never counts
  fs.mkdirSync(path.join(ev, 'negative'));
  put('negative/smoke-run1.json', { checks: [{ file: 'a.check.js', status: 'FAIL' }, { file: 'b.check.js', status: 'FAIL' }] }, 0);  // red on purpose
  put('smoke-negative.json', { checks: [{ file: 'a.check.js', status: 'FAIL' }, { file: 'b.check.js', status: 'FAIL' }] }, 0);
  const changedAt = Date.now() - 200 * 1000;
  assert.equal(reusableSmoke(ev, corpus, changedAt)?.file, 'smoke.json');
  assert.equal(reusableSmoke(ev, corpus, Date.now() - 50 * 1000), null);  // code changed after the full run
  assert.equal(reusableSmoke(ev, [...corpus, 'c.check.js'], changedAt), null);  // a check the run never saw
  assert.equal(reusableSmoke(path.join(ev, 'nope'), corpus, 0), null);
});

test('smokeArgs / smokeEstimateMs / smokeGroups: project flags minus the gate\'s own, a delay-based estimate, slice chains', () => {
  assert.deepEqual(smokeArgs('["--delay", "12000", "--viewport", "1080x1920", "--channel", "orca", "--quiet", "--port", "1"]'), ['--delay', '12000', '--viewport', '1080x1920']);
  assert.deepEqual(smokeArgs('{"args": ["--delay", "500"]}'), ['--delay', '500']);
  assert.deepEqual(smokeArgs('nope'), []);
  assert.deepEqual(smokeArgs(null), []);
  assert.equal(smokeEstimateMs(61, ['--delay', '12000']), 25000 + 61 * 13000);  // cc-capytal-war: ~13.6 min
  assert.equal(smokeEstimateMs(60, []), 25000 + 60 * 1300);
  const corpus = ['S01-a.check.js', 'S13-05-x.check.js', 'S13-06-y.check.js', 'S13-07-z.check.js', 'S17-00-a.check.js', 'S17-01-b.check.js', 'S17-02-c.check.js', 'misc.check.js'];
  assert.deepEqual(smokeGroups(corpus, ['S17-01-b.check.js', 'S17-02-c.check.js', 'S13-06-y.check.js', 'misc.check.js']), [
    { files: ['S17-00-a.check.js', 'S17-01-b.check.js', 'S17-02-c.check.js'], judge: ['S17-01-b.check.js', 'S17-02-c.check.js'] },
    { files: ['S13-05-x.check.js', 'S13-06-y.check.js'], judge: ['S13-06-y.check.js'] },
    { files: ['misc.check.js'], judge: ['misc.check.js'] },
  ]);
});

test('end to end: a quoted slice id finds its evidence; no fresh report and a run over budget is a WARN, not a run', () => {
  const { d, g } = repo();
  fs.writeFileSync(path.join(d, 'slices/S12-x.md'), 'id: "S12"\npaths:\n  code: [src/a.js]\n  art: []\n');
  assert.equal(sliceFacts(fs.readFileSync(path.join(d, 'slices/S12-x.md'), 'utf8')).id, 'S12');
  const fake = path.join(d, 'fake-smoke.mjs');
  fs.writeFileSync(fake, "import fs from 'node:fs'; fs.writeFileSync(process.env.FAKE_LOG, 'ran'); console.log(JSON.stringify({ checks: [] }));");
  const env = { ...process.env, CHECK_SLICE_SMOKE_RUNNER: fake, CHECK_SLICE_CACHE_DIR: path.join(d, '.cache-baseline'), FAKE_LOG: path.join(d, 'fake.log') };
  fs.mkdirSync(path.join(d, 'scripts/smoke/checks'), { recursive: true });
  for (let i = 0; i < 30; i++) fs.writeFileSync(path.join(d, `scripts/smoke/checks/S0${i % 9 + 1}-${i}.check.js`), '//\n');
  fs.writeFileSync(path.join(d, 'scripts/smoke/run-args.json'), '["--delay", "12000"]');
  g('add', '-A'); g('commit', '-qm', 'corpus');
  const ev = path.join(d, '.cursor/evidence/tasks/T-S12/evidence');
  fs.mkdirSync(path.join(ev, 'run3'), { recursive: true });
  fs.writeFileSync(path.join(ev, 'preview-startup.json'), JSON.stringify({ previewUrl: 'http://localhost:7458/' }));
  fs.mkdirSync(path.join(d, 'src')); fs.writeFileSync(path.join(d, 'src/a.js'), '1');
  const run = () => spawnSync(process.execPath, [SCRIPT, '--root', d, '--only', 'smoke', '--slice', 'slices/S12-x.md'], { encoding: 'utf8', env });
  let r = run();
  assert.match(r.stdout, /WARN smoke: smoke did not run: no full-corpus \*smoke\*\.json in \.cursor\/evidence\/tasks\/T-S12\/evidence newer than the last code change, and a run \(30 checks with --delay 12000, ~7 min\) does not fit the \d+ s budget/);
  assert.equal(fs.existsSync(path.join(d, 'fake.log')), false);
  // the writer's last full run, in a subfolder, after the last code change (a later notes edit does not count)
  const checks = fs.readdirSync(path.join(d, 'scripts/smoke/checks')).map((f) => ({ id: f.replace('.check.js', ''), file: f, status: 'PASS' }));
  fs.writeFileSync(path.join(ev, 'run3/smoke-run3.json'), JSON.stringify({ checks }));
  fs.writeFileSync(path.join(d, 'notes.md'), 'after the run');
  fs.writeFileSync(path.join(d, 'scripts/smoke/run-args.json'), '["--delay", "12000"] ');  // gate config, not code
  fs.writeFileSync(path.join(d, 'scripts/smoke/known-red.json'), '{}');
  r = run();
  assert.match(r.stdout, /PASS smoke: 30 checks, 0 red \(0 known\), 0 new\/changed run on a fresh page; full run reused from evidence\/run3\/smoke-run3\.json/);
});

// a minimal Cocos 3.x serialized scene: nodes, then components pointing back with node.__id__
function sceneDoc({ projection = 0, canvasFlags = 45, dimFlags = 45, labels = [] } = {}) {
  const d = [
    { __type__: 'cc.SceneAsset', _name: 'game' },
    { __type__: 'cc.Scene', _name: 'game', _parent: null },
    { __type__: 'cc.Node', _name: 'Canvas', _parent: { __id__: 1 } },
    { __type__: 'cc.Node', _name: 'Camera', _parent: { __id__: 2 } },
    { __type__: 'cc.Camera', node: { __id__: 3 }, _projection: projection },
    { __type__: 'cc.Canvas', node: { __id__: 2 }, _cameraComponent: { __id__: 4 } },
    { __type__: 'cc.Widget', node: { __id__: 2 }, _alignFlags: canvasFlags },
    { __type__: 'cc.Node', _name: 'Sprite - Dim', _parent: { __id__: 2 } },
    { __type__: 'cc.Sprite', node: { __id__: 7 } },
    { __type__: 'cc.Widget', node: { __id__: 7 }, _alignFlags: dimFlags },
    { __type__: 'cc.Node', _name: 'Panel', _parent: { __id__: 2 } },
    { __type__: 'cc.Node', _name: 'Sprite - Dim', _parent: { __id__: 10 } },  // a panel's own dim: local art
    { __type__: 'cc.Sprite', node: { __id__: 11 } },
  ];
  for (const l of labels) {
    const n = d.push({ __type__: 'cc.Node', _name: l.name, _parent: { __id__: 10 } }) - 1;
    d.push({ __type__: 'cc.UITransform', node: { __id__: n }, _contentSize: { width: l.w, height: l.h } });
    d.push({ __type__: 'cc.Label', node: { __id__: n }, _string: l.text, _fontSize: l.size, _overflow: l.ov, _enableWrapText: !!l.wrap, _actualFontSize: l.actual });
  }
  return d;
}

test('sceneFindings: a clean scene, then each class reviewers raised as a blocker (camera, Canvas widget, screen dim, label boxes)', () => {
  assert.deepEqual(sceneFindings(sceneDoc()), []);
  const lines = sceneFindings(sceneDoc({ projection: 1, canvasFlags: 0, dimFlags: 5 }));
  assert.equal(lines.length, 3, lines.join('\n'));
  assert.match(lines[0], /^game\/Canvas: Canvas camera is PERSPECTIVE \(_projection 1\)/);
  assert.match(lines[1], /^game\/Canvas: Canvas has no Widget on all four edges \(_alignFlags 0\)/);
  assert.match(lines[2], /^game\/Canvas\/Sprite - Dim: dim\/overlay sprite without a Widget/);  // the panel's dim is not reported
  const labels = sceneFindings(sceneDoc({ labels: [
    { name: 'Label - Saved', text: 'Dầu nhớt', size: 28, ov: 2, w: 90, h: 50, actual: 18 },            // SHRINK saved at 64%
    { name: 'Label - Caption', text: '?', size: 72, ov: 2, w: 160, h: 40 },                            // box shorter than the font
    { name: 'Label - Bubble', text: 'Wash the car first!', size: 40, ov: 1, w: 200, h: 60 },           // CLAMP, ~430 px on one line
    { name: 'Label - Tip', text: 'Water puts out fires', size: 32, ov: 3, w: 40, h: 300, wrap: true },  // one character per line
    { name: 'Label - Fits', text: 'GO', size: 40, ov: 2, w: 120, h: 60, actual: 40 },
    { name: 'Label - Runtime', text: 'Label', size: 40, ov: 2, w: 60, h: 60, actual: 20 },             // placeholder text: not judged
    { name: 'Label - Wraps', text: 'a long tip that wraps on purpose', size: 30, ov: 2, w: 300, h: 200, wrap: true },
  ] }));
  assert.equal(labels.length, 4, labels.join('\n'));
  assert.match(labels[0], /Label - Saved: Label "Dầu nhớt" SHRINK 28px in 90x50: saved at 18px \(64% of the authored size\)/);
  assert.match(labels[1], /Label - Caption: [^\n]*the box is shorter than the font, every string shrinks/);
  assert.match(labels[2], /Label - Bubble: [^\n]*needs ~\d+px on one line — clipped/);
  assert.match(labels[3], /Label - Tip: [^\n]*RESIZE_HEIGHT box narrower than two glyphs/);
  assert.deepEqual(sceneFindings({ not: 'an array' }), []);
});

test('textWidth: wide glyphs count more than latin, capitals more than lower case', () => {
  assert.ok(textWidth('漢字', 20) > textWidth('ab', 20));
  assert.ok(textWidth('ABC', 20) > textWidth('abc', 20));
  assert.equal(Math.round(textWidth('a b', 10)), Math.round((0.55 + 0.28 + 0.55) * 10));
});

test('end to end: scene WARNs only for changed .scene/.prefab files, every file with --all-checks', () => {
  const { d, g } = repo();
  fs.mkdirSync(path.join(d, 'assets/scenes'), { recursive: true });
  fs.writeFileSync(path.join(d, 'assets/scenes/old.scene'), JSON.stringify(sceneDoc({ projection: 1 })));
  g('add', '-A'); g('commit', '-qm', 'legacy scene');
  let r = exec(d, '--only', 'scene');
  assert.match(r.stdout, /SKIP scene: no changed \.scene\/\.prefab/);
  fs.writeFileSync(path.join(d, 'assets/scenes/game.scene'), JSON.stringify(sceneDoc({ canvasFlags: 0 })));
  r = exec(d, '--only', 'scene');
  assert.equal(r.status, 0);  // WARN, never a block
  assert.match(r.stdout, /WARN scene: 1 scene\/text problem\(s\) in 1 file\(s\)[^\n]*\n  assets\/scenes\/game\.scene: game\/Canvas: Canvas has no Widget/);
  r = exec(d, '--only', 'scene', '--all-checks');
  assert.match(r.stdout, /WARN scene: 2 scene\/text problem\(s\) in 2 file\(s\)/);
});
