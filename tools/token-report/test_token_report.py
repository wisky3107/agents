#!/usr/bin/env python3
"""Unit tests for token_report.py — run: python3 -m unittest test_token_report.py"""

import json
import os
import tempfile
import unittest

import token_report as tr

BOOT = ('Before performing any task in this session: 1. Find and read every AGENTS.md and .cursor/rules files '
        'that applies to the current workspace. 2. Run git status once.')
PRODUCER = ('You are the game-producer for the Cocos project at /Users/wikz/Works/games/CocosCreator/cc-x. '
            'Your shell cwd and Orca worktree MUST stay this project.')
FLEET = ('You are the cocos-orca-fleet orchestrator for /Users/wikz/Works/games/CocosCreator/cc-x, running slice S08. '
         'write the pointer PLAN per .cursor/skills/game-producer/reference/slice-to-plan.md')


def write_jsonl(rows):
    fd, path = tempfile.mkstemp(suffix='.jsonl')
    with os.fdopen(fd, 'w') as fh:
        for r in rows:
            fh.write(json.dumps(r) + '\n')
    return path


class ClassifyV2(unittest.TestCase):
    def test_boot_then_producer(self):
        self.assertEqual(tr.classify_v2([BOOT, PRODUCER], '/x.jsonl'), 'producer')

    def test_fleet_prompt_citing_producer_files_is_fleet(self):
        self.assertEqual(tr.classify_v2([BOOT, FLEET], '/x.jsonl'), 'fleet-orch')
        # the baseline classifier calls the same prompt a producer: that is the §0 skew
        self.assertEqual(tr.classify_baseline(' || ' + BOOT + ' || ' + FLEET, '/x.jsonl'), 'producer')

    def test_paste_wrapper_and_variants(self):
        self.assertEqual(tr.classify_v2(['<pasted_content id="ab"> ' + PRODUCER + ' </pasted_content>'], '/x'), 'producer')
        self.assertEqual(tr.classify_v2(['You are the NEW supervised cocos-orca-fleet coordinator for S01.'], '/x'), 'fleet-orch')
        self.assertEqual(tr.classify_v2(['You are the game producer for this project. Read and follow SKILL.md'], '/x'), 'producer')
        self.assertEqual(tr.classify_v2(['-v4.1-flash --auto`). Run the DAG for this slice only. Coordinator only'], '/x'), 'fleet-orch')
        # takeover / replacement prompts seen on cc-lego-stack 2026-10-01..02
        self.assertEqual(tr.classify_v2(['You are the NEW game-producer for /p. User explicitly requests replacing producer'], '/x'), 'producer')
        self.assertEqual(tr.classify_v2(['You are replacement coordinator for existing S01 and all-slices producer Run run_1.'], '/x'), 'fleet-orch')
        self.assertEqual(tr.classify_v2(['You are the game-brief author for this existing Cocos project.'], '/x'), 'helper')
        self.assertEqual(tr.classify_v2(['You are a documentation gate recovery agent in /p.'], '/x'), 'helper')
        # a producer prompt body that mentions "coordinator only" is still a producer
        self.assertEqual(tr.classify_v2([PRODUCER + ' You are coordinator only: never edit game files or slice files.'], '/x'), 'producer')
        # review round 1 findings
        self.assertEqual(tr.classify_v2(['You are the replacement S10 Cocos Orca Fleet coordinator for /p.'], '/x'), 'fleet-orch')
        self.assertEqual(tr.classify_v2(['You are an orca-fleet worker joining run_1 as implement.'], '/x'), 'fleet-worker')
        self.assertEqual(tr.classify_v2(['Khởi động lại Producer cho project này'], '/x'), 'producer')
        self.assertEqual(tr.classify_v2(['You are not the game-producer; just list the slices.'], '/x'), 'interactive')

    def test_lanes(self):
        self.assertEqual(tr.classify_v2(['You are working inside Orca, a multi-agent IDE. You are a dispatched worker.'], '/x'), 'fleet-worker')
        self.assertEqual(tr.classify_v2(['You are in the Cocos project at /p, implementing slice S04 as a single agent.'], '/x'), 'slice-agent')
        self.assertEqual(tr.classify_v2(['You are the independent reviewer for slice S04 in /p.'], '/x'), 'slice-agent')
        self.assertEqual(tr.classify_v2(['Read reference/x/rip-port/slices/S22/study-task.md in full'], '/x'), 'helper')

    def test_subagent_and_interactive(self):
        self.assertEqual(tr.classify_v2([PRODUCER], '/p/abc/subagents/agent-1.jsonl'), 'subagent')
        self.assertEqual(tr.classify_v2(['còn những phần nào chưa xong'], '/x'), 'interactive')
        self.assertEqual(tr.classify_v2([BOOT], '/x'), 'orca-boot-only')
        self.assertEqual(tr.classify_v2(['<command-name>/model</command-name>', 'giúp tôi sửa bug'], '/x'), 'interactive')

    def test_agents_md_boot_variant_is_skipped(self):
        boot2 = 'Read AGENTS.md at the repo root before doing anything else. Confirm you have loaded it.'
        self.assertEqual(tr.classify_v2([boot2, PRODUCER], '/x'), 'producer')

    def test_continuation_inherits_original_role(self):
        orig = write_jsonl([{'type': 'user', 'message': {'content': BOOT}},
                            {'type': 'user', 'message': {'content': PRODUCER}}])
        try:
            cont = f'Continue work from the prior Orca session using the context below. transcript: ```text {orig} ```'
            self.assertEqual(tr.classify_v2([cont], '/x'), 'producer')
        finally:
            os.unlink(orig)
        cont2 = ('Continue work from the prior Orca session. transcript /nonexistent/a.jsonl '
                 'Latest Orca status hints: Last user prompt: resume producer')
        self.assertEqual(tr.classify_v2([cont2], '/x'), 'producer')

    def test_slice_and_project(self):
        self.assertEqual(tr.find_slice(FLEET, ''), 'S08')
        self.assertEqual(tr.find_slice('', '/Users/wikz/orca/workspaces/cc-x/S01-polished-playable'), 'S01')
        self.assertEqual(tr.find_slice('running slice S14a now', ''), 'S14a')
        self.assertEqual(tr.find_project('/Users/wikz/orca/workspaces/cc-lego-stack/S01-a', ''), 'cc-lego-stack')
        self.assertEqual(tr.find_project('/Users/wikz/Works/games/CocosCreator/cc-x', ''), 'cc-x')
        self.assertEqual(tr.find_project('', 'project /Users/wikz/Works/games/CocosCreator/cc-monopoly-go (Cocos Creator 3.8)'),
                         'cc-monopoly-go')


class Behaviour(unittest.TestCase):
    def count(self, cmd, name='Bash', path=''):
        return tr.behaviour({'name': name, 'cmd': cmd, 'path': path})

    def test_help_read_check(self):
        c = self.count('orca orchestration check --help; orca terminal read --terminal t1 --limit 40')
        self.assertEqual(c['orca --help'], 1)
        self.assertEqual(c['terminal read'], 1)
        self.assertEqual(self.count('orca orchestration check --wait --types worker_done --timeout-ms 540000')['check --wait'], 1)
        self.assertEqual(self.count('orca orchestration check --ack d1 --wait --timeout-ms 1')['check --wait'], 1)
        self.assertEqual(self.count('orca orchestration check --ack d1 --json')['check --ack (no wait)'], 1)
        self.assertEqual(self.count('orca orchestration check --json')['check (no wait/ack)'], 1)
        self.assertEqual(self.count('ls --help')['orca --help'], 0)

    def test_guide_and_sleep(self):
        self.assertEqual(self.count('orca skills get orchestration --full')['guide --full'], 1)
        self.assertEqual(self.count('sleep 60')['sleep>30 / sleep loop'], 1)
        self.assertEqual(self.count('sleep 5')['sleep>30 / sleep loop'], 0)
        self.assertEqual(self.count('until curl -s x; do sleep 5; done')['sleep>30 / sleep loop'], 1)

    def test_skill_reads(self):
        self.assertEqual(tr.skill_reads({'name': 'Read', 'path': '/a/game-producer/SKILL.md'}), ['/a/game-producer/SKILL.md'])
        self.assertEqual(tr.skill_reads({'name': 'Bash', 'cmd': "sed -n '1,80p' .cursor/skills/x/SKILL.md"}),
                         ['.cursor/skills/x/SKILL.md'])
        self.assertEqual(tr.skill_reads({'name': 'Bash', 'cmd': 'git add SKILL.md'}), [])


class TurnClass(unittest.TestCase):
    def turn(self, calls, text_len=0):
        return {'calls': calls, 'text_len': text_len}

    def test_classes(self):
        wait = {'name': 'Bash', 'cmd': 'orca terminal wait --terminal t --for tui-idle --timeout-ms 540000'}
        mech = {'name': 'Bash', 'cmd': 'git -C /p merge --no-ff feat/S01'}
        over = {'name': 'Read', 'path': '/p/.cursor/skills/game-producer/SKILL.md'}
        judge = {'name': 'Read', 'path': '/p/.cursor/evidence/tasks/T-S01/evidence/review.md'}
        self.assertEqual(tr.turn_class(self.turn([wait])), 'wait')
        self.assertEqual(tr.turn_class(self.turn([wait, mech])), 'mechanical')
        self.assertEqual(tr.turn_class(self.turn([over])), 'overhead')
        self.assertEqual(tr.turn_class(self.turn([over, judge])), 'judgement')
        self.assertEqual(tr.turn_class(self.turn([], text_len=40)), 'wait')
        self.assertEqual(tr.turn_class(self.turn([], text_len=4000)), 'judgement')

    def test_terminal_send(self):
        nudge = {'name': 'Bash', 'cmd': 'orca terminal send --terminal t --text "approved — commit"'}
        decision = {'name': 'Bash', 'cmd': 'orca terminal send --terminal t --text "' + 'scope answer ' * 30 + '"'}
        self.assertEqual(tr.call_class(nudge), 'mechanical')
        self.assertEqual(tr.call_class(decision), 'judgement')
        self.assertEqual(tr.call_class({'name': 'Bash', 'cmd': 'orca orchestration ask --question "x"'}), 'judgement')

    def test_handoff_status_read_is_wait(self):
        cmd = "python3 -c 'import json;d=json.load(open(\"e/HANDOFF.json\"));print(d[\"status\"])'"
        self.assertEqual(tr.call_class({'name': 'Bash', 'cmd': cmd}), 'wait')

    def test_codex_wait_tool_and_strict_short_text(self):
        self.assertEqual(tr.call_class({'name': 'wait', 'cmd': '{"cell_id":"1","yield_time_ms":1000}'}), 'wait')
        self.assertEqual(tr.turn_class(self.turn([], text_len=40), short_text='judgement'), 'judgement')


class Parsers(unittest.TestCase):
    def test_claude_dedupes_message_id_and_keeps_max_output(self):
        usage = {'cache_read_input_tokens': 100, 'cache_creation_input_tokens': 10, 'input_tokens': 1, 'output_tokens': 2}
        usage2 = dict(usage, output_tokens=50)
        rows = [
            {'type': 'user', 'timestamp': '2026-09-25T00:00:00Z', 'cwd': '/p', 'sessionId': 's1', 'message': {'content': PRODUCER}},
            {'type': 'assistant', 'timestamp': '2026-09-25T00:00:01Z', 'message': {'id': 'm1', 'usage': usage,
             'content': [{'type': 'text', 'text': 'hi'}]}},
            {'type': 'assistant', 'timestamp': '2026-09-25T00:00:02Z', 'message': {'id': 'm1', 'usage': usage2,
             'content': [{'type': 'tool_use', 'name': 'Bash', 'input': {'command': 'orca terminal read'}}]}},
            {'type': 'assistant', 'timestamp': '2026-10-05T00:00:00Z', 'message': {'id': 'm2', 'usage': usage, 'content': []}},
        ]
        path = write_jsonl(rows)
        try:
            s = tr.parse_claude(path, '2026-09-24', '2026-10-01')
        finally:
            os.unlink(path)
        self.assertEqual(len(s['turns']), 1)
        t = s['turns'][0]
        self.assertEqual(t['ctx'], 111)
        self.assertEqual(t['out'], 50)
        self.assertEqual([c['cmd'] for c in t['calls']], ['orca terminal read'])
        self.assertEqual(s['session_id'], 's1')

    def test_codex_skips_duplicate_token_counts_and_attaches_calls(self):
        def tc(total, inp):
            return {'type': 'event_msg', 'timestamp': '2026-09-25T00:00:05Z', 'payload': {'type': 'token_count', 'info': {
                'total_token_usage': {'total_tokens': total},
                'last_token_usage': {'input_tokens': inp, 'cached_input_tokens': inp - 10, 'output_tokens': 3}}}}
        rows = [
            {'type': 'session_meta', 'timestamp': '2026-09-25T00:00:00Z', 'payload': {'id': 'c1', 'cwd': '/p'}},
            {'type': 'response_item', 'timestamp': '2026-09-25T00:00:01Z', 'payload': {'type': 'message', 'role': 'user',
             'content': [{'type': 'input_text', 'text': FLEET}]}},
            {'type': 'response_item', 'timestamp': '2026-09-25T00:00:02Z', 'payload': {'type': 'custom_tool_call', 'name': 'exec',
             'input': 'await tools.exec_command({cmd:"orca orchestration check --json"})'}},
            tc(100, 90), tc(100, 90), tc(250, 140),
        ]
        path = write_jsonl(rows)
        try:
            s = tr.parse_codex(path, '2026-09-24', None)
        finally:
            os.unlink(path)
        self.assertEqual([t['ctx'] for t in s['turns']], [90, 140])
        self.assertEqual(len(s['turns'][0]['calls']), 1)
        self.assertEqual(s['turns'][1]['calls'], [])
        self.assertEqual(tr.classify_v2(s['user_texts'], path), 'fleet-orch')


    def test_role_comes_from_file_head_whatever_the_window(self):
        usage = {'cache_read_input_tokens': 5, 'input_tokens': 1, 'output_tokens': 1}
        rows = [
            {'type': 'user', 'timestamp': '2026-09-20T00:00:00Z', 'message': {'content': PRODUCER}},
            {'type': 'user', 'timestamp': '2026-09-29T00:00:00Z', 'message': {'content': 'you hung, what happen?'}},
            {'type': 'assistant', 'timestamp': '2026-09-29T00:00:01Z', 'message': {'id': 'm9', 'usage': usage, 'content': []}},
        ]
        path = write_jsonl(rows)
        try:
            s = tr.parse_claude(path, '2026-09-28', None)
        finally:
            os.unlink(path)
        self.assertEqual(tr.classify_v2(s['user_texts'], path), 'producer')
        self.assertNotIn('game-producer', s['first_baseline'])  # baseline stays window-filtered, as role2.py did


class Window(unittest.TestCase):
    def test_norm_bound(self):
        self.assertEqual(tr.norm_bound('2026-09-24'), '2026-09-24T00:00:00.000Z')
        self.assertEqual(tr.norm_bound('2026-10-01T12:41:00Z'), '2026-10-01T12:41:00.000Z')
        self.assertEqual(tr.norm_bound('2026-10-01 19:41+07:00'), '2026-10-01T12:41:00.000Z')
        until = tr.norm_bound('2026-10-01T12:41:00Z')
        self.assertFalse(tr.in_window('2026-10-01T12:41:00.500Z', '2026-09-24', until))
        self.assertTrue(tr.in_window('2026-10-01T12:40:59.999Z', '2026-09-24', until))

    def test_dedupe_global_keeps_earliest_file(self):
        a = {'source': 'claude', 'turns': [{'mid': 'm1', 'ctx': 10}, {'mid': 'm2', 'ctx': 20}]}
        b = {'source': 'claude', 'turns': [{'mid': 'm1', 'ctx': 10}, {'mid': 'm3', 'ctx': 5}]}
        c = {'source': 'claude', 'turns': [{'mid': 'm2', 'ctx': 20}]}
        sessions = [a, b, c]
        self.assertEqual(tr.dedupe_global(sessions), 30)
        self.assertEqual([[t['mid'] for t in s['turns']] for s in sessions], [['m1', 'm2'], ['m3']])


class Registry(unittest.TestCase):
    def test_guard_log_wins_then_registry(self):
        sess = {'session_id': 's1', 'start': '2026-10-03T00:01:00Z', 'cwd': '/p'}
        self.assertEqual(tr.registry_role(sess, [], {'s1': {'CC_ROLE': 'producer', 'CC_SLICE': 'S02'}})['role'], 'producer')
        reg = [{'ts': '2026-10-03T00:00:30Z', 'cwd': '/p', 'role': 'coordinator', 'slice': 'S03'},
               {'ts': '2026-10-02T00:00:30Z', 'cwd': '/p', 'role': 'worker'}]
        got = tr.registry_role(sess, reg, {})
        self.assertEqual((got['role'], got['slice'], got['via']), ('coordinator', 'S03', 'spawn-registry'))
        self.assertIsNone(tr.registry_role(dict(sess, cwd='/q'), reg, {}))

    def test_rows_are_consumed_one_to_one(self):
        reg = [{'ts': '2026-10-03T00:00:00Z', 'cwd': '/p', 'role': 'producer'},
               {'ts': '2026-10-03T00:00:20Z', 'cwd': '/p', 'role': 'coordinator'}]
        used = set()
        first = tr.registry_role({'session_id': 'a', 'start': '2026-10-03T00:00:30Z', 'cwd': '/p'}, reg, {}, used)
        second = tr.registry_role({'session_id': 'b', 'start': '2026-10-03T00:00:40Z', 'cwd': '/p'}, reg, {}, used)
        self.assertEqual((first['role'], second['role']), ('coordinator', 'producer'))

    def test_alias_role(self):
        self.assertEqual(tr.alias_role('coordinator', '/p'), 'fleet-orch')
        self.assertEqual(tr.alias_role('worker', '/Users/wikz/orca/workspaces/cc-x/S01-a'), 'fleet-worker')
        self.assertEqual(tr.alias_role('worker', '/Users/wikz/Works/games/CocosCreator/cc-x'), 'slice-agent')
        self.assertEqual(tr.alias_role('judge', '/p'), 'producer')  # runner judge calls are producer cost
        self.assertEqual(tr.key_label('wikz-leap-codex-cli'), 'codex')


if __name__ == '__main__':
    unittest.main()
