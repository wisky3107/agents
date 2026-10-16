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
 *   tsc         project tsconfig, --noEmit. A writer's "tsc clean" is not evidence (S05 F1). In files the
 *               slice changed FAIL only for errors that are new against the slice base (merge-base with
 *               --base): the base is built in a temporary `git worktree add --detach` (temp/tsconfig.cocos.json
 *               copied with the root rewritten, temp/declarations, node_modules and extensions linked), and
 *               errors are keyed by file + TS code + message with line numbers and the checkout root dropped
 *               and quoted object types collapsed, compared as multisets so a duplicate still counts as new.
 *               Errors that were already there in a changed file are WARN ("N pre-existing in touched files,
 *               0 new"): a legacy project with non-strict code blocked every slice (cc-capytal-war S14, S15).
 *               A file the slice moved (git rename detection of the base against the checkout as it is, untracked
 *               files included) keeps its old errors: they are keyed under the new path. git's default similarity
 *               (50%) and rename limit apply: a moved-and-rewritten file or a mass move falls back to "all new".
 *               No base or no buildable baseline: every error in a changed file FAILs, and the note says why.
 *               Without --base: main / master; in a linked worktree the main checkout's branch; else HEAD (only
 *               uncommitted work counts as changed; the header line says so). The runner passes the commit a
 *               single-lane slice started from (base_sha).
 *               Errors elsewhere in the project are WARN (pre-existing), and extensions/, temp/ and engine
 *               declarations are ignored.
 *   es5         the same tsconfig with --target es5, TS2802 in assets/ only, same split and baseline. The editor
 *               preview runs ES2015+, the web-mobile build is ES5 loose: `[...map.values()]` became
 *               `[].concat(iterator)` and broke every level change (S08, caught in S09).
 *   specs       every tests/**\/*.spec.ts runs through the commands of its own `Run:` header, old
 *               specs included: a data change turned the S01 spec red and nobody reran it (S08 F3).
 *               The header is the leading comment: `Run:` (or `Run from …:`) then the commands, on
 *               that line or indented under it. A new or changed spec without one fails; an older
 *               one is listed as not run (WARN).
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
 *   assumptions a changed .ts/.js/.mjs/.json file still holds a "tune on the preview" note: numbers authored as a
 *               guess and never tuned shipped wheels 8-26 px off their arches (cc-car-service-kids S02-S09).
 *               WARN: measure the value, or file a followup.
 *   scene       changed .scene / .prefab files (all of them with --all-checks), the scene defects reviewers
 *               kept raising as blockers (12 of 19 review blockers since 2026-10-05 were scene or text):
 *               a Canvas camera that is not ORTHO (the UI renders 0.87x-2.3x: cat-dash, firefighter,
 *               love-train, car-service S01); a Canvas without a Widget on all four edges (HUD tied to the
 *               design frame: love-train S01 F2); a dim / overlay / backdrop sprite without one (undimmed
 *               bands: firefighter S08, monster-truck S01); a Label whose box cannot hold its text — SHRINK
 *               saved below 80% of the authored size, a box shorter than the font, text estimated wider
 *               than a no-wrap SHRINK/CLAMP box, a RESIZE_HEIGHT box narrower than two glyphs (car-service
 *               S01/S03, monster-truck S03-S05, firefighter S01). WARN: fix it, or declare the node in
 *               integration-notes.md when it is laid out by code; the reviewer rules on each line. A line
 *               the same file already gave at the slice base is listed as `pre-existing` — not this
 *               slice's (a prefab a slice only renamed a member in kept its old layout debt: capytal S19).
 *   smoke       the whole scripts/smoke/checks corpus through the smoke-test skill's run-smoke.mjs on the
 *               chrome channel (a fresh page), with the project's own run-smoke flags from
 *               scripts/smoke/run-args.json (`["--delay", "12000", "--viewport", "1080x1920"]`), then every
 *               new or changed check on a fresh page together with the earlier checks of its own slice
 *               (same `Sxx-` prefix: step 2 of 3 needs step 1), after the suite's gate — the full run's
 *               first check, or `"gate": [...]` in run-args.json — since run-smoke waits --delay only
 *               after a check, a group without it reads an unloaded scene (capytal S18). A red check FAILs unless
 *               scripts/smoke/known-red.json lists it (`{"<check id>": {"since": "S13", "followup": "F-12",
 *               "reason": "…"}}`); a check red on that fresh page but green in the full run FAILs (it
 *               passes on state another slice's check or a warm page left). Smoke findings were
 *               24% of review findings since 2026-10-05: an earlier slice's check gone red, a new check red
 *               on a cold page, "18 pre-existing failures" carried from slice to slice. WARN: ledger rows
 *               this slice added (the reviewer rules on each), rows without a followup, rows now green, a
 *               run that could not reach the preview. The port comes from --port, else the slice's
 *               evidence/preview-startup.json; neither → SKIP. A full-corpus report the writer already
 *               left in the slice evidence (*smoke*.json at any depth, every check in it, newer than every
 *               changed non-.md file) is reused instead of a second run. All runs share --smoke-budget
 *               seconds (default 300; the runner gives check-slice 600 in all); a run whose estimate
 *               (checks × --delay) does not fit is not started — WARN, save the last full run in evidence
 *               (cc-capytal-war: 61 checks × 12 s = 12 min). With --out the full report is saved beside
 *               it as static-smoke.json for the reviewer, with the fresh-page runs under `fresh_page`.
 *
 * Prints one line per check and the detail under it, then `RESULT PASS|WARN|FAIL (...)`.
 * Exit 1 on any FAIL, else 0. SKIP (no tsconfig, no tests, no slice) is not a failure.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

const CHECKS = ['tsc', 'es5', 'specs', 'scope', 'smoke-lint', 'evidence', 'notes', 'assumptions', 'scene', 'smoke'];
// always inside a slice: tests, evidence, producer state, docs
const ALWAYS = ['tests/**', 'scripts/smoke/checks/**', 'scripts/smoke/known-red.json', '.cursor/evidence/**', '.cursor/producer*', 'docs/**', 'slices/**',
  '*.md', 'producer-state.json', 'producer-log.md'];
const SPEC_TIMEOUT_MS = 180000;
const SMOKE_BUDGET_S = 360; // the runner gives check-slice 600 s in all; tsc/es5 take seconds, specs up to ~200
const SMOKE_GROUP_MAX = 16; // fresh pages per run (one per slice chain of new/changed checks); the budget decides the rest
const KNOWN_RED = 'scripts/smoke/known-red.json';
const GATE_CONFIG = [KNOWN_RED, 'scripts/smoke/run-args.json'];

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
    else if (a === '--port') o.port = argv[++i];
    else if (a === '--smoke-budget') o.smokeBudget = Number(argv[++i]);
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

function runTsc(root, extra, cwd = root) {
  const [bin, pre] = tscBin(root);
  const r = sh(bin, [...pre, '-p', 'tsconfig.json', '--noEmit', ...extra], cwd, 300000);
  const errors = `${r.stdout}${r.stderr}`.split('\n').filter((l) => /error TS\d+/.test(l));
  return { status: r.status, errors, raw: `${r.stdout}${r.stderr}`.trim() };
}

// not the slice's code: editor extensions (shader-graph, textmeshpro ship their own type errors),
// generated dirs, and engine declarations outside the project
const NOT_PROJECT = /^(\.\.\/|\/|extensions\/|temp\/|library\/|build\/|node_modules\/|local\/|profiles\/)/;

/** tsc error lines → in a file this slice changed (own: FAIL), elsewhere in the project (old: WARN), not project code (ignored). */
export function classifyErrors(errors, changed) {
  const ch = new Set(changed);
  const out = { own: [], old: [], ignored: 0 };
  for (const l of errors) {
    const m = l.trim().match(/^(.+?)\(\d+,\d+\)/);
    if (!m) out.own.push(l); // a config error names no file: never pre-existing noise
    else if (NOT_PROJECT.test(m[1])) out.ignored++;
    else (ch.has(m[1]) ? out.own : out.old).push(l);
  }
  return out;
}

/**
 * "file|TS code|message": no line numbers, the checkout root as <root>, quoted object types collapsed (they grow with
 * the code). `moved` (old path → new path, from renameMap) keys an error of a moved file under its new path.
 */
export function errorKey(line, roots, moved) {
  const m = line.trim().match(/^(.+?)\(\d+,\d+\):\s*error (TS\d+):\s*(.*)$/);
  if (!m) return null;
  let msg = m[3];
  for (const r of [...roots].sort((x, y) => y.length - x.length)) if (r) msg = msg.split(r.replace(/\/$/, '')).join('<root>');
  return `${moved?.get(m[1]) ?? m[1]}|${m[2]}|${msg.replace(/'\{[^']*\}'/g, "'{…}'")}`;
}

/**
 * Split lines into new ones and ones the baseline already had (multiset: the second copy of a baseline error is new).
 * `moved` maps a baseline path to the path it has now (a file the slice moved keeps its old errors).
 */
export function splitAgainstBaseline(lines, baseLines, roots, moved) {
  const left = new Map();
  for (const l of baseLines) { const k = errorKey(l, roots, moved); if (k) left.set(k, (left.get(k) || 0) + 1); }
  const out = { fresh: [], pre: [] };
  for (const l of lines) {
    const k = errorKey(l, roots);
    if (k && left.get(k) > 0) { left.set(k, left.get(k) - 1); out.pre.push(l); } else out.fresh.push(l);
  }
  return out;
}

/**
 * Files git sees as moved between `from` and the checkout as it is now (committed, staged, unstaged and untracked):
 * Map old path → new path. Untracked files are added as intent-to-add to a COPY of the index (GIT_INDEX_FILE), so
 * the real index and the object store are untouched. Empty when anything fails.
 */
export function renameMap(root, from) {
  const moved = new Map();
  let tmp = null;
  try {
    const idx = path.resolve(root, git(root, 'rev-parse', '--git-path', 'index').trim());
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'check-slice-idx-'));
    const copy = path.join(tmp, 'index');
    if (fs.existsSync(idx)) fs.copyFileSync(idx, copy);
    const env = { ...process.env, GIT_INDEX_FILE: copy };
    const run = (...a) => spawnSync('git', a, { cwd: root, encoding: 'utf8', env, maxBuffer: 64 << 20, timeout: 120000 });
    if (run('add', '-N', '-A', '.').status !== 0) return moved;
    const r = run('diff', '-M', '--name-status', '-z', from);
    if (r.status !== 0) return moved;
    const f = r.stdout.split('\0');
    for (let i = 0; i < f.length - 1;) {
      if (/^[RC]\d*$/.test(f[i])) { if (f[i][0] === 'R' && f[i + 1] && f[i + 2]) moved.set(f[i + 1], f[i + 2]); i += 3; } else i += 2;
    }
  } catch { /* no rename info: the old keys apply */ } finally { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); }
  return moved;
}

/**
 * tsc errors at the slice base, from a detached worktree of the merge-base (cached by project + sha + flags).
 * Cached in os.tmpdir() (CHECK_SLICE_CACHE_DIR overrides). Lines come back with the worktree path as <root>. `problem` instead of `lines` when it cannot be built.
 */
function makeBaseline(root, base) {
  const dirs = [];
  let mb = null;
  let wt = null;
  const prep = () => {
    if (!base) return 'no base ref';
    mb = git(root, 'merge-base', base, 'HEAD').trim();
    if (!mb) return `no merge-base of ${base} and HEAD`;
    return null;
  };
  const build = () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'check-slice-base-'));
    dirs.push(tmp);
    const dir = path.join(tmp, 'wt');
    const r = sh('git', ['worktree', 'add', '--detach', '-q', dir, mb], root, 300000);
    if (r.status !== 0) return `git worktree add ${mb.slice(0, 8)} failed: ${(r.stderr || '').trim().slice(0, 200)}`;
    wt = dir;
    // untracked inputs of the tsconfig: the editor's temp/ (the extended config names the checkout root in
    // its paths, so it is rewritten for this directory), node_modules, extensions
    const cfg = path.join(root, 'temp', 'tsconfig.cocos.json');
    if (fs.existsSync(cfg)) {
      fs.mkdirSync(path.join(dir, 'temp'), { recursive: true });
      const roots = [root, fs.realpathSync(root)];
      let txt = fs.readFileSync(cfg, 'utf8');
      for (const x of roots) txt = txt.split(x.replace(/\/$/, '')).join(dir);
      fs.writeFileSync(path.join(dir, 'temp', 'tsconfig.cocos.json'), txt);
      if (fs.existsSync(path.join(root, 'temp', 'declarations'))) fs.symlinkSync(path.join(root, 'temp', 'declarations'), path.join(dir, 'temp', 'declarations'));
    }
    for (const n of ['node_modules', 'extensions']) if (fs.existsSync(path.join(root, n)) && !fs.existsSync(path.join(dir, n))) fs.symlinkSync(path.join(root, n), path.join(dir, n));
    return null;
  };
  const runs = new Map();
  const lines = (extra) => {
    const key = extra.join(' ');
    if (runs.has(key)) return runs.get(key);
    let res;
    try {
      res = { problem: prep() };
      if (!res.problem) {
        res.moved = renameMap(root, mb);
        const mtime = (f) => (fs.existsSync(path.join(root, f)) ? fs.statSync(path.join(root, f)).mtimeMs : 0);
        const id = crypto.createHash('sha1').update(`v1|${fs.realpathSync(root)}|${mb}|${mtime('temp/tsconfig.cocos.json')}|${mtime('temp/declarations')}|${key}`).digest('hex').slice(0, 20);
        const cache = path.join(process.env.CHECK_SLICE_CACHE_DIR || path.join(os.tmpdir(), 'check-slice-baseline'), `${id}.json`);
        let cached = null;
        try { cached = JSON.parse(fs.readFileSync(cache, 'utf8')); } catch { /* none */ }
        if (cached) res = { lines: cached, moved: res.moved };
        else {
          res.problem = wt ? null : build();
          if (!res.problem) {
            const t = runTsc(root, extra, wt);
            const strip = (l) => l.split(fs.realpathSync(wt)).join('<root>').split(wt).join('<root>'); // the longer spelling first (/private/var vs /var)
            if (!t.errors.length && t.status !== 0) res.problem = `tsc failed at ${mb.slice(0, 8)} without error lines`;
            else if (t.errors.some((l) => !/\(\d+,\d+\)/.test(l))) res.problem = `tsc at ${mb.slice(0, 8)} reported a config error (${t.errors.find((l) => !/\(\d+,\d+\)/.test(l)).trim().slice(0, 100)})`;
            else {
              res = { lines: t.errors.map(strip), moved: res.moved };
              try { fs.mkdirSync(path.dirname(cache), { recursive: true }); fs.writeFileSync(cache, JSON.stringify(res.lines)); } catch { /* cache is optional */ }
            }
          }
        }
      }
    } catch (e) { res = { problem: e.message }; }
    runs.set(key, res);
    return res;
  };
  const dispose = () => {
    const removed = wt ? sh('git', ['worktree', 'remove', '--force', wt], root).status === 0 : true;
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
    if (!removed) sh('git', ['worktree', 'prune'], root); // only when remove failed: other tools' worktrees stay alone
  };
  return { root, lines, dispose };
}

function tscResult(r, changed, what, fix, baseline, extra) {
  if (r.status === 0) return { status: 'PASS' };
  if (!r.errors.length) return { status: 'FAIL', note: 'tsc failed without error lines', lines: [r.raw.slice(0, 2000)] };
  const c = classifyErrors(r.errors, changed);
  const ignored = c.ignored ? `; ${c.ignored} outside project code ignored` : '';
  let own = c.own;
  let pre = [];
  let why = '';
  if (own.length && baseline) {
    const b = baseline.lines(extra);
    if (b.problem) why = ` (no baseline: ${b.problem}; every error in a changed file counts)`;
    else {
      const roots = [baseline.root, fs.realpathSync(baseline.root)];
      const baseLines = extra.includes('es5') ? es5Errors(b.lines) : b.lines;
      // a config error names no file: never pre-existing noise
      const split = splitAgainstBaseline(own.filter((l) => /\(\d+,\d+\)/.test(l)), baseLines, roots, b.moved);
      own = [...own.filter((l) => !/\(\d+,\d+\)/.test(l)), ...split.fresh];
      pre = split.pre;
    }
  }
  const preNote = pre.length ? `; ${pre.length} pre-existing in touched files not counted` : '';
  if (own.length) return { status: 'FAIL', note: `${own.length} ${pre.length ? 'new ' : ''}${what} in files this slice changed${fix}${preNote}${ignored}${why}`, lines: [...own.slice(0, 40), ...(c.old.length ? [`(${c.old.length} more in unchanged files)`] : [])] };
  if (pre.length) return { status: 'WARN', note: `${pre.length} pre-existing ${what} in touched files, 0 new${c.old.length ? `; ${c.old.length} more in files this slice did not change` : ''}${ignored}`, lines: pre.slice(0, 20) };
  if (c.old.length) return { status: 'WARN', note: `${c.old.length} pre-existing ${what} in files this slice did not change — not this slice's, file a followup${ignored}`, lines: c.old.slice(0, 20) };
  return { status: 'PASS', note: ignored.slice(2) };
}

function checkTsc(root, changed, baseline) {
  const p = tsconfigProblem(root);
  if (p) return { status: 'SKIP', note: p };
  return tscResult(runTsc(root, []), changed, 'error(s)', '', baseline, []);
}

export const es5Errors = (lines) => lines.filter((l) => /error TS2802/.test(l) && /^assets\//.test(l.trim()));

function checkEs5(root, changed, baseline) {
  const p = tsconfigProblem(root);
  if (p) return { status: 'SKIP', note: p };
  const r = runTsc(root, ['--target', 'es5']);
  const bad = es5Errors(r.errors);
  return tscResult({ status: bad.length ? 1 : 0, errors: bad, raw: '' }, changed, 'iteration(s) the ES5 web build breaks', ' (use Array.from / forEach)', baseline, ['--target', 'es5']);
}

/** The commands of a spec's `Run:` header: one per comment line that starts with tsc / node / npx / python3. */
export function specCommands(src) {
  // the leading /** … */ block, else the leading // lines; indentation after the comment marker kept
  const block = src.match(/^\s*\/\*\*?([\s\S]*?)\*\//);
  const lines = block
    ? block[1].split('\n').map((l) => l.replace(/^\s*\*?/, ''))
    : ((src.match(/^(?:[ \t]*\/\/[^\n]*\n)+/) || [''])[0]).split('\n').map((l) => l.replace(/^\s*\/\//, ''));
  const at = lines.findIndex((l) => /\bRun\b[^:\n]*:/.test(l));
  if (at < 0) return [];
  const clean = (c) => c.replace(/\s+\([^)]*\)\s*$/, '').replace(/\s\[[^\]]*\]/g, '').trim();
  const cmds = [];
  const rest = lines[at].replace(/^.*?\bRun\b[^:\n]*:/, '').trim();
  if (rest) cmds.push(clean(rest));
  // then the indented lines under it, up to the first blank or unindented one
  for (const l of lines.slice(at + 1)) {
    if (/^\s{2,}\S/.test(l) && !/^\s*\(/.test(l)) cmds.push(clean(l));
    else if (cmds.length) break;
  }
  return cmds.filter(Boolean);
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

function checkSpecs(root, changed) {
  const specs = listSpecs(root);
  if (!specs.length) return { status: 'SKIP', note: 'no tests/**/*.spec.ts' };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'check-slice-'));
  const lines = [];
  const unrun = [];
  let failed = 0;
  for (const spec of specs) {
    const rel = path.relative(root, spec);
    const cmds = specCommands(fs.readFileSync(spec, 'utf8'));
    if (!cmds.length) {
      // a spec this slice wrote must say how it runs; an older one is reported, not blocked on
      if (changed.includes(rel)) { failed++; lines.push(`${rel}: no \`Run:\` header with its commands`); } else unrun.push(rel);
      continue;
    }
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
  const notRun = unrun.length ? [`not run — no \`Run:\` header (older specs; add one when you touch them):`, ...unrun.map((f) => `  ${f}`)] : [];
  const ran = specs.length - unrun.length;
  if (failed) return { status: 'FAIL', note: `${failed}/${ran} spec(s) failed`, lines: [...lines, ...notRun] };
  if (unrun.length) return { status: 'WARN', note: `${ran}/${ran} specs pass, ${unrun.length} not run`, lines: notRun };
  return { status: 'PASS', note: `${ran}/${ran} specs` };
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

/**
 * The slice base when --base is not given: main / master; in a linked worktree (a fleet lane on its own branch) the
 * branch the main checkout is on; in the main checkout on another branch HEAD itself (a single lane works uncommitted
 * on the base branch, so changed = working tree + untracked) with a note that commits of this slice are not seen.
 * The runner passes --base (the commit the slice started from), so this is the fallback for a hand run.
 * → { ref, note } | null
 */
export function defaultBase(root) {
  for (const b of ['main', 'master']) if (sh('git', ['rev-parse', '--verify', '-q', b], root).status === 0) return { ref: b, note: '' };
  const here = git(root, 'rev-parse', '--abbrev-ref', 'HEAD').trim();
  const dir = (a) => { const o = git(root, 'rev-parse', a).trim(); return o ? fs.realpathSync(path.resolve(root, o)) : ''; };
  if (dir('--git-dir') !== dir('--git-common-dir')) {
    const main = git(root, 'worktree', 'list', '--porcelain').split('\n\n')[0].match(/^branch refs\/heads\/(.+)$/m)?.[1];
    return main && main !== here ? { ref: main, note: `the main checkout's branch ${main}` } : null;
  }
  if (!here || here === 'HEAD') return null;
  return { ref: 'HEAD', note: `no main/master: only uncommitted work is seen as changed, commits of this slice are not (pass --base <sha>)` };
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
  const id = ((src.match(/^id:\s*(\S+)/m) || [])[1] || '').replace(/^["']|["']$/g, '') || null; // id: "S17" is S17
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

/** Lines that still say a value is a guess to tune later. */
export function assumptionNotes(src) {
  return src.split('\n').flatMap((l, i) => (/tune (on|in|against) (the )?preview/i.test(l) ? [{ line: i + 1, text: l.trim().slice(0, 160) }] : []));
}

function checkAssumptions(root, changed) {
  const files = changed.filter((f) => /\.(ts|js|mjs|json)$/.test(f) && !/^(tests|docs|\.cursor|slices|scripts\/smoke)\/|^producer-state\.json$/.test(f) && fs.existsSync(path.join(root, f)));
  const lines = files.flatMap((f) => assumptionNotes(fs.readFileSync(path.join(root, f), 'utf8')).map((h) => `${f}:${h.line}: ${h.text}`));
  return lines.length
    ? { status: 'WARN', note: `${lines.length} value(s) still marked "tune on the preview" — measure it against the art (crop at 2x) or file a followup`, lines }
    : { status: 'PASS', note: `${files.length} changed file(s)` };
}

const ALL_EDGES = 1 | 4 | 8 | 32; // Widget top | bottom | left | right
const OVERFLOW = { 0: 'NONE', 1: 'CLAMP', 2: 'SHRINK', 3: 'RESIZE_HEIGHT' };
const OVERLAY_NAME = /(^|[^a-z])(dim|overlay|backdrop|scrim|shade)([^a-z]|$)/i;
const PLACEHOLDER_TEXT = /^(|label|new label|\?|0|-|text)$/i;

/** Rough rendered width of a one-line string: per-glyph factors of the font size (CJK/Hangul 1.0, capitals and digits 0.62, others 0.55, space 0.28, punctuation 0.35). */
export function textWidth(str, size, bold = false) {
  let w = 0;
  for (const ch of str) {
    if (/[\u3000-\u9fff\uac00-\ud7af\uff00-\uffef]/.test(ch)) w += 1;
    else if (ch === ' ') w += 0.28;
    else if (/[A-Z0-9ĐƠƯÂÊÔĂ]/.test(ch)) w += 0.62;
    else if (/[.,:;!'"()\-|]/.test(ch)) w += 0.35;
    else w += 0.55;
  }
  return w * size * (bold ? 1.05 : 1);
}

/**
 * The scene-check lines for one parsed .scene/.prefab (Cocos 3.x serialized array): `<node path>: <problem>`.
 * Components are matched to their node by `node.__id__`; the path walks `_parent` (5 levels at most).
 */
export function sceneFindings(doc) {
  if (!Array.isArray(doc)) return [];
  const comps = new Map();
  doc.forEach((o) => {
    const n = o && typeof o === 'object' && o.node && o.node.__id__;
    if (n !== undefined && n !== null && String(o.__type__ || '').startsWith('cc.')) (comps.get(n) || comps.set(n, []).get(n)).push(o);
  });
  const name = (i) => {
    const parts = [];
    for (let k = i, depth = 0; k !== undefined && k !== null && doc[k] && depth < 5; k = doc[k]._parent?.__id__, depth++) parts.unshift(doc[k]._name || `#${k}`);
    return parts.join('/');
  };
  const of = (i, t) => (comps.get(i) || []).filter((c) => c.__type__ === t);
  const fullWidget = (i) => of(i, 'cc.Widget').some((w) => ((w._alignFlags || 0) & ALL_EDGES) === ALL_EDGES);
  const out = [];
  doc.forEach((o, i) => {
    if (!o || o.__type__ !== 'cc.Node') return;
    for (const c of of(i, 'cc.Canvas')) {
      const cam = doc[c._cameraComponent?.__id__];
      if (cam && cam._projection !== 0) out.push(`${name(i)}: Canvas camera is PERSPECTIVE (_projection ${cam._projection}); the UI renders scaled — set it to ORTHO (0)`);
      if (!fullWidget(i)) out.push(`${name(i)}: Canvas has no Widget on all four edges (_alignFlags ${of(i, 'cc.Widget').map((w) => w._alignFlags).join(',') || 'none'}); the HUD stays on the design frame at other aspects — align top/bottom/left/right (45)`);
    }
    // a screen-level overlay: a child of the prefab/scene root or of the Canvas (a dim inside a panel is local art)
    const parent = o._parent?.__id__;
    const top = parent === undefined || parent === null || !doc[parent]?._parent || of(parent, 'cc.Canvas').length > 0;
    if (OVERLAY_NAME.test(o._name || '') && top && of(i, 'cc.Sprite').length && !fullWidget(i)) {
      out.push(`${name(i)}: dim/overlay sprite without a Widget on all four edges; it leaves undimmed bands at other aspects`);
    }
    for (const l of of(i, 'cc.Label')) {
      const box = of(i, 'cc.UITransform')[0]?._contentSize;
      if (!box) continue;
      const size = l._fontSize || 0;
      const ov = l._overflow ?? 0;
      const text = String(l._string ?? '');
      const where = `${name(i)}: Label "${text.slice(0, 24)}" ${OVERFLOW[ov]} ${size}px in ${Math.round(box.width)}x${Math.round(box.height)}`;
      if (!size) continue;
      if (ov === 2 && l._actualFontSize && text && !PLACEHOLDER_TEXT.test(text.trim()) && l._actualFontSize < 0.8 * size) {
        out.push(`${where}: saved at ${Math.round(l._actualFontSize)}px (${Math.round((100 * l._actualFontSize) / size)}% of the authored size) — give it the box the text needs`);
      } else if ((ov === 1 || ov === 2) && box.height < 0.9 * size) {
        out.push(`${where}: the box is shorter than the font, every string ${ov === 2 ? 'shrinks' : 'is clipped'} — make the box at least the line height`);
      } else if ((ov === 1 || ov === 2) && !l._enableWrapText && text && !PLACEHOLDER_TEXT.test(text.trim())) {
        const est = textWidth(text, size, l._isBold);
        if (est > 1.15 * box.width) out.push(`${where}: "${text.slice(0, 24)}" needs ~${Math.round(est)}px on one line — ${ov === 2 ? `shrinks to ~${Math.round((size * box.width) / est)}px` : 'clipped'}`);
      }
      if (ov === 3 && box.width < 2 * size && [...text].length > 2 && !PLACEHOLDER_TEXT.test(text.trim())) {
        out.push(`${where}: RESIZE_HEIGHT box narrower than two glyphs, it wraps about one character per line — give it the design width`);
      }
    }
  });
  return out;
}

/** Split a file's lines against the same file at the base, as multisets: [new, pre-existing]. */
export function splitScene(now, before) {
  const left = new Map();
  for (const l of before) left.set(l, (left.get(l) || 0) + 1);
  const fresh = [], old = [];
  for (const l of now) {
    if (left.get(l) > 0) { old.push(l); left.set(l, left.get(l) - 1); } else fresh.push(l);
  }
  return [fresh, old];
}

function checkScene(root, changed, all, base) {
  const isScene = (f) => /^assets\/.*\.(scene|prefab)$/.test(f);
  const files = (all ? filesUnder(root, 'assets').filter(isScene) : changed.filter(isScene)).filter((f) => fs.existsSync(path.join(root, f)));
  if (!files.length) return { status: 'SKIP', note: all ? 'no .scene/.prefab under assets/' : 'no changed .scene/.prefab' };
  const fresh = [], old = [];
  for (const f of files) {
    let doc;
    try { doc = JSON.parse(fs.readFileSync(path.join(root, f), 'utf8')); } catch { continue; }
    let before = [];
    if (base) { try { before = sceneFindings(JSON.parse(git(root, 'show', `${base}:${f}`) || 'null')); } catch { /* new or unreadable at the base */ } }
    const [n, o] = splitScene(sceneFindings(doc), before);
    fresh.push(...n.map((l) => `${f}: ${l}`));
    old.push(...o.map((l) => `pre-existing: ${f}: ${l}`));
  }
  if (!fresh.length && !old.length) return { status: 'PASS', note: `${files.length} scene/prefab file(s)` };
  const note = fresh.length
    ? `${fresh.length} scene/text problem(s) in ${files.length} file(s) — fix each, or declare it in integration-notes.md (laid out by code)${old.length ? `; ${old.length} pre-existing at the base, not this slice's` : ''}`
    : `${old.length} pre-existing scene/text problem(s) at the base in the ${files.length} file(s) this slice touched — not this slice's, a followup at most`;
  return { status: 'WARN', note, lines: [...fresh, ...old] };
}

/**
 * The preview port a preview-startup.json names: `previewUrl` (the prompt's key), else `url` / `preview_url` /
 * `preview.url` (pilot 24 S39 wrote `url` from run_project_preview and the smoke gate SKIPPED four times), else `port`.
 */
export function previewUrlPort(j) {
  const url = j?.previewUrl || j?.url || j?.preview_url || j?.preview?.url || '';
  const m = String(url).match(/:(\d+)/);
  return m ? m[1] : j?.port ? String(j.port) : null;
}

/** Preview port: --port, else the slice's evidence/preview-startup.json. */
export function smokePort(root, o, id) {
  if (o.port) return String(o.port);
  if (!id) return null;
  const f = path.join(root, '.cursor', 'evidence', 'tasks', `T-${id}`, 'evidence', 'preview-startup.json');
  try {
    return previewUrlPort(JSON.parse(fs.readFileSync(f, 'utf8')));
  } catch { return null; }
}

/** known-red.json → { id: {since, followup, reason} }; {} when absent or unreadable. */
export function parseKnownRed(text) {
  if (!text) return {};
  try {
    const j = JSON.parse(text);
    return j && typeof j === 'object' && !Array.isArray(j) ? j : {};
  } catch { return {}; }
}

const checkKey = (c) => c.id || String(c.file || '').replace(/\.check\.js$/, '');
const red = (c) => c.status !== 'PASS';
const inLedger = (known, c) => Object.hasOwn(known, checkKey(c)) || Object.hasOwn(known, c.file || '');
const why = (c) => `${checkKey(c)} ${c.status}${c.note ? ` — ${String(c.note).slice(0, 100)}` : ''}${c.actual !== undefined ? ` · actual ${JSON.stringify(c.actual).slice(0, 120)}` : ''}`;

/**
 * Verdict over a full run, the cold (alone) runs and the ledger. `full` / each cold report is run-smoke's
 * JSON (`checks`, or `infra_error`); `knownBase` is the ledger at the slice base, so rows added now are seen.
 */
export function smokeVerdict(full, cold, known, knownBase, rerun = []) {
  if (!full || full.infra_error || !Array.isArray(full.checks)) {
    return { status: 'WARN', note: `smoke did not run: ${full?.infra_error || 'no report'} — start the preview (or pass --port) and rerun` };
  }
  const fails = [], warns = [];
  const reds = full.checks.filter(red);
  // a red the slice did not touch, rerun alone on a fresh page (with its slice's earlier checks): green there is
  // the full run's flake (load, order), not this slice's — a WARN; red again stays a FAIL
  const freshGreen = (c) => rerun.includes(c.file) && cold.some(({ file, report }) => file === c.file && Array.isArray(report?.checks)
    && report.checks.some((x) => (x.file === file || checkKey(x) === checkKey(c)) && !red(x)));
  for (const c of reds) {
    if (inLedger(known, c)) continue;
    if (freshGreen(c)) warns.push(`red in the full run, green on a fresh page with its slice's earlier checks (flaky under load or order): ${why(c)}`);
    else fails.push(`red: ${why(c)}`);
  }
  for (const c of full.checks) if (!red(c) && inLedger(known, c)) warns.push(`known-red now green, drop it from ${KNOWN_RED}: ${checkKey(c)}`);
  const ids = new Set(full.checks.map(checkKey));
  for (const [k, v] of Object.entries(known)) {
    if (!Object.hasOwn(knownBase, k)) warns.push(`added to ${KNOWN_RED} by this slice (reviewer rules): ${k}${v?.reason ? ` — ${v.reason}` : ''}`);
    if (!v?.followup) warns.push(`${KNOWN_RED} ${k} has no followup id`);
    if (!ids.has(k) && !ids.has(k.replace(/\.check\.js$/, ''))) warns.push(`${KNOWN_RED} ${k} names no check in the corpus`);
  }
  for (const { file, report } of cold) {
    if (rerun.includes(file)) continue; // judged above, with its full-run red
    if (!report || report.infra_error || !Array.isArray(report.checks)) { warns.push(`${file} on a fresh page did not run: ${report?.infra_error || 'no report'}`); continue; }
    const c = report.checks.find((x) => x.file === file) || (report.checks.length === 1 ? report.checks[0] : null);
    if (!c) continue;
    const inFull = full.checks.find((x) => x.file === file || checkKey(x) === checkKey(c));
    if (red(c) && !(inFull && red(inFull))) fails.push(`red on a fresh page with its slice's earlier checks, green in the full run (it leans on state another slice's check or a warm page left): ${why(c)}`);
  }
  const lines = [...fails, ...warns];
  const flakes = warns.filter((l) => l.startsWith('red in the full run, green on a fresh page')).length;
  const summary = `${full.checks.length} checks, ${reds.length} red (${reds.length - flakes - fails.filter((l) => l.startsWith('red:')).length} known${flakes ? `, ${flakes} green on a fresh page` : ''}), ${cold.length - rerun.length} new/changed run on a fresh page`;
  if (fails.length) return { status: 'FAIL', note: `${summary} — fix each red check, or list one another slice owns in ${KNOWN_RED} with a followup`, lines };
  if (warns.length) return { status: 'WARN', note: summary, lines };
  return { status: 'PASS', note: summary };
}

/**
 * A full-corpus report already in the slice evidence: *smoke*.json at any depth (not under memory/ or a
 * negative-control folder or name) with a `checks` list that names every corpus file, no infra_error,
 * written after the newest changed file (a torn file, still being written, is skipped). Several such runs saw
 * the same code: the one with the fewest red checks is reused (newest on a tie), and a check red in one of
 * them but green in another is `flaky` (pilot 24 S38: two reruns with 19-20 reds, a different set each time,
 * overwrote the green smoke.json and the gate failed; a quiet rerun had the 7 known reds only).
 * → { file, report, runs, flaky: [check key] } | null
 */
export function reusableSmoke(evDir, corpus, newestChange) {
  if (!evDir || !fs.existsSync(evDir)) return null;
  const files = fs.readdirSync(evDir, { recursive: true }).map(String)
    // a negative-control run is red on purpose: never the slice's full run
    .filter((f) => /smoke[^/]*\.json$/i.test(f) && path.basename(f) !== 'static-smoke.json' && !/(^|\/)(memory|neg[^/]*)\/|negative/i.test(f))
    .map((f) => ({ f, m: fs.statSync(path.join(evDir, f)).mtimeMs })).sort((a, b) => b.m - a.m);
  const runs = [];
  for (const { f, m } of files) {
    if (m < newestChange) break;
    let j;
    try { j = JSON.parse(fs.readFileSync(path.join(evDir, f), 'utf8')); } catch { continue; }
    if (!j || j.infra_error || !Array.isArray(j.checks)) continue;
    const have = new Set(j.checks.map((c) => c.file));
    if (corpus.every((c) => have.has(c))) runs.push({ file: f, report: j, reds: j.checks.filter(red).length });
  }
  if (!runs.length) return null;
  const best = runs.reduce((a, b) => (b.reds < a.reds ? b : a));
  const greenSomewhere = new Set(runs.flatMap((r) => r.report.checks.filter((c) => !red(c)).map(checkKey)));
  const flaky = [...new Set(runs.flatMap((r) => r.report.checks.filter((c) => red(c) && greenSomewhere.has(checkKey(c))).map(checkKey)))].sort();
  return { file: best.file, report: best.report, runs: runs.length, flaky };
}

const smokeRunner = (root) => process.env.CHECK_SLICE_SMOKE_RUNNER || path.join(root, '.cursor', 'skills', 'smoke-test', 'scripts', 'run-smoke.mjs');

const OWN_FLAGS = new Set(['--port', '--channel', '--checks', '--page', '--screenshots-dir']);

/** The project's run-smoke flags (scripts/smoke/run-args.json: an array, or {"args": [...]}), minus the ones the gate sets. */
export function smokeArgs(text) {
  let a;
  try { a = JSON.parse(text || '[]'); } catch { return []; }
  a = Array.isArray(a) ? a : Array.isArray(a?.args) ? a.args : [];
  const out = [];
  for (let i = 0; i < a.length; i++) {
    const f = String(a[i]);
    if (OWN_FLAGS.has(f)) { if (a[i + 1] !== undefined && !String(a[i + 1]).startsWith('--')) i++; continue; }
    if (f === '--quiet' || f === '--attach-only') continue;
    out.push(f);
  }
  return out;
}

/** The suite gate files from run-args.json (`{"args": [...], "gate": ["S01-00-boot.check.js"]}`); [] when not set. */
export function smokeGate(text) {
  try {
    const j = JSON.parse(text || '[]');
    return Array.isArray(j?.gate) ? j.gate.map((f) => (String(f).endsWith('.check.js') ? String(f) : `${f}.check.js`)) : [];
  } catch { return []; }
}

/** Rough wall time of a run of n checks: page start, --settle once, then --delay (run-smoke default 300 ms) plus ~0.5 s each. */
export function smokeEstimateMs(n, args) {
  const num = (flag, dflt) => {
    const i = args.indexOf(flag);
    return i > -1 && Number.isFinite(Number(args[i + 1])) ? Number(args[i + 1]) : dflt;
  };
  return 10000 + num('--settle', 0) + n * (num('--delay', 300) + 500);
}

/**
 * The wall time a full run really took: the newest report in the slice evidence that covers most of the corpus,
 * scaled to the corpus size, +10%. Stale reports count (only the duration is used). null when there is none.
 */
export function measuredSmokeMs(evDir, corpus) {
  if (!evDir || !fs.existsSync(evDir)) return null;
  let best = null;
  for (const f of fs.readdirSync(evDir, { recursive: true }).map(String)) {
    if (!/smoke[^/]*\.json$/i.test(f) || /(^|\/)(memory|neg[^/]*)\/|negative/i.test(f)) continue;
    let j;
    try { j = JSON.parse(fs.readFileSync(path.join(evDir, f), 'utf8')); } catch { continue; }
    const n = Array.isArray(j?.checks) ? j.checks.length : 0;
    const ms = Date.parse(j?.finishedAt) - Date.parse(j?.startedAt);
    if (n < 0.8 * corpus || !(ms > 0)) continue;
    const at = Date.parse(j.finishedAt);
    if (!best || at > best.at) best = { at, ms: Math.round((ms * corpus) / n * 1.1) };
  }
  return best?.ms ?? null;
}

/** Extra wall time from the checks' own `// DELAY: <ms>` headers (run-smoke) over the run's --delay. */
export function headerDelayMs(dir, files, args) {
  const i = args.indexOf('--delay');
  const base = i > -1 && Number.isFinite(Number(args[i + 1])) ? Number(args[i + 1]) : 300;
  let extra = 0;
  for (const f of files) {
    const m = (readText(path.join(dir, f)) || '').match(/^\/\/ *DELAY: *(\d+)\s*$/m);
    if (m) extra += Math.max(0, Number(m[1]) - base);
  }
  return extra;
}

/** A changed check and the earlier checks of its slice (same `Sxx-` prefix), in corpus order; others alone. */
export function smokeGroups(corpus, touched, gate = []) {
  const sorted = [...corpus].sort();
  const groups = new Map();
  const head = gate.filter((f) => corpus.includes(f));
  for (const file of touched) {
    const prefix = (file.match(/^(S\d+[a-z]?)-/i) || [])[1];
    const key = prefix || file;
    const upTo = sorted.indexOf(file);
    const members = prefix ? sorted.filter((f, i) => f.startsWith(`${prefix}-`) && i <= upTo) : [file];
    const g = groups.get(key) || { files: [], judge: [] };
    for (const m of members) if (!g.files.includes(m)) g.files.push(m);
    g.judge.push(file);
    groups.set(key, g);
  }
  // run order: the suite gate first (it absorbs the boot --delay), then the slice chain in corpus order
  return [...groups.values()].map((g) => ({ files: [...head, ...g.files.sort().filter((f) => !head.includes(f))], judge: g.judge }));
}

function runSmoke(root, port, checksDir, timeout, extra = []) {
  const r = sh(process.execPath, [smokeRunner(root), '--port', port, '--channel', 'chrome', '--quiet', '--checks', checksDir, ...extra], root, timeout);
  try { return JSON.parse(r.stdout); } catch { return { infra_error: `run-smoke exit ${r.status}: ${(r.stderr || r.error?.message || '').trim().slice(0, 200)}` }; }
}

function checkSmoke(root, o, changed, base) {
  if (!fs.existsSync(smokeRunner(root))) return { status: 'SKIP', note: 'no .cursor/skills/smoke-test/scripts/run-smoke.mjs' };
  const dir = path.join(root, 'scripts', 'smoke', 'checks');
  const all = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.check.js')) : [];
  if (!all.length) return { status: 'SKIP', note: 'no scripts/smoke/checks/*.check.js' };
  const src = readSlice(root, o.slice);
  const id = (src && sliceFacts(src).id) || (path.basename(o.slice || '').match(/^(S\d+[a-z]?)/i) || [])[1] || null;
  const port = smokePort(root, o, id);
  // a corpus that never ran is not a pass: WARN, so the runner log and the reviewer see it (pilot 24 S39: SKIP ×4, unseen)
  if (!port) return { status: 'WARN', note: `smoke not run: no preview port — pass --port or write .cursor/evidence/tasks/T-${id || '<Sxx>'}/evidence/preview-startup.json with "previewUrl"` };
  const known = parseKnownRed(readText(path.join(root, KNOWN_RED)));
  const knownBase = base ? parseKnownRed(git(root, 'show', `${base}:${KNOWN_RED}`)) : known;
  const deadline = Date.now() + (o.smokeBudget > 0 ? o.smokeBudget : SMOKE_BUDGET_S) * 1000;
  const left = () => deadline - Date.now();
  const evDir = id ? path.join(root, '.cursor', 'evidence', 'tasks', `T-${id}`, 'evidence') : null;
  // notes, docs, evidence and the gate's own config (ledger, run flags) written after the last full run do not make it stale
  const newest = Math.max(0, ...changed.filter((f) => fs.existsSync(path.join(root, f)) && !f.startsWith('.cursor/') && !/\.md$/.test(f) && !f.startsWith('docs/')
    && !GATE_CONFIG.includes(f))
    .map((f) => fs.statSync(path.join(root, f)).mtimeMs));
  const extra = smokeArgs(readText(path.join(root, 'scripts', 'smoke', 'run-args.json')));
  const reused = reusableSmoke(evDir, all, newest);
  const est = measuredSmokeMs(evDir, all.length) ?? smokeEstimateMs(all.length, extra) + headerDelayMs(dir, all, extra);
  const full = reused ? reused.report
    : est > left() ? { infra_error: `no full-corpus *smoke*.json in ${evDir ? path.relative(root, evDir) : 'the slice evidence'} newer than the last code change, and a run (${all.length} checks${extra.length ? ` with ${extra.join(' ')}` : ''}, ~${Math.round(est / 60000)} min) does not fit the ${Math.round(left() / 1000)} s budget — save your last full run there` }
    : runSmoke(root, port, dir, Math.max(1000, left()), extra);
  const touched = changed.filter((f) => /^scripts\/smoke\/checks\/[^/]+\.check\.js$/.test(f) && fs.existsSync(path.join(root, f))).map((f) => path.basename(f));
  const cold = [], runs = [], skipped = [];
  // reds outside the ledger in checks this slice did not touch: rerun on a fresh page after the slice's own groups
  const rerun = full && Array.isArray(full.checks) ? full.checks.filter((c) => red(c) && c.file && !inLedger(known, c) && !touched.includes(c.file) && all.includes(c.file)).map((c) => c.file) : [];
  if (full && Array.isArray(full.checks)) {
    const gateText = readText(path.join(root, 'scripts', 'smoke', 'run-args.json'));
    const gate = smokeGate(gateText).length ? smokeGate(gateText) : full.checks[0]?.file ? [full.checks[0].file] : [];
    // this slice's own chain first (its new checks matter most), then the others in corpus order; a group that does
    // not fit the budget left (or past SMOKE_GROUP_MAX) is skipped, never cut off mid-run (capytal S23: 13 changed checks)
    const own = (g) => (id && g.judge.some((f) => f.toUpperCase().startsWith(`${id.toUpperCase()}-`)) ? 0 : 1);
    const reruns = (g) => (g.judge.every((f) => rerun.includes(f)) ? 1 : 0); // the slice's own and changed checks first
    const groups = smokeGroups(all, [...touched, ...rerun], gate).map((g, i) => ({ ...g, i })).sort((a, b) => reruns(a) - reruns(b) || own(a) - own(b) || a.i - b.i);
    for (const [n, g] of groups.entries()) {
      const need = smokeEstimateMs(g.files.length, extra) + headerDelayMs(dir, g.files, extra);
      if (n >= SMOKE_GROUP_MAX || need > left()) { skipped.push(...g.judge.filter((f) => !rerun.includes(f))); continue; }
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'check-slice-smoke-'));
      try {
        // run-smoke sorts the folder by name: a numbered copy keeps the gate first; names map back after
        g.files.forEach((f, i) => fs.copyFileSync(path.join(dir, f), path.join(tmp, `${String(i).padStart(3, '0')}~${f}`)));
        const report = runSmoke(root, port, tmp, Math.max(1000, Math.min(need * 2, left())), extra);
        for (const c of report.checks || []) if (c.file) c.file = String(c.file).replace(/^\d{3}~/, '');
        runs.push({ files: g.files, judged: g.judge, report });
        for (const file of g.judge) cold.push({ file, report });
      } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
    }
  }
  if (o.out) {
    const f = path.join(path.dirname(path.resolve(root, o.out)), 'static-smoke.json');
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, `${JSON.stringify(runs.length ? { ...full, fresh_page: runs } : full, null, 2)}\n`);
  }
  const r = smokeVerdict(full, cold, known, knownBase, rerun);
  if (reused) r.note = `${r.note}; full run reused from evidence/${reused.file}${reused.runs > 1 ? ` (fewest reds of ${reused.runs} full runs since the last change)` : ''}`;
  if (reused?.flaky.length) {
    r.lines = [...(r.lines || []), `flaky since the last change (red in one full run, green in another): ${reused.flaky.slice(0, 12).join(', ')}${reused.flaky.length > 12 ? `, … (${reused.flaky.length - 12} more)` : ''}`];
    if (r.status === 'PASS') r.status = 'WARN';
  }
  if (skipped.length) {
    const list = skipped.map((f) => f.replace(/\.check\.js$/, ''));
    r.lines = [...(r.lines || []), `${skipped.length} new/changed check(s) not run on a fresh page (the smoke budget or ${SMOKE_GROUP_MAX} pages ran out): ${list.slice(0, 12).join(', ')}${list.length > 12 ? `, … (${list.length - 12} more)` : ''}`];
    if (r.status === 'PASS') r.status = 'WARN';
  }
  return r;
}

export function main(argv) {
  const o = parseArgs(argv);
  const root = path.resolve(o.root || git(process.cwd(), 'rev-parse', '--show-toplevel').trim() || process.cwd());
  const dflt = o.base ? null : defaultBase(root);
  const base = o.base || dflt?.ref || null;
  const changed = changedFiles(root, base);
  const baseline = makeBaseline(root, base);
  const run = {
    tsc: () => checkTsc(root, changed, baseline),
    es5: () => checkEs5(root, changed, baseline),
    specs: () => checkSpecs(root, changed),
    scope: () => checkScope(root, o.slice, changed),
    'smoke-lint': () => checkSmokeLint(root, changed, o.allChecks),
    evidence: () => checkEvidence(root, o, changed),
    notes: () => checkNotes(root, o, changed),
    assumptions: () => checkAssumptions(root, changed),
    scene: () => checkScene(root, changed, o.allChecks, base),
    smoke: () => checkSmoke(root, o, changed, base),
  };
  const out = [`check-slice ${path.basename(root)} slice=${o.slice || '-'} base=${base || '-'}${dflt?.note ? ` (${dflt.note})` : ''} at ${new Date().toISOString()}`];
  const worst = { FAIL: [], WARN: [] };
  try {
    for (const name of CHECKS.filter((c) => o.only.includes(c))) {
      const t0 = Date.now();
      const r = run[name]();
      out.push(`${r.status} ${name}${r.note ? `: ${r.note}` : ''} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
      for (const l of r.lines || []) out.push(`  ${l}`);
      if (worst[r.status]) worst[r.status].push(name);
    }
  } finally { baseline.dispose(); }
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
