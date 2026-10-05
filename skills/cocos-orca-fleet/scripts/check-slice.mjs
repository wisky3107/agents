#!/usr/bin/env node
/**
 * check-slice.mjs — the static gate a slice passes before review, run by the runner itself (single
 * lane), the writer before ready_for_review, and the reviewer as its first static step. The checks
 * come from the review findings of cc-lego-stack S01–S11 (scorecard, 2026-10-05): the classes that
 * recurred across slices and that a script can catch, so the reviewer stops spending rounds on them.
 *
 *   node .cursor/skills/cocos-orca-fleet/scripts/check-slice.mjs [--slice slices/Sxx-*.md] [--base <ref>]
 *        [--out <file>] [--only <checks>] [--skip <checks>] [--notes <integration-notes.md>] [--all-checks]
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
 *   evidence    every docs/evidence/ path the slice names exists (`<x>` and `*` match anything, `Vn` a
 *               viewport digit, a name without an extension a prefix), unless integration-notes.md
 *               lists it under `## evidence deferred` with a reason: required evidence was missing
 *               in S05, S07, S09, S10 and S11. WARN when an evidence file under docs/evidence/<Sxx>/
 *               (before/ and baseline left out) is older than the newest changed code or data file:
 *               S11 evidence described a pack the slice had since rebuilt (R2-01).
 *   notes       integration-notes.md carries three sections (they come from the same review):
 *               `## acceptance map` names the check, spec or manual reason for every acceptance row
 *               (by its id such as A-11-03, else #n) — rows nobody measured shipped (S06 F2, S08 F2);
 *               `## gaps` gives every known gap a disposition (fixed, followup F-n, director D-n /
 *               gate, or `none`) — a gap the writer noted and shipped anyway (S08 F4);
 *               `## negative controls` names every new or changed smoke check and spec with the
 *               broken state it went red on — vacuous checks passed (S04 F3, S11 F-04).
 *
 * Prints one line per check and the detail under it, then `RESULT PASS|WARN|FAIL (...)`.
 * Exit 1 on any FAIL, else 0. SKIP (no tsconfig, no tests, no slice) is not a failure.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const CHECKS = ['tsc', 'es5', 'specs', 'scope', 'smoke-lint', 'evidence', 'notes'];
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
    else if (a === '--skip') { const skip = argv[++i].split(',').map((s) => s.trim()); o.only = o.only.filter((c) => !skip.includes(c)); }
    else if (a === '--notes') o.notes = argv[++i];
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

/** Slice id (front matter `id:`), acceptance rows as ids (A-11-03 … else #n), docs/evidence/ paths named anywhere. */
export function sliceFacts(src) {
  const id = (src.match(/^id:\s*(\S+)/m) || [])[1] || null;
  const acc = (src.match(/^acceptance:[^\n]*\n((?:[ \t]+[^\n]*\n|\s*\n)*)/m) || [])[1] || '';
  const rows = [...acc.matchAll(/^\s+-\s+text:\s*(.*)$/gm)].map((m, i) => (m[1].match(/\b[A-Z]{1,3}-\d{1,3}-\d{1,3}\b/) || [`#${i + 1}`])[0]);
  const evidence = [...new Set([...src.matchAll(/docs\/evidence\/[A-Za-z0-9_.\/*<>-]+/g)].map((m) => m[0].replace(/[.,;:]+$/, '')))];
  return { id, rows, evidence };
}

/** A path the slice names → a matcher over project-relative files. */
export function evidenceRe(p) {
  const last = p.split('/').pop();
  const prefix = p.endsWith('/') || p.endsWith('**') || (last && !last.includes('.') && !last.includes('*'));
  const body = p.replace(/\/?\*\*$/, '/').replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/<[^>]*>/g, '\u0000').replace(/\bVn\b/g, 'V\\d')
    .replace(/\*/g, '[^/]*').replace(/\u0000/g, '[^/]+');
  return new RegExp(`^${body}${prefix ? '.*' : ''}$`);
}

/** The lines under a `## <title>` heading (any level), up to the next heading; null when there is no such heading. */
export function section(md, title) {
  const lines = md.split('\n');
  const at = lines.findIndex((l) => new RegExp(`^#{1,6}\\s*${title}\\b`, 'i').test(l));
  if (at < 0) return null;
  const end = lines.findIndex((l, i) => i > at && /^#{1,6}\s/.test(l));
  return lines.slice(at + 1, end < 0 ? undefined : end).join('\n');
}

function filesUnder(root, rel) {
  const out = [];
  const walk = (d) => {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p); else out.push(path.relative(root, p));
    }
  };
  walk(path.join(root, rel));
  return out;
}

const notesPath = (o, id) => o.notes || `.cursor/evidence/tasks/T-${id}/evidence/integration-notes.md`;
const readSlice = (root, slice) => (slice && fs.existsSync(path.resolve(root, slice)) ? fs.readFileSync(path.resolve(root, slice), 'utf8') : null);
const readText = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null);

function checkEvidence(root, o, changed) {
  const src = readSlice(root, o.slice);
  if (!src) return { status: 'SKIP', note: o.slice ? `${o.slice} not found` : 'no --slice' };
  const { id, evidence } = sliceFacts(src);
  if (!evidence.length) return { status: 'SKIP', note: 'the slice names no docs/evidence/ path' };
  const have = filesUnder(root, 'docs/evidence');
  const deferred = section(readText(path.resolve(root, notesPath(o, id))) || '', 'evidence deferred') || '';
  const missing = evidence.filter((p) => !have.some((f) => evidenceRe(p).test(f)) && !deferred.includes(p) && !deferred.includes(p.split('/').pop()));
  const lines = missing.map((p) => `missing: ${p}`);
  // stale: claims under docs/evidence/<id>/ older than the newest changed code/data file
  const code = changed.filter((f) => !/^(docs|tests|scripts\/smoke|\.cursor|slices)\//.test(f) && !f.endsWith('.md') && fs.existsSync(path.join(root, f)));
  const newest = code.map((f) => [f, fs.statSync(path.join(root, f)).mtimeMs]).sort((a, b) => b[1] - a[1])[0];
  let stale = [];
  if (newest && id) {
    stale = have.filter((f) => f.startsWith(`docs/evidence/${id}/`) && !/\/(before|baseline)\//.test(f) && /\.(md|json|txt)$/.test(f)
      && fs.statSync(path.join(root, f)).mtimeMs < newest[1] - 1000);
    if (stale.length) lines.push(`older than ${newest[0]} (${new Date(newest[1]).toISOString()}) — regenerate or say why it still holds:`, ...stale.slice(0, 20).map((f) => `  ${f}`));
  }
  if (missing.length) return { status: 'FAIL', note: `${missing.length} named evidence path(s) missing — produce them or list them under ## evidence deferred with a reason`, lines };
  if (stale.length) return { status: 'WARN', note: `${stale.length} evidence file(s) older than the last code/data change`, lines };
  return { status: 'PASS', note: `${evidence.length} named path(s) present` };
}

const DISPOSITION = /\b(fixed|none|followups?|F-\d+|director|D-?\d+|gate_\w+|deferred)\b/i;

function checkNotes(root, o, changed) {
  const src = readSlice(root, o.slice);
  if (!src) return { status: 'SKIP', note: o.slice ? `${o.slice} not found` : 'no --slice' };
  const { id, rows } = sliceFacts(src);
  if (!rows.length) return { status: 'SKIP', note: 'the slice has no acceptance rows' };
  const file = notesPath(o, id);
  const md = readText(path.resolve(root, file));
  if (md === null) return { status: 'FAIL', note: `${file} missing` };
  const lines = [];
  const map = section(md, 'acceptance map');
  if (map === null) lines.push('no `## acceptance map` section (row → check / spec / manual reason)');
  else for (const r of rows) if (!new RegExp(`(^|[^\\w-])${r.replace(/[#-]/g, '\\$&')}(?![\\w-])`).test(map)) lines.push(`acceptance map: ${r} has no check named`);
  const gaps = section(md, '(?:known |open )?gaps');
  if (gaps === null) lines.push('no `## gaps` section (write `none` when there are none)');
  else {
    const items = gaps.split('\n').filter((l) => /^\s*([-*]|\d+\.|\|)\s*\S/.test(l) && !/^\s*\|[\s:-]+\|/.test(l) && !/^\s*\|\s*gap\b/i.test(l));
    if (!items.length && !/\bnone\b/i.test(gaps)) lines.push('`## gaps` is empty — write `none` when there are none');
    for (const l of items) if (!DISPOSITION.test(l)) lines.push(`gap without a disposition (fixed / followup F-n / director D-n): ${l.trim().slice(0, 160)}`);
  }
  const checks = changed.filter((f) => (/^scripts\/smoke\/checks\/.+\.check\.js$/.test(f) || /^tests\/.+\.spec\.ts$/.test(f)) && fs.existsSync(path.join(root, f)));
  if (checks.length) {
    const neg = section(md, 'negative controls?');
    if (neg === null) lines.push('no `## negative controls` section (each new/changed check: the broken state it went red on)');
    else for (const f of checks) if (!neg.includes(path.basename(f).replace(/\.(check\.js|spec\.ts)$/, ''))) lines.push(`negative control missing: ${f}`);
  }
  return lines.length ? { status: 'FAIL', note: `${file}: ${lines.length} problem(s)`, lines }
    : { status: 'PASS', note: `${rows.length} acceptance row(s) mapped${checks.length ? `, ${checks.length} negative control(s)` : ''}` };
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
    evidence: () => checkEvidence(root, o, changed),
    notes: () => checkNotes(root, o, changed),
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
