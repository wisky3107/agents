#!/usr/bin/env python3
"""Token report for the Cocos producer / fleet pipeline (plan M0).

Reads Claude Code transcripts and Codex sessions (optionally OmniRoute) and reports, per role:
sessions, turns, context tokens, first-turn context, output, behaviour counts, and the
wait / mechanical / overhead / judgement split of coordinator turns.

Cost model: almost all spend is cache-read input, so cost ~= turns x context size. "Context"
of a turn = every input token of that API call (cache read + cache write + fresh input).

Stdlib only. Timestamps are compared as UTC ISO strings (`--since 2026-09-24` works).
"""

from __future__ import annotations

import argparse
import collections
import glob
import json
import os
import re
import sqlite3
import statistics
import sys
from datetime import datetime, timedelta, timezone

HOME = os.path.expanduser('~')
CLAUDE_GLOB = os.path.join(HOME, '.claude', 'projects', '**', '*.jsonl')
CODEX_GLOB = os.path.join(HOME, '.codex', 'sessions', '**', '*.jsonl')
OMNI_DB = os.path.join(HOME, '.omniroute', 'storage.sqlite')
OMNI_LOGS = os.path.join(HOME, '.omniroute', 'call_logs')
SPAWN_REGISTRY = os.path.join(HOME, '.agents', 'logs', 'spawns.jsonl')
GUARD_LOG = os.path.join(HOME, '.agents', 'logs', 'coordinator-guard.jsonl')

ROLES = ['producer', 'fleet-orch', 'fleet-worker', 'slice-agent', 'helper', 'subagent', 'orca-boot-only', 'interactive']

# --------------------------------------------------------------------------- classification

BOOT_RE = re.compile(
    r'before performing any task in this session|agents\.md loaded|'
    r'read agents\.md at the repo root before doing anything else', re.I)
PASTE_RE = re.compile(r'</?pasted_content[^>]*>', re.I)
CODEX_PREAMBLE_RE = re.compile(r'^\s*(# AGENTS\.md instructions|<environment_context>|<user_instructions>|<INSTRUCTIONS>|<skills_instructions>|<permissions)', re.I)
CONTINUATION_RE = re.compile(r'^\s*continue work from the prior orca session', re.I)
TRANSCRIPT_PATH_RE = re.compile(r'(/[^\s`\'"]+\.jsonl)')

# v2: decided by the first *task* prompt (boot preamble, slash-command noise and paste wrappers
# removed). The role whose marker appears EARLIEST in the prompt wins: spawn prompts open with
# "You are the …", and later lines may name other roles (a fleet prompt cites game-producer files).
# Markers include body lines of the spawn templates, because prompts sent in chunks lose their head.
_YOU_ARE = r'you are (?!not\b)(?:the |a |an )?(?:[\w-]+ ){0,3}'
V2_RULES = [
    ('fleet-worker', re.compile(
        r'you are a dispatched worker|you are working inside orca, a multi-agent ide|' + _YOU_ARE + r'orca-fleet worker', re.I)),
    ('fleet-orch', re.compile(
        r'cocos[- ]orca[- ]fleet (orchestrator|coordinator)\b|' + _YOU_ARE + r'(fleet )?coordinator for\b|'
        r'fleet coordinator for slice|run the full fleet lifecycle|load the `?cocos-orca-fleet`? skill|'
        r'run the dag for this slice only|pointer plan docs/plans/|resume the existing (fleet )?run\b', re.I)),
    ('producer', re.compile(
        _YOU_ARE + r'game[- ]producer|resume (the )?(game-)?producer\b|<command-name>/game-producer|'
        r'run (the )?game-producer|act as (the )?game-producer|fresh producer run|'
        r'khởi động lại (game-)?producer|'
        r'you are coordinator only: never edit game files or slice files', re.I)),
    ('slice-agent', re.compile(
        r'implementing slice s\d+ as a single agent|you are the independent reviewer for slice|'
        r'you are the (writer|reviewer|planner)\b|writer and editor-lock', re.I)),
    # one-off lanes the producer spawns: rip analysts, slice studies, brief authors, gate recovery
    ('helper', re.compile(
        r'study-task\.md|analyst-task\.md|slice-study-prompt|' + _YOU_ARE + r'(game-)?brief author|'
        r'author the project contracts|' + _YOU_ARE + r'recovery agent', re.I)),
]

SLICE_RES = [
    re.compile(r'\b(?:running|for|implementing|reviewer for|fresh) slice (S\d{2}[a-z]?)\b', re.I),
    re.compile(r'\bslice (S\d{2}[a-z]?)\b', re.I),
    re.compile(r'\bT-(S\d{2}[a-z]?)\b'),
]
CWD_SLICE_RE = re.compile(r'/(s\d{2}[a-z]?)[-_]', re.I)
PROJECT_RES = [
    re.compile(r'/CocosCreator/([^/\s`\'"),]+)'),
    re.compile(r'/orca/workspaces/([^/\s`\'"),]+)/'),
]


def clean_prompt(text: str) -> str:
    return PASTE_RE.sub(' ', text or '').strip()


def first_task_prompt(user_texts: list[str]) -> str:
    """First user text that is a real task: not a boot preamble, slash-command echo or Codex preamble."""
    for raw in user_texts:
        t = clean_prompt(raw)
        if not t:
            continue
        low = t.lower()
        if t.startswith('<local-command') or t.startswith('<command-name>/model') or low.startswith('<command-message>model'):
            continue
        if CODEX_PREAMBLE_RE.match(t):
            continue
        if BOOT_RE.search(low[:400]) and len(t) < 1500:
            continue
        return t
    return ''


def _marker_role(text: str) -> str | None:
    head = text[:6000]
    best = None
    for role, rx in V2_RULES:
        m = rx.search(head)
        if m and (best is None or m.start() < best[0]):
            best = (m.start(), role)
    return best[1] if best else None


def peek_user_texts(path: str, limit: int = 8, max_lines: int = 600) -> list[str]:
    """First user texts of a transcript (Claude or Codex), without reading the whole file."""
    texts: list[str] = []
    try:
        with open(path, errors='ignore') as fh:
            for i, line in enumerate(fh):
                if i >= max_lines or len(texts) >= limit:
                    break
                try:
                    e = json.loads(line)
                except ValueError:
                    continue
                if e.get('type') == 'user':
                    c = (e.get('message') or {}).get('content')
                    txt = ' '.join(x.get('text', '') for x in c if isinstance(x, dict) and x.get('type') == 'text') \
                        if isinstance(c, list) else (c or '')
                elif e.get('type') == 'response_item' and (e.get('payload') or {}).get('role') == 'user':
                    txt = ' '.join(x.get('text', '') for x in e['payload'].get('content') or [] if isinstance(x, dict))
                else:
                    continue
                if txt:
                    texts.append(txt[:8000])
    except OSError:
        pass
    return texts


def classify_v2(user_texts: list[str], path: str, _depth: int = 0) -> str:
    if '/subagents/' in path:
        return 'subagent'
    task = first_task_prompt(user_texts)
    if not task:
        joined = ' '.join(user_texts).lower()
        return 'orca-boot-only' if BOOT_RE.search(joined) else 'interactive'
    if CONTINUATION_RE.match(task):
        # Orca handoff to a new provider/session: inherit the role of the original transcript.
        m = TRANSCRIPT_PATH_RE.search(task)
        if m and _depth < 2 and os.path.exists(m.group(1)):
            inherited = classify_v2(peek_user_texts(m.group(1)), m.group(1), _depth + 1)
            if inherited not in ('interactive', 'orca-boot-only'):
                return inherited
        hint = re.search(r'last user prompt:(.{0,300})', task, re.I | re.S)
        return (_marker_role(hint.group(1)) if hint else None) or 'interactive'
    return _marker_role(task) or 'interactive'


def classify_baseline(first: str, path: str) -> str:
    """Copy of baseline-scripts/role2.py, kept so §0 of the plan stays reproducible.

    §0 was produced before role2.py gained its `orca-spawned(boot)` branch (the saved
    /tmp/omni/roles.json has no such role), so that branch folds into `interactive` here.
    """
    fl = first.lower()
    fl = fl.replace('before performing any task in this session', '').replace('agents.md loaded', '')
    if 'you are the game-producer' in fl or 'resume game-producer' in fl or ('game-producer' in fl and 'producer' in fl[:20000]):
        return 'producer'
    if 'cocos-orca-fleet orchestrator' in fl or 'orchestrator for' in fl:
        return 'fleet-orch'
    if 'dispatched worker' in fl:
        return 'fleet-worker'
    if 'writer and editor-lock' in fl or 'you are the writer' in fl or 'you are the reviewer' in fl or 'you are the planner' in fl:
        return 'slice-agent'
    if '/subagents/' in path:
        return 'subagent'
    return 'interactive'


def _norm_slice(s: str) -> str:
    return 'S' + s[1:3] + s[3:].lower()  # S14a stays S14a


def find_slice(task: str, cwd: str) -> str:
    for rx in SLICE_RES:
        m = rx.search(task[:4000])
        if m:
            return _norm_slice(m.group(1))
    m = CWD_SLICE_RE.search(cwd or '')
    return _norm_slice(m.group(1)) if m else ''


def find_project(cwd: str, task: str) -> str:
    for src in (cwd or '', task[:2000]):
        for rx in PROJECT_RES:
            m = rx.search(src)
            if m:
                return m.group(1)
    return os.path.basename((cwd or '').rstrip('/')) or '?'

# --------------------------------------------------------------------------- behaviour

ORCA_HELP_RE = re.compile(r'\borca\b[^\n;&|]*?(?:\s--help\b|\shelp\b)')
TERMINAL_READ_RE = re.compile(r'\borca\s+terminal\s+read\b')
CHECK_RE = re.compile(r'\borca\s+orchestration\s+check\b[^\n;&|]*')
GUIDE_FULL_RE = re.compile(r'\borca\s+skills\s+get\s+orchestration\b[^\n;&|]*--full')
SLEEP_RE = re.compile(r'\bsleep\s+(\d+)')
LOOP_SLEEP_RE = re.compile(r'\b(until|while)\b[^\n]*\bsleep\b|\bsleep\b[^\n]*\bdone\b', re.S)
SKILL_PATH_RE = re.compile(r'([\w./~-]*SKILL\.md)')
SHELL_READ_RE = re.compile(r'\b(cat|sed|head|tail|less|bat|nl|awk)\b')


def behaviour(call: dict) -> collections.Counter:
    """Counters for one tool call. call = {name, cmd, path}."""
    c = collections.Counter()
    cmd = call.get('cmd') or ''
    name = call.get('name') or ''
    if cmd:
        c['orca --help'] += len(ORCA_HELP_RE.findall(cmd))
        c['terminal read'] += len(TERMINAL_READ_RE.findall(cmd))
        for m in CHECK_RE.finditer(cmd):
            seg = m.group(0)
            if '--wait' in seg:
                c['check --wait'] += 1
            elif '--ack' in seg:
                c['check --ack (no wait)'] += 1
            else:
                c['check (no wait/ack)'] += 1
        c['guide --full'] += len(GUIDE_FULL_RE.findall(cmd))
        if any(int(n) > 30 for n in SLEEP_RE.findall(cmd)) or LOOP_SLEEP_RE.search(cmd):
            c['sleep>30 / sleep loop'] += 1
    return c


def skill_reads(call: dict) -> list[str]:
    name = call.get('name') or ''
    if name == 'Read' and (call.get('path') or '').endswith('SKILL.md'):
        return [call['path']]
    cmd = call.get('cmd') or ''
    if 'SKILL.md' in cmd and SHELL_READ_RE.search(cmd):
        return SKILL_PATH_RE.findall(cmd)
    return []

# --------------------------------------------------------------------------- turn classes

WAIT_RE = re.compile(
    r'\borca\s+terminal\s+(wait|read|list|show)\b|\borca\s+orchestration\s+(check|inbox|run-show|run-list|gate-list|task-list|worker-list)\b|'
    r'\bsleep\b|\btail\s+-f\b|HANDOFF\.json|orca-wait|\borca\s+status\b')
MECH_RE = re.compile(
    r'\bgit\b|\brsync\b|\bcp\b|\bmv\b|\bmkdir\b|close-editor|open-editor|probe\.mjs|bootstrap\.mjs|wait-mcp|'
    r'\borca\s+worktree\b|\bcurl\b|validate-[\w-]+\.mjs|brief-progress|orca-memory|clean_spec\.py|'
    r'\borca\s+terminal\s+(create|close)\b|producer-log\.md|lessons\.jsonl')
OVERHEAD_RE = re.compile(r'SKILL\.md|/reference/[\w.-]+\.md|\s--help\b|\borca\s+skills\s+get\b')
DECISION_SEND_RE = re.compile(r'approved\s*[—-]\s*commit|resume the cocos-orca-fleet coordinator loop', re.I)
MECH_FILES_RE = re.compile(r'(AGENT_NOTES\.md|producer-log\.md|lessons\.jsonl|HANDOFF\.json|producer-state\.json)$')

TURN_CLASSES = ['wait', 'overhead', 'mechanical', 'judgement']


def call_class(call: dict) -> str:
    name = call.get('name') or ''
    cmd = call.get('cmd') or ''
    path = call.get('path') or ''
    if name in ('Read', 'NotebookRead'):
        return 'overhead' if OVERHEAD_RE.search(path) else 'judgement'
    if name in ('Edit', 'Write', 'MultiEdit', 'NotebookEdit'):
        return 'mechanical' if MECH_FILES_RE.search(path) else 'judgement'
    if name in ('Monitor', 'ScheduleWakeup', 'TaskOutput', 'BashOutput', 'TodoWrite', 'TaskCreate', 'TaskUpdate',
                'wait', 'sleep'):  # Codex `wait` / `sleep` tools poll a running exec cell
        return 'wait'
    if name in ('Grep', 'Glob', 'Agent', 'Task', 'WebFetch', 'WebSearch', 'AskUserQuestion', 'Skill'):
        return 'judgement'
    if not cmd:
        return 'judgement'
    if re.search(r'\borca\s+orchestration\s+(ask|reply|send|gate-create|gate-resolve|task-create|dispatch)\b', cmd):
        return 'judgement'
    if re.search(r'\borca\s+terminal\s+send\b', cmd):
        return 'mechanical' if DECISION_SEND_RE.search(cmd) or len(cmd) < 220 else 'judgement'
    if OVERHEAD_RE.search(cmd) and not MECH_RE.search(cmd):
        return 'overhead'
    if WAIT_RE.search(cmd) and not MECH_RE.search(cmd):
        return 'wait'
    if MECH_RE.search(cmd) or WAIT_RE.search(cmd):
        return 'mechanical'
    return 'judgement'


def turn_class(turn: dict, short_text: str = 'wait') -> str:
    """short_text: class of a tool-less turn under 600 chars ("still running…"). The ceiling is
    sensitive to it, so turn_split reports both 'wait' and the strict 'judgement' variant."""
    calls = turn['calls']
    if not calls:
        return short_text if turn['text_len'] < 600 else 'judgement'
    kinds = {call_class(c) for c in calls}
    for k in ('judgement', 'mechanical', 'overhead'):
        if k in kinds:
            return k
    return 'wait'

# --------------------------------------------------------------------------- parsers


def norm_bound(value: str | None) -> str | None:
    """CLI date/time → UTC 'YYYY-MM-DDTHH:MM:SS.mmmZ', so plain string compares against transcript
    timestamps (which carry milliseconds) are exact. Naive values are taken as UTC."""
    if not value:
        return None
    dt = datetime.fromisoformat(value.strip().replace('Z', '+00:00'))
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    dt = dt.astimezone(timezone.utc)
    return dt.strftime('%Y-%m-%dT%H:%M:%S.') + f'{dt.microsecond // 1000:03d}Z'


def in_window(ts: str, since: str, until: str | None) -> bool:
    if not ts:
        return True
    if ts < since:
        return False
    return until is None or ts < until


def parse_claude(path: str, since: str, until: str | None) -> dict | None:
    msgs: dict[str, dict] = {}
    order: list[str] = []
    user_texts: list[str] = []
    first_baseline = ''
    cwd = ''
    sid = ''
    t0 = t1 = ''
    with open(path, errors='ignore') as fh:
        for line in fh:
            try:
                e = json.loads(line)
            except ValueError:
                continue
            ts = e.get('timestamp', '')
            cwd = cwd or e.get('cwd') or ''
            sid = sid or e.get('sessionId') or ''
            m = e.get('message') or {}
            txt = ''
            if e.get('type') == 'user':
                c = m.get('content')
                if isinstance(c, list):
                    txt = ' '.join(x.get('text', '') for x in c if isinstance(x, dict) and x.get('type') == 'text')
                else:
                    txt = c or ''
                # role comes from the file head, whatever the window (a cut-off producer stays a producer)
                if txt and len(user_texts) < 8:
                    user_texts.append(txt[:8000])
            if not in_window(ts, since, until):
                continue
            if e.get('type') == 'user':
                if txt and not txt.startswith('<local-command') and len(first_baseline) < 20000:
                    first_baseline += ' || ' + txt[:4000]
            elif e.get('type') == 'assistant' and m.get('usage'):
                mid = m.get('id') or e.get('uuid')
                if mid not in msgs:
                    msgs[mid] = {'ts': ts, 'u': m['usage'], 'calls': [], 'text_len': 0, 'out': 0}
                    order.append(mid)
                rec = msgs[mid]
                rec['out'] = max(rec['out'], m['usage'].get('output_tokens') or 0)
                for x in m.get('content') or []:
                    if not isinstance(x, dict):
                        continue
                    if x.get('type') == 'tool_use':
                        inp = x.get('input') or {}
                        rec['calls'].append({
                            'name': x.get('name'),
                            'cmd': inp.get('command') if isinstance(inp.get('command'), str) else '',
                            'path': inp.get('file_path') or inp.get('notebook_path') or '',
                        })
                    elif x.get('type') == 'text':
                        rec['text_len'] += len(x.get('text') or '')
                t0 = t0 or ts
                t1 = ts or t1
    if not msgs:
        return None
    turns = []
    for mid in order:
        r = msgs[mid]
        u = r['u']
        cr = u.get('cache_read_input_tokens') or 0
        cw = u.get('cache_creation_input_tokens') or 0
        inp = u.get('input_tokens') or 0
        turns.append({'ts': r['ts'], 'ctx': cr + cw + inp, 'cache_read': cr, 'cache_write': cw,
                      'out': r['out'], 'calls': r['calls'], 'text_len': r['text_len'], 'mid': mid})
    return {'source': 'claude', 'file': path, 'session_id': sid, 'cwd': cwd, 'start': t0, 'end': t1,
            'user_texts': user_texts, 'first_baseline': first_baseline, 'turns': turns}


def _codex_calls(payload: dict) -> list[dict]:
    t = payload.get('type')
    if t == 'custom_tool_call':
        return [{'name': payload.get('name') or 'exec', 'cmd': payload.get('input') or '', 'path': ''}]
    if t == 'function_call':
        args = payload.get('arguments') or ''
        cmd = args
        try:
            a = json.loads(args)
            if isinstance(a, dict):
                c = a.get('cmd') or a.get('command')
                cmd = ' '.join(c) if isinstance(c, list) else (c or args)
        except ValueError:
            pass
        return [{'name': payload.get('name') or 'function', 'cmd': cmd, 'path': ''}]
    if t == 'local_shell_call':
        c = (payload.get('action') or {}).get('command') or []
        return [{'name': 'shell', 'cmd': ' '.join(c) if isinstance(c, list) else str(c), 'path': ''}]
    return []


def parse_codex(path: str, since: str, until: str | None) -> dict | None:
    turns = []
    user_texts: list[str] = []
    cwd = sid = t0 = t1 = ''
    pending_calls: list[dict] = []
    pending_text = 0
    last_total = None
    with open(path, errors='ignore') as fh:
        for line in fh:
            try:
                e = json.loads(line)
            except ValueError:
                continue
            p = e.get('payload') or {}
            typ = e.get('type')
            if typ == 'session_meta':
                cwd = cwd or p.get('cwd') or ''
                sid = sid or p.get('id') or p.get('session_id') or ''
                continue
            ts = e.get('timestamp', '')
            if typ == 'response_item' and p.get('type') == 'message' and p.get('role') == 'user':
                txt = ' '.join(x.get('text', '') for x in p.get('content') or [] if isinstance(x, dict))
                if txt and len(user_texts) < 8:  # file head, whatever the window
                    user_texts.append(txt[:8000])
                continue
            if not in_window(ts, since, until):
                continue
            if typ == 'response_item':
                pt = p.get('type')
                if pt == 'message' and p.get('role') == 'assistant':
                    pending_text += sum(len(x.get('text', '')) for x in p.get('content') or [] if isinstance(x, dict))
                else:
                    pending_calls.extend(_codex_calls(p))
            elif typ == 'event_msg' and p.get('type') == 'token_count':
                info = p.get('info') or {}
                last = info.get('last_token_usage')
                total = (info.get('total_token_usage') or {}).get('total_tokens')
                if not last or total == last_total:
                    continue  # duplicate emission (rate-limit refresh) carries the same totals
                last_total = total
                inp = last.get('input_tokens') or 0
                cr = last.get('cached_input_tokens') or 0
                turns.append({'ts': ts, 'ctx': inp, 'cache_read': cr, 'cache_write': last.get('cache_write_input_tokens') or 0,
                              'out': last.get('output_tokens') or 0, 'calls': pending_calls, 'text_len': pending_text, 'mid': ''})
                pending_calls, pending_text = [], 0
                t0 = t0 or ts
                t1 = ts
    if not turns:
        return None
    return {'source': 'codex', 'file': path, 'session_id': sid, 'cwd': cwd, 'start': t0, 'end': t1,
            'user_texts': user_texts, 'first_baseline': '', 'turns': turns}

# --------------------------------------------------------------------------- joins (M1 registry, M2 guard log)


def _read_jsonl(path: str) -> list[dict]:
    out = []
    if not os.path.exists(path):
        return out
    with open(path, errors='ignore') as fh:
        for line in fh:
            try:
                out.append(json.loads(line))
            except ValueError:
                pass
    return out


def _iso_to_dt(ts: str) -> datetime | None:
    try:
        return datetime.fromisoformat(ts.replace('Z', '+00:00'))
    except (ValueError, AttributeError):
        return None


def registry_role(sess: dict, registry: list[dict], guard: dict[str, dict], used: set | None = None) -> dict | None:
    """Guard log (exact, by session_id) first; else the nearest UNUSED spawn-registry row in the same
    cwd that was written 0-300 s before the session's first turn. Rows are consumed one-to-one so a
    producer and a coordinator spawned in the same checkout cannot take each other's row."""
    g = guard.get(sess['session_id'])
    if g and g.get('CC_ROLE'):
        return {'role': g['CC_ROLE'], 'slice': g.get('CC_SLICE') or '', 'via': 'guard-log'}
    start = _iso_to_dt(sess['start'])
    if not start:
        return None
    used = set() if used is None else used
    best = None
    for i, r in enumerate(registry):
        if i in used:
            continue
        rts = _iso_to_dt(r.get('ts', ''))
        if not rts or not r.get('role'):
            continue
        same_place = sess['cwd'] and (sess['cwd'] == r.get('cwd') or sess['cwd'] == r.get('project'))
        dt = (start - rts).total_seconds()
        if same_place and 0 <= dt <= 300 and (best is None or dt < best[0]):
            best = (dt, i, r)
    if best:
        used.add(best[1])
        return {'role': best[2]['role'], 'slice': best[2].get('slice') or '', 'via': 'spawn-registry'}
    return None


def alias_role(role: str, cwd: str) -> str:
    """Launcher roles (M1 `--role`) → report roles. `worker` is a fleet worker inside an Orca
    feature worktree, otherwise a single-lane writer/reviewer in the main checkout."""
    if role == 'coordinator':
        return 'fleet-orch'
    if role == 'judge':
        # the producer runner's judge calls are producer cost (plan §1: the gate includes the judge)
        return 'producer'
    if role == 'worker':
        return 'fleet-worker' if '/orca/workspaces/' in (cwd or '') else 'slice-agent'
    return role

# --------------------------------------------------------------------------- OmniRoute


def key_label(name: str) -> str:
    """API key names stay out of reports (the repo is public); keep only the client family."""
    low = (name or '').lower()
    return 'claude' if 'claude' in low else 'codex' if 'codex' in low else 'other'


def omniroute_totals(since: str, until: str | None) -> dict:
    """Per-client totals from call_logs, with the table's coverage: call_logs keeps only ~7 days, so a
    window that starts earlier must be compared on the overlap only."""
    if not os.path.exists(OMNI_DB):
        return {}
    try:
        con = sqlite3.connect(f'file:{OMNI_DB}?mode=ro', uri=True, timeout=5)
        oldest = con.execute('select min(timestamp) from call_logs').fetchone()[0] or ''
        lo = max(since, oldest)
        q = ('select api_key_name, count(*), sum(tokens_in), sum(coalesce(tokens_cache_read,0)), '
             'sum(coalesce(tokens_cache_creation,0)), sum(tokens_out) from call_logs where timestamp >= ? ')
        args = [lo]
        if until:
            q += 'and timestamp < ? '
            args.append(until)
        q += 'group by 1'
        rows = con.execute(q, args).fetchall()
        con.close()
    except sqlite3.Error as err:
        return {'error': str(err)}
    agg: dict[str, collections.Counter] = collections.defaultdict(collections.Counter)
    for k, n, ti, cr, cw, to in rows:
        a = agg[key_label(k)]
        a['calls'] += n
        a['tokens_in'] += ti or 0
        a['cache_read'] += cr or 0
        a['cache_write'] += cw or 0
        a['out'] += to or 0
    return {'oldest_row': oldest, 'compared_from': lo, 'clients': {k: dict(v) for k, v in agg.items()}}


def mcp_group(name: str) -> str:
    if name.startswith('mcp__'):
        parts = name.split('__')
        return 'mcp:' + (parts[1] if len(parts) > 1 else '?')
    if 'funplay' in name:
        return 'mcp:funplay(?)'
    return 'builtin'


# JSON tool schemas tokenize at roughly 3.2-4 bytes per token. Logged request bodies do not carry the
# whole context, so a per-request tokens/bytes ratio is meaningless; report a range instead.
SCHEMA_BYTES_PER_TOKEN = (4.0, 3.2)


def schema_breakdown(since: str, until: str | None, sample: int) -> dict:
    """Tool-schema bytes per MCP server, from OmniRoute request bodies.

    Only the days OmniRoute still keeps bodies for, and that directory is live, so the sample (not the
    per-server sizes) changes between runs. Not filtered by --project (bodies carry no cwd)."""
    files = sorted(glob.glob(os.path.join(OMNI_LOGS, '*', '*.json')))
    files = [f for f in files if os.path.basename(os.path.dirname(f)) >= since[:10]
             and (until is None or os.path.basename(os.path.dirname(f)) <= until[:10])]
    if not files:
        return {'requests_with_tools': 0}
    step = max(1, len(files) // max(1, sample))
    sigs: dict[str, dict] = {}
    seen = 0
    scanned = 0
    for f in files[::step]:
        scanned += 1
        try:
            d = json.load(open(f))
        except (ValueError, OSError):
            continue
        rb = d.get('requestBody')
        if isinstance(rb, str):
            try:
                rb = json.loads(rb)
            except ValueError:
                rb = None
        if not isinstance(rb, dict) or not rb.get('tools'):
            continue
        s = d.get('summary') or {}
        tools = [t for t in rb['tools'] if isinstance(t, dict)]
        groups = collections.Counter()
        for t in tools:
            name = t.get('name') or (t.get('function') or {}).get('name') or ''
            groups[mcp_group(name)] += len(json.dumps(t))
        key = key_label(s.get('apiKeyName') or '')
        sig = key + '|' + ','.join(f'{g}:{round(b, -3)}' for g, b in sorted(groups.items()))
        rec = sigs.setdefault(sig, {'key': key, 'count': 0, 'groups': dict(groups), 'tools_bytes': sum(groups.values())})
        rec['count'] += 1
        seen += 1
    lo, hi = SCHEMA_BYTES_PER_TOKEN
    out = []
    for rec in sorted(sigs.values(), key=lambda r: -r['count'])[:8]:
        out.append({'key': rec['key'], 'requests': rec['count'], 'tools_bytes': rec['tools_bytes'],
                    'groups_bytes': rec['groups'],
                    'groups_tokens_est': {g: [round(b / lo), round(b / hi)] for g, b in rec['groups'].items()}})
    return {'files_in_window': len(files), 'files_scanned': scanned, 'requests_with_tools': seen,
            'bytes_per_token': list(SCHEMA_BYTES_PER_TOKEN), 'signatures': out}

# --------------------------------------------------------------------------- aggregation


def collect(args) -> list[dict]:
    registry = _read_jsonl(SPAWN_REGISTRY)
    guard = {}
    for g in _read_jsonl(GUARD_LOG):
        if g.get('session_id'):
            guard.setdefault(g['session_id'], g)
    since_ts = datetime.fromisoformat(args.since[:10]).replace(tzinfo=timezone.utc).timestamp() - 86400
    sessions = []
    sources = []
    if 'claude' in args.sources:
        sources += [('claude', f) for f in glob.glob(CLAUDE_GLOB, recursive=True)]
    if 'codex' in args.sources:
        sources += [('codex', f) for f in glob.glob(CODEX_GLOB, recursive=True)]
    for kind, f in sources:
        try:
            if os.path.getmtime(f) < since_ts:
                continue
        except OSError:
            continue
        s = parse_claude(f, args.since, args.until) if kind == 'claude' else parse_codex(f, args.since, args.until)
        if s:
            sessions.append(s)
    sessions.sort(key=lambda s: (s['start'], s['file']))
    used: set[int] = set()
    kept = []
    for s in sessions:
        task = first_task_prompt(s['user_texts'])
        s['role'] = classify_v2(s['user_texts'], s['file'])
        s['role_via'] = 'prompt-marker'
        s['role_baseline'] = classify_baseline(s['first_baseline'], s['file']) if s['source'] == 'claude' else ''
        s['slice'] = find_slice(task, s['cwd'])
        joined = registry_role(s, registry, guard, used)
        if joined:
            s['role'] = alias_role(joined['role'], s['cwd'])
            s['slice'] = joined['slice'] or s['slice']
            s['role_via'] = joined['via']
        s['project'] = find_project(s['cwd'], task)
        s['task_head'] = re.sub(r'\s+', ' ', task[:160])
        if args.project and args.project not in (s['cwd'] or '') and args.project != s['project']:
            continue
        kept.append(s)
    return kept


def dedupe_global(sessions: list[dict]) -> int:
    """Drop Claude turns whose message.id already appeared in an earlier file (resumed or forked
    sessions and copied subagent files repeat history). Sessions must be sorted by start; the earliest
    file keeps the turn. Returns the context tokens removed; empties sessions are dropped in place."""
    seen: set[str] = set()
    removed = 0
    for s in sessions:
        if s['source'] != 'claude':
            continue
        keep = []
        for t in s['turns']:
            if t['mid'] and t['mid'] in seen:
                removed += t['ctx']
                continue
            if t['mid']:
                seen.add(t['mid'])
            keep.append(t)
        s['turns'] = keep
    sessions[:] = [s for s in sessions if s['turns']]
    return removed


def summarize(sessions: list[dict], role_key: str = 'role') -> dict:
    g: dict[str, collections.Counter] = collections.defaultdict(collections.Counter)
    firsts: dict[str, list[int]] = collections.defaultdict(list)
    for s in sessions:
        a = g[s[role_key] or '?']
        a['sessions'] += 1
        a['turns'] += len(s['turns'])
        a['ctx'] += sum(t['ctx'] for t in s['turns'])
        a['cache_read'] += sum(t['cache_read'] for t in s['turns'])
        a['out'] += sum(t['out'] for t in s['turns'])
        firsts[s[role_key] or '?'].append(s['turns'][0]['ctx'])
    total = sum(a['ctx'] for a in g.values()) or 1
    rows = {}
    for r, a in sorted(g.items(), key=lambda x: -x[1]['ctx']):
        rows[r] = {'sessions': a['sessions'], 'turns': a['turns'], 'ctx': a['ctx'], 'share': a['ctx'] / total,
                   'avg_ctx': a['ctx'] // max(1, a['turns']), 'median_first_ctx': int(statistics.median(firsts[r])),
                   'out': a['out'], 'cache_read': a['cache_read']}
    return {'total_ctx': total, 'roles': rows}


def behaviour_table(sessions: list[dict]) -> dict:
    out: dict[str, collections.Counter] = collections.defaultdict(collections.Counter)
    for s in sessions:
        c = out[s['role']]
        seen_skill = collections.Counter()
        for t in s['turns']:
            if not t['calls'] and t['text_len']:
                c['text-only turns'] += 1
            for call in t['calls']:
                c.update(behaviour(call))
                for p in skill_reads(call):
                    seen_skill[os.path.basename(os.path.dirname(p)) or p] += 1
                    c['SKILL.md reads'] += 1
        c['SKILL.md re-reads'] += sum(n - 1 for n in seen_skill.values() if n > 1)
    return {r: dict(c) for r, c in out.items()}


def turn_split(sessions: list[dict], roles=('producer', 'fleet-orch')) -> dict:
    out = {}
    for role in roles:
        cnt = collections.Counter()
        ctx = collections.Counter()
        strict_judgement = 0
        for s in sessions:
            if s['role'] != role:
                continue
            for t in s['turns']:
                k = turn_class(t)
                cnt[k] += 1
                ctx[k] += t['ctx']
                if turn_class(t, short_text='judgement') == 'judgement':
                    strict_judgement += t['ctx']
        tot_turns = sum(cnt.values()) or 1
        tot_ctx = sum(ctx.values()) or 1
        out[role] = {k: {'turns': cnt[k], 'turn_share': cnt[k] / tot_turns, 'ctx': ctx[k], 'ctx_share': ctx[k] / tot_ctx}
                     for k in TURN_CLASSES}
        out[role]['replaceable_ctx_share'] = sum(ctx[k] for k in ('wait', 'overhead', 'mechanical')) / tot_ctx
        # same split with short tool-less turns ("still running…") counted as judgement: the lower bound
        out[role]['replaceable_ctx_share_strict'] = 1 - strict_judgement / tot_ctx
    return out


def slice_table(sessions: list[dict]) -> list[dict]:
    g: dict[tuple, collections.Counter] = collections.defaultdict(collections.Counter)
    for s in sessions:
        if s['role'] not in ('producer', 'fleet-orch', 'fleet-worker', 'slice-agent', 'helper') or not s['slice']:
            continue
        a = g[(s['project'], s['slice'], s['role'], s['source'])]
        a['sessions'] += 1
        a['turns'] += len(s['turns'])
        a['ctx'] += sum(t['ctx'] for t in s['turns'])
    return [{'project': p, 'slice': sl, 'role': r, 'source': src, **dict(a)}
            for (p, sl, r, src), a in sorted(g.items())]

# --------------------------------------------------------------------------- output


def fmt_tok(n: float) -> str:
    if n >= 1e9:
        return f'{n / 1e9:.2f}B'
    if n >= 1e6:
        return f'{n / 1e6:.1f}M'
    if n >= 1e3:
        return f'{n / 1e3:.1f}k'
    return str(int(n))


def print_roles(title: str, summ: dict) -> None:
    print(f'\n## {title} (total context {fmt_tok(summ["total_ctx"])})')
    print(f'{"role":22} {"sess":>5} {"turns":>7} {"context":>9} {"share":>6} {"avg ctx":>8} {"1st turn":>9} {"output":>7}')
    for r, a in summ['roles'].items():
        print(f'{r:22} {a["sessions"]:5} {a["turns"]:7} {fmt_tok(a["ctx"]):>9} {a["share"] * 100:5.1f}% '
              f'{fmt_tok(a["avg_ctx"]):>8} {fmt_tok(a["median_first_ctx"]):>9} {fmt_tok(a["out"]):>7}')


def print_report(rep: dict) -> None:
    print(f'# token-report  {rep["window"]["since"]} → {rep["window"]["until"] or "now"}'
          + (f'  project={rep["window"]["project"]}' if rep['window']['project'] else ''))
    for src, a in rep['by_source'].items():
        print(f'- source {src}: {a["sessions"]} sessions, {a["turns"]} turns, context {fmt_tok(a["ctx"])}')
    print('- source cursor: không đo được (Cursor auto không đi qua transcript Claude/Codex hay OmniRoute)')
    for src, summ in rep['roles_by_source'].items():
        print_roles(f'Roles v2 — {src}', summ)
    if rep.get('roles_baseline_claude'):
        print_roles('Roles theo classifier baseline (role2.py) — claude, để đối chiếu §0', rep['roles_baseline_claude'])
    if rep.get('reclassified'):
        print('\n## Baseline → v2 (claude, context)')
        for (a, b), v in rep['reclassified']:
            print(f'  {a:20} → {b:16} {v["sessions"]:4} sess  {fmt_tok(v["ctx"]):>8}')
    print('\n## Behaviour (tool calls)')
    keys = ['orca --help', 'terminal read', 'check (no wait/ack)', 'check --ack (no wait)', 'check --wait',
            'guide --full', 'sleep>30 / sleep loop', 'SKILL.md reads', 'SKILL.md re-reads', 'text-only turns']
    print(f'{"role":16} ' + ' '.join(f'{k[:12]:>12}' for k in keys))
    for r, c in sorted(rep['behaviour'].items()):
        print(f'{r:16} ' + ' '.join(f'{c.get(k, 0):12}' for k in keys))
    print('\n## Turn split (heuristic): wait / overhead / mechanical = script-replaceable, judgement = needs LLM')
    for role, d in rep['turn_split'].items():
        parts = '  '.join(f'{k} {d[k]["turns"]} turns ({d[k]["ctx_share"] * 100:.0f}% ctx)' for k in TURN_CLASSES)
        print(f'  {role:12} {parts}  → replaceable ≈ {d["replaceable_ctx_share_strict"] * 100:.0f}–'
              f'{d["replaceable_ctx_share"] * 100:.0f}% of context (strict–default)')
    if rep.get('slices'):
        print('\n## Per slice (coordination + lanes with a slice id)')
        for row in rep['slices']:
            print(f'  {row["project"]:28} {row["slice"]:4} {row["role"]:12} {row["source"]:6} '
                  f'{row["sessions"]:3} sess {row["turns"]:6} turns {fmt_tok(row["ctx"]):>8}')
    print(f'\n- dedupe message.id giữa các file (resume/fork/subagent copy): bỏ {fmt_tok(rep["cross_file_dupe_ctx"])} context')
    om = rep.get('omniroute')
    if om:
        print('\n## OmniRoute call_logs (đối chiếu tổng, không lọc theo --project)')
        if 'error' in om:
            print('  error:', om['error'])
        else:
            print(f'  call_logs có từ {om["oldest_row"]}; so sánh từ {om["compared_from"]}')
            for c, r in sorted(om['clients'].items()):
                tr_cr = rep['transcript_cache_read_overlap'].get(c)
                diff = f'  transcript {fmt_tok(tr_cr)} ({(r["cache_read"] - tr_cr) / tr_cr * 100:+.1f}% OmniRoute)' if tr_cr else ''
                print(f'  {c:8} calls={r["calls"]:6} in={fmt_tok(r["tokens_in"]):>8} '
                      f'cache_read={fmt_tok(r["cache_read"]):>8} out={fmt_tok(r["out"]):>7}{diff}')
    sb = rep.get('schema')
    if sb and sb.get('signatures'):
        print(f'\n## Tool schema theo MCP server (OmniRoute bodies, {sb["requests_with_tools"]} request mẫu '
              f'trên {sb["files_scanned"]} file đọc; thư mục body đang chạy nên mẫu đổi giữa các lần)')
        for sig in sb['signatures']:
            groups = ', '.join(f'{g} {b // 1024}KB ≈ {fmt_tok(sig["groups_tokens_est"][g][0])}–'
                               f'{fmt_tok(sig["groups_tokens_est"][g][1])} tok'
                               for g, b in sorted(sig['groups_bytes'].items(), key=lambda x: -x[1]))
            print(f'  [{sig["key"] or "?"}] {sig["requests"]} req, tools {sig["tools_bytes"] // 1024}KB: {groups}')


def build_report(args) -> dict:
    sessions = collect(args)
    claude_raw = [s for s in sessions if s['source'] == 'claude']
    # baseline classifier is only for reproducing §0, which deduped per file: summarize before the global dedupe
    baseline_summary = summarize(claude_raw, 'role_baseline') if claude_raw else None
    removed = dedupe_global(sessions)
    by_source = collections.defaultdict(collections.Counter)
    for s in sessions:
        a = by_source[s['source']]
        a['sessions'] += 1
        a['turns'] += len(s['turns'])
        a['ctx'] += sum(t['ctx'] for t in s['turns'])
    rep = {
        'window': {'since': args.since, 'until': args.until, 'project': args.project},
        'generated_at': datetime.now(timezone.utc).isoformat(timespec='seconds'),
        'by_source': {k: dict(v) for k, v in by_source.items()},
        'roles_by_source': {src: summarize([s for s in sessions if s['source'] == src]) for src in sorted(by_source)},
        'roles_all': summarize(sessions),
        'behaviour': behaviour_table(sessions),
        'turn_split': turn_split(sessions),
        'slices': slice_table(sessions),
        'cross_file_dupe_ctx': removed,
    }
    claude = [s for s in sessions if s['source'] == 'claude']
    if claude:
        rep['roles_baseline_claude'] = baseline_summary
        moves = collections.defaultdict(collections.Counter)
        for s in claude:
            if s['role_baseline'] != s['role']:
                v = moves[(s['role_baseline'], s['role'])]
                v['sessions'] += 1
                v['ctx'] += sum(t['ctx'] for t in s['turns'])
        rep['reclassified'] = sorted(((k, dict(v)) for k, v in moves.items()), key=lambda x: -x[1]['ctx'])
    if args.omniroute:
        om = omniroute_totals(args.since, args.until)
        rep['omniroute'] = om
        lo = om.get('compared_from') or args.since
        overlap = collections.Counter()
        for s in sessions:
            overlap[s['source']] += sum(t['cache_read'] for t in s['turns'] if in_window(t['ts'], lo, args.until))
        rep['transcript_cache_read_overlap'] = dict(overlap)
    if args.schema:
        rep['schema'] = schema_breakdown(args.since, args.until, args.schema_sample)
    if args.sessions:
        rep['sessions'] = [{k: s[k] for k in ('source', 'file', 'session_id', 'cwd', 'project', 'slice', 'role', 'role_via',
                                               'role_baseline', 'start', 'end', 'task_head')}
                           | {'turns': len(s['turns']), 'ctx': sum(t['ctx'] for t in s['turns'])} for s in sessions]
    return rep


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    default_since = (datetime.now(timezone.utc) - timedelta(days=7)).strftime('%Y-%m-%d')
    ap.add_argument('--since', default=default_since, help='UTC ISO date/time, inclusive (default: 7 days ago)')
    ap.add_argument('--until', default=None, help='UTC ISO date/time, exclusive (default: now)')
    ap.add_argument('--project', default=None, help='project slug or path substring of the session cwd')
    ap.add_argument('--sources', default='claude,codex', help='comma list: claude,codex')
    ap.add_argument('--omniroute', action='store_true', help='add OmniRoute call_logs totals per API key')
    ap.add_argument('--schema', action='store_true', help='tool-schema bytes per MCP server from OmniRoute bodies')
    ap.add_argument('--schema-sample', type=int, default=400)
    ap.add_argument('--sessions', action='store_true', help='include the per-session list in --json output')
    ap.add_argument('--json', action='store_true', help='print JSON instead of tables')
    ap.add_argument('--out', default=None, help='also write the JSON report to this path')
    args = ap.parse_args(argv)
    args.sources = {s.strip() for s in args.sources.split(',') if s.strip()}
    args.since, args.until = norm_bound(args.since), norm_bound(args.until)
    rep = build_report(args)
    if args.out:
        with open(args.out, 'w') as fh:
            json.dump(rep, fh, indent=1, default=str)
    if args.json:
        json.dump(rep, sys.stdout, indent=1, default=str)
        print()
    else:
        print_report(rep)
    return 0


if __name__ == '__main__':
    sys.exit(main())
