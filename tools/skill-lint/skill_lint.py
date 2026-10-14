#!/usr/bin/env python3
"""Static linter for the skills under ~/.agents/skills (and the links that install them).

Checks, per skill:
  - frontmatter (agentskills.io spec): `name` 1-64 chars of a-z 0-9 and single inner hyphens, equal to
    the folder; `description` 1-1024 chars; a model-invoked skill says when to use it ("Use when …");
  - size: SKILL.md over 500 lines (disclose reference into linked files);
  - references: markdown links and paths into the skill system (`~/.agents/skills/…`,
    `.cursor/skills/<skill>/…`, `../<skill>/…`, `<skill>/…`, `${CLAUDE_SKILL_DIR}/…`) that do not
    exist; skill-relative paths (`reference/…`, `scripts/…`) that resolve nowhere are only INFO, since
    the same spelling is usually a project path or another skill's file;
  - syntax: `node --check` for .mjs/.js/.cjs, compile() for .py, `bash -n` for .sh;
and, once: install links (~/.claude/skills, the templates' .cursor/.claude skills) that dangle.

Findings are observations with a severity; exit 1 only on an ERROR in a skill this repo owns
(vendored skills from .skill-lock.json are reported, never fail the run). Stdlib only.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import tempfile

HOME = os.path.expanduser('~')
HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_ROOT = os.path.normpath(os.path.join(HERE, '..', '..', 'skills'))
TEMPLATES = [os.path.join(HOME, 'Works', 'games', 'template', t)
             for t in ('cc-game-template', 'cc-playable-template', 'cc4-game-template')]
DEFAULT_LINK_DIRS = [os.path.join(HOME, '.claude', 'skills')] + [
    os.path.join(t, d, 'skills') for t in TEMPLATES for d in ('.cursor', '.claude')]

MAX_DESC = 1024
MAX_LINES = 500
SKIP_DIRS = {'node_modules', '.git', '__pycache__', 'assets', 'output', 'cache'}
# docs that resolve in a project, not here: copied evidence, kit payloads, templates
DOC_SKIP_DIRS = SKIP_DIRS | {'evidence', 'files'}
NAME_RE = re.compile(r'[a-z0-9]+(?:-[a-z0-9]+)*')
CODE_EXT = {'.mjs': 'node', '.js': 'node', '.cjs': 'node', '.py': 'python', '.sh': 'bash'}
SKILL_SUBDIRS = ('reference', 'references', 'scripts', 'agents', 'tests', 'bin', 'lib')
TRIGGER_RE = re.compile(r'\buse (it |this (skill )?)?(when|for|whenever|to)\b|\btriggers? on\b'
                        r'|\bwhen (the |a )?(user|they|director|someone|you)\b', re.I)

LINK_RE = re.compile(r'\]\(([^)\s]+)\)')
CODE_SPAN_RE = re.compile(r'`([^`\s]+)`')
# anchored paths into the skill system, anywhere in the text (prose, code spans, fenced blocks)
ANCHORED_RE = re.compile(
    r'(?:~|\$HOME|' + re.escape(HOME) + r')/\.agents/(?:skills|tools|bin|hooks)/[^\s`\'")\]]+'
    r'|\$\{?CLAUDE_SKILL_DIR\}?/[^\s`\'")\]]+'
    r'|(?<![\w/])(?:[\w<>.-]+/)?\.cursor/skills/[^\s`\'")\]]+')
PLACEHOLDER_RE = re.compile(r'[<>*{}|…]|\.\.\.|\bS(?:xx|NN|nn)\b|\bNN\b|\bXX+\b|\bslug\b', re.I)
TRAIL_RE = re.compile(r'(?::\d+(?:-\d+)?|#[\w-]*|[.,;:!?)\]]+)$')

SEVERITIES = ('ERROR', 'WARN', 'INFO')


# --------------------------------------------------------------------------- frontmatter

def parse_frontmatter(text: str) -> dict | None:
    """The `---` block at the top as {key: str}: plain, quoted, and folded/literal (>-, |) scalars.
    None when the file does not open with one."""
    m = re.match(r'---\r?\n(.*?)\r?\n---\r?\n', text, re.S)
    if not m:
        return None
    out: dict = {}
    lines = m.group(1).splitlines()
    i = 0
    while i < len(lines):
        km = re.match(r'([A-Za-z0-9_-]+):\s*(.*)$', lines[i])
        i += 1
        if not km:
            continue
        key, val = km.group(1), km.group(2).strip()
        if val in ('>', '>-', '>+', '|', '|-', '|+') or val == '':
            block = []
            while i < len(lines) and (lines[i].startswith((' ', '\t')) or not lines[i].strip()):
                block.append(lines[i].strip())
                i += 1
            sep = '\n' if val.startswith('|') else ' '
            val = sep.join(b for b in block if b) if val else ' '.join(b for b in block if b)
        elif len(val) >= 2 and val[0] == val[-1] and val[0] in '"\'':
            val = val[1:-1]
        out[key] = val
    return out


def check_frontmatter(skill: str, text: str) -> list[dict]:
    fm = parse_frontmatter(text)
    if fm is None:
        return [finding('ERROR', 'frontmatter', 'SKILL.md has no `---` frontmatter block')]
    out = []
    name = fm.get('name', '')
    if not name:
        out.append(finding('ERROR', 'frontmatter', '`name` missing'))
    elif len(name) > 64 or not NAME_RE.fullmatch(name):
        out.append(finding('ERROR', 'frontmatter', f'`name: {name}` must be 1-64 chars of a-z, 0-9 and single inner hyphens'))
    if name and name != skill:
        out.append(finding('ERROR', 'frontmatter', f'`name: {name}` does not match the folder `{skill}`'))
    desc = fm.get('description', '')
    if not desc:
        out.append(finding('ERROR', 'frontmatter', '`description` missing'))
    elif len(desc) > MAX_DESC:
        out.append(finding('ERROR', 'description', f'description is {len(desc)} chars (spec max {MAX_DESC}): clients may reject or truncate it'))
    model_invoked = fm.get('disable-model-invocation', '').lower() != 'true'
    if desc and model_invoked and not TRIGGER_RE.search(desc):
        out.append(finding('WARN', 'description', 'model-invoked skill whose description never says when to use it ("Use when …")'))
    return out


# --------------------------------------------------------------------------- references

def finding(sev: str, check: str, msg: str, file: str = 'SKILL.md', line: int | None = None) -> dict:
    return {'severity': sev, 'check': check, 'message': msg, 'file': file, 'line': line}


def clean(ref: str) -> str:
    ref = ref.strip().strip('"\'')
    prev = None
    while prev != ref:
        prev, ref = ref, TRAIL_RE.sub('', ref)
    return ref


class Resolver:
    """Maps a path written in a skill doc to the file it means, when it unambiguously means one."""

    def __init__(self, root: str, templates: list[str]):
        self.root = os.path.abspath(root)
        # <agents>/skills → <agents> (the main checkout or a worktree of it); a template's skills
        # folder still means the real ~/.agents for `~/.agents/…` paths
        parent = os.path.dirname(self.root)
        is_agents = any(os.path.exists(os.path.join(parent, x)) for x in ('tools', '.skill-lock.json'))
        self.agents_home = parent if is_agents else os.path.join(HOME, '.agents')
        ah_skills = os.path.join(self.agents_home, 'skills')
        self.agents_skills = set(os.listdir(ah_skills)) if os.path.isdir(ah_skills) else set()
        self.skills = {d for d in os.listdir(self.root) if os.path.isdir(os.path.join(self.root, d))}
        self.template_skills = {}
        for t in templates:
            for d in ('.cursor', '.claude'):
                sd = os.path.join(t, d, 'skills')
                if os.path.isdir(sd):
                    for name in os.listdir(sd):
                        self.template_skills.setdefault(name, os.path.join(sd, name))

    def skill_dir(self, name: str) -> str | None:
        if name in self.skills:
            return os.path.join(self.root, name)
        return self.template_skills.get(name)

    def sibling(self, name: str, rest: list[str]) -> str:
        """`../<skill>/rest` means that skill wherever it is installed, whatever the doc's depth: in a
        project every skill sits side by side under .cursor/skills."""
        return os.path.join(self.skill_dir(name), *rest)

    def exists(self, target: str) -> bool:
        """In a worktree, a path under <agents> also counts when the main checkout has it (an
        untracked shim such as bin/pkill is installed there, never committed)."""
        if os.path.exists(target):
            return True
        main = os.path.join(HOME, '.agents')
        if target.startswith(self.agents_home + '/') and self.agents_home != main:
            return os.path.exists(os.path.join(main, target[len(self.agents_home) + 1:]))
        return False

    def anchored(self, ref: str, skill_dir: str) -> str | None:
        """Absolute target of an anchored ref, or None when it names nothing checkable."""
        for pre in ('~/.agents/', '$HOME/.agents/', HOME + '/.agents/'):
            if ref.startswith(pre):
                return os.path.join(self.agents_home, ref[len(pre):])
        m = re.match(r'\$\{?CLAUDE_SKILL_DIR\}?/(.*)', ref)
        if m:
            return os.path.join(skill_dir, m.group(1))
        m = re.search(r'\.cursor/skills/([^/]+)(?:/(.*))?$', ref)
        if m:
            base = self.skill_dir(m.group(1))
            return None if base is None else os.path.join(base, m.group(2) or '')
        return None

    def relative(self, ref: str, skill_dir: str, file_dir: str) -> tuple[str | None, str]:
        """(target, kind) for a code-span path: kind 'skill' (into another skill: must exist),
        'local' (skill-relative dir: may be a project path) or '' (not ours to check)."""
        parts = ref.split('/')
        if len(parts) < 2:
            return None, ''
        if parts[0] == '..' and len(parts) > 2 and self.skill_dir(parts[1]):
            return self.sibling(parts[1], parts[2:]), 'skill'
        if parts[0] in self.skills or (parts[0] in self.template_skills and parts[0] not in SKILL_SUBDIRS):
            return os.path.join(self.skill_dir(parts[0]), *parts[1:]), 'skill'
        if parts[0] in SKILL_SUBDIRS and os.path.isdir(os.path.join(skill_dir, parts[0])):
            return os.path.join(skill_dir, ref), 'local'
        return None, ''


def iter_text_files(skill_dir: str):
    for dirpath, dirnames, filenames in os.walk(skill_dir, followlinks=False):
        dirnames[:] = sorted(d for d in dirnames if d not in DOC_SKIP_DIRS)
        for f in sorted(filenames):
            if f.endswith('.md') and 'template' not in f.lower():
                yield os.path.join(dirpath, f)


def check_references(skill_dir: str, res: Resolver) -> list[dict]:
    out, seen = [], set()
    for path in iter_text_files(skill_dir):
        rel = os.path.relpath(path, skill_dir)
        file_dir = os.path.dirname(path)
        try:
            lines = read_text(path).splitlines()
        except OSError:
            continue
        fenced = False
        for n, line in enumerate(lines, 1):
            if line.lstrip().startswith(('```', '~~~')):
                fenced = not fenced
            cands = []
            for m in LINK_RE.finditer(line if not fenced else ''):  # a link in a fence is an example
                ref = clean(m.group(1))
                if not re.match(r'[a-z]+:', ref) and not ref.startswith('#') and ('/' in ref or '.' in ref):
                    cands.append(('link', ref))
            anchored = [clean(m.group(0)) for m in ANCHORED_RE.finditer(line)]
            cands += [('anchored', r) for r in anchored]
            for m in CODE_SPAN_RE.finditer(line):
                ref = clean(m.group(1))
                if '/' in ref and not any(ref in a or a in ref for a in anchored):
                    cands.append(('span', ref))
            for kind, ref in cands:
                if not ref or PLACEHOLDER_RE.search(ref) or (rel, ref) in seen:
                    continue
                if kind == 'link':
                    target, sev = os.path.normpath(os.path.join(file_dir, ref.split('#')[0])), 'ERROR'
                    parts = ref.split('/')
                    if not res.exists(target) and parts[0] == '..' and len(parts) > 2 and res.skill_dir(parts[1]):
                        target = res.sibling(parts[1], parts[2:])
                elif kind == 'anchored':
                    target = res.anchored(ref, skill_dir)
                    skills_dir = res.agents_home + '/skills/'
                    # a missing file in a skill that exists is an ERROR; naming a skill that is not
                    # installed there may be an optional or template-only one: WARN
                    sev = ('ERROR' if target and target.startswith(skills_dir)
                           and target[len(skills_dir):].split('/')[0] in res.agents_skills else 'WARN')
                else:
                    target, where = res.relative(ref, skill_dir, file_dir)
                    if target and where == 'local' and os.path.exists(os.path.join(file_dir, ref)):
                        continue  # a sibling-relative path (reference/x.md linking reference/y.md)
                    sev = 'ERROR' if where == 'skill' else 'INFO'
                if not target or res.exists(target):
                    continue
                seen.add((rel, ref))
                check = 'ref' if sev != 'INFO' else 'ref-unresolved'
                out.append(finding(sev, check, f'`{ref}` → {short(target)} does not exist', rel, n))
    return out


def read_text(path: str) -> str:
    with open(path, encoding='utf-8', errors='replace') as fh:
        return fh.read()


def short(p: str) -> str:
    return p.replace(HOME, '~', 1)


# --------------------------------------------------------------------------- syntax

def check_syntax(skill_dir: str) -> list[dict]:
    out = []
    for dirpath, dirnames, filenames in os.walk(skill_dir, followlinks=False):
        dirnames[:] = sorted(d for d in dirnames if d not in SKIP_DIRS)
        for f in sorted(filenames):
            kind = CODE_EXT.get(os.path.splitext(f)[1])
            if not kind:
                continue
            path = os.path.join(dirpath, f)
            rel = os.path.relpath(path, skill_dir)
            err = syntax_error(kind, path)
            if err:
                out.append(finding('ERROR', 'syntax', err, rel))
    return out


def syntax_error(kind: str, path: str) -> str | None:
    if kind == 'python':
        try:
            compile(read_text(path), path, 'exec')
        except SyntaxError as e:
            return f'line {e.lineno}: {e.msg}'
        return None
    cmd = ['node', '--check', path] if kind == 'node' else ['bash', '-n', path]
    err = run_check(cmd)
    if err and kind == 'node' and 'await is only valid' in err:
        # an editor snippet (`*.editor.js`) runs inside an async wrapper: check it that way
        with tempfile.NamedTemporaryFile('w', suffix='.js', delete=False) as fh:
            fh.write('(async () => {\n' + read_text(path) + '\n})();\n')
        try:
            err = run_check(['node', '--check', fh.name])
        finally:
            os.unlink(fh.name)
    return err


def run_check(cmd: list[str]) -> str | None:
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
    except (OSError, subprocess.TimeoutExpired) as e:
        return f'{cmd[0]} could not run: {e}'
    if r.returncode == 0:
        return None
    msg = [l for l in (r.stderr or r.stdout).splitlines() if l.strip()]
    hint = next((l for l in msg if 'Error' in l or 'error' in l), msg[0] if msg else 'failed')
    return hint.strip()[:200]


# --------------------------------------------------------------------------- links

def check_links(link_dirs: list[str]) -> list[dict]:
    out = []
    for d in link_dirs:
        if not os.path.isdir(d):
            continue
        for name in sorted(os.listdir(d)):
            p = os.path.join(d, name)
            if os.path.islink(p) and not os.path.exists(p):
                out.append(finding('ERROR', 'link', f'{short(p)} → {os.readlink(p)} dangles', short(d)))
    return out


# --------------------------------------------------------------------------- run

def vendored(root: str) -> set[str]:
    lock = os.path.join(os.path.dirname(os.path.abspath(root)), '.skill-lock.json')
    try:
        return set(json.loads(read_text(lock)).get('skills', {}))
    except (OSError, ValueError):
        return set()


def lint_skill(skill: str, root: str, res: Resolver, syntax: bool = True) -> dict:
    skill_dir = os.path.join(root, skill)
    md = os.path.join(skill_dir, 'SKILL.md')
    if not os.path.isfile(md):
        return {'skill': skill, 'lines': 0, 'findings': [finding('ERROR', 'frontmatter', 'no SKILL.md')]}
    text = read_text(md)
    lines = text.count('\n') + 1
    found = check_frontmatter(skill, text)
    if lines > MAX_LINES:
        found.append(finding('WARN', 'size', f'SKILL.md is {lines} lines (> {MAX_LINES}): disclose reference into linked files'))
    found += check_references(skill_dir, res)
    if syntax:
        found += check_syntax(skill_dir)
    fm = parse_frontmatter(text) or {}
    return {'skill': skill, 'lines': lines, 'desc_chars': len(fm.get('description', '')),
            'model_invoked': fm.get('disable-model-invocation', '').lower() != 'true', 'findings': found}


def run(root: str, only: list[str] | None = None, syntax: bool = True,
        link_dirs: list[str] | None = None, templates: list[str] | None = None) -> dict:
    res = Resolver(root, TEMPLATES if templates is None else templates)
    vend = vendored(root)
    skills = sorted(s for s in res.skills if not s.startswith('.') and (not only or s in only))
    reports = []
    for s in skills:
        r = lint_skill(s, root, res, syntax)
        r['vendored'] = s in vend
        reports.append(r)
    links = check_links(DEFAULT_LINK_DIRS if link_dirs is None else link_dirs) if not only else []
    owned_errors = sum(1 for r in reports if not r['vendored'] for f in r['findings'] if f['severity'] == 'ERROR')
    owned_errors += sum(1 for f in links if f['severity'] == 'ERROR')
    load = sum(r.get('desc_chars', 0) for r in reports if r.get('model_invoked'))
    return {'root': root, 'skills': reports, 'links': links, 'errors': owned_errors, 'description_load_chars': load}


def render(report: dict, verbose: bool = False) -> str:
    out = []
    order = {s: i for i, s in enumerate(SEVERITIES)}
    for r in report['skills']:
        fs = sorted(r['findings'], key=lambda f: (order[f['severity']], f['file'], f['line'] or 0))
        if not verbose:
            fs = [f for f in fs if f['severity'] != 'INFO']
        if not fs:
            continue
        tag = ' (vendored: not failing)' if r['vendored'] else ''
        out.append(f"\n{r['skill']}{tag} — SKILL.md {r['lines']} lines")
        for f in fs:
            loc = f"{f['file']}:{f['line']}" if f['line'] else f['file']
            out.append(f"  {f['severity']:5} {f['check']:14} {loc}  {f['message']}")
    if report['links']:
        out.append('\ninstall links')
        for f in report['links']:
            out.append(f"  {f['severity']:5} {f['check']:14} {f['message']}")
    counts = {s: 0 for s in SEVERITIES}
    for r in report['skills']:
        for f in r['findings']:
            counts[f['severity']] += 1
    for f in report['links']:
        counts[f['severity']] += 1
    clean_n = sum(1 for r in report['skills'] if not any(f['severity'] != 'INFO' for f in r['findings']))
    out.append(f"\n{len(report['skills'])} skills ({clean_n} clean) · {counts['ERROR']} ERROR "
               f"({report['errors']} in owned skills) · {counts['WARN']} WARN · model-invoked description load "
               f"{report['description_load_chars']} chars")
    return '\n'.join(out).lstrip('\n')


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    ap.add_argument('skills', nargs='*', help='skill names (default: every skill under --root)')
    ap.add_argument('--root', default=DEFAULT_ROOT, help=f'skills folder (default {short(DEFAULT_ROOT)})')
    ap.add_argument('--no-syntax', action='store_true', help='skip node/python/bash syntax checks')
    ap.add_argument('--json', action='store_true', help='JSON report on stdout')
    ap.add_argument('-v', '--verbose', action='store_true', help='also print INFO findings')
    a = ap.parse_args(argv)
    if not os.path.isdir(a.root):
        ap.error(f'no skills folder at {a.root}')
    report = run(a.root, a.skills or None, syntax=not a.no_syntax)
    print(json.dumps(report, indent=2) if a.json else render(report, a.verbose))
    return 1 if report['errors'] else 0


if __name__ == '__main__':
    sys.exit(main())
