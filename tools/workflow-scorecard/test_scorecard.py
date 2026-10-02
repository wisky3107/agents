import json
import os
import sqlite3
import subprocess
import tempfile
import unittest

import scorecard as sc


class Parsers(unittest.TestCase):
    def test_verdict_prefers_overall_line(self):
        text = 'F10 APPROVED for the fix.\n**Overall verdict: INFRA_BLOCKED. S01 cannot be APPROVED.**\n'
        self.assertEqual(sc.parse_verdict(text), 'INFRA_BLOCKED')

    def test_verdict_tagged_and_standalone(self):
        self.assertEqual(sc.parse_verdict('## VERDICT: CHANGES_REQUESTED\nlater APPROVED text'), 'CHANGES_REQUESTED')
        self.assertEqual(sc.parse_verdict('notes\n\n**APPROVED**\n'), 'APPROVED')
        self.assertIsNone(sc.parse_verdict('no verdict here'))

    def test_review_order(self):
        self.assertEqual(sc.order_reviews(['review-round2.md', 'review.md', 'review-round3.md']),
                         ['review.md', 'review-round2.md', 'review-round3.md'])
        self.assertEqual(sc.order_reviews(['review.md', 'review-round1.md', 'review-round2.md']),
                         ['review-round1.md', 'review-round2.md', 'review.md'])

    def test_fix_owners(self):
        text = ('## fix_routing\n\n| ids | owner | scope |\n|---|---|---|\n| F1 | code | a.ts |\n'
                '| F2, F3 | scene | main.scene |\n\n## Other\n| F9 | code | x |\n')
        self.assertEqual(dict(sc.fix_owners(text)), {'code': 1, 'scene': 1})

    def test_gates(self):
        text = 'ART2D: PASS\n**VERDICT**: **FAIL**\nCONCEPT: PASS — good\n'
        self.assertEqual(sc.parse_gates(text), [('ART2D', 'PASS'), ('VERDICT', 'FAIL'), ('CONCEPT', 'PASS')])

    def test_notes_fix_rounds(self):
        text = ('- 2026-09-24 S01 fleet merged fix_rounds=1 bump=none\n'
                '- 2026-09-26 S02-city-build: VERDICT APPROVED, fix_rounds=2 (+1)\n'
                '- 2026-09-25 director gate S03 — no rounds here\n')
        self.assertEqual(sc.notes_fix_rounds(text), {'S01': 1, 'S02': 2})

    def test_slice_of(self):
        self.assertEqual(sc.slice_of('T-S01 fix F1'), 'S01')
        self.assertEqual(sc.slice_of('Merge s10-rip-asset'), 'S10')
        self.assertEqual(sc.slice_of('S14a gate'), 'S14A')
        self.assertIsNone(sc.slice_of('TASK ROLE: review'))


class Orca(unittest.TestCase):
    def test_outcomes(self):
        r = lambda d: json.dumps(d)  # noqa: E731
        self.assertEqual(sc.task_outcome('failed', r({'subject': 'CHANGES_REQUESTED: x'}))[0], 'review_rejected')
        self.assertEqual(sc.task_outcome('failed', r({'reason': 'agent_prompt_stalled; superseded by y'}))[0], 'stalled')
        self.assertEqual(sc.task_outcome('failed', r({'reason': 'superseded: integrate failed'}))[0], 'superseded')
        self.assertEqual(sc.task_outcome('failed', r({'subject': 'BLOCKED at the human reload gate'}))[0], 'blocked')
        self.assertEqual(sc.task_outcome('failed', None)[0], 'failed')
        self.assertEqual(sc.task_outcome('completed', r({'subject': 'ok'})), ('completed', 'ok'))

    def test_roles(self):
        self.assertEqual(sc.task_role('TASK ROLE: review'), 'review')
        self.assertEqual(sc.task_role('T-S01 fix F1 scene rendering'), 'fix')
        self.assertEqual(sc.task_role('stray'), 'other')

    def test_project_paths(self):
        ps = ['cc-block-out-color-sort-puzzle', 'cc-block-out']
        self.assertEqual(sc.project_of_path(os.path.join(sc.WORKSPACES_ROOT, 'cc-lego-layers', 'wt'), ps), 'cc-lego-layers')
        self.assertEqual(sc.project_of_path(os.path.join(sc.GAMES_ROOT, 'cc-block-out'), ps), 'cc-block-out')
        self.assertIsNone(sc.project_of_path('/Users/x/orca/projects/learning', ps))
        self.assertEqual(sc.project_of_claude_dir('-Users-w-orca-workspaces-cc-block-out-S01-core', ps), 'cc-block-out')
        self.assertEqual(sc.project_of_claude_dir('-Users-w-Works-games-CocosCreator-cc-block-out-color-sort-puzzle', ps),
                         'cc-block-out-color-sort-puzzle')


class Attribution(unittest.TestCase):
    def test_rules(self):
        self.assertEqual(sc.classify_event({'fix_target': 'contract:Fable note', 'cause': 'scene broke'})[0], 'brief')
        self.assertEqual(sc.classify_event({'cause': "provider 'Bad Request: {model: x}'"})[0], 'gateway')
        self.assertEqual(sc.classify_event({'cause': 'codex sandbox cannot reach 127.0.0.1'})[0], 'agent')
        self.assertEqual(sc.classify_event({'cause': 'Set spread breaks only in the built game'})[0], 'ship')
        self.assertEqual(sc.classify_event({'event': 'budget_bump', 'cause': 'advisory guard above estimate'})[0], 'brief')
        self.assertEqual(sc.classify_event({'event': 'respawn'})[0], 'orca')
        self.assertEqual(sc.classify_event({'event': 'other'})[0], 'other')
        self.assertEqual(sc.classify_event({'system': 'agent:review', 'cause': 'scene broke'}), ('agent', 'written agent:review'))
        self.assertEqual(sc.classify_event({'system': 'bogus', 'event': 'respawn'})[0], 'orca')

    def test_learning_rows(self):
        self.assertTrue(sc.is_learning({'event': 'recipe_candidate'}))
        self.assertTrue(sc.is_learning({'kind': 'failure_fix'}))
        self.assertFalse(sc.is_learning({'event': 'fix_round'}))


class Gateway(unittest.TestCase):
    def test_hist(self):
        h = [0] * len(sc.BUCKETS)
        for s in (0.1, 3, 3, 3, 700):
            sc.hist_add(h, s)
        self.assertEqual(sc.hist_pct(h, .5), 4)
        self.assertEqual(sc.hist_pct(h, .95), float('inf'))
        self.assertIsNone(sc.hist_pct([0] * len(sc.BUCKETS), .5))

    def test_session_from_body(self):
        sid = '8aad2495-dbae-400d-89b1-b5231f731afa'
        body = {'requestBody': {'messages': [{'content': '"user_id":"fake"'}],
                                'metadata': {'user_id': json.dumps({'device_id': 'd', 'session_id': sid})}}}
        self.assertEqual(sc.session_from_body(json.dumps(body).encode()), sid)
        self.assertIsNone(sc.session_from_body(b'{"requestBody": {}}'))

    def test_snapshot_keeps_fuller_day(self):
        with tempfile.TemporaryDirectory() as d:
            omni = os.path.join(d, 'omni.sqlite')
            src = sqlite3.connect(omni)
            src.execute('CREATE TABLE call_logs (timestamp TEXT, status INTEGER, provider TEXT, model TEXT, '
                        'duration INTEGER, tokens_in INTEGER, tokens_out INTEGER)')
            rows = [('2026-10-01T01:00:00Z', 200, 'claude', 'm', 1000, 10, 1)] * 3 + \
                   [('2026-10-02T01:00:00Z', 500, 'claude', 'm', 2000, 10, 1)]
            src.executemany('INSERT INTO call_logs VALUES (?,?,?,?,?,?,?)', rows)
            src.commit()
            con = sc.connect(os.path.join(d, 'sc.sqlite'))
            sc.snapshot_gateway(con, omni, d, ['cc-x'])
            # retention drops two calls from the oldest day; the earlier, fuller snapshot must stay
            src.execute("DELETE FROM call_logs WHERE rowid IN (1, 2)")
            src.commit()
            sc.snapshot_gateway(con, omni, d, ['cc-x'])
            got = dict(con.execute('SELECT day, calls FROM llm_daily'))
            self.assertEqual(got, {'2026-10-01': 3, '2026-10-02': 1})
            self.assertEqual(con.execute('SELECT SUM(errors) FROM llm_daily').fetchone()[0], 1)


class Collect(unittest.TestCase):
    def test_project(self):
        with tempfile.TemporaryDirectory() as root:
            ev = os.path.join(root, '.cursor', 'evidence')
            t1 = os.path.join(ev, 'tasks', 'T-S01', 'evidence')
            os.makedirs(t1)
            with open(os.path.join(t1, 'review.md'), 'w') as fh:
                fh.write('## VERDICT: CHANGES_REQUESTED\n\n## fix_routing\n\n| ids | owner |\n|---|---|\n| F1 | code |\n')
            with open(os.path.join(t1, 'review-round2.md'), 'w') as fh:
                fh.write('**Verdict: APPROVED**\n')
            with open(os.path.join(t1, '2d-check.md'), 'w') as fh:
                fh.write('ART2D: FAIL\nART2D: PASS\n')
            lessons = [{'slice': 'S01', 'event': 'budget_bump', 'ratio': 2.5, 'fix_target': 'contract:x'},
                       {'slice': 'S02', 'event': 'budget_bump', 'ratio': 1.2, 'fix_target': 'contract:x'},
                       {'slice': 'S01', 'event': 'recipe_candidate', 'kind': 'failure_fix'}]
            with open(os.path.join(ev, 'lessons.jsonl'), 'w') as fh:
                fh.write('\n'.join(json.dumps(r) for r in lessons) + '\nnot json\n')
            with open(os.path.join(root, 'AGENT_NOTES.md'), 'w') as fh:
                fh.write('reviewer_agent: claude --model opus  # comment\n- 2026-09-24 S01 fleet merged fix_rounds=1\n')
            subprocess.run(['git', '-C', root, 'init', '-q'], check=True)
            for when, msg in (('2026-09-24T10:00:00Z', 'chore(producer): S01 PLAN'),
                              ('2026-09-24T12:30:00Z', 'Merge S01-core: done')):
                subprocess.run(['git', '-C', root, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q',
                                '--allow-empty', '-m', msg], check=True,
                               env=dict(os.environ, GIT_COMMITTER_DATE=when, GIT_AUTHOR_DATE=when))
            con = sc.connect(os.path.join(root, 'sc.sqlite'))
            sc.collect_project(con, 'cc-x', root)
            row = con.execute('SELECT review_rounds, first_verdict, final_verdict, fix_rounds, fix_rounds_source, '
                              'fix_owners, merged, budget_ratio FROM slices WHERE slice="S01"').fetchone()
            self.assertEqual(row, (2, 'CHANGES_REQUESTED', 'APPROVED', 1, 'AGENT_NOTES', '{"code": 1}', 1, 2.5))
            self.assertEqual(con.execute('SELECT e2e_min FROM slices WHERE slice="S01"').fetchone()[0], 150)
            self.assertEqual(con.execute('SELECT COUNT(*) FROM learnings').fetchone()[0], 1)
            self.assertEqual(con.execute("SELECT GROUP_CONCAT(result) FROM gates").fetchone()[0], 'FAIL,PASS')
            facts = dict(con.execute('SELECT key, value FROM project_facts'))
            self.assertEqual(json.loads(facts['reviewer_agent']), 'claude --model opus')
            report = sc.report(con, ['cc-x'])
            self.assertIn('contract:x', report)  # recurrence across S01 and S02


class E2E(unittest.TestCase):
    def test_merge_and_plan(self):
        log = [('c3', '2026-09-24T13:00:00+00:00', 'merge: S02 thing'),
               ('c2', '2026-09-24T12:00:00+00:00', "Merge branch 'me/S01-core'"),
               ('c1', '2026-09-24T10:00:00+00:00', 'chore(producer): pin study, S01 PLAN (branch A)')]
        m = sc.merges_and_e2e(log)
        self.assertEqual(m['S01']['e2e'], 120)
        self.assertIsNone(m['S02']['e2e'])


class Runner(unittest.TestCase):
    LOG = """2026-10-02T08:54:11.856Z runner: selected (fleet lane)
2026-10-02T09:05:23.683Z runner: blocked lane_blocked: fleet HANDOFF infra_blocked: Cursor not logged in
2026-10-02T10:28:15.952Z runner: answer q1 (lane_blocked): send this answer
2026-10-02T10:52:52.458Z runner: blocked unknown_status: fleet HANDOFF status "implementing"
2026-10-02T12:20:33.893Z runner: blocked coordinator_missing: coordinator gone
2026-10-02T12:43:55.452Z runner: answer q3 (coordinator_missing): taken over
2026-10-02T14:17:16.144Z runner: phase accept
2026-10-02T14:17:16.159Z runner: blocked approval_evidence: not APPROVED
2026-10-02T14:46:43.685Z runner: phase accept
"""

    def test_stops(self):
        st = sc.runner_stops(self.LOG)
        self.assertEqual([x['reason'] for x in st], ['lane_blocked', 'unknown_status', 'coordinator_missing', 'approval_evidence'])
        self.assertEqual([x['wait_min'] for x in st], [82.9, 87.7, 23.4, 29.5])
        self.assertEqual([x['answered'] for x in st], [True, False, True, False])
        self.assertEqual(st[0]['category'], 'lane')
        self.assertEqual(st[0]['detail'], 'fleet HANDOFF infra_blocked: Cursor not logged in')

    def test_open_stop(self):
        st = sc.runner_stops('2026-10-02T09:00:00Z runner: blocked fleet_gate: pick one')
        self.assertEqual((st[0]['category'], st[0]['wait_min'], st[0]['closed_at']), ('director', None, None))

    def test_slice(self):
        with tempfile.TemporaryDirectory() as d:
            with open(os.path.join(d, 'producer-state.json'), 'w') as fh:
                json.dump({'phase': 'done', 'lane': 'fleet', 'selected_at': '2026-10-02T08:54:11.845Z'}, fh)
            with open(os.path.join(d, 'merge-journal.json'), 'w') as fh:
                json.dump({'fix_rounds': 2, 'steps': {'merge': {'done_at': '2026-10-02T14:47:14Z'},
                                                       'verify': {'status': 'verified'},
                                                       'worktree_rm': {'kept': 'dirty'},
                                                       'record': {'done_at': '2026-10-02T14:48:52.910Z'}}}, fh)
            rs = sc.runner_slice(d)
            self.assertEqual((rs['e2e_min'], rs['fix_rounds'], rs['verify'], rs['worktree_kept']), (355, 2, 'verified', 'dirty'))
            self.assertIsNone(sc.runner_slice(os.path.join(d, 'missing')))

    def test_blocked_superseded(self):
        self.assertEqual(sc.task_outcome('blocked', json.dumps({'reason': 'Superseded: spec predated decision'}))[0], 'superseded')
        self.assertEqual(sc.task_outcome('blocked', None)[0], 'blocked')

    def test_logs(self):
        with tempfile.TemporaryDirectory() as d:
            proj = os.path.join(sc.GAMES_ROOT, 'cc-x')
            spawns, guard = os.path.join(d, 's.jsonl'), os.path.join(d, 'g.jsonl')
            with open(spawns, 'w') as fh:
                fh.write(json.dumps({'ts': 't1', 'project': proj, 'role': 'coordinator', 'slice': 'S08',
                                     'agentSpec': 'codex', 'handle': 'h1'}) + '\n')
            with open(guard, 'w') as fh:
                for v in ('allow', 'allow', 'block'):
                    fh.write(json.dumps({'ts': '2026-10-02T10:00:00Z', 'project': proj, 'role': 'coordinator',
                                         'cli': 'codex', 'mode': 'shadow', 'verdict': v}) + '\n')
            old = sc.SPAWN_REGISTRY, sc.GUARD_LOG
            sc.SPAWN_REGISTRY, sc.GUARD_LOG = spawns, guard
            try:
                con = sc.connect(os.path.join(d, 'sc.sqlite'))
                sc.collect_logs(con, ['cc-x'])
            finally:
                sc.SPAWN_REGISTRY, sc.GUARD_LOG = old
            self.assertEqual(con.execute('SELECT project, role, agent FROM spawns').fetchall(), [('cc-x', 'coordinator', 'codex')])
            self.assertEqual(dict(con.execute('SELECT verdict, count FROM guard')), {'allow': 2, 'block': 1})


class S1Sources(unittest.TestCase):
    def test_ship_infra_agents(self):
        with tempfile.TemporaryDirectory() as root:
            ev = os.path.join(root, '.cursor', 'evidence')
            t = os.path.join(ev, 'tasks', 'T-S02', 'evidence')
            os.makedirs(t)
            with open(os.path.join(t, 'stats.json'), 'w') as fh:
                json.dump({'fix_rounds': 1, 'review_rounds': 2,
                           'agents': {'implement': 'claude --model opus', 'review': 'cursor --model auto'}}, fh)
            with open(os.path.join(ev, 'ship-log.jsonl'), 'w') as fh:
                fh.write(json.dumps({'at': 'a1', 'step': 'build', 'ok': True, 'exit': 0, 'sec': 40, 'sha': 'abc', 'size_kib': 9000, 'url': ''}) + '\n')
                fh.write(json.dumps({'at': 'a2', 'step': 'deploy', 'ok': False, 'exit': 1, 'sec': 5, 'sha': 'abc', 'size_kib': None, 'url': ''}) + '\n')
            with open(os.path.join(ev, 'infra-log.jsonl'), 'w') as fh:
                fh.write(json.dumps({'at': 'b1', 'checkout': '/wt', 'task': 'T-S02', 'ms': 300,
                                     'funplay': {'reachable': True, 'parity': True}}) + '\n')
                fh.write(json.dumps({'at': 'b2', 'checkout': '/wt', 'task': 'T-S02', 'ms': 900,
                                     'funplay': {'reachable': False, 'parity': False}, 'orca': {'available': True}}) + '\n')
            con = sc.connect(os.path.join(root, 'sc.sqlite'))
            sc.collect_project(con, 'cc-x', root)
            self.assertEqual(con.execute('SELECT review_rounds, fix_rounds, reviewer FROM slices WHERE slice="S02"').fetchone(),
                             (2, 1, 'cursor --model auto'))
            self.assertEqual(dict(con.execute('SELECT role, agent FROM slice_agents')),
                             {'implement': 'claude --model opus', 'review': 'cursor --model auto'})
            self.assertEqual(con.execute('SELECT step, ok FROM ship ORDER BY at').fetchall(), [('build', 1), ('deploy', 0)])
            self.assertEqual(con.execute('SELECT funplay_reachable, funplay_parity, orca FROM infra ORDER BY at').fetchall(),
                             [(1, 1, None), (0, 0, 1)])
            report = sc.report(con, ['cc-x'])
            self.assertIn('| cc-x | deploy | 1 | 0/1 (0%)', report)
            self.assertIn('| cc-x | 2 | 1 | 1/2 (50%) | 1 |', report)


class S2S3(unittest.TestCase):
    def test_judge(self):
        self.assertEqual(sc.judge('orca.task_fail', 0.2, 50), 'critical')
        self.assertEqual(sc.judge('orca.task_fail', 0.1, 50), 'warning')
        self.assertEqual(sc.judge('orca.task_fail', 0.01, 50), 'good')
        self.assertEqual(sc.judge('orca.task_fail', 0.5, 3), 'na')  # below min n
        self.assertEqual(sc.judge('agent.first_pass', 0.2, 6), 'critical')
        self.assertEqual(sc.judge('agent.first_pass', 0.4, 6), 'warning')
        self.assertEqual(sc.judge('memory.promotion', 0.0, 57), 'warning')  # yellow-only KPI

    def test_short_agent(self):
        self.assertEqual(sc.short_agent('claude --model opus --effort high'), 'claude opus')
        self.assertEqual(sc.short_agent('task_b7 (opencode deepseek-v4.1-flash)'), 'opencode deepseek-v4.1-flash')
        self.assertEqual(sc.short_agent('opencode --model opencode-go/deepseek-v4.1-flash'), 'opencode deepseek-v4.1-flash')
        self.assertEqual(sc.short_agent('antigravity'), 'antigravity')
        self.assertIsNone(sc.short_agent(''))

    def _db(self, d, rows):
        con = sc.connect(os.path.join(d, 'sc.sqlite'))
        for p, s, fr, review in rows:
            con.execute('INSERT INTO slices (project, slice, review_rounds, fix_rounds) VALUES (?,?,?,?)', (p, s, 1, fr))
            con.execute('INSERT INTO slice_agents VALUES (?,?,?,?)', (p, s, 'review', review))
        con.commit()
        return con

    def test_experiment_needs_same_project(self):
        with tempfile.TemporaryDirectory() as d:
            # each reviewer only ever ran in its own project: a project comparison, not a config one
            rows = [('cc-a', f'S{i:02}', 0, 'claude --model opus') for i in range(5)] + \
                   [('cc-b', f'S{i:02}', 1, 'cursor --model auto') for i in range(5)]
            exps = sc.experiments(self._db(d, rows), ['cc-a', 'cc-b'])
            rev = [e for e in exps if e['dim'] == 'reviewer']
            self.assertEqual({e['arm'] for e in rev}, {'claude opus', 'cursor auto'})
            self.assertTrue(all(e['ready'].startswith('chưa (mỗi nhánh') for e in rev))
            self.assertEqual({e['arm']: e['own'] for e in rev}, {'claude opus': 5, 'cursor auto': 5})

    def test_experiment_ready(self):
        with tempfile.TemporaryDirectory() as d:
            rows = [('cc-a', f'S{i:02}', 0, 'claude --model opus') for i in range(5)] + \
                   [('cc-a', f'S{i:02}', 2, 'cursor --model auto') for i in range(5, 10)]
            rev = [e for e in sc.experiments(self._db(d, rows), ['cc-a']) if e['dim'] == 'reviewer']
            self.assertTrue(all(e['ready'] == 'có' for e in rev))
            got = {e['arm']: (e['first_pass'], e['fix_median']) for e in rev}
            self.assertEqual(got, {'claude opus': (1.0, 0), 'cursor auto': (0.0, 2)})

    def test_outputs(self):
        with tempfile.TemporaryDirectory() as d:
            con = self._db(d, [('cc-a', 'S01', 3, 'claude --model opus')])
            con.execute("INSERT INTO llm_daily VALUES ('2026-10-01','agy','m','',300,30,0,0,0,0,'[]','[]',0)")
            con.commit()
            flags = sc.evaluate(con, ['cc-a'])
            gw = [f for f in flags if f['kpi'] == 'gateway.error_rate'][0]
            self.assertEqual((gw['status'], gw['scope']), ('critical', 'provider agy'))
            fp = [f for f in flags if f['kpi'] == 'agent.first_pass'][0]
            self.assertEqual(fp['status'], 'na')  # one slice < min n 5
            weekly, dash = sc.write_outputs(con, ['cc-a'], d)
            self.assertIn('gateway.error_rate', open(weekly).read())
            html_text = open(dash).read()
            self.assertIn('<title>Workflow scorecard</title>', html_text)
            self.assertIn('prefers-color-scheme: dark', html_text)
            self.assertIn('✖ ĐỎ', html_text)


if __name__ == '__main__':
    unittest.main()
