#!/usr/bin/env node
/**
 * check-slice.mjs — the static gate a slice passes before review, run by the runner itself (single
 * lane), the writer before ready_for_review, and the reviewer as its first static step. The checks
 * come from the review findings of cc-lego-stack S01–S11 (scorecard, 2026-10-05): the classes that
 * recurred across slices and that a script can catch, so the reviewer stops spending rounds on them.
 *
 *   node .cursor/skills/cocos-orca-fleet/scripts/check-slice.mjs [--slice slices/Sxx-*.md] [--base <ref>]
 *        [--out <file>] [--only tsc,es5,specs,scope,smoke-lint] [--all-checks]
 *
 *   tsc         project tsconfig, --noEmit. A writer's "tsc clean" is not evidence (S05 F1).
 *   es5         the same tsconfig with --target es5, TS2802 in assets/ only. The editor preview runs
 *               ES2015+, the web-mobile build is ES5 loose: `[...map.values()]` became
 *               `[].concat(iterator)` and broke every level change (S08, caught in S09).
 *   specs       every tests/**\/*.spec.ts runs through the commands of its own `Run:` header, old
 *               specs included: a data change turned the S01 spec red and nobody reran it (S08 F3).
 *               A spec without a `Run:` header fails.
 *   scope       changed paths (base...HEAD, working tree, untracked) outside the slice `paths.code` /
 *               `paths.art` and the usual test/evidence/doc places. WARN: the reviewer rules on each
 *               line, and the writer declares it in integration-notes.md.
 *   smoke-lint  changed scripts/smoke/checks/*.check.js: a fail guard written as `if (x > limit) fail(...)`
 *               passes when x is NaN or undefined (S11 F-04, a vacuous probe). Write it as
 *               `if (!(x <= limit)) fail(...)`, test Number.isFinite in the same condition, or end the
 *               line with `// finite: <why x is always a number>`.
 *
 * Prints one line per check and the detail under it, then `RESULT PASS|WARN|FAIL (...)`.
 * Exit 1 on any FAIL, else 0. SKIP (no tsconfig, no tests, no slice) is not a failure.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const CHECKS = ['tsc', 'es5', 'specs', 'scope', 'smoke-lint'];
// always inside a slice: tests, evidence, producer state, docs
const ALWAYS = ['tests/**', 'scripts/smoke/checks/**', '.cursor/evidence/**', '.cursor/producer*', 'docs/**', 'slices/**',
  '*.md', 'producer-state.json', 'producer-log.md'];
const SPEC_TIMEOUT_MS = 180000;

export function parseArgs(argv) {
  const o = { only: CHECKS, allChecks: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--slice') o.slice = argv[++i];
    else if (a === '--base') o.base = argv[++i];
    else if (a === '--out') o.out = argv[++i];
    else if (a === '--root') o.root = argv[++i];
    else if (a === '--only') o.only = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--all-checks') o.allChecks = true;
    else throw new Error(`unknown argument ${a}`);
  }
  return o;
}

const sh = (cmd, args, cwd, timeout = 120000) => spawnSync(cmd, args, { cwd, encoding: 'utf8', timeout, maxBuffer: 64 << 20 });
const git = (root, ...a) => { const r = sh('git', a, root); return r.status === 0 ? r.stdout : ''; };

function tscBin(root) {
  const local = path.join(root, 'node_modules', '.bin', 'tsc');
  if (fs.existsSync(local)) return [local, []];
  return sh('sh', ['-c', 'command -v tsc'], root).status === 0 ? ['tsc', []] : ['npx', ['--no-install', 'tsc']];
}

/** tsconfig present and loadable (a Cocos project extends temp/tsconfig.cocos.json, which the editor writes). */
function tsconfigProblem(root) {
  const f = path.join(root, 'tsconfig.json');
  if (!fs.existsSync(f)) return 'no tsconfig.json';
  const ext = fs.readFileSync(f, 'utf8').match(/"extends"\s*:\s*"([^"]+)"/);
  if (ext && !fs.existsSync(path.resolve(root, ext[1]))) return `${ext[1]} missing (open the editor once in this checkout)`;
  return null;
}

function runTsc(root, extra) {
  const [bin, pre] = tscBin(root);
  const r = sh(bin, [...pre, '-p', 'tsconfig.json', '--noEmit', ...extra], root, 300000);
  const errors = `${r.stdout}${r.stderr}`.split('\n').filter((l) => /error TS\d+/.test(l));
  return { status: r.status, errors, raw: `${r.stdout}${r.stderr}`.trim() };
}

function checkTsc(root) {
  const p = tsconfigProblem(root);
  if (p) return { status: 'SKIP', note: p };
  const r = runTsc(root, []);
  if (r.status === 0) return { status: 'PASS' };
  return { status: 'FAIL', note: `${r.errors.length} error(s)`, lines: (r.errors.length ? r.errors : [r.raw]).slice(0, 40) };
}

export const es5Errors = (lines) => lines.filter((l) => /error TS2802/.test(l) && /^assets\//.test(l.trim()));

function checkEs5(root) {
  const p = tsconfigProblem(root);
  if (p) return { status: 'SKIP', note: p };
  const bad = es5Errors(runTsc(root, ['--target', 'es5']).errors);
  if (!bad.length) return { status: 'PASS' };
  return { status: 'FAIL', note: `${bad.length} iteration(s) the ES5 web build breaks (use Array.from / forEach)`, lines: bad.slice(0, 40) };
}

/** The commands of a spec's `Run:` header: one per comment line that starts with tsc / node / npx / python3. */
export function specCommands(src) {
  const head = (src.match(/\/\*\*?([\s\S]*?)\*\//) || [])[1] || '';
  const at = head.search(/\bRun:/);
  if (at < 0) return [];
  const lines = head.slice(at + 4).split('\n').map((l) => l.replace(/^\s*\*\s?/, '').trim());
  const cmds = [];
  for (const l of lines) {
    if (!/^(tsc|node|npx|python3?)\s/.test(l)) {
      if (cmds.length) break;
      continue;
    }
    cmds.push(l.replace(/\s+\(.*\)\s*$/, '').replace(/\s\[[^\]]*\]/g, '').trim());
  }
  return cmds;
}

function listSpecs(root) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p); } else if (e.name.endsWith('.spec.ts')) out.push(p);
    }
  };
  if (fs.existsSync(path.join(root, 'tests'))) walk(path.join(root, 'tests'));
  return out.sort();
}

function checkSpecs(root) {
  const specs = listSpecs(root);
  if (!specs.length) return { status: 'SKIP', note: 'no tests/**/*.spec.ts' };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'check-slice-'));
  const lines = [];
  let failed = 0;
  for (const spec of specs) {
    const rel = path.relative(root, spec);
    const cmds = specCommands(fs.readFileSync(spec, 'utf8'));
    if (!cmds.length) { failed++; lines.push(`${rel}: no \`Run:\` header with tsc/node commands`); continue; }
    // each spec's /tmp/<dir> output goes to a fresh dir, so a stale build from another checkout never runs
    const script = cmds.map((c) => c.replace(/\/tmp\/([\w.-]+)/g, `${tmp}/$1`)).join(' && ');
    const t0 = Date.now();
    const r = sh('bash', ['-c', script], root, SPEC_TIMEOUT_MS);
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    if (r.status === 0) continue;
    failed++;
    const tail = `${r.stdout}${r.stderr}`.trim().split('\n').filter((l) => /FAIL|error|Error/.test(l)).slice(0, 6);
    lines.push(`${rel}: exit ${r.status ?? (r.signal || 'timeout')} after ${secs} s — ${script}`, ...tail.map((l) => `    ${l.trim().slice(0, 240)}`));
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  return failed ? { status: 'FAIL', note: `${failed}/${specs.length} spec(s) failed`, lines }
    : { status: 'PASS', note: `${specs.length}/${specs.length} specs` };
}

/** `paths.code` and `paths.art` of a slice file (inline `[a, b]` or block `- a  # comment`). */
export function slicePaths(src) {
  const body = src.replace(/^---\n/, '');
  const m = body.match(/^paths:[^\n]*\n((?:[ \t]+[^\n]*\n|\s*\n)*)/m);
  if (!m) return null;
  const out = [];
  let key = null;
  for (const raw of m[1].split('\n')) {
    const l = raw.replace(/\s+#.*$/, '');
    const k = l.match(/^\s{1,4}(\w+):\s*(.*)$/);
    if (k) {
      key = k[1];
      if ((key === 'code' || key === 'art') && k[2].startsWith('[')) out.push(...k[2].replace(/^\[|\]$/g, '').split(',').map((s) => s.trim()).filter(Boolean));
      continue;
    }
    const item = l.match(/^\s+-\s+(.+?)\s*$/);
    if (item && (key === 'code' || key === 'art')) out.push(item[1].replace(/^["']|["']$/g, ''));
  }
  return out;
}

export function globRe(g) {
  const s = g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*\/?/g, '\0').replace(/\*/g, '[^/]*').replace(/\0/g, '.*');
  return new RegExp(`^${s}$`);
}

export function outOfScope(changed, allowed) {
  const res = [...allowed, ...ALWAYS].map(globRe);
  const dirs = allowed.map((a) => a.replace(/\/?\*.*$/, '')).filter(Boolean);
  return changed.filter((f) => {
    const asset = f.endsWith('.meta') ? f.slice(0, -5) : f;
    if (res.some((r) => r.test(f) || r.test(asset))) return false;
    // a new folder's own .meta (assets/x/y.meta) for an allowed path under it
    if (f.endsWith('.meta') && dirs.some((d) => d === asset || d.startsWith(`${asset}/`))) return false;
    return true;
  });
}

function defaultBase(root) {
  for (const b of ['main', 'master']) if (sh('git', ['rev-parse', '--verify', '-q', b], root).status === 0) return b;
  return null;
}

function changedFiles(root, base) {
  const set = new Set();
  const add = (s) => s.split('\n').map((l) => l.trim()).filter(Boolean).forEach((f) => set.add(f));
  if (base) add(git(root, 'diff', '--name-only', `${base}...HEAD`));
  add(git(root, 'diff', '--name-only', 'HEAD'));
  add(git(root, 'ls-files', '--others', '--exclude-standard'));
  return [...set].sort();
}

function checkScope(root, slice, changed) {
  if (!slice) return { status: 'SKIP', note: 'no --slice' };
  const file = path.resolve(root, slice);
  if (!fs.existsSync(file)) return { status: 'SKIP', note: `${slice} not found` };
  const allowed = slicePaths(fs.readFileSync(file, 'utf8'));
  if (!allowed) return { status: 'SKIP', note: `${slice} has no paths:` };
  const out = outOfScope(changed, allowed);
  return out.length ? { status: 'WARN', note: `${out.length} path(s) outside paths.code/art — declare each in integration-notes.md or move it`, lines: out }
    : { status: 'PASS', note: `${changed.length} changed path(s) inside the slice` };
}

/** Fail guards that pass on NaN: `if (a > b) fail(...)` / `if (a < b) x = false`. */
export function nanUnsafe(src) {
  const hits = [];
  src.split('\n').forEach((l, i) => {
    const m = l.match(/\bif\s*\((.*?)\)\s*\{?\s*(fail\(|[\w.[\]'"]+\s*=\s*false\b)/);
    if (!m) return;
    const c = m[1].trim();
    if (!/[^=!<>]\s*(<=?|>=?)\s*[^=>]/.test(c)) return;
    if (/^!\s*\(/.test(c) || /isFinite|isNaN|\/\/\s*finite:/.test(l)) return;
    hits.push({ line: i + 1, text: l.trim().slice(0, 160) });
  });
  return hits;
}

function checkSmokeLint(root, changed, all) {
  const dir = 'scripts/smoke/checks';
  const files = all
    ? (fs.existsSync(path.join(root, dir)) ? fs.readdirSync(path.join(root, dir)).filter((f) => f.endsWith('.check.js')).map((f) => `${dir}/${f}`) : [])
    : changed.filter((f) => f.startsWith(`${dir}/`) && f.endsWith('.check.js') && fs.existsSync(path.join(root, f)));
  if (!files.length) return { status: 'SKIP', note: all ? 'no smoke checks' : 'no changed smoke checks' };
  const lines = [];
  for (const f of files) for (const h of nanUnsafe(fs.readFileSync(path.join(root, f), 'utf8'))) lines.push(`${f}:${h.line}: ${h.text}`);
  return lines.length
    ? { status: 'FAIL', note: `${lines.length} fail guard(s) that pass on NaN/undefined — write if (!(x <= limit)), test Number.isFinite, or add // finite: <why>`, lines }
    : { status: 'PASS', note: `${files.length} check file(s)` };
}

export function main(argv) {
  const o = parseArgs(argv);
  const root = path.resolve(o.root || git(process.cwd(), 'rev-parse', '--show-toplevel').trim() || process.cwd());
  const base = o.base || defaultBase(root);
  const changed = changedFiles(root, base);
  const run = {
    tsc: () => checkTsc(root),
    es5: () => checkEs5(root),
    specs: () => checkSpecs(root),
    scope: () => checkScope(root, o.slice, changed),
    'smoke-lint': () => checkSmokeLint(root, changed, o.allChecks),
  };
  const out = [`check-slice ${path.basename(root)} slice=${o.slice || '-'} base=${base || '-'} at ${new Date().toISOString()}`];
  const worst = { FAIL: [], WARN: [] };
  for (const name of CHECKS.filter((c) => o.only.includes(c))) {
    const t0 = Date.now();
    const r = run[name]();
    out.push(`${r.status} ${name}${r.note ? `: ${r.note}` : ''} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
    for (const l of r.lines || []) out.push(`  ${l}`);
    if (worst[r.status]) worst[r.status].push(name);
  }
  const result = worst.FAIL.length ? 'FAIL' : worst.WARN.length ? 'WARN' : 'PASS';
  out.push(`RESULT ${result}${worst.FAIL.length || worst.WARN.length ? ` (${[...worst.FAIL, ...worst.WARN].join(', ')})` : ''}`);
  const text = `${out.join('\n')}\n`;
  if (o.out) { fs.mkdirSync(path.dirname(path.resolve(root, o.out)), { recursive: true }); fs.writeFileSync(path.resolve(root, o.out), text); }
  process.stdout.write(text);
  return result === 'FAIL' ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('check-slice.mjs')) {
  try { process.exitCode = main(process.argv.slice(2)); } catch (e) { process.stderr.write(`check-slice: ${e.message}\n`); process.exitCode = 2; }
}
