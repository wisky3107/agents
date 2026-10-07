#!/usr/bin/env python3
"""Workflow scorecard for the Cocos producer / fleet pipeline (plan 2026-10-02, step S0).

Reads data the workflow already writes and stores numbers in one SQLite file:
OmniRoute call_logs (gateway), Orca runs/tasks (orchestration), per-project evidence
(review.md, stats.json, *check*.md, lessons.jsonl, AGENT_NOTES, EXPECT), git merges,
token-report slices (tokens per role) and orca-memory / playbook state (memory).

Read-only towards every source. Never blocks delivery. Stdlib only.

  scorecard.py snapshot                 # OmniRoute + Orca (daily; OmniRoute keeps ~7 days)
  scorecard.py collect [--project p]    # project evidence + git + token-report
  scorecard.py report  [--project p] [--out file]
  scorecard.py join-check               # can gateway calls be joined to sessions / projects?
  scorecard.py scorecard                # weekly KPI flags + dashboard HTML (S2) and config arms (S3)
  scorecard.py daily                    # snapshot + collect + report to logs/scorecard-latest.md
"""

from __future__ import annotations

import argparse
import bisect
import collections
import glob
import json
import os
import re
import sqlite3
import statistics
import subprocess
import sys
from datetime import datetime, timezone

HOME = os.path.expanduser('~')
GAMES_ROOT = os.path.join(HOME, 'Works', 'games', 'CocosCreator')
WORKSPACES_ROOT = os.path.join(HOME, 'orca', 'workspaces')
DB_PATH = os.environ.get('SCORECARD_DB', os.path.join(HOME, '.agents', 'logs', 'scorecard.sqlite'))
LATEST_REPORT = os.path.join(HOME, '.agents', 'logs', 'scorecard-latest.md')
SPAWN_REGISTRY = os.path.join(HOME, '.agents', 'logs', 'spawns.jsonl')
RESOLUTIONS = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'resolutions.json')
EXPERIMENTS = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'experiments.json')
HEALTH_MODEL = 'connection-test'  # OmniRoute's own account probes: not agent traffic
GUARD_LOG = os.path.join(HOME, '.agents', 'logs', 'coordinator-guard.jsonl')
OMNI_DB = os.path.join(HOME, '.omniroute', 'storage.sqlite')
OMNI_LOGS = os.path.join(HOME, '.omniroute', 'call_logs')
CLAUDE_PROJECTS = os.path.join(HOME, '.claude', 'projects')
PLAYBOOK_REGISTRY = os.path.join(HOME, 'Works', 'games', 'cocos-playbook', 'registry.json')
MEMORY_HOOK_LOG = os.path.join(HOME, '.orca-memory', 'pilot', 'hook-log.jsonl')
TOKEN_REPORT_CANDIDATES = [
    os.path.join(HOME, '.agents', 'tools', 'token-report', 'token_report.py'),
    os.path.join(HOME, '.agents-wt', 'coordinator-token-opt', 'tools', 'token-report', 'token_report.py'),
]
ORCA = os.environ.get('ORCA_CLI_COMMAND', 'orca')

# Pilot projects first; the rest are baseline only.
ACTIVE_DAYS = 30  # a project is tracked while one of its slices changed in this many days

# Combinable histograms (seconds) so percentiles survive daily aggregation.
BUCKETS = [0.25, 0.5, 1, 2, 4, 8, 15, 30, 60, 120, 300, 600, float('inf')]

SETTLED = ('completed', 'review_rejected', 'blocked', 'infra_blocked', 'stalled', 'superseded', 'failed')
SYSTEMS = ['orca', 'gateway', 'agent', 'engine', 'brief', 'art', 'ship', 'memory', 'other']

# --------------------------------------------------------------------------- schema

SCHEMA = """
CREATE TABLE IF NOT EXISTS llm_daily (
  day TEXT, provider TEXT, model TEXT, api_key TEXT,
  calls INTEGER, errors INTEGER, tokens_in INTEGER, tokens_out INTEGER,
  cache_read INTEGER, cache_creation INTEGER,
  dur_hist TEXT, ttft_hist TEXT, ttft_n INTEGER,
  PRIMARY KEY (day, provider, model, api_key));
CREATE TABLE IF NOT EXISTS llm_errors (
  day TEXT, provider TEXT, error TEXT, count INTEGER,
  PRIMARY KEY (day, provider, error));
CREATE TABLE IF NOT EXISTS llm_health (
  day TEXT, provider TEXT, connection TEXT, checks INTEGER, failures INTEGER, last_error TEXT,
  PRIMARY KEY (day, provider, connection));
CREATE TABLE IF NOT EXISTS llm_session_daily (
  day TEXT, session_id TEXT, provider TEXT, project TEXT,
  calls INTEGER, errors INTEGER, tokens_in INTEGER, tokens_out INTEGER, cache_read INTEGER,
  PRIMARY KEY (day, session_id, provider));
CREATE TABLE IF NOT EXISTS orca_runs (
  run_id TEXT PRIMARY KEY, project TEXT, slice TEXT, objective TEXT,
  created_at TEXT, updated_at TEXT);
CREATE TABLE IF NOT EXISTS orca_tasks (
  task_id TEXT PRIMARY KEY, run_id TEXT, project TEXT, slice TEXT, role TEXT,
  status TEXT, outcome TEXT, title TEXT, created_at TEXT, completed_at TEXT, result_subject TEXT);
CREATE TABLE IF NOT EXISTS slices (
  project TEXT, slice TEXT,
  review_rounds INTEGER, first_verdict TEXT, final_verdict TEXT, verdict_source TEXT,
  infra_blocked_reviews INTEGER, fix_rounds INTEGER, fix_rounds_source TEXT,
  fix_owners TEXT, merged INTEGER, merge_sha TEXT, merged_at TEXT,
  e2e_min INTEGER, e2e_source TEXT, budget_ratio REAL, reviewer TEXT,
  PRIMARY KEY (project, slice));
CREATE TABLE IF NOT EXISTS events (
  project TEXT, line INTEGER, slice TEXT, event TEXT, system TEXT, rule TEXT,
  fix_target TEXT, cause TEXT, ratio REAL, at TEXT,
  PRIMARY KEY (project, line));
CREATE TABLE IF NOT EXISTS learnings (
  project TEXT, line INTEGER, slice TEXT, event TEXT, kind TEXT, candidate_id TEXT,
  PRIMARY KEY (project, line));
CREATE TABLE IF NOT EXISTS gates (
  project TEXT, slice TEXT, file TEXT, gate TEXT, seq INTEGER, result TEXT,
  PRIMARY KEY (project, file, gate, seq));
CREATE TABLE IF NOT EXISTS tokens (
  project TEXT, slice TEXT, role TEXT, source TEXT, sessions INTEGER, turns INTEGER, ctx INTEGER,
  PRIMARY KEY (project, slice, role, source));
CREATE TABLE IF NOT EXISTS project_facts (
  project TEXT, key TEXT, value TEXT, PRIMARY KEY (project, key));
CREATE TABLE IF NOT EXISTS runner_slices (
  project TEXT, slice TEXT, lane TEXT, phase TEXT, selected_at TEXT, merged_at TEXT, recorded_at TEXT,
  e2e_min INTEGER, fix_rounds INTEGER, verify TEXT, worktree_kept TEXT,
  PRIMARY KEY (project, slice));
CREATE TABLE IF NOT EXISTS runner_stops (
  project TEXT, slice TEXT, seq INTEGER, reason TEXT, category TEXT,
  opened_at TEXT, closed_at TEXT, wait_min REAL, answered INTEGER, detail TEXT,
  PRIMARY KEY (project, slice, seq));
CREATE TABLE IF NOT EXISTS spawns (
  ts TEXT, project TEXT, slice TEXT, role TEXT, agent TEXT, handle TEXT,
  PRIMARY KEY (ts, handle));
CREATE TABLE IF NOT EXISTS guard (
  day TEXT, project TEXT, role TEXT, cli TEXT, mode TEXT, verdict TEXT, rule TEXT, count INTEGER,
  PRIMARY KEY (day, project, role, cli, mode, verdict, rule));
CREATE TABLE IF NOT EXISTS slice_agents (
  project TEXT, slice TEXT, role TEXT, agent TEXT, PRIMARY KEY (project, slice, role));
CREATE TABLE IF NOT EXISTS ship (
  project TEXT, at TEXT, step TEXT, ok INTEGER, exit INTEGER, sec INTEGER, sha TEXT, size_kib INTEGER, url TEXT,
  PRIMARY KEY (project, at, step));
CREATE TABLE IF NOT EXISTS infra (
  project TEXT, at TEXT, checkout TEXT, task TEXT, ms INTEGER,
  funplay_reachable INTEGER, funplay_parity INTEGER, preview_port INTEGER, orca INTEGER,
  PRIMARY KEY (project, at, checkout));
CREATE TABLE IF NOT EXISTS runs_log (at TEXT, step TEXT, ok INTEGER, note TEXT);
CREATE TABLE IF NOT EXISTS static_checks (
  project TEXT, slice TEXT, seq INTEGER, at TEXT, source TEXT, result TEXT, failed TEXT, warned TEXT,
  PRIMARY KEY (project, slice, seq));
CREATE TABLE IF NOT EXISTS flag_history (
  day TEXT, kpi TEXT, scope TEXT, status TEXT, text TEXT, PRIMARY KEY (day, kpi, scope));
"""


def connect(path: str = DB_PATH) -> sqlite3.Connection:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    con = sqlite3.connect(path)
    con.executescript(SCHEMA)
    return con


def log_step(con, step: str, ok: bool, note: str = '') -> None:
    con.execute('INSERT INTO runs_log VALUES (?,?,?,?)', (now_iso(), step, int(ok), note[:500]))
    con.commit()


def now_iso() -> str:
    return datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')


def norm_ts(ts: str | None) -> str | None:
    """Orca mixes '2026-10-02 02:09:21' and '2026-10-01T11:24:26Z'; store ISO UTC."""
    if not ts:
        return None
    ts = ts.strip().replace(' ', 'T')
    if not re.search(r'(Z|[+-]\d\d:?\d\d)$', ts):
        ts += 'Z'
    return ts


def parse_ts(ts: str) -> datetime:
    return datetime.fromisoformat(ts.replace('Z', '+00:00'))

# --------------------------------------------------------------------------- histograms


def hist_add(h: list[int], seconds: float | None) -> None:
    if seconds is None:
        return
    h[bisect.bisect_left(BUCKETS, seconds)] += 1


def hist_merge(a: list[int], b: list[int]) -> list[int]:
    return [x + y for x, y in zip(a, b)]


def hist_pct(h: list[int], q: float) -> float | None:
    """Upper bound of the bucket holding quantile q (nearest rank)."""
    n = sum(h)
    if not n:
        return None
    rank, seen = max(1, round(q * n + 0.4999)), 0
    for i, c in enumerate(h):
        seen += c
        if seen >= rank:
            return BUCKETS[i]
    return BUCKETS[-1]

# --------------------------------------------------------------------------- project mapping


def active_projects(root: str = GAMES_ROOT, days: int = ACTIVE_DAYS, now: float | None = None) -> list[str]:
    """Projects the per-slice KPIs cover: every cc-* / cc4-* checkout with a slice task dir
    (.cursor/evidence/tasks/T-S*) that changed in the last `days` days — a new project joins with
    its first slice, an idle one drops out. Newest mtime of the task dir and the files two levels in."""
    cutoff = (now if now is not None else datetime.now().timestamp()) - days * 86400
    out = []
    for name in sorted(os.listdir(root)) if os.path.isdir(root) else []:
        if not name.startswith(('cc-', 'cc4-')):
            continue
        newest = 0.0
        for d in glob.glob(os.path.join(root, name, '.cursor', 'evidence', 'tasks', 'T-S*')):
            for f in [d, *glob.glob(os.path.join(d, '*')), *glob.glob(os.path.join(d, '*', '*'))]:
                try:
                    newest = max(newest, os.path.getmtime(f))
                except OSError:
                    pass
        if newest >= cutoff:
            out.append(name)
    return out


def known_projects() -> list[str]:
    names = set()
    if os.path.isdir(GAMES_ROOT):
        names.update(n for n in os.listdir(GAMES_ROOT) if n.startswith(('cc-', 'cc4-')))
    return sorted(names, key=len, reverse=True)


def project_of_path(path: str | None, projects: list[str]) -> str | None:
    """Main checkout or Orca worktree path -> project slug. Renamed or archived projects still
    count under their own slug, so `projects` is not a filter here."""
    if not path:
        return None
    for root in (GAMES_ROOT, WORKSPACES_ROOT):
        if path.startswith(root + os.sep):
            return path[len(root) + 1:].split(os.sep)[0] or None
    return None


def project_of_claude_dir(dirname: str, projects: list[str]) -> str | None:
    """~/.claude/projects/<cwd with / and . as ->; worktrees sit under orca-workspaces-<project>-."""
    for marker in ('-CocosCreator-', '-orca-workspaces-'):
        if marker in dirname:
            rest = dirname.split(marker, 1)[1]
            for p in projects:  # longest first
                if rest == p or rest.startswith(p + '-'):
                    return p
    return None


SLICE_RE = re.compile(r'\b(?:T-)?([Ss]\d{1,3}[a-z]?)(?=\b|[-_])')


def slice_of(text: str | None) -> str | None:
    m = SLICE_RE.search(text or '')
    return m.group(1).upper() if m else None

# --------------------------------------------------------------------------- gateway (OmniRoute)

USER_ID_RE = re.compile(rb'"user_id"\s*:\s*"((?:[^"\\]|\\.)*)"')


def session_from_body(raw: bytes) -> str | None:
    """Claude Code puts {"session_id": ...} as a JSON string in requestBody.metadata.user_id."""
    m = USER_ID_RE.search(raw)
    if not m:
        return None
    try:
        inner = json.loads(b'"' + m.group(1) + b'"')
        sid = json.loads(inner).get('session_id')
    except (ValueError, AttributeError):
        return None
    return sid if isinstance(sid, str) and re.fullmatch(r'[0-9a-f-]{36}', sid) else None


def claude_session_index(projects: list[str]) -> dict[str, str | None]:
    idx: dict[str, str | None] = {}
    for f in glob.glob(os.path.join(CLAUDE_PROJECTS, '*', '*.jsonl')):
        idx[os.path.basename(f)[:-6]] = project_of_claude_dir(os.path.basename(os.path.dirname(f)), projects)
    return idx


def snapshot_gateway(con, omni_db: str = OMNI_DB, logs_dir: str = OMNI_LOGS, projects: list[str] | None = None) -> str:
    if not os.path.exists(omni_db):
        return 'omniroute db missing'
    projects = projects or known_projects()
    src = sqlite3.connect(f'file:{omni_db}?mode=ro', uri=True)
    cols = {r[1] for r in src.execute('PRAGMA table_info(call_logs)')}
    want = ['timestamp', 'status', 'provider', 'model', 'api_key_name', 'duration', 'ttft_ms',
            'tokens_in', 'tokens_out', 'tokens_cache_read', 'tokens_cache_creation', 'error_type',
            'error_summary', 'artifact_relpath', 'has_request_body', 'connection_id']
    sel = ', '.join(c if c in cols else f'NULL AS {c}' for c in want)
    rows = src.execute(f'SELECT {sel} FROM call_logs').fetchall()
    src.close()

    groups: dict[tuple, dict] = {}
    errors: collections.Counter = collections.Counter()
    sessions: dict[tuple, list[int]] = {}
    sess_idx = claude_session_index(projects)
    days = set()
    health: dict[tuple, list] = {}
    for (ts, status, provider, model, key, dur, ttft, tin, tout, cr, cc, etype, esum, rel, has_body, conn) in rows:
        day = (ts or '')[:10]
        if not day:
            continue
        provider, model, key = provider or '?', model or '?', key or ''
        if model == HEALTH_MODEL:
            # account probes: their failures say an account is dead, not that agents hit errors
            h = health.setdefault((day, provider, (conn or '?')[:8]), [0, 0, None])
            h[0] += 1
            if status and status >= 400:
                h[1] += 1
                h[2] = (esum or etype or f'HTTP {status}')[:120]
            continue
        days.add(day)
        g = groups.setdefault((day, provider, model, key), {
            'calls': 0, 'errors': 0, 'in': 0, 'out': 0, 'cr': 0, 'cc': 0,
            'dur': [0] * len(BUCKETS), 'ttft': [0] * len(BUCKETS), 'ttft_n': 0})
        err = bool(status and status >= 400)
        g['calls'] += 1
        g['errors'] += err
        g['in'] += tin or 0
        g['out'] += tout or 0
        g['cr'] += cr or 0
        g['cc'] += cc or 0
        hist_add(g['dur'], dur / 1000 if dur else None)
        if ttft:
            hist_add(g['ttft'], ttft / 1000)
            g['ttft_n'] += 1
        if err:
            label = etype or (f'HTTP {status}')
            errors[(day, provider, label)] += 1
        if provider == 'claude' and has_body and rel:
            path = os.path.join(logs_dir, rel)
            try:
                with open(path, 'rb') as fh:
                    sid = session_from_body(fh.read())
            except OSError:
                sid = None
            if sid:
                s = sessions.setdefault((day, sid, provider), [0, 0, 0, 0, 0])
                s[0] += 1
                s[1] += err
                s[2] += tin or 0
                s[3] += tout or 0
                s[4] += cr or 0

    # Replace a day only when we now see at least as many calls: the oldest day OmniRoute still
    # holds is cut by retention, and must not overwrite an earlier, complete snapshot.
    new_calls = collections.Counter()
    for (day, *_), g in groups.items():
        new_calls[day] += g['calls']
    stored = dict(con.execute('SELECT day, SUM(calls) FROM llm_daily GROUP BY day'))
    keep = {d for d in days if stored.get(d, 0) > new_calls[d]}
    for day in days - keep:
        con.execute('DELETE FROM llm_daily WHERE day=?', (day,))
        con.execute('DELETE FROM llm_errors WHERE day=?', (day,))
    groups = {k: g for k, g in groups.items() if k[0] not in keep}
    errors = collections.Counter({k: n for k, n in errors.items() if k[0] not in keep})
    for (day, provider, model, key), g in groups.items():
        con.execute('INSERT INTO llm_daily VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)', (
            day, provider, model, key, g['calls'], g['errors'], g['in'], g['out'], g['cr'], g['cc'],
            json.dumps(g['dur']), json.dumps(g['ttft']), g['ttft_n']))
    for (day, provider, label), n in errors.items():
        con.execute('INSERT INTO llm_errors VALUES (?,?,?,?)', (day, provider, label[:120], n))
    for day in {k[0] for k in health}:
        con.execute('DELETE FROM llm_health WHERE day=?', (day,))
    for (day, provider, conn), (checks, fails, last) in health.items():
        con.execute('INSERT INTO llm_health VALUES (?,?,?,?,?,?)', (day, provider, conn, checks, fails, last))
    # rows snapshotted before health checks were split out
    con.execute('DELETE FROM llm_daily WHERE model=?', (HEALTH_MODEL,))
    # Bodies live ~3 days; only overwrite session rows for days that still have them.
    sess_calls = collections.Counter()
    for (day, *_), v in sessions.items():
        sess_calls[day] += v[0]
    stored = dict(con.execute('SELECT day, SUM(calls) FROM llm_session_daily GROUP BY day'))
    body_days = {d for d in sess_calls if stored.get(d, 0) <= sess_calls[d]}
    sessions = {k: v for k, v in sessions.items() if k[0] in body_days}
    for day in body_days:
        con.execute('DELETE FROM llm_session_daily WHERE day=?', (day,))
    for (day, sid, provider), s in sessions.items():
        con.execute('INSERT INTO llm_session_daily VALUES (?,?,?,?,?,?,?,?,?)',
                    (day, sid, provider, sess_idx.get(sid), *s))
    con.commit()
    return f'{len(rows)} calls, {len(days)} days ({len(keep)} kept from earlier snapshot), {len(sessions)} session-days'

# --------------------------------------------------------------------------- orchestration (Orca)

ROLE_WORDS = ['review', 'fix', 'scan', 'implement', 'integrate', 'concept', 'mesh', 'anim', 'art',
              'plan', 'gate', 'smoke']


def task_role(title: str) -> str:
    m = re.search(r'TASK ROLE:\s*([\w-]+)', title or '')
    if m:
        return m.group(1).lower()
    low = (title or '').lower()
    for w in ROLE_WORDS:
        if re.search(rf'\b{w}', low):
            return w
    return 'other'


def task_outcome(status: str, result) -> tuple[str, str]:
    """Orca marks a CHANGES_REQUESTED review, a stalled dispatch and a task superseded by its
    retry all as `failed`; split them so only stalls and real failures count against Orca."""
    subject = ''
    if isinstance(result, str):
        try:
            result = json.loads(result)
        except ValueError:
            subject = result
    if isinstance(result, dict):
        subject = str(result.get('subject') or result.get('summary') or result.get('reason') or '')
    if status not in ('failed', 'blocked'):
        return status, subject
    up = subject.upper()
    for needle, outcome in (('CHANGES_REQUESTED', 'review_rejected'), ('INFRA_BLOCKED', 'infra_blocked'),
                            ('STALL', 'stalled'), ('SUPERSEDED', 'superseded'), ('BLOCKED', 'blocked')):
        if needle in up:
            return outcome, subject
    return status, subject


def orca_json(args: list[str]):
    out = subprocess.run([ORCA, 'orchestration', *args, '--json'], capture_output=True, text=True, timeout=60)
    d = json.loads(out.stdout or '{}')
    if not d.get('ok', True):
        raise RuntimeError((d.get('error') or {}).get('message', 'orca error'))
    return d.get('result', d)


def snapshot_orca(con, projects: list[str] | None = None) -> str:
    projects = projects or known_projects()
    runs, cursor = [], None
    for _ in range(50):
        r = orca_json(['run-list', '--limit', '100'] + (['--cursor', cursor] if cursor else []))
        runs += r.get('runs', [])
        cursor = r.get('nextCursor')
        if not cursor:
            break
    seen = {row[0]: row[1] for row in con.execute('SELECT run_id, updated_at FROM orca_runs')}
    ntasks = 0
    for run in runs:
        rid, upd = run['id'], norm_ts(run.get('updated_at'))
        if seen.get(rid) == upd and con.execute('SELECT 1 FROM orca_tasks WHERE run_id=? LIMIT 1', (rid,)).fetchone():
            continue
        tasks = orca_json(['task-list', '--run', rid, '--brief']).get('tasks', [])
        project = None
        for t in tasks:
            inc = t.get('created_by_process_incarnation') or ''
            project = project or project_of_path(inc.split('::')[-1].split('@@')[0], projects)
        run_slice = slice_of(run.get('objective'))
        con.execute('INSERT OR REPLACE INTO orca_runs VALUES (?,?,?,?,?,?)', (
            rid, project, run_slice, (run.get('objective') or '')[:300], norm_ts(run.get('created_at')), upd))
        for t in tasks:
            title = t.get('task_title') or t.get('display_name') or ''
            outcome, subject = task_outcome(t.get('status'), t.get('result'))
            con.execute('INSERT OR REPLACE INTO orca_tasks VALUES (?,?,?,?,?,?,?,?,?,?,?)', (
                t['id'], rid, project, slice_of(title) or run_slice, task_role(title), t.get('status'),
                outcome, title[:200], norm_ts(t.get('created_at')), norm_ts(t.get('completed_at')), subject[:200]))
            ntasks += 1
    con.commit()
    return f'{len(runs)} runs, {ntasks} tasks refreshed'

# --------------------------------------------------------------------------- project evidence

VERDICT_RE = re.compile(r'\b(APPROVED|CHANGES_REQUESTED|INFRA_BLOCKED)\b')
REVIEW_SKIP_RE = re.compile(r'spec|prompt|term|request', re.I)
ROUND_RE = re.compile(r'(?:round-?|-r|fix)(\d+)', re.I)


def parse_verdict(text: str) -> str | None:
    lines = text.splitlines()
    tagged = [l for l in lines if re.search(r'verdict', l, re.I) and VERDICT_RE.search(l)]
    if tagged:
        overall = [l for l in tagged if re.search(r'overall', l, re.I)]
        return VERDICT_RE.search((overall or tagged)[-1 if not overall else 0]).group(1)
    alone = [l for l in lines if VERDICT_RE.fullmatch(l.strip(' *#`>-_.'))]
    if alone:
        return VERDICT_RE.search(alone[-1]).group(1)
    hits = VERDICT_RE.findall(text)
    return hits[-1] if hits else None


def order_reviews(names: list[str]) -> list[str]:
    """Unnumbered review.md is round 1 when numbering starts at 2, else it is the final review."""
    numbered = sorted((int(m.group(1)), n) for n in names if (m := ROUND_RE.search(n)))
    plain = sorted(n for n in names if not ROUND_RE.search(n))
    if numbered and numbered[0][0] == 1:
        return [n for _, n in numbered] + plain
    return plain + [n for _, n in numbered]




def fix_owners(text: str) -> collections.Counter:
    """Owner column of the review's fix_routing table, found by its header (some tables put a
    severity column before it); the second column when there is no `owner` header."""
    m = re.search(r'^## fix_routing\s*$(.*?)(?=^## |\Z)', text, re.M | re.S)
    if not m:
        return collections.Counter()
    rows = [[c.strip() for c in l.strip().strip('|').split('|')] for l in m.group(1).splitlines() if l.strip().startswith('|')]
    if not rows:
        return collections.Counter()
    head = [c.lower() for c in rows[0]]
    col = head.index('owner') if 'owner' in head else None
    out = collections.Counter()
    for r in rows[1:]:
        if re.fullmatch(r'[\s:|-]*', '|'.join(r)) or not re.match(r'(F|R\d+-)[\w.,\s-]*$', r[0]):
            continue
        if col is not None:
            owner = re.match(r'[a-z][\w-]*', r[col].lower()) if len(r) > col else None
            if owner:
                out[owner.group(0)] += 1
        else:
            # no owner column (only paths): the paths say whose work it is
            out[owner_from_paths(' '.join(r[1:]))] += 1
    return out


def owner_from_paths(text: str) -> str:
    t = text.lower()
    for owner, rx in (('scene', r'\.scene|\.prefab'), ('code', r'\.(ts|mjs|js)\b|assets/scripts'),
                      ('art', r'concept|pixel/|voxel/|\.(png|webp|glb|svg)\b|/art'), ('docs', r'docs/|\.md\b')):
        if re.search(rx, t):
            return f'{owner} (theo path)'
    return 'khác (theo path)'


GATE_RE = re.compile(r'\b(ART2D|CONCEPT|VERDICT|ANIM)\b\W{0,6}:?\W{0,6}\b(PASS|FAIL)\b')


def parse_gates(text: str) -> list[tuple[str, str]]:
    return GATE_RE.findall(text)


NOTES_RE = re.compile(r'^- .*?\b(S\d+[a-z]?)\b.*?fix_rounds=(\d+)', re.M)


def notes_fix_rounds(text: str) -> dict[str, int]:
    out = {}
    for s, n in NOTES_RE.findall(text):
        out[s] = int(n)  # later lines win
    return out


MERGE_RE = re.compile(r"^(?:Merge (?:branch ')?(?:[\w.-]+/)?|merge: )([Ss]\d+[a-z]?)\b")


def git_log(root: str) -> list[tuple[str, str, str]]:
    try:
        out = subprocess.run(['git', '-C', root, 'log', '--format=%H%x09%cI%x09%s', 'HEAD'],
                             capture_output=True, text=True, timeout=60).stdout
    except (OSError, subprocess.TimeoutExpired):
        return []
    return [tuple(l.split('\t', 2)) for l in out.splitlines() if l.count('\t') >= 2]


def merges_and_e2e(log: list[tuple[str, str, str]]) -> dict[str, dict]:
    """First merge per slice; e2e = oldest producer PLAN commit for that slice -> that merge."""
    oldest_first = list(reversed(log))
    out: dict[str, dict] = {}
    for sha, at, subj in oldest_first:
        m = MERGE_RE.match(subj)
        if not m:
            continue
        s = m.group(1).upper()
        d = out.setdefault(s, {'merges': 0, 'sha': sha[:10], 'at': at, 'e2e': None, 'src': None})
        d['merges'] += 1
    for s, d in out.items():
        plan = next((at for _, at, subj in oldest_first
                     if subj.startswith('chore(producer)') and re.search(rf'\b{s}\b', subj)
                     and 'PLAN' in subj and at <= d['at']), None)
        if plan:
            d['e2e'] = round((parse_ts(d['at']) - parse_ts(plan)).total_seconds() / 60)
            d['src'] = 'git: producer PLAN commit -> first merge'
    return out

# --------------------------------------------------------------------------- producer runner

STOP_CATEGORY = {
    'fleet_gate': 'director', 'director_gate': 'director',
    'approval_evidence': 'review', 'verdict_override': 'review', 'verdict_mismatch': 'review',
    'lane_blocked': 'lane', 'commit_stalled': 'lane', 'gate_unresolved': 'lane',
    'unknown_status': 'runner', 'coordinator_missing': 'runner', 'bad_handoff': 'runner', 'orca_error': 'runner',
    'policy_conflict': 'config', 'agent_conflict': 'config', 'cursor_off': 'config',
    'verify_manual': 'review',  # main verified, but a check needs a human: an automation gap
}
# A director stop is a real decision: its wait is the director's time, not a defect. Every other
# stop is one the workflow could have avoided.
DECISION_CATEGORIES = {'director'}
LOG_RE = re.compile(r'^(\S+Z) runner: (.*)$')
SPAWN_RE = re.compile(r'^spawned (\w+) \S+ \(([^,)]+)')
SPAWN_ROLE = {'writer': 'implement', 'reviewer': 'review', 'coordinator': 'coordinator', 'verifier': 'verifier'}
STATS_ROLE = {'writer': 'implement', 'integrator': 'integrate', 'reviewer': 'review'}


def runner_spawns(log_text: str) -> dict[str, str]:
    """producer-log.md `spawned <role> term_… (<launch spec>, --role …)` → role → the spec that
    first ran it in this slice. The slice's own record, so a later AGENT_NOTES change does not
    relabel it (S3 arms)."""
    out: dict[str, str] = {}
    for line in log_text.splitlines():
        m = LOG_RE.match(line.strip())
        sp = SPAWN_RE.match(m.group(2)) if m else None
        if sp:
            out.setdefault(SPAWN_ROLE.get(sp.group(1), sp.group(1)), sp.group(2).strip())
    return out


def runner_stops(log_text: str) -> list[dict]:
    """producer-log.md: `blocked <reason>: …` opens a stop; the next `answer`, `blocked` or
    `phase` line closes it. wait_min is how long the slice waited on a human or a fix."""
    stops, cur = [], None

    def close(at, answered):
        nonlocal cur
        if cur:
            cur.update(closed_at=at, answered=answered,
                       wait_min=round((parse_ts(at) - parse_ts(cur['opened_at'])).total_seconds() / 60, 1))
            stops.append(cur)
            cur = None
    for line in log_text.splitlines():
        m = LOG_RE.match(line.strip())
        if not m:
            continue
        at, msg = m.groups()
        if msg.startswith('blocked '):
            close(at, False)
            reason = msg[8:].split(':', 1)[0].strip()
            cur = {'reason': reason, 'category': STOP_CATEGORY.get(reason, 'other'), 'opened_at': at,
                   'detail': msg[8 + len(reason) + 1:].strip()[:200]}
        elif msg.startswith('answer '):
            close(at, True)
        elif msg.startswith('phase ') and cur:
            close(at, False)
    if cur:
        stops.append({**cur, 'closed_at': None, 'answered': False, 'wait_min': None})
    return stops


STATIC_LOG_RE = re.compile(r'^static check (PASS|WARN|FAIL|ERROR)(?: \(([^)]*)\))?')
STATIC_LINE_RE = re.compile(r'^(PASS|WARN|FAIL|SKIP) ([\w-]+)')


def runner_static(log_text: str) -> list[dict]:
    """producer-log.md `static check FAIL (specs, smoke-lint)`: one row per check-slice run the
    runner made before a review round (single lane). The parenthesis lists FAIL checks, then WARN."""
    out = []
    for line in log_text.splitlines():
        m = LOG_RE.match(line.strip())
        st = STATIC_LOG_RE.match(m.group(2)) if m else None
        if st:
            out.append({'at': m.group(1), 'result': st.group(1), 'names': [x.strip() for x in (st.group(2) or '').split(',') if x.strip()]})
    return out


def static_file(text: str) -> dict | None:
    """evidence/static-check.txt: the last check-slice run of a slice (any lane), per-check status."""
    m = re.search(r'^check-slice \S+ .* at (\S+)$', text, re.M)
    res = re.search(r'^RESULT (\w+)', text, re.M)
    if not (m and res):
        return None
    checks = [STATIC_LINE_RE.match(l).groups() for l in text.splitlines() if STATIC_LINE_RE.match(l)]
    return {'at': m.group(1), 'result': res.group(1), 'failed': [n for st, n in checks if st == 'FAIL'],
            'warned': [n for st, n in checks if st == 'WARN']}


def read_json(path: str, default=None):
    try:
        with open(path) as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return default


def runner_slice(task_dir: str) -> dict | None:
    state = read_json(os.path.join(task_dir, 'producer-state.json'))
    if not isinstance(state, dict):
        return None
    j = read_json(os.path.join(task_dir, 'merge-journal.json'), {}) or {}
    steps = j.get('steps') or {}
    rec = (steps.get('record') or {}).get('done_at')
    sel = state.get('selected_at')
    return {
        'lane': state.get('lane') or j.get('lane'), 'phase': state.get('phase'), 'selected_at': sel,
        'merged_at': (steps.get('merge') or {}).get('done_at'), 'recorded_at': rec,
        'e2e_min': round((parse_ts(rec) - parse_ts(sel)).total_seconds() / 60) if rec and sel else None,
        'fix_rounds': j.get('fix_rounds') if isinstance(j.get('fix_rounds'), int) else None,
        'verify': (steps.get('verify') or {}).get('status'),
        'worktree_kept': (steps.get('worktree_rm') or {}).get('kept'),
    }


def collect_logs(con, projects: list[str] | None = None) -> str:
    """Spawn registry (M1) and coordinator guard log (M2), both in ~/.agents/logs."""
    projects = projects or known_projects()
    n = 0
    for _, d in read_jsonl(SPAWN_REGISTRY):
        con.execute('INSERT OR REPLACE INTO spawns VALUES (?,?,?,?,?,?)', (
            d.get('ts'), project_of_path(d.get('project') or d.get('cwd'), projects), d.get('slice'),
            d.get('role'), d.get('agentSpec'), d.get('handle')))
        n += 1
    con.execute('DELETE FROM guard')
    agg = collections.Counter()
    for _, d in read_jsonl(GUARD_LOG):
        agg[((d.get('ts') or '')[:10], project_of_path(d.get('project') or d.get('cwd'), projects), d.get('role'),
             d.get('cli'), d.get('mode'), d.get('verdict'), d.get('rule') or '')] += 1
    for k, c in agg.items():
        con.execute('INSERT INTO guard VALUES (?,?,?,?,?,?,?,?)', (*k, c))
    con.commit()
    return f'{n} spawns, {sum(agg.values())} guard rows'

# --------------------------------------------------------------------------- attribution

# First match wins; cause is tried before cost, then fix_target. Heuristic for backfill only:
# S1 adds an explicit `system` field to lessons.jsonl.
SYSTEM_RULES = [
    ('gateway', r'provider|bad request|rate.?limit|\b5\d\d\b|quota|omniroute|capacity|overloaded|\{model:'),
    ('agent', r'loop(ed)? on|malformed tool|hallucinat|ignored the|misread|wrong terminal|misattribut'),
    ('art', r'\bart\b|sprite|\.png|texture|mesh|concept|\.glb|atlas|antigravity|\bagy\b|tripo|blender|animation'),
    ('ship', r'built game|release build|\bdeploy|vercel|build-only|only in the build'),
    ('engine', r'editor|creator|funplay|\bmcp\b|preview|scene|prefab|import|\.meta\b|cocos'),
    ('agent', r'review|sandbox'),
    ('brief', r'contract|brief|expect|scope\.md|how_to|slice file|change_budget|estimate'),
    ('orca', r'terminal|dispatch|worker|coordinator|\brun\b|orca|stall|respawn|nudge|worktree|merge|handoff|lock'),
    ('memory', r'recipe|playbook|lesson|memory'),
]
EVENT_DEFAULTS = {'budget_bump': 'brief', 'director_gate': 'brief', 'respawn': 'orca',
                  'merge_conflict': 'orca', 'infra_blocked': 'engine'}


def classify_event(row: dict) -> tuple[str, str]:
    written = str(row.get('system') or '')
    if written.split(':')[0] in SYSTEMS:
        return written.split(':')[0], f'written {written}'
    ft = str(row.get('fix_target') or '')
    if ft.startswith('contract:'):
        return 'brief', 'fix_target contract:'
    for field in ('cause', 'cost', 'fix_target'):
        text = str(row.get(field) or '').lower()
        for system, rx in SYSTEM_RULES:
            if re.search(rx, text):
                return system, f'{field}~{system}'
    ev = row.get('event')
    if ev in EVENT_DEFAULTS:
        return EVENT_DEFAULTS[ev], f'event {ev}'
    return 'other', 'no rule'


def read_jsonl(path: str) -> list[tuple[int, dict]]:
    out = []
    if not os.path.exists(path):
        return out
    with open(path, encoding='utf-8', errors='replace') as fh:
        for i, line in enumerate(fh, 1):
            line = line.strip()
            if not line:
                continue
            try:
                d = json.loads(line)
            except ValueError:
                continue
            if isinstance(d, dict):
                out.append((i, d))
    return out


def is_learning(row: dict) -> bool:
    return row.get('event') in ('recipe_candidate', 'recipe_reuse') or ('kind' in row and 'event' not in row)


def collect_project(con, project: str, root: str | None = None) -> str:
    root = root or os.path.join(GAMES_ROOT, project)
    if not os.path.isdir(root):
        return f'{project}: missing'
    ev_dir = os.path.join(root, '.cursor', 'evidence')
    for table in ('slices', 'events', 'learnings', 'gates', 'project_facts', 'runner_slices', 'runner_stops',
                  'slice_agents', 'ship', 'infra', 'static_checks'):
        con.execute(f'DELETE FROM {table} WHERE project=?', (project,))

    lessons = read_jsonl(os.path.join(ev_dir, 'lessons.jsonl'))
    budget: dict[str, float] = {}
    lesson_fix: collections.Counter = collections.Counter()
    for line, row in lessons:
        s = str(row.get('slice') or '').upper() or None
        if is_learning(row):
            con.execute('INSERT INTO learnings VALUES (?,?,?,?,?,?)', (
                project, line, s, row.get('event'), row.get('kind'), row.get('candidate_id')))
            continue
        system, rule = classify_event(row)
        ratio = row.get('ratio') if isinstance(row.get('ratio'), (int, float)) else None
        con.execute('INSERT INTO events VALUES (?,?,?,?,?,?,?,?,?,?)', (
            project, line, s, row.get('event'), system, rule, str(row.get('fix_target') or '')[:200],
            str(row.get('cause') or row.get('cost') or '')[:300], ratio, row.get('at')))
        if row.get('event') == 'budget_bump' and ratio and s:
            budget[s] = max(budget.get(s, 0), ratio)
        if row.get('event') == 'fix_round' and s:
            lesson_fix[s] += int(row.get('count') or 1)

    notes = {}
    if os.path.exists(os.path.join(root, 'AGENT_NOTES.md')):
        with open(os.path.join(root, 'AGENT_NOTES.md'), encoding='utf-8', errors='replace') as fh:
            notes = notes_fix_rounds(fh.read())
    merges = merges_and_e2e(git_log(root))

    task_dirs = glob.glob(os.path.join(ev_dir, 'tasks', 'T-S*'))
    slices = {slice_of(os.path.basename(d)) for d in task_dirs} | set(merges) | set(notes) | set(budget)
    slices.discard(None)
    by_slice_dirs = collections.defaultdict(list)
    for d in task_dirs:
        by_slice_dirs[slice_of(os.path.basename(d))].append(d)

    for s in sorted(slices, key=lambda x: (int(re.sub(r'\D', '', x) or 0), x)):
        verdicts, owners, infra, stats = [], collections.Counter(), 0, {}
        # check-slice: the runner's runs before each review round (log), else the slice's last run (file)
        runs = []
        for d in by_slice_dirs.get(s, []):
            log = os.path.join(d, 'producer-log.md')
            if os.path.exists(log):
                with open(log, encoding='utf-8', errors='replace') as fh:
                    runs += [{'at': r['at'], 'source': 'runner', 'result': r['result'], 'failed': r['names'] if r['result'] == 'FAIL' else [],
                              'warned': r['names'] if r['result'] == 'WARN' else []} for r in runner_static(fh.read())]
        if not runs:
            for d in by_slice_dirs.get(s, []):
                f = os.path.join(d, 'evidence', 'static-check.txt')
                if os.path.exists(f):
                    with open(f, encoding='utf-8', errors='replace') as fh:
                        sf = static_file(fh.read())
                    if sf:
                        runs.append({**sf, 'source': 'file'})
        for i, r in enumerate(sorted(runs, key=lambda r: r['at']), 1):
            con.execute('INSERT OR REPLACE INTO static_checks VALUES (?,?,?,?,?,?,?,?)', (
                project, s, i, r['at'], r['source'], r['result'], ','.join(r['failed']), ','.join(r['warned'])))
        for d in by_slice_dirs.get(s, []):
            evd = os.path.join(d, 'evidence')
            names = [os.path.basename(f) for f in glob.glob(os.path.join(evd, 'review*.md'))
                     if not REVIEW_SKIP_RE.search(os.path.basename(f)[6:])]
            for n in order_reviews(names):
                with open(os.path.join(evd, n), encoding='utf-8', errors='replace') as fh:
                    text = fh.read()
                v = parse_verdict(text)
                if v:
                    verdicts.append(v)
                    infra += v == 'INFRA_BLOCKED'
                owners += fix_owners(text)
            sp = os.path.join(evd, 'stats.json')
            if os.path.exists(sp):
                try:
                    with open(sp) as fh:
                        stats = json.load(fh)
                except ValueError:
                    pass
            for f in glob.glob(os.path.join(d, '**', '*check*.md'), recursive=True):
                with open(f, encoding='utf-8', errors='replace') as fh:
                    seq = collections.Counter()
                    for gate, result in parse_gates(fh.read()):
                        seq[gate] += 1
                        con.execute('INSERT OR REPLACE INTO gates VALUES (?,?,?,?,?,?)', (
                            project, s, os.path.relpath(f, root), gate, seq[gate], result))
        final = verdicts[-1] if verdicts else None
        vsrc = 'review*.md' if verdicts else None
        sv = str(stats.get('verdict') or '').upper()
        if VERDICT_RE.search(sv):
            final, vsrc = VERDICT_RE.search(sv).group(1), 'stats.json'
        sfr = next((stats[k] for k in ('fix_rounds', 'fixRounds') if isinstance(stats.get(k), int)), None)
        if sfr is not None:
            fr, frs = sfr, 'stats.json'
        elif s in notes:
            fr, frs = notes[s], 'AGENT_NOTES'
        elif s in lesson_fix:
            fr, frs = lesson_fix[s], 'lessons fix_round'
        else:
            fr, frs = None, None
        mg = merges.get(s, {})
        e2e, e2e_src = mg.get('e2e'), mg.get('src')
        for d in by_slice_dirs.get(s, []):
            rs = runner_slice(d)
            if not rs:
                continue
            con.execute('INSERT OR REPLACE INTO runner_slices VALUES (?,?,?,?,?,?,?,?,?,?,?)', (
                project, s, rs['lane'], rs['phase'], rs['selected_at'], rs['merged_at'], rs['recorded_at'],
                rs['e2e_min'], rs['fix_rounds'], rs['verify'], rs['worktree_kept']))
            # the runner makes no producer PLAN commit, so its own timestamps time the slice
            if rs['e2e_min'] is not None:
                e2e, e2e_src = rs['e2e_min'], 'runner: selected_at -> record'
            if rs['fix_rounds'] is not None:
                fr, frs = rs['fix_rounds'], 'merge-journal.json'
            log = os.path.join(d, 'producer-log.md')
            if os.path.exists(log):
                with open(log, encoding='utf-8', errors='replace') as fh:
                    log_text = fh.read()
                for role, spec in runner_spawns(log_text).items():
                    con.execute('INSERT OR IGNORE INTO slice_agents VALUES (?,?,?,?)', (project, s, role, spec))
                for i, st in enumerate(runner_stops(log_text), 1):
                    con.execute('INSERT OR REPLACE INTO runner_stops VALUES (?,?,?,?,?,?,?,?,?,?)', (
                        project, s, i, st['reason'], st['category'], st['opened_at'], st['closed_at'],
                        st['wait_min'], int(st['answered']), st['detail']))
        reviewer = stats.get('reviewer') if isinstance(stats.get('reviewer'), str) else None
        agents = stats.get('agents') if isinstance(stats.get('agents'), dict) else {}
        for role, spec in agents.items():
            # fleets name roles their own way ("writer", "integrator", "reviewer"); one name per role here
            role = STATS_ROLE.get(role, role)
            if isinstance(spec, str) and not spec.startswith('skipped'):
                con.execute('INSERT OR REPLACE INTO slice_agents VALUES (?,?,?,?)', (project, s, role, spec))
        reviewer = next((agents[k] for k in ('review', 'reviewer') if isinstance(agents.get(k), str)), reviewer)
        n_reviews = stats['review_rounds'] if isinstance(stats.get('review_rounds'), int) else len(verdicts)
        con.execute('INSERT INTO slices VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', (
            project, s, n_reviews, verdicts[0] if verdicts else None, final, vsrc, infra, fr, frs,
            json.dumps(dict(owners)) if owners else None, int(bool(mg)), mg.get('sha'), mg.get('at'),
            e2e, e2e_src, budget.get(s), reviewer))

    for _, d in read_jsonl(os.path.join(ev_dir, 'ship-log.jsonl')):
        con.execute('INSERT OR REPLACE INTO ship VALUES (?,?,?,?,?,?,?,?,?)', (
            project, d.get('at'), d.get('step'), int(bool(d.get('ok'))), d.get('exit'), d.get('sec'),
            d.get('sha'), d.get('size_kib'), d.get('url')))
    for _, d in read_jsonl(os.path.join(ev_dir, 'infra-log.jsonl')):
        fp, pv, oc = d.get('funplay') or {}, d.get('preview') or {}, d.get('orca') or {}
        con.execute('INSERT OR REPLACE INTO infra VALUES (?,?,?,?,?,?,?,?,?)', (
            project, d.get('at'), d.get('checkout'), d.get('task'), d.get('ms'),
            None if 'reachable' not in fp else int(bool(fp['reachable'])),
            None if fp.get('parity') is None else int(bool(fp['parity'])),
            pv.get('port'), None if 'available' not in oc else int(bool(oc['available']))))

    facts = {}
    ex = os.path.join(root, 'EXPECT_GAMEPLAY_VISUAL.md')
    if os.path.exists(ex):
        with open(ex, encoding='utf-8', errors='replace') as fh:
            t = fh.read()
        facts.update({
            'expect_rows': sum(1 for l in t.splitlines() if l.startswith('|') and not re.match(r'^\|[\s:|-]+\|$', l)),
            'expect_given': len(re.findall(r'\bGIVEN\b', t)),
            'expect_assumption': len(re.findall(r'\bASSUMPTION\b', t)),
            'expect_probe_refs': len(re.findall(r'video-probe|probe/|measured', t, re.I)),
        })
    an = os.path.join(root, 'AGENT_NOTES.md')
    if os.path.exists(an):
        with open(an, encoding='utf-8', errors='replace') as fh:
            t = fh.read()
        ts = re.search(r'^typesafe:\s*$(.*?)(?=^\S)', t, re.M | re.S)
        facts['typesafe_enabled'] = bool(ts and re.search(r'enabled:\s*true', ts.group(1)))
        for key in ('reviewer_agent', 'writer_agent', 'orchestrator_agent', 'art_backend'):
            m = re.search(rf'^\s*{key}:\s*([^#\n]+)', t, re.M)
            if m:
                facts[key] = m.group(1).strip()
    for k, v in facts.items():
        con.execute('INSERT INTO project_facts VALUES (?,?,?)', (project, k, json.dumps(v)))
    con.commit()
    return f'{project}: {len(slices)} slices, {len(lessons)} lessons rows'


def find_token_report() -> str | None:
    return next((p for p in TOKEN_REPORT_CANDIDATES if os.path.exists(p)), None)


def collect_tokens(con, project: str, since: str = '2026-09-01') -> str:
    tr = find_token_report()
    if not tr:
        return 'token-report not found'
    out = os.path.join(os.path.dirname(DB_PATH), f'.token-report-{project}.json')
    r = subprocess.run([sys.executable, tr, '--project', project, '--since', since, '--json', '--out', out],
                       capture_output=True, text=True, timeout=900)
    if r.returncode or not os.path.exists(out):
        return f'token-report failed: {r.stderr.strip()[-200:]}'
    with open(out) as fh:
        d = json.load(fh)
    os.remove(out)
    con.execute('DELETE FROM tokens WHERE project=?', (project,))
    for row in d.get('slices', []):
        if row.get('project') != project:
            continue
        con.execute('INSERT OR REPLACE INTO tokens VALUES (?,?,?,?,?,?,?)', (
            project, row.get('slice'), row.get('role'), row.get('source'),
            row.get('sessions'), row.get('turns'), row.get('ctx')))
    con.commit()
    return f'{project}: {len(d.get("slices", []))} token rows'

# --------------------------------------------------------------------------- join check


def join_check(con) -> str:
    rows = con.execute('''SELECT provider, COUNT(*), SUM(calls), SUM(project IS NOT NULL)
                          FROM llm_session_daily GROUP BY provider''').fetchall()
    tot = con.execute('''SELECT provider, SUM(calls) FROM llm_daily
                         WHERE day IN (SELECT DISTINCT day FROM llm_session_daily) GROUP BY provider''').fetchall()
    tot = dict(tot)
    lines = ['provider | session-days | calls joined to a session | of all calls those days | session-days mapped to a project',
             '---|---|---|---|---']
    for p, n, calls, mapped in rows:
        share = f'{calls / tot[p]:.0%}' if tot.get(p) else '—'
        lines.append(f'{p} | {n} | {calls} | {share} | {mapped}')
    missing = sorted(set(tot) - {r[0] for r in rows})
    if missing:
        lines.append(f'no session id in bodies for: {", ".join(missing)} (only claude bodies carry metadata.user_id)')
    return '\n'.join(lines)

# --------------------------------------------------------------------------- report


def pct(a, b) -> str:
    return f'{a}/{b} ({a / b:.0%})' if b else '—'


def fmt_s(x) -> str:
    return '—' if x is None else ('>600s' if x == float('inf') else f'≤{x:g}s')


def table(head: list[str], rows: list[list]) -> str:
    if not rows:
        return '_không có dữ liệu_\n'
    out = ['| ' + ' | '.join(head) + ' |', '|' + '---|' * len(head)]
    out += ['| ' + ' | '.join('—' if c is None else str(c) for c in r) + ' |' for r in rows]
    return '\n'.join(out) + '\n'


def report(con, projects: list[str]) -> str:
    q = lambda sql, *a: con.execute(sql, a).fetchall()  # noqa: E731
    ph = ','.join('?' * len(projects))
    days = q('SELECT MIN(day), MAX(day), COUNT(DISTINCT day) FROM llm_daily')[0]
    md = [f'# Workflow scorecard — baseline\n',
          f'Tạo lúc {now_iso()}. Dự án: {", ".join(projects)}.',
          f'OmniRoute: {days[0]} → {days[1]} ({days[2]} ngày đã snapshot).',
          'Số nhỏ = tín hiệu định hướng, không phải tỷ lệ chuẩn. Quy hệ thống cho dữ liệu cũ là heuristic '
          '(cột `rule` trong bảng `events`).\n']

    # 1 orca
    md.append('## 1. Điều phối (Orca)\n')
    rows = []
    for p, in q(f'SELECT DISTINCT project FROM orca_tasks WHERE project IN ({ph}) ORDER BY 1', *projects):
        c = dict(q('SELECT outcome, COUNT(*) FROM orca_tasks WHERE project=? GROUP BY 1', p))
        runs = q('SELECT COUNT(*) FROM orca_runs WHERE project=?', p)[0][0]
        settled = sum(c.get(k, 0) for k in SETTLED)
        bad = c.get('stalled', 0) + c.get('failed', 0)
        rows.append([p, runs, settled, c.get('completed', 0), c.get('review_rejected', 0),
                     c.get('blocked', 0) + c.get('infra_blocked', 0), c.get('stalled', 0),
                     c.get('superseded', 0), c.get('failed', 0), pct(bad, settled)])
    md.append(table(['project', 'runs', 'task đã xong', 'completed', 'review từ chối', 'blocked', 'stalled',
                     'bị thay thế', 'failed khác', 'stalled + failed'], rows))
    md.append('_Orca ghi mọi kết cục này là `failed`. "Review từ chối" thuộc §3; "bị thay thế" là hệ quả '
              'của task trước, không tính là lỗi riêng; "blocked" thường chờ người (vd. reload gate)._\n')
    rows = q(f'''SELECT project, COUNT(*), COUNT(DISTINCT slice) FROM events
                 WHERE system='orca' AND project IN ({ph}) GROUP BY 1''', *projects)
    md.append('Sự cố điều phối trong lessons.jsonl:\n')
    md.append(table(['project', 'sự cố', 'số slice dính'], rows))
    rows = q(f'''SELECT r.project, r.slice, r.lane, r.phase, r.e2e_min,
                        (SELECT COUNT(*) FROM runner_stops s WHERE s.project=r.project AND s.slice=r.slice),
                        (SELECT ROUND(SUM(wait_min)) FROM runner_stops s WHERE s.project=r.project AND s.slice=r.slice),
                        (SELECT GROUP_CONCAT(category || ':' || n, ' ') FROM (SELECT category, COUNT(*) n FROM runner_stops s
                          WHERE s.project=r.project AND s.slice=r.slice GROUP BY category))
                 FROM runner_slices r WHERE r.project IN ({ph}) ORDER BY r.project, r.slice''', *projects)
    md.append('Producer runner — mỗi slice (dừng = runner chờ người hoặc chờ sửa):\n')
    md.append(table(['project', 'slice', 'lane', 'phase', 'e2e phút', 'số lần dừng', 'phút chờ', 'theo loại'], rows))
    rows = q(f'''SELECT category, reason, COUNT(*), ROUND(SUM(wait_min)), SUM(answered) FROM runner_stops
                 WHERE project IN ({ph}) GROUP BY 1, 2 ORDER BY 4 DESC''', *projects)
    md.append('Runner dừng theo lý do:\n')
    md.append(table(['loại', 'lý do', 'lần', 'phút chờ', 'có câu trả lời'], rows))
    rows = q(f'''SELECT project, role, cli, mode, verdict, SUM(count) FROM guard
                 WHERE project IN ({ph}) GROUP BY 1, 2, 3, 4, 5 ORDER BY 1, 6 DESC''', *projects)
    md.append('Coordinator guard (M2; ở mode shadow, `block` nghĩa là lẽ ra đã chặn):\n')
    md.append(table(['project', 'role', 'cli', 'mode', 'verdict', 'lệnh'], rows))

    # 2 gateway
    md.append('## 2. Gateway (OmniRoute)\n')
    agg: dict[str, dict] = {}
    for prov, calls, errs, tin, cr, cc, dh, th in q(
            'SELECT provider, calls, errors, tokens_in, cache_read, cache_creation, dur_hist, ttft_hist FROM llm_daily'):
        a = agg.setdefault(prov, {'calls': 0, 'err': 0, 'in': 0, 'cr': 0, 'cc': 0,
                                  'dur': [0] * len(BUCKETS), 'ttft': [0] * len(BUCKETS)})
        a['calls'] += calls
        a['err'] += errs
        a['in'] += tin
        a['cr'] += cr
        a['cc'] += cc
        a['dur'] = hist_merge(a['dur'], json.loads(dh))
        a['ttft'] = hist_merge(a['ttft'], json.loads(th))
    rows = []
    for prov, a in sorted(agg.items(), key=lambda kv: -kv[1]['calls']):
        ctx = max(a['in'], a['cr'] + a['cc'])  # OmniRoute tokens_in already includes cache read/creation
        rows.append([prov, a['calls'], pct(a['err'], a['calls']), fmt_s(hist_pct(a['dur'], .5)),
                     fmt_s(hist_pct(a['dur'], .95)), fmt_s(hist_pct(a['ttft'], .95)) + f' (n={sum(a["ttft"])})',
                     f'{a["cr"] / ctx:.0%}' if ctx else '—'])
    md.append(table(['provider', 'calls', 'lỗi', 'p50 thời gian', 'p95 thời gian', 'p95 TTFT', 'cache read'], rows))
    rows = q('''SELECT provider, error, SUM(count) n FROM llm_errors GROUP BY 1, 2 ORDER BY n DESC LIMIT 8''')
    md.append('Lỗi hay gặp nhất:\n')
    md.append(table(['provider', 'lỗi', 'số lần'], rows))
    rows = q(f'''SELECT project, SUM(calls), SUM(errors) FROM llm_session_daily
                 WHERE project IN ({ph}) GROUP BY 1''', *projects)
    md.append('Lỗi gateway theo project (chỉ claude, những ngày còn request body):\n')
    md.append(table(['project', 'calls', 'lỗi'], [[p, c, pct(e, c)] for p, c, e in rows]))
    gw = q(f"SELECT project, slice, cause FROM events WHERE system='gateway' AND project IN ({ph})", *projects)
    md.append('Nối call gateway về session/project:\n')
    md.append(join_check(con) + '\n')
    md.append('Slice bị chặn bởi provider (lessons):\n')
    md.append(table(['project', 'slice', 'nguyên nhân'], [[p, s, (c or '')[:100]] for p, s, c in gw]))

    # 3 agents
    md.append('## 3. Agent theo vai trò\n')
    md.append('check-slice (gate trước review; runner = các lần runner chạy trước mỗi vòng review, file = lần chạy cuối):\n')
    md.append(table(STATIC_HEAD, static_rows(con, projects)))
    rows = []
    for p in projects:
        # review.md is often rewritten each round, so fix_rounds (when known) decides first pass.
        sl = q('''SELECT fix_rounds, first_verdict, review_rounds, infra_blocked_reviews FROM slices
                  WHERE project=? AND (fix_rounds IS NOT NULL OR review_rounds>0)''', p)
        if not sl:
            continue
        first = sum(1 for fr, fv, _, _ in sl if (fr == 0 if fr is not None else fv == 'APPROVED'))
        rounds = [fr + 1 if fr is not None else rr for fr, _, rr, _ in sl]
        frs = [fr for fr, *_ in sl if fr is not None]
        facts = dict(q('SELECT key, value FROM project_facts WHERE project=?', p))
        rows.append([p, len(sl), pct(first, len(sl)), statistics.median(rounds), sum(x[3] for x in sl),
                     f'{sum(frs)} / {len(frs)} slice' if frs else '—',
                     json.loads(facts.get('reviewer_agent', 'null'))])
    md.append(table(['project', 'slice có số liệu', 'qua review không cần fix', 'median vòng review',
                     'review INFRA_BLOCKED', 'fix rounds / slice có số', 'reviewer_agent (AGENT_NOTES)'], rows))
    owners: collections.Counter = collections.Counter()
    for p, fo in q(f'SELECT project, fix_owners FROM slices WHERE fix_owners IS NOT NULL AND project IN ({ph})', *projects):
        for k, v in json.loads(fo).items():
            owners[(p, k)] += v
    md.append('Chủ của finding trong bảng fix_routing:\n')
    md.append(table(['project', 'owner', 'finding'], [[p, o, n] for (p, o), n in sorted(owners.items())]))
    rows = q(f'''SELECT project, role, SUM(outcome='completed'), SUM(outcome='review_rejected'),
                        SUM(outcome IN ('failed','stalled')), COUNT(*)
                 FROM orca_tasks WHERE project IN ({ph}) GROUP BY 1, 2 HAVING COUNT(*) >= 2 ORDER BY 1, 6 DESC''', *projects)
    md.append('Task Orca theo vai trò:\n')
    md.append(table(['project', 'role', 'completed', 'review từ chối', 'stalled/failed', 'tổng'], rows))
    rows = q(f'''SELECT project, role, agent, COUNT(*) FROM spawns WHERE project IN ({ph})
                 GROUP BY 1, 2, 3 ORDER BY 1, 4 DESC''', *projects)
    md.append('Agent được spawn qua bootstrap (spawn registry M1):\n')
    md.append(table(['project', 'role', 'agent', 'lần'], rows))
    rows = q(f'''SELECT project, role, agent, COUNT(*), GROUP_CONCAT(slice) FROM slice_agents WHERE project IN ({ph})
                 GROUP BY 1, 2, 3 ORDER BY 1, 2''', *projects)
    md.append('Agent đã chạy theo vai trò (stats.json `agents`, S1):\n')
    md.append(table(['project', 'role', 'agent', 'slice', 'danh sách'], rows))
    rows = q(f'''SELECT project, role, SUM(sessions), SUM(turns), SUM(ctx) FROM tokens
                 WHERE project IN ({ph}) GROUP BY 1, 2 ORDER BY 1, 5 DESC''', *projects)
    md.append('Token theo vai trò (token-report; Cursor không đo được):\n')
    md.append(table(['project', 'role', 'sessions', 'turns', 'context tokens (M)'],
                    [[p, r, s, t, f'{c / 1e6:.1f}'] for p, r, s, t, c in rows]))
    esc = []
    for p, s, cause in q(f"SELECT project, slice, cause FROM events WHERE project IN ({ph})", *projects):
        other = {x.upper() for x in re.findall(r'\b(S\d+[a-z]?)\b', cause or '')} - {s}
        if s and other:
            esc.append([p, s, ', '.join(sorted(other)), (cause or '')[:90]])
    md.append('Ứng viên lỗi lọt (sự cố ở slice này nhắc tới slice khác; cần `origin_slice` ở S1 để chắc chắn):\n')
    md.append(table(['project', 'slice phát hiện', 'slice được nhắc', 'nguyên nhân'], esc[:15]))

    # 4 engine
    md.append('## 4. Engine, MCP và preview\n')
    rows = q(f'''SELECT project, COUNT(*), COUNT(DISTINCT slice) FROM events
                 WHERE system='engine' AND project IN ({ph}) GROUP BY 1''', *projects)
    md.append(table(['project', 'sự cố engine/MCP/preview', 'số slice dính'], rows))
    rows = []
    for p in projects:
        r = q('''SELECT COUNT(*), SUM(funplay_reachable IS NOT NULL), SUM(funplay_reachable), SUM(funplay_parity = 0),
                        COUNT(DISTINCT checkout) FROM infra WHERE project=?''', p)[0]
        if not r[0]:
            continue
        ms = sorted(x for x, in q('SELECT ms FROM infra WHERE project=? AND ms IS NOT NULL', p))
        rows.append([p, r[0], r[4], pct(r[2] or 0, r[1] or 0), r[3] or 0, ms[len(ms) // 2] if ms else None])
    md.append('Probe (infra-log.jsonl):\n')
    md.append(table(['project', 'lần probe', 'checkout', 'Funplay trả lời', 'sai project (parity)', 'median ms'], rows))
    if not rows:
        md.append('_Chưa có `infra-log.jsonl`: chỉ project tạo từ template sau S1 (probe.mjs mới) mới ghi._\n')

    # 5 brief
    md.append('## 5. Đầu vào, bằng chứng và hợp đồng\n')
    rows = []
    for p in projects:
        f = {k: json.loads(v) for k, v in q('SELECT key, value FROM project_facts WHERE project=?', p)}
        if 'expect_rows' not in f:
            continue
        rows.append([p, f['expect_rows'], f['expect_given'], f['expect_assumption'], f['expect_probe_refs']])
    md.append(table(['project', 'dòng EXPECT', 'GIVEN', 'ASSUMPTION', 'nhắc tới số đo/probe'], rows))
    rows = []
    for p in projects:
        ratios = [r for r, in q('SELECT budget_ratio FROM slices WHERE project=? AND budget_ratio IS NOT NULL', p)]
        n_brief = q("SELECT COUNT(*) FROM events WHERE project=? AND system='brief' AND event!='budget_bump'", p)[0][0]
        gates = q("SELECT COUNT(*) FROM events WHERE project=? AND event='director_gate'", p)[0][0]
        if ratios or n_brief:
            rows.append([p, len(ratios), f'×{statistics.median(ratios):.2f}' if ratios else '—',
                         f'×{max(ratios):.2f}' if ratios else '—', n_brief, gates])
    md.append(table(['project', 'slice có budget_bump', 'median ratio', 'max ratio', 'sự cố do hợp đồng', 'director gate'], rows))

    # 6 art
    md.append('## 6. Art\n')
    rows = []
    for p, gate in q(f'SELECT DISTINCT project, gate FROM gates WHERE project IN ({ph}) ORDER BY 1, 2', *projects):
        files = q('SELECT file, GROUP_CONCAT(result) FROM (SELECT file, result FROM gates WHERE project=? AND gate=? ORDER BY seq) GROUP BY file', p, gate)
        first = sum(1 for _, seq in files if seq.split(',')[0] == 'PASS')
        fails = sum(seq.split(',').count('FAIL') for _, seq in files)
        rows.append([p, gate, len(files), pct(first, len(files)), fails])
    md.append(table(['project', 'gate', 'file check', 'PASS ngay lần đầu', 'số FAIL'], rows))
    rows = q(f'''SELECT project, COUNT(*), COUNT(DISTINCT slice) FROM events
                 WHERE system='art' AND project IN ({ph}) GROUP BY 1''', *projects)
    md.append('Sự cố art trong lessons:\n')
    md.append(table(['project', 'sự cố', 'số slice dính'], rows))
    md.append('_Chưa có credits, phút/asset và backend: cần `art-gates.json` (S1)._\n')

    # 7 ship
    md.append('## 7. Ship\n')
    rows = q(f"SELECT project, slice, cause FROM events WHERE system='ship' AND project IN ({ph})", *projects)
    md.append(table(['project', 'slice', 'lỗi chỉ có ở bản build / deploy'], [[p, s, (c or '')[:100]] for p, s, c in rows]))
    rows = []
    for p in projects:
        for step, n, ok, sec, kib in q('''SELECT step, COUNT(*), SUM(ok), ROUND(AVG(sec)), MAX(size_kib) FROM ship
                                          WHERE project=? GROUP BY step''', p):
            rows.append([p, step, n, pct(ok or 0, n), sec, kib])
    md.append('Build / deploy (ship-log.jsonl):\n')
    md.append(table(['project', 'bước', 'lần chạy', 'thành công', 'giây trung bình', 'size lớn nhất (KiB)'], rows))
    if not rows:
        md.append('_Chưa có `ship-log.jsonl`: chỉ project tạo từ template sau S1 (build.sh/deploy.sh mới) mới ghi._\n')

    # 8 memory
    md.append('## 8. Học và memory\n')
    rec = []
    for p, ft, n, sl in q(f'''SELECT project, fix_target, COUNT(*), GROUP_CONCAT(DISTINCT slice) FROM events
                             WHERE project IN ({ph}) AND fix_target NOT IN ('', 'none') GROUP BY 1, 2''', *projects):
        distinct = sorted(set((sl or '').split(',')) - {''})
        if len(distinct) >= 2:
            rec.append([p, ft[:70], n, ', '.join(distinct)])
    md.append('Lỗi lặp (cùng `fix_target` ở ≥2 slice):\n')
    md.append(table(['project', 'fix_target', 'số lần', 'slice'], sorted(rec, key=lambda r: -r[2])[:12]))
    rows = q(f'''SELECT project, COUNT(*), SUM(kind='failure_fix'), SUM(kind='successful_pattern'),
                        SUM(event='recipe_reuse') FROM learnings WHERE project IN ({ph}) GROUP BY 1''', *projects)
    md.append('Bài học thu được:\n')
    md.append(table(['project', 'bản ghi học', 'failure_fix', 'successful_pattern', 'recipe_reuse'], rows))
    if os.path.exists(PLAYBOOK_REGISTRY):
        with open(PLAYBOOK_REGISTRY) as fh:
            reg = json.load(fh)
        recs = reg.get('recipes', reg) if isinstance(reg, dict) else reg
        st = collections.Counter(r.get('status') for r in recs)
        md.append(f'Playbook: {len(recs)} recipe — ' + ', '.join(f'{k}: {v}' for k, v in st.most_common()) + '.\n')
    hooks = [d for _, d in read_jsonl(MEMORY_HOOK_LOG)]
    if hooks:
        by = collections.defaultdict(list)
        for h in hooks:
            by[(h.get('project'), h.get('mode'))].append(h)
        rows = [[p, m, len(v), sum(1 for h in v if h.get('inject')),
                 round(statistics.mean(h.get('elapsed_ms') or 0 for h in v)),
                 round(statistics.mean([h['pack_tokens'] for h in v if h.get('pack_tokens')] or [0]))]
                for (p, m), v in sorted(by.items())]
        md.append('Hook orca-memory:\n')
        md.append(table(['project', 'mode', 'lần gọi', 'đã inject', 'ms trung bình', 'pack tokens trung bình'], rows))

    # 9 typesafe
    md.append('## 9. TypeSafe\n')
    on = [p for p, v in q(f"SELECT project, value FROM project_facts WHERE key='typesafe_enabled' AND project IN ({ph})",
                          *projects) if json.loads(v)]
    md.append(f'Bật ở: {", ".join(on) if on else "không project nào"} — không đo.\n')

    # appendix
    md.append('## Phụ lục: từng slice\n')
    rows = q(f'''SELECT project, slice, review_rounds, first_verdict, final_verdict, fix_rounds, fix_rounds_source,
                        merged, e2e_min, budget_ratio FROM slices WHERE project IN ({ph}) ORDER BY project''', *projects)
    md.append(table(['project', 'slice', 'vòng review', 'verdict đầu', 'verdict cuối', 'fix rounds', 'nguồn',
                     'merged', 'e2e phút', 'budget ×'], rows))
    unk = q(f"SELECT project, system, COUNT(*) FROM events WHERE project IN ({ph}) GROUP BY 1, 2 ORDER BY 1, 3 DESC", *projects)
    md.append('Phân bổ sự cố theo hệ thống (heuristic):\n')
    md.append(table(['project', 'system', 'sự cố'], unk))
    return '\n'.join(md)

# --------------------------------------------------------------------------- resolutions


def load_resolutions(path: str | None = None) -> list[dict]:
    data = read_json(path or RESOLUTIONS, [])
    return data if isinstance(data, list) else []


def resolution_for(res: list[dict], kind: str, at: str | None, **fields) -> dict | None:
    """The fix that covers an occurrence at `at`: same kind, every given field equal, `match`
    (regex) found in `text`, and the occurrence before `fixed_at`. A repeat after the fix is not
    covered, so a regression shows again."""
    text = fields.pop('text', '') or ''
    for r in res:
        if r.get('kind') != kind or any(k in r and r[k] != v for k, v in fields.items()):
            continue
        if r.get('match') and not re.search(r['match'], text):
            continue
        if at and r.get('fixed_at') and at >= r['fixed_at']:
            continue
        return r
    return None

# --------------------------------------------------------------------------- S2: thresholds

# (warn, crit, direction, min_n). direction 'high' = bigger is worse. Plan §4 sets the numbers;
# below min_n a KPI reads "chưa đủ dữ liệu" instead of a colour (§2.4: small N is a signal only).
THRESHOLDS = {
    'orca.task_fail': (0.08, 0.15, 'high', 10),
    'orca.runner_avoidable_wait': (0.20, 0.40, 'high', 1),
    'orca.director_wait_min': (60, None, 'high', 3),  # yellow-only: the director's time, shown so it is seen
    'gateway.error_rate': (0.02, 0.03, 'high', 200),
    'gateway.dead_connections': (1, None, 'high', 1),  # yellow-only: an account to re-login or remove
    'agent.first_pass': (0.50, 0.30, 'low', 5),
    'agent.infra_blocked': (1, 3, 'high', 1),
    'agent.static_first_fail': (0.30, 0.50, 'high', 3),
    'engine.funplay_reach': (0.95, 0.80, 'low', 5),
    'engine.incidents_per_slice': (0.20, 0.50, 'high', 5),
    'brief.budget_ratio': (1.5, 2.0, 'high', 3),
    'brief.contract_recur': (2, 3, 'high', 1),
    'art.first_pass_gate': (0.80, 0.60, 'low', 5),
    'ship.success': (0.90, 0.75, 'low', 3),
    'memory.recurrence': (2, 3, 'high', 1),
    'memory.promotion': (0.01, None, 'low', 20),  # yellow only: a reminder, never red
}
ACTIONS = {
    'orca.task_fail': 'retro mục fix_target skill:cocos-orca-fleet; xem task stalled',
    'orca.runner_avoidable_wait': 'xem các lần dừng tránh được lâu nhất; sửa nguyên nhân rồi ghi vào resolutions.json',
    'orca.director_wait_min': 'quyết định chờ director lâu: bật thông báo runner / gom câu hỏi trước slice',
    'gateway.error_rate': 'đổi combo / fallback provider trong OmniRoute',
    'gateway.dead_connections': 'đăng nhập lại hoặc gỡ tài khoản đó trong OmniRoute',
    'agent.first_pass': 'xem fix_routing owner; cân nhắc đổi writer/reviewer (§4.3, S3)',
    'agent.infra_blocked': 'reviewer không tới được preview: đổi reviewer hoặc sửa preflight',
    'agent.static_first_fail': 'writer giao slice khi check-slice còn FAIL: xem loại FAIL lặp lại, sửa prompt writer hoặc nguồn lỗi',
    'engine.funplay_reach': 'sửa setup hook / pin port',
    'engine.incidents_per_slice': 'retro các sự cố engine; sửa template/skill liên quan',
    'brief.budget_ratio': 'sửa cách calibrate change_budget trong slice-schema.md',
    'brief.contract_recur': 'amendment hợp đồng ngay, không chờ retro',
    'art.first_pass_gate': 'so backend art theo first-pass (S3)',
    'ship.success': 'xem log build/deploy thất bại',
    'memory.recurrence': 'lỗi lặp: sửa gốc ở fix_target, đưa vào playbook',
    'memory.promotion': 'nhắc curator review candidate',
}
STATUS_LABEL = {'good': 'XANH', 'warning': 'VÀNG', 'critical': 'ĐỎ', 'fixed': 'ĐÃ SỬA · chờ xác nhận', 'na': 'chưa đủ dữ liệu'}
CATEGORY_OF = {'orca': '1. Điều phối', 'gateway': '2. Gateway', 'agent': '3. Agent', 'engine': '4. Engine/MCP',
               'brief': '5. Đầu vào & hợp đồng', 'art': '6. Art', 'ship': '7. Ship', 'memory': '8. Học/memory'}


def judge(kpi: str, value, n: int) -> str:
    warn, crit, direction, min_n = THRESHOLDS[kpi]
    if value is None or n < min_n:
        return 'na'
    if direction == 'high':
        return 'critical' if crit is not None and value >= crit else 'warning' if value >= warn else 'good'
    return 'critical' if crit is not None and value <= crit else 'warning' if value < warn else 'good'


def evaluate(con, projects: list[str]) -> list[dict]:
    """One row per (KPI, scope): value, n, status, threshold, action."""
    q = lambda sql, *a: con.execute(sql, a).fetchall()  # noqa: E731
    out = []

    res = load_resolutions()

    def add(kpi, scope, value, n, text, residual=None, fixes=(), fmt=None):
        """`residual`: the value once occurrences covered by a recorded fix are corrected or left
        out. A red/yellow KPI takes the residual's colour; one whose residual is fine reads 'fixed'
        until new data confirms it."""
        warn, crit, direction, min_n = THRESHOLDS[kpi]
        cmp = '≥' if direction == 'high' else '≤'
        status = judge(kpi, value, n)
        if status in ('critical', 'warning') and fixes and residual is not None:
            after = judge(kpi, residual, max(n, min_n))
            rank = {'critical': 0, 'warning': 1, 'good': 2}
            if rank.get(after, 0) > rank[status]:
                status = 'fixed' if after == 'good' else after
                shown = fmt(residual) if fmt else (f'{residual:.0%}' if isinstance(residual, float) and residual <= 1 else f'{residual:g}')
                text += f' → {shown} sau phần đã sửa (' + ', '.join(sorted({f["fixed_by"] for f in fixes})) + ')'
        out.append({'kpi': kpi, 'category': CATEGORY_OF[kpi.split('.')[0]], 'scope': scope, 'value': value,
                    'n': n, 'text': text, 'status': status,
                    'threshold': f'vàng {cmp} {warn:g}' + (f', đỏ {cmp} {crit:g}' if crit is not None else '') + f', n ≥ {min_n}',
                    'action': ACTIONS[kpi]})

    for p in projects:
        c = dict(q('SELECT outcome, COUNT(*) FROM orca_tasks WHERE project=? GROUP BY 1', p))
        settled = sum(c.get(k, 0) for k in SETTLED)
        bad = c.get('stalled', 0) + c.get('failed', 0)
        if settled:
            add('orca.task_fail', p, bad / settled, settled, pct(bad, settled))
        rs = q('SELECT slice, selected_at, recorded_at, e2e_min FROM runner_slices WHERE project=? AND e2e_min > 0', p)
        if rs:
            e2e = sum(r[3] for r in rs)
            avoid = left = 0.0
            fixes = []
            for sl, sel, rec, _ in rs:
                for reason, cat, opened, wait, detail in q('''SELECT reason, category, opened_at, wait_min, detail FROM runner_stops
                                                              WHERE project=? AND slice=? AND wait_min IS NOT NULL''', p, sl):
                    # only time inside the slice; a director gate asked before selection is not slice time
                    if cat in DECISION_CATEGORIES or opened < sel or (rec and opened > rec):
                        continue
                    avoid += wait
                    fx = resolution_for(res, 'runner_stop', opened, reason=reason, text=detail)
                    if fx:
                        fixes.append(fx)
                    else:
                        left += wait
            add('orca.runner_avoidable_wait', p, avoid / e2e, len(rs),
                f'{avoid:.0f}/{e2e:.0f} phút ({avoid / e2e:.0%}), {len(rs)} slice', left / e2e, fixes, lambda v: f'còn {v:.0%}')
        dw = [w for w, in q('''SELECT wait_min FROM runner_stops WHERE project=? AND wait_min IS NOT NULL
                               AND category IN ('director')''', p)]
        if dw:
            m = statistics.median(dw)
            add('orca.director_wait_min', p, m, len(dw), f'median {m:.0f} phút / {len(dw)} quyết định')

        sl = q('SELECT fix_rounds, first_verdict FROM slices WHERE project=? AND (fix_rounds IS NOT NULL OR review_rounds > 0)', p)
        if sl:
            first = sum(1 for fr, fv in sl if (fr == 0 if fr is not None else fv == 'APPROVED'))
            add('agent.first_pass', p, first / len(sl), len(sl), pct(first, len(sl)))
        sc = q('''SELECT slice, result, failed FROM static_checks c WHERE project=? AND seq =
                  (SELECT MIN(seq) FROM static_checks d WHERE d.project=c.project AND d.slice=c.slice)''', p)
        if sc:
            bad = [(sl, f) for sl, r, f in sc if r == 'FAIL']
            kinds = collections.Counter(k for _, f in bad for k in f.split(',') if k)
            add('agent.static_first_fail', p, len(bad) / len(sc), len(sc),
                f'{len(bad)}/{len(sc)} slice FAIL ở lần chạy đầu' + (' (' + ', '.join(f'{k} {n}' for k, n in kinds.most_common()) + ')' if kinds else ''))
        ib = q('SELECT COALESCE(SUM(infra_blocked_reviews), 0) FROM slices WHERE project=?', p)[0][0]
        ib += q("SELECT COUNT(*) FROM events WHERE project=? AND event='infra_blocked' AND system LIKE 'agent%'", p)[0][0]
        nsl = q('SELECT COUNT(*) FROM slices WHERE project=?', p)[0][0]
        if nsl:
            add('agent.infra_blocked', p, ib, nsl, f'{ib} lần / {nsl} slice')

        r = q('SELECT COUNT(*), SUM(funplay_reachable) FROM infra WHERE project=? AND funplay_reachable IS NOT NULL', p)[0]
        if r[0]:
            add('engine.funplay_reach', p, (r[1] or 0) / r[0], r[0], pct(r[1] or 0, r[0]))
        ne = q("SELECT COUNT(*) FROM events WHERE project=? AND system='engine'", p)[0][0]
        if nsl:
            add('engine.incidents_per_slice', p, ne / nsl, nsl, f'{ne} / {nsl} slice')

        bumps = q('''SELECT ratio, cause, at, slice FROM events WHERE project=? AND event='budget_bump' AND ratio IS NOT NULL
                     ORDER BY line DESC LIMIT 5''', p)
        if bumps:
            ratios = [b[0] for b in bumps]
            m = statistics.median(ratios)
            fixes, corrected = [], []
            for ratio, cause, at, sl in bumps:
                fx = resolution_for(res, 'budget_bump', at, project=p, text=cause)
                if fx:
                    fixes.append(fx)
                    # a recount under the fixed counter replaces the ratio; without one the row drops out
                    if sl in (fx.get('recount') or {}):
                        corrected.append(fx['recount'][sl])
                else:
                    corrected.append(ratio)
            add('brief.budget_ratio', p, m, len(ratios), f'median ×{m:.2f} ({len(ratios)} slice gần nhất)',
                statistics.median(corrected) if corrected else None, fixes, lambda v: f'đếm lại ×{v:.2f}')

        def recurrence(kpi, brief_only):
            cond = "system = 'brief'" if brief_only else "system != 'brief'"
            rows = q(f'''SELECT fix_target, slice, at FROM events WHERE project=? AND {cond}
                         AND fix_target NOT IN ('', 'none')''', p)
            by = collections.defaultdict(list)
            for ft, sl, at in rows:
                by[ft].append((sl, at))
            if not by:
                return
            ft, occ = max(by.items(), key=lambda kv: len({sl for sl, _ in kv[1]}))
            n_sl = len({sl for sl, _ in occ})
            fx = [f for sl, at in occ if (f := resolution_for(res, 'fix_target', at, project=p, fix_target=ft))]
            after = len({sl for sl, at in occ if not resolution_for(res, 'fix_target', at, project=p, fix_target=ft)})
            add(kpi, p, n_sl, 1, f'{n_sl} slice: {ft[:50]}', after, fx, lambda v: f'còn {v:g} slice lặp')
        recurrence('brief.contract_recur', True)

        files = q('''SELECT file, GROUP_CONCAT(result) FROM (SELECT file, result FROM gates WHERE project=? ORDER BY file, gate, seq)
                     GROUP BY file''', p)
        if files:
            first = sum(1 for _, seqs in files if seqs.split(',')[0] == 'PASS')
            add('art.first_pass_gate', p, first / len(files), len(files), pct(first, len(files)))
        r = q('SELECT COUNT(*), SUM(ok) FROM ship WHERE project=?', p)[0]
        if r[0]:
            add('ship.success', p, (r[1] or 0) / r[0], r[0], pct(r[1] or 0, r[0]))
        recurrence('memory.recurrence', False)  # contract repeats are brief.contract_recur

    days = [d for d, in q('SELECT DISTINCT day FROM llm_daily ORDER BY day DESC LIMIT 7')]
    if days:
        ph = ','.join('?' * len(days))
        for prov, calls, errs in q(f'SELECT provider, SUM(calls), SUM(errors) FROM llm_daily WHERE day IN ({ph}) GROUP BY 1', *days):
            add('gateway.error_rate', f'provider {prov}', errs / calls if calls else None, calls, pct(errs, calls))
    hdays = [d for d, in q('SELECT DISTINCT day FROM llm_health ORDER BY day DESC LIMIT 2')]
    if hdays:
        # two days, so a dead account still shows early in the day; ≥3 probes, at least half failing
        ph2 = ','.join('?' * len(hdays))
        for prov, total, dead in q(f'''SELECT provider, COUNT(*), SUM(c >= 3 AND f * 2 >= c) FROM
                                       (SELECT provider, connection, SUM(checks) c, SUM(failures) f FROM llm_health
                                        WHERE day IN ({ph2}) GROUP BY 1, 2) GROUP BY 1''', *hdays):
            add('gateway.dead_connections', f'provider {prov}', dead or 0, total,
                f'{dead or 0}/{total} tài khoản lỗi health-check ({min(hdays)}→{max(hdays)})')
    if os.path.exists(PLAYBOOK_REGISTRY):
        reg = read_json(PLAYBOOK_REGISTRY, [])
        recs = reg.get('recipes', reg) if isinstance(reg, dict) else reg
        ok = sum(1 for r in recs if r.get('status') in ('verified', 'default'))
        add('memory.promotion', 'playbook', ok / len(recs) if recs else None, len(recs), f'{ok}/{len(recs)} recipe verified/default')
    return out

# --------------------------------------------------------------------------- S3: configurations


def short_agent(spec: str | None) -> str | None:
    """'claude --model opus --effort high' -> 'claude opus'; 'task_x (opencode deepseek-v4.1-flash)' -> 'opencode deepseek-v4.1-flash'."""
    if not spec:
        return None
    m = re.search(r'\(([^)]+)\)', spec)
    if m and not spec.strip().startswith(('claude', 'cursor', 'codex', 'antigravity', 'agy', 'gemini', 'opencode')):
        spec = m.group(1)
    tokens = spec.split()
    if not tokens:
        return None
    model = re.search(r'--model\s+(\S+)', spec)
    if model:
        return f'{tokens[0]} {model.group(1).split("/")[-1]}'
    head = [t for t in tokens[:2] if not t.startswith('-')]
    return ' '.join(head[:1] + [t.split('/')[-1] for t in head[1:]])


def experiments(con, projects: list[str], switches: list[dict] | None = None) -> list[dict]:
    """Slices grouped by the configuration that ran them (S3). Each arm needs ≥5 slices before a
    comparison means anything; below that the row says so. A slice without its own label takes the
    lock that held when it finished: experiments.json records each switch, so a slice done before a
    switch keeps the old arm instead of the current AGENT_NOTES value."""
    q = lambda sql, *a: con.execute(sql, a).fetchall()  # noqa: E731
    switches = read_json(EXPERIMENTS, []) if switches is None else switches
    arms: dict[tuple, list] = collections.defaultdict(list)
    for p in projects:
        facts = {k: json.loads(v) for k, v in q('SELECT key, value FROM project_facts WHERE project=?', p)}
        for s, fr, fv, e2e, reviewer, done in q('''SELECT s.slice, s.fix_rounds, s.first_verdict, s.e2e_min, s.reviewer,
                                                         COALESCE(r.recorded_at, s.merged_at)
                                                  FROM slices s LEFT JOIN runner_slices r ON r.project=s.project AND r.slice=s.slice
                                                  WHERE s.project=? AND (s.fix_rounds IS NOT NULL OR s.review_rounds > 0)''', p):
            ag = dict(q('SELECT role, agent FROM slice_agents WHERE project=? AND slice=?', p, s))
            # (label, from the slice itself?) — the AGENT_NOTES lock is only what the project asked for
            dims = {
                'reviewer': (ag.get('review') or reviewer, facts.get('reviewer_agent')),
                'writer': (ag.get('implement'), facts.get('writer_agent')),
                'art_backend': (ag.get('art'), facts.get('art_backend')),
            }
            for dim, (own, locked) in dims.items():
                if not own and done:
                    for sw in switches:
                        if sw.get('project') == p and sw.get('dim') == dim and parse_ts(done) < parse_ts(sw['switched_at']):
                            locked = sw['from']
                            break
                arm = short_agent(own) if own else (short_agent(locked) if dim != 'art_backend' else locked)
                if arm:
                    arms[(dim, arm)].append({'project': p, 'slice': s, 'first': fr == 0 if fr is not None else fv == 'APPROVED',
                                             'fix': fr, 'e2e': e2e, 'own': bool(own)})
    out = []
    by_dim = collections.defaultdict(list)
    for (dim, arm), rows in arms.items():
        by_dim[dim].append((arm, rows))
    for dim, lst in sorted(by_dim.items()):
        # comparable only inside one project: some project with ≥5 slices in each of ≥2 arms. Arms
        # that are just different projects compare projects, not configurations.
        per = collections.defaultdict(collections.Counter)  # project -> arm -> slices
        for arm, rows in lst:
            for r in rows:
                per[r['project']][arm] += 1
        shared = {p: c for p, c in per.items() if len(c) >= 2}
        if any(sum(1 for n in c.values() if n >= 5) >= 2 for c in shared.values()):
            ready = 'có'
        elif shared:
            ready = 'chưa (trong ' + ', '.join(f'{p}: ' + ' / '.join(f'{n}' for n in c.values()) for p, c in shared.items()) + \
                    ' slice; cần ≥5 mỗi nhánh)'
        else:
            ready = 'chưa (mỗi nhánh là một project khác: đổi cấu hình trong cùng project)'
        for arm, rows in sorted(lst, key=lambda x: -len(x[1])):
            fixes = [r['fix'] for r in rows if r['fix'] is not None]
            e2es = [r['e2e'] for r in rows if r['e2e']]
            out.append({'dim': dim, 'arm': arm, 'n': len(rows), 'projects': sorted({r['project'] for r in rows}),
                        'first_pass': sum(r['first'] for r in rows) / len(rows),
                        'fix_median': statistics.median(fixes) if fixes else None,
                        'e2e_median': statistics.median(e2es) if e2es else None,
                        'own': sum(r['own'] for r in rows), 'ready': ready})
    return out

def registered_experiments(con, switches: list[dict] | None = None) -> list[dict]:
    """Each experiments.json switch, compared inside its own project: slices labelled `from`
    against slices labelled `to`. A switch with `ended_at` (the lock went back) stops there:
    slices that finish later belong to neither arm."""
    q = lambda sql, *a: con.execute(sql, a).fetchall()  # noqa: E731
    switches = read_json(EXPERIMENTS, []) if switches is None else switches
    role = {'writer': 'implement', 'reviewer': 'review', 'art_backend': 'art'}
    out = []
    for sw in switches:
        p, dim = sw.get('project'), sw.get('dim')
        arms = {short_agent(sw['from']): [], short_agent(sw['to']): []}
        for sl, fr, fv, e2e, owners, own, done in q('''
                SELECT s.slice, s.fix_rounds, s.first_verdict, s.e2e_min, s.fix_owners, a.agent, COALESCE(r.recorded_at, s.merged_at)
                FROM slices s LEFT JOIN slice_agents a ON a.project=s.project AND a.slice=s.slice AND a.role=?
                LEFT JOIN runner_slices r ON r.project=s.project AND r.slice=s.slice
                WHERE s.project=? AND (s.fix_rounds IS NOT NULL OR s.review_rounds > 0)''', role.get(dim, dim), p):
            if sw.get('ended_at') and done and parse_ts(done) >= parse_ts(sw['ended_at']):
                continue
            if own:
                arm = short_agent(own)
            elif done:  # no label of its own: the lock that held when it finished
                arm = short_agent(sw['from'] if parse_ts(done) < parse_ts(sw['switched_at']) else sw['to'])
            else:
                arm = None
            if arm not in arms:
                continue  # no label and not provably before the switch, or another configuration
            wait = q('''SELECT COALESCE(SUM(wait_min), 0) FROM runner_stops WHERE project=? AND slice=?
                        AND category NOT IN ('director')''', p, sl)[0][0]
            arms[arm].append({'slice': sl, 'fix': fr, 'first': fr == 0 if fr is not None else fv == 'APPROVED', 'e2e': e2e,
                              'owners': json.loads(owners) if owners else {}, 'wait': wait})
        for arm, rows in arms.items():
            fixes = [r['fix'] for r in rows if r['fix'] is not None]
            e2es = [r['e2e'] for r in rows if r['e2e']]
            owners = collections.Counter()
            for r in rows:
                owners.update(r['owners'])
            out.append({'project': p, 'dim': dim, 'arm': arm, 'side': 'trước' if arm == short_agent(sw['from']) else 'sau',
                        'slices': ', '.join(r['slice'] for r in rows), 'n': len(rows),
                        'first_pass': f"{sum(r['first'] for r in rows)}/{len(rows)}" if rows else '—',
                        'fix_median': statistics.median(fixes) if fixes else None,
                        'e2e_median': statistics.median(e2es) if e2es else None,
                        'owners': ', '.join(f'{k} {v}' for k, v in owners.most_common()),
                        'ready': 'có' if all(len(v) >= 5 for v in arms.values()) else
                                 f"dừng sớm ({sw.get('ended_note', sw['ended_at'])})" if sw.get('ended_at') else
                                 'chưa (cần ≥5 slice mỗi nhánh)'})
    return out

# --------------------------------------------------------------------------- S2: weekly + dashboard


STATIC_HEAD = ['project', 'slice', 'lần chạy', 'lần đầu', 'lần cuối', 'bị trả lại', 'check FAIL', 'check WARN']


def static_rows(con, projects: list[str]) -> list[list]:
    """check-slice per slice: runs, first and last result, bounces (FAIL runs before the last), the
    checks that failed or warned in any run."""
    ph = ','.join('?' * len(projects))
    rows = []
    by = collections.defaultdict(list)
    for p, sl, r, f, w in con.execute(f'''SELECT project, slice, result, failed, warned FROM static_checks
                                          WHERE project IN ({ph}) ORDER BY project, slice, seq''', projects):
        by[(p, sl)].append((r, f, w))
    for (p, sl), runs in by.items():
        kinds = lambda i: ', '.join(sorted({k for r in runs for k in r[i].split(',') if k}))  # noqa: E731
        rows.append([p, sl, len(runs), runs[0][0], runs[-1][0], sum(1 for r in runs[:-1] if r[0] == 'FAIL'), kinds(1), kinds(2)])
    return rows


def scorecard_md(con, projects: list[str], flags: list[dict], exps: list[dict]) -> str:
    md = [f'# Scorecard tuần {datetime.now().strftime("%G-W%V")}\n',
          f'Tạo lúc {now_iso()}. Ngưỡng: `THRESHOLDS` trong scorecard.py (plan §4). '
          'Dưới số mẫu tối thiểu, KPI ghi "chưa đủ dữ liệu".\n']
    count = collections.Counter(f['status'] for f in flags)
    md.append(f"Tổng: ĐỎ {count['critical']} · VÀNG {count['warning']} · ĐÃ SỬA (chờ xác nhận) {count['fixed']} · "
              f"XANH {count['good']} · chưa đủ dữ liệu {count['na']}\n")
    order = {'critical': 0, 'warning': 1, 'fixed': 2, 'good': 3, 'na': 4}
    md.append('## KPI theo hạng mục\n')
    md.append(table(['hạng mục', 'KPI', 'phạm vi', 'trạng thái', 'giá trị', 'n', 'ngưỡng', 'hành động khi đỏ/vàng'],
                    [[f['category'], f['kpi'], f['scope'], STATUS_LABEL[f['status']], f['text'], f['n'], f['threshold'],
                      f['action'] if f['status'] in ('critical', 'warning') else ('chờ slice mới xác nhận' if f['status'] == 'fixed' else '')]
                     for f in sorted(flags, key=lambda f: (f['category'], order[f['status']], f['scope']))]))
    ph = ','.join('?' * len(projects))
    week_start = datetime.now(timezone.utc).date().fromordinal(datetime.now(timezone.utc).date().toordinal() - 7).isoformat()
    rows = con.execute(f'''SELECT s.project, s.slice, s.fix_rounds, s.final_verdict, s.e2e_min,
                                  COALESCE(r.recorded_at, s.merged_at)
                           FROM slices s LEFT JOIN runner_slices r ON r.project=s.project AND r.slice=s.slice
                           WHERE s.project IN ({ph}) AND COALESCE(r.recorded_at, s.merged_at) >= ?
                           ORDER BY 6''', (*projects, week_start)).fetchall()
    md.append('## Slice xong trong 7 ngày qua\n')
    md.append(table(['project', 'slice', 'fix rounds', 'verdict cuối', 'e2e phút', 'xong lúc'], rows))
    rec = con.execute(f'''SELECT project, fix_target, COUNT(DISTINCT slice) n FROM events WHERE project IN ({ph})
                          AND fix_target NOT IN ('', 'none') GROUP BY 1, 2 HAVING n >= 2 ORDER BY n DESC LIMIT 3''',
                      projects).fetchall()
    md.append('## Top 3 fix_target lặp lại\n')
    md.append(table(['project', 'fix_target', 'số slice'], rec))
    md.append('## check-slice (gate trước review)\n')
    md.append(table(STATIC_HEAD, static_rows(con, projects)))
    reg = registered_experiments(con)
    if reg:
        md.append('## Thí nghiệm đã đăng ký (experiments.json, so trong cùng project)\n')
        md.append(table(['project', 'chiều', 'nhánh', 'trước/sau', 'slice', 'không cần fix', 'median fix rounds',
                         'median e2e phút', 'owner finding', 'so được?'],
                        [[e['project'], e['dim'], e['arm'], e['side'], e['slices'], e['first_pass'], e['fix_median'],
                          e['e2e_median'], e['owners'], e['ready']] for e in reg]))
    md.append('## Thí nghiệm theo cấu hình (S3)\n')
    md.append('So sánh chỉ có nghĩa khi mọi nhánh của một chiều có ≥5 slice.\n')
    md.append('"nhãn từ slice" = số slice có cấu hình ghi trong chính slice (stats.json `agents` / reviewer); '
              'phần còn lại lấy theo khóa trong AGENT_NOTES.\n')
    md.append(table(['chiều', 'nhánh', 'slice', 'nhãn từ slice', 'project', 'qua review không cần fix', 'median fix rounds',
                     'median e2e phút', 'so được?'],
                    [[e['dim'], e['arm'], e['n'], e['own'], ', '.join(e['projects']), f"{e['first_pass']:.0%}", e['fix_median'],
                      e['e2e_median'], e['ready']] for e in exps]))
    return '\n'.join(md)


DASHBOARD_CSS = """
@import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=Space+Mono:wght@400;700&display=swap');
/* "Sticker Sheet" skin, shared with the director console: cream paper, 2px ink borders, hard offset
   shadows, coloured stickers with ink text. Status always shows its icon and label, never colour alone. */
:root { color-scheme: light; --bg: #FFF4D6; --surface: #FFFFFF; --surface-2: #FFF9E8; --fg: #111111; --muted: #3F3F46;
  --border: #111111; --rule: #E3DCC8; --hard: #111111;
  --yellow: #FFD23F; --pink: #FF6BB5; --blue: #7CC4FF; --green: #7EE0A1; --coral: #FFB199; }
@media (prefers-color-scheme: dark) { :root:where(:not([data-theme="light"])) {
  color-scheme: dark; --bg: #141414; --surface: #1F1F1F; --surface-2: #2A2A2A; --fg: #FAFAFA; --muted: #C4C4C4;
  --border: #FAFAFA; --rule: #3A3A3A; --hard: #FFD23F; } }
:root[data-theme="dark"] { color-scheme: dark; --bg: #141414; --surface: #1F1F1F; --surface-2: #2A2A2A; --fg: #FAFAFA;
  --muted: #C4C4C4; --border: #FAFAFA; --rule: #3A3A3A; --hard: #FFD23F; }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.5 "Space Grotesk", system-ui, -apple-system, sans-serif;
  font-variant-numeric: tabular-nums; -webkit-font-smoothing: antialiased; }
main { max-width: 1280px; margin: 0 auto; padding: 24px 20px 56px; background: var(--bg); color: var(--fg); }
.crumb { font: 12px/1.3 "Space Mono", ui-monospace, monospace; text-transform: uppercase; color: var(--muted); }
h1 { font-size: 40px; font-weight: 700; letter-spacing: -.02em; line-height: 1.1; margin: 2px 0 0; }
h2 { display: flex; align-items: center; gap: 10px; font-size: 20px; font-weight: 700; margin: 36px 0 12px; }
h2::before { content: ""; width: 12px; height: 12px; flex: none; background: var(--pink); border: 2px solid #111; border-radius: 3px; transform: rotate(45deg); }
.tags { display: flex; flex-wrap: wrap; gap: 8px; margin: 12px 0 22px; }
.tag { display: inline-flex; align-items: center; min-height: 26px; padding: 4px 8px; border: 2px solid var(--border); border-radius: 6px;
  background: var(--surface); font: 700 11.5px/1.45 "Space Mono", ui-monospace, monospace; text-transform: uppercase; overflow-wrap: anywhere; }
.sub { color: var(--muted); margin: -4px 0 12px; font-size: 14px; overflow-wrap: anywhere; }
.stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(170px, 100%), 1fr)); gap: 16px; }
.stat { padding: 14px 16px; border: 2px solid #111; border-radius: 10px; box-shadow: 4px 4px 0 var(--hard); color: #111; }
.stat .k { font: 700 12px/1.2 "Space Mono", ui-monospace, monospace; text-transform: uppercase; }
.stat .v { font-size: 40px; font-weight: 700; line-height: 1; margin-top: 10px; }
.st-critical { background: var(--coral); } .st-warning { background: var(--yellow); } .st-fixed { background: var(--blue); }
.st-good { background: var(--green); } .st-na { background: var(--surface); color: var(--fg); border-color: var(--border); }
.tiles { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(280px, 100%), 1fr)); gap: 18px; }
.tile { background: var(--surface); border: 2px solid var(--border); border-radius: 10px; box-shadow: 4px 4px 0 var(--hard);
  padding: 14px 16px; min-width: 0; overflow-wrap: anywhere; }
.tile.critical, .tile.warning, .tile.fixed { color: #111; border-color: #111; }
.tile.critical { background: var(--coral); } .tile.warning { background: var(--yellow); } .tile.fixed { background: var(--blue); }
.tile .k { font: 700 11.5px/1.35 "Space Mono", ui-monospace, monospace; text-transform: uppercase; }
.tile .v { font-size: 17px; font-weight: 700; margin: 8px 0; }
.tile .s { font-size: 13.5px; font-weight: 500; margin-top: 8px; }
.badge { display: inline-flex; align-items: center; gap: 5px; height: 24px; padding: 0 8px; border: 2px solid var(--border);
  border-radius: 6px; background: var(--surface); color: var(--fg); font: 700 11.5px/1 "Space Mono", ui-monospace, monospace;
  text-transform: uppercase; white-space: nowrap; }
.badge.good, .badge.warning, .badge.critical, .badge.fixed { color: #111; border-color: #111; }
.badge.good { background: var(--green); } .badge.warning { background: var(--yellow); }
.badge.critical { background: var(--coral); } .badge.fixed { background: var(--blue); }
.dot { display: none; }
.wrap { overflow-x: auto; background: var(--surface); border: 2px solid var(--border); border-radius: 10px; box-shadow: 4px 4px 0 var(--hard); }
table { border-collapse: collapse; width: 100%; font-size: 14px; }
th, td { text-align: left; padding: 9px 10px; border-bottom: 1px solid var(--rule); vertical-align: top; }
th { font: 700 11.5px/1.25 "Space Mono", ui-monospace, monospace; text-transform: uppercase; background: var(--surface-2);
  border-bottom: 2px solid var(--border); position: sticky; top: 0; }
td { font-weight: 500; }
td.num { text-align: right; }
td.nowrap { white-space: nowrap; font-size: 13px; }
tbody tr:hover td { background: var(--surface-2); }
tr:last-child td { border-bottom: none; }
.muted { color: var(--muted); }
@media (max-width: 640px) { h1 { font-size: 30px; } .stat .v { font-size: 32px; } main { padding: 18px 14px 40px; } }
"""
ICON = {'good': '✓', 'warning': '▲', 'critical': '✖', 'fixed': '↻', 'na': '–'}


def esc(x) -> str:
    import html
    return html.escape('—' if x is None else str(x))


def badge(status: str) -> str:
    return f'<span class="badge {status}"><span class="dot"></span>{ICON[status]} {esc(STATUS_LABEL[status])}</span>'


def html_table(head: list[str], rows: list[list], num: set[int] = frozenset(), nowrap: set[int] = frozenset()) -> str:
    if not rows:
        return '<p class="muted">Không có dữ liệu.</p>'
    th = ''.join(f'<th>{esc(h)}</th>' for h in head)
    body = ''.join('<tr>' + ''.join(
        f'<td class="num">{esc(c)}</td>' if i in num else (f'<td>{c}</td>' if isinstance(c, str) and c.startswith('<span class="badge')
                                                           else f'<td class="nowrap">{esc(c)}</td>' if i in nowrap
                                                           else f'<td>{esc(c)}</td>')
        for i, c in enumerate(r)) + '</tr>' for r in rows)
    return f'<div class="wrap"><table><thead><tr>{th}</tr></thead><tbody>{body}</tbody></table></div>'


def dashboard_html(con, projects: list[str], flags: list[dict], exps: list[dict], fragment: bool = False) -> str:
    """The local dashboard page; fragment=True drops the doctype/html/head/body wrapper for the
    claude.ai artifact copy (logs/scorecard-artifact.html), which the publisher wraps itself."""
    q = lambda sql, *a: con.execute(sql, a).fetchall()  # noqa: E731
    ph = ','.join('?' * len(projects))
    count = collections.Counter(f['status'] for f in flags)
    order = {'critical': 0, 'warning': 1, 'fixed': 2, 'good': 3, 'na': 4}
    hot = [f for f in sorted(flags, key=lambda f: (order[f['status']], f['category'])) if f['status'] in ('critical', 'warning', 'fixed')]
    tiles = ''.join(
        f'<div class="tile {f["status"]}"><div class="k">{esc(f["category"])} · {esc(f["kpi"])} · {esc(f["scope"])}</div>'
        f'<div class="v">{esc(f["text"])}</div>{badge(f["status"])}<div class="s">{esc(f["action"])}</div></div>' for f in hot)
    parts = [
        *([f'<title>Workflow scorecard</title><style>{DASHBOARD_CSS}</style><main lang="vi">'] if fragment else [
            '<!doctype html><html lang="vi"><head><meta charset="utf-8">',
            '<meta name="viewport" content="width=device-width, initial-scale=1">',
            f'<title>Workflow scorecard</title><style>{DASHBOARD_CSS}</style></head><body><main>']),
        '<div class="crumb">Workflow / scorecard</div><h1>Workflow scorecard</h1>',
        '<div class="tags">' + ''.join(f'<span class="tag">{esc(t)}</span>' for t in (
            f'cập nhật {now_iso()}', f'dự án: {", ".join(projects)}', 'số nhỏ = tín hiệu định hướng')) + '</div>',
        '<div class="stats">' + ''.join(
            f'<div class="stat st-{s}"><div class="k">{ICON[s]} {esc(STATUS_LABEL[s])}</div><div class="v">{count[s]}</div></div>'
            for s in ('critical', 'warning', 'fixed', 'good', 'na')) + '</div>',
        '<h2>Cần xử lý</h2>', f'<div class="tiles">{tiles}</div>' if tiles else '<p class="muted">Không có KPI đỏ hoặc vàng.</p>',
        '<h2>Tất cả KPI</h2>',
        html_table(['hạng mục', 'KPI', 'phạm vi', 'trạng thái', 'giá trị', 'n', 'ngưỡng'],
                   [[f['category'], f['kpi'], f['scope'], badge(f['status']), f['text'], f['n'], f['threshold']]
                    for f in sorted(flags, key=lambda f: (f['category'], order[f['status']], f['scope']))], {5}, {2, 6}),
        '<h2>Producer runner: mỗi slice</h2>',
        html_table(['project', 'slice', 'phase', 'e2e phút', 'lần dừng', 'phút chờ'],
                   q(f'''SELECT r.project, r.slice, r.phase, r.e2e_min,
                                (SELECT COUNT(*) FROM runner_stops s WHERE s.project=r.project AND s.slice=r.slice),
                                (SELECT ROUND(SUM(wait_min)) FROM runner_stops s WHERE s.project=r.project AND s.slice=r.slice)
                         FROM runner_slices r WHERE r.project IN ({ph}) ORDER BY 1, 2''', *projects), {3, 4, 5}),
        '<h2>check-slice: gate trước review</h2><p class="sub">Mỗi slice: số lần chạy, kết quả lần đầu và lần cuối, số lần trả về writer.</p>',
        html_table(STATIC_HEAD, static_rows(con, projects), {2, 5}),
        '<h2>Runner dừng theo lý do</h2>',
        html_table(['loại', 'lý do', 'lần', 'phút chờ'],
                   q(f'''SELECT category, reason, COUNT(*), ROUND(SUM(wait_min)) FROM runner_stops WHERE project IN ({ph})
                         GROUP BY 1, 2 ORDER BY 4 DESC''', *projects), {2, 3}),
        '<h2>Thí nghiệm đã đăng ký</h2><p class="sub">experiments.json: so trong cùng project, mỗi nhánh cần ≥5 slice.</p>',
        html_table(['project', 'chiều', 'nhánh', 'trước/sau', 'slice', 'không cần fix', 'median fix rounds', 'median e2e phút',
                    'owner finding', 'so được?'],
                   [[e['project'], e['dim'], e['arm'], e['side'], e['slices'], e['first_pass'], e['fix_median'], e['e2e_median'],
                     e['owners'], e['ready']] for e in registered_experiments(con)], {6, 7}),
        '<h2>Thí nghiệm theo cấu hình (S3)</h2><p class="sub">Chỉ so được khi trong cùng một project mỗi nhánh có ≥5 slice.</p>',
        html_table(['chiều', 'nhánh', 'slice', 'nhãn từ slice', 'project', 'qua review không cần fix', 'median fix rounds',
                    'median e2e phút', 'so được?'],
                   [[e['dim'], e['arm'], e['n'], e['own'], ', '.join(e['projects']), f"{e['first_pass']:.0%}", e['fix_median'],
                     e['e2e_median'], e['ready']] for e in exps], {2, 3, 6, 7}),
        '<h2>Gateway 7 ngày</h2>',
        html_table(['ngày', 'provider', 'calls', 'lỗi'],
                   q('''SELECT day, provider, SUM(calls), SUM(errors) FROM llm_daily
                        WHERE day IN (SELECT DISTINCT day FROM llm_daily ORDER BY day DESC LIMIT 7)
                        GROUP BY 1, 2 ORDER BY 1 DESC, 3 DESC'''), {2, 3}),
        '<h2>Slice</h2>',
        html_table(['project', 'slice', 'fix rounds', 'nguồn', 'verdict cuối', 'e2e phút', 'nguồn e2e'],
                   q(f'''SELECT project, slice, fix_rounds, fix_rounds_source, final_verdict, e2e_min, e2e_source FROM slices
                         WHERE project IN ({ph}) ORDER BY project, slice''', *projects), {2, 5}),
        '</main>' if fragment else '</main></body></html>',
    ]
    return '\n'.join(parts)


def write_outputs(con, projects: list[str], logs_dir: str = os.path.dirname(LATEST_REPORT)) -> list[str]:
    flags, exps = evaluate(con, projects), experiments(con, projects)
    weekly_dir = os.path.join(logs_dir, 'weekly')
    os.makedirs(weekly_dir, exist_ok=True)
    weekly = os.path.join(weekly_dir, f'scorecard-{datetime.now().strftime("%G-W%V")}.md')  # rewritten daily; last day wins
    dash = os.path.join(logs_dir, 'scorecard-dashboard.html')
    art = os.path.join(logs_dir, 'scorecard-artifact.html')  # the copy published to claude.ai on request
    with open(weekly, 'w') as fh:
        fh.write(scorecard_md(con, projects, flags, exps))
    with open(dash, 'w') as fh:
        fh.write(dashboard_html(con, projects, flags, exps))
    with open(art, 'w') as fh:
        fh.write(dashboard_html(con, projects, flags, exps, fragment=True))
    return [weekly, dash, art]

def new_reds(con, flags: list[dict], day: str) -> list[dict] | None:
    """Record today's KPI statuses and return the ones that turned red since the last earlier day
    (a KPI missing that day counts as new). None on the very first run: it only seeds the history,
    so the existing reds do not all fire at once. A rerun the same day never repeats an alert."""
    prev_day = con.execute('SELECT MAX(day) FROM flag_history WHERE day < ?', (day,)).fetchone()[0]
    prev = {(k, sc): st for k, sc, st in con.execute('SELECT kpi, scope, status FROM flag_history WHERE day=?', (prev_day,))}
    today = {(k, sc): st for k, sc, st in con.execute('SELECT kpi, scope, status FROM flag_history WHERE day=?', (day,))}
    con.execute('DELETE FROM flag_history WHERE day=?', (day,))
    for f in flags:
        con.execute('INSERT OR REPLACE INTO flag_history VALUES (?,?,?,?,?)', (day, f['kpi'], f['scope'], f['status'], f['text']))
    con.commit()
    if prev_day is None and not today:
        return None
    return [f for f in flags if f['status'] == 'critical'
            and prev.get((f['kpi'], f['scope'])) != 'critical' and today.get((f['kpi'], f['scope'])) != 'critical']


def alert_text(reds: list[dict]) -> str:
    """One line under 200 characters: what turned red, where, and the value."""
    parts = [f"{f['kpi']} {f['scope']} ({f['text']})" for f in reds]
    text = f"{len(reds)} ĐỎ mới: " + '; '.join(parts)
    return text if len(text) <= 190 else text[:187] + '…'


def notify(text: str, logs_dir: str = os.path.dirname(LATEST_REPORT)) -> bool:
    """A macOS notification (osascript), plus a line in logs/scorecard-alerts.log. SCORECARD_NOTIFY=0 turns
    the notification off; the log line is always written."""
    with open(os.path.join(logs_dir, 'scorecard-alerts.log'), 'a') as fh:
        fh.write(f'{now_iso()} {text}\n')
    if os.environ.get('SCORECARD_NOTIFY', '1') == '0':
        return False
    quoted = '"' + text.replace('\\', '\\\\').replace('"', '\\"') + '"'  # AppleScript string: no \u escapes
    script = f'display notification {quoted} with title "Workflow scorecard" subtitle "xem logs/scorecard-dashboard.html"'
    r = subprocess.run(['osascript', '-e', script], capture_output=True, text=True, timeout=20)
    return r.returncode == 0

# --------------------------------------------------------------------------- CLI


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--db', default=DB_PATH)
    sub = ap.add_subparsers(dest='cmd', required=True)
    sub.add_parser('snapshot')
    c = sub.add_parser('collect')
    c.add_argument('--project', action='append')
    c.add_argument('--no-tokens', action='store_true')
    r = sub.add_parser('report')
    r.add_argument('--project', action='append')
    r.add_argument('--out')
    sub.add_parser('join-check')
    w = sub.add_parser('scorecard')
    w.add_argument('--project', action='append')
    d = sub.add_parser('daily')
    d.add_argument('--project', action='append')
    d.add_argument('--no-tokens', action='store_true')
    a = ap.parse_args(argv)
    con = connect(a.db)
    projects = getattr(a, 'project', None) or active_projects()

    def step(name, fn):
        try:
            note = fn()
            log_step(con, name, True, note)
            print(f'{name}: {note}', file=sys.stderr)
        except Exception as e:  # a failed source never stops the others
            log_step(con, name, False, repr(e))
            print(f'{name}: FAILED {e!r}', file=sys.stderr)

    if a.cmd in ('snapshot', 'daily'):
        step('gateway', lambda: snapshot_gateway(con))
        step('orca', lambda: snapshot_orca(con))
    if a.cmd in ('collect', 'daily'):
        step('logs', lambda: collect_logs(con))
        for p in projects:
            step(f'collect {p}', lambda p=p: collect_project(con, p))
            if not a.no_tokens:
                step(f'tokens {p}', lambda p=p: collect_tokens(con, p))
    if a.cmd == 'join-check':
        print(join_check(con))
    if a.cmd == 'scorecard' or a.cmd == 'daily':
        for f in write_outputs(con, projects):
            print(f'scorecard: {f}', file=sys.stderr)
    if a.cmd == 'daily':
        def alert():
            reds = new_reds(con, evaluate(con, projects), datetime.now().strftime('%Y-%m-%d'))
            if reds is None:
                return 'seeded flag history (first run: no alert)'
            if not reds:
                return 'no new red'
            text = alert_text(reds)
            return f'{"notified" if notify(text) else "logged"}: {text}'
        step('alert', alert)
    if a.cmd in ('report', 'daily'):
        text = report(con, projects)
        out = getattr(a, 'out', None) or (LATEST_REPORT if a.cmd == 'daily' else None)
        if out:
            with open(out, 'w') as fh:
                fh.write(text)
            print(f'report: {out}', file=sys.stderr)
        else:
            print(text)
    return 0


if __name__ == '__main__':
    sys.exit(main())
