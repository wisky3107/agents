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
 *
 * Prints one line per check and the detail under it, then `RESULT PASS|WARN|FAIL (...)`.
 * Exit 1 on any FAIL, else 0. SKIP (no tsconfig, no tests, no slice) is not a failure.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

const CHECKS = ['tsc', 'es5', 'specs', 'scope', 'smoke-lint', 'evidence', 'notes', 'assumptions'];
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
