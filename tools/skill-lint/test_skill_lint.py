#!/usr/bin/env python3
"""Unit tests for skill_lint.py — run: python3 -m unittest test_skill_lint.py"""

import contextlib
import io
import json
import os
import shutil
import tempfile
import unittest

import skill_lint as sl


def skill_md(name, desc='Do the thing. Use when the user asks for the thing.', extra='', body=''):
    return f'---\nname: {name}\ndescription: >-\n  {desc}\n{extra}---\n\n# {name}\n\n{body}\n'


class Tree(unittest.TestCase):
    """A throwaway <agents>/skills tree with a template, so nothing real is read."""

    def setUp(self):
        self.home = tempfile.mkdtemp()
        self.root = os.path.join(self.home, 'agents', 'skills')
        os.makedirs(os.path.join(self.home, 'agents', 'tools'))  # marks <agents> as the agents checkout
        self.template = os.path.join(self.home, 'template')
        os.makedirs(os.path.join(self.template, '.cursor', 'skills', 'smoke-test'))
        self.write('smoke-test/SKILL.md', skill_md('smoke-test'), base=os.path.join(self.template, '.cursor', 'skills'))

    def tearDown(self):
        shutil.rmtree(self.home)

    def write(self, rel, text, base=None):
        path = os.path.join(base or self.root, rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, 'w') as fh:
            fh.write(text)
        return path

    def lint(self, *only, syntax=False, links=None):
        return sl.run(self.root, list(only) or None, syntax=syntax, link_dirs=links or [], templates=[self.template])

    def findings(self, report, skill):
        return [(f['severity'], f['check']) for r in report['skills'] if r['skill'] == skill for f in r['findings']]


class Frontmatter(Tree):
    def test_clean_skill(self):
        self.write('alpha/SKILL.md', skill_md('alpha'))
        r = self.lint()
        self.assertEqual(self.findings(r, 'alpha'), [])
        self.assertEqual(r['errors'], 0)

    def test_name_mismatch_and_format(self):
        self.write('alpha/SKILL.md', skill_md('Alpha--x'))
        checks = self.findings(self.lint(), 'alpha')
        self.assertEqual(checks.count(('ERROR', 'frontmatter')), 2)

    def test_missing_frontmatter(self):
        self.write('alpha/SKILL.md', '# alpha\n')
        self.assertIn(('ERROR', 'frontmatter'), self.findings(self.lint(), 'alpha'))

    def test_long_description(self):
        self.write('alpha/SKILL.md', skill_md('alpha', desc='Use when x. ' + 'y' * 1100))
        self.assertIn(('ERROR', 'description'), self.findings(self.lint(), 'alpha'))

    def test_folded_description_parsed_whole(self):
        fm = sl.parse_frontmatter('---\nname: a\ndescription: >-\n  one\n  two\nother: "q"\n---\n')
        self.assertEqual(fm, {'name': 'a', 'description': 'one two', 'other': 'q'})

    def test_trigger_needed_only_when_model_invoked(self):
        self.write('alpha/SKILL.md', skill_md('alpha', desc='Does the thing.'))
        self.write('beta/SKILL.md', skill_md('beta', desc='Does the thing.', extra='disable-model-invocation: true\n'))
        r = self.lint()
        self.assertIn(('WARN', 'description'), self.findings(r, 'alpha'))
        self.assertEqual(self.findings(r, 'beta'), [])

    def test_size(self):
        self.write('alpha/SKILL.md', skill_md('alpha', body='line\n' * 600))
        self.assertIn(('WARN', 'size'), self.findings(self.lint(), 'alpha'))


class References(Tree):
    def test_broken_link_and_anchored_path(self):
        body = ('See [guide](reference/guide.md) and [gone](reference/gone.md).\n'
                'Run `node ~/.agents/skills/alpha/scripts/run.mjs` or ~/.agents/skills/alpha/scripts/missing.mjs.\n')
        self.write('alpha/SKILL.md', skill_md('alpha', body=body))
        self.write('alpha/reference/guide.md', 'ok')
        self.write('alpha/scripts/run.mjs', 'export {}\n')
        sl_home = sl.HOME
        try:
            sl.HOME = self.home  # anchored ~/.agents/ maps to <agents>, the root's parent
            r = self.lint()
        finally:
            sl.HOME = sl_home
        msgs = [f['message'] for x in r['skills'] for f in x['findings']]
        self.assertEqual(len(msgs), 2, msgs)
        self.assertTrue(any('reference/gone.md' in m for m in msgs))
        self.assertTrue(any('missing.mjs' in m for m in msgs))

    def test_sibling_skill_resolves_in_template(self):
        body = '- `../smoke-test/SKILL.md` — runner.\n- `../nope-skill/SKILL.md`\n- `../smoke-test/missing.md`\n'
        self.write('alpha/reference/x.md', body)
        self.write('alpha/SKILL.md', skill_md('alpha'))
        r = self.lint()
        msgs = [f['message'] for x in r['skills'] for f in x['findings']]
        self.assertEqual(len(msgs), 1, msgs)  # unknown skill: not ours to check; missing file in a known one: ERROR
        self.assertIn('smoke-test/missing.md', msgs[0])

    def test_cursor_skills_path_maps_to_root(self):
        self.write('beta/SKILL.md', skill_md('beta'))
        self.write('beta/scripts/ok.mjs', '')
        self.write('alpha/SKILL.md', skill_md('alpha', body='`node .cursor/skills/beta/scripts/ok.mjs` and `.cursor/skills/beta/scripts/no.mjs`\n'))
        r = self.lint()
        self.assertEqual([c for c in self.findings(r, 'alpha')], [('ERROR', 'ref')])

    def test_placeholders_project_paths_and_skipped_dirs(self):
        body = ('`slices/S<nn>-*.md`, `T-Sxx/HANDOFF.json`, `evidence/review.md`, `docs/x.md`, '
                '`scripts/smoke/checks/a.js`, `https://x.y/z`\n')
        self.write('alpha/SKILL.md', skill_md('alpha', body=body))
        self.write('alpha/scripts/real.mjs', '')
        self.write('alpha/learnings/p/evidence/review.md', '[x](nope.md)')
        self.write('alpha/reference/brief-template.md', '[x](nope.md)')
        r = self.lint()
        sev = [s for s, _ in self.findings(r, 'alpha')]
        self.assertNotIn('ERROR', sev)
        self.assertNotIn('WARN', sev)
        self.assertEqual(sev.count('INFO'), 1)  # scripts/smoke/... : the skill has scripts/, so it is noted


    def test_fenced_example_links_and_unknown_installed_skill(self):
        body = ('```md\n- [Ordering](./src/ordering/CONTEXT.md)\n```\n- [<title>](link)\n'
                '`~/.agents/skills/not-installed/SKILL.md` and `~/.agents/skills/alpha/gone.md`\n')
        self.write('alpha/SKILL.md', skill_md('alpha', body=body))
        sl_home = sl.HOME
        try:
            sl.HOME = self.home
            got = self.findings(self.lint(), 'alpha')
        finally:
            sl.HOME = sl_home
        self.assertEqual(sorted(got), [('ERROR', 'ref'), ('WARN', 'ref')])


class Syntax(Tree):
    def test_python_and_node(self):
        self.write('alpha/SKILL.md', skill_md('alpha'))
        self.write('alpha/scripts/ok.py', 'x = 1\n')
        self.write('alpha/scripts/bad.py', 'def (:\n')
        self.write('alpha/scripts/bad.mjs', 'export const = ;\n')
        self.write('alpha/scripts/ok.mjs', 'export const a = 1;\n')
        self.write('alpha/scripts/snippet.editor.js', 'const r = await Editor.Message.request("scene", "q");\n')
        files = sorted(f['file'] for r in self.lint(syntax=True)['skills'] for f in r['findings'] if f['check'] == 'syntax')
        expected = ['scripts/bad.py'] + (['scripts/bad.mjs'] if shutil.which('node') else [])
        self.assertEqual(files, sorted(expected))


class Run(Tree):
    def test_vendored_errors_do_not_fail(self):
        self.write('vend/SKILL.md', skill_md('other'))
        with open(os.path.join(os.path.dirname(self.root), '.skill-lock.json'), 'w') as fh:
            json.dump({'skills': {'vend': {}}}, fh)
        r = self.lint()
        self.assertEqual(r['errors'], 0)
        self.assertTrue(r['skills'][0]['vendored'])
        self.assertIn('vendored', sl.render(r))

    def test_dangling_install_link(self):
        links = os.path.join(self.home, 'links')
        os.makedirs(links)
        os.makedirs(self.root)
        os.symlink(os.path.join(self.home, 'gone'), os.path.join(links, 'gone'))
        os.symlink(self.template, os.path.join(links, 'ok'))
        r = sl.run(self.root, syntax=False, link_dirs=[links], templates=[])
        self.assertEqual(len(r['links']), 1)
        self.assertEqual(r['errors'], 1)

    def test_description_load_counts_model_invoked_only(self):
        self.write('alpha/SKILL.md', skill_md('alpha', desc='Use when a.'))
        self.write('beta/SKILL.md', skill_md('beta', desc='Use when bb.', extra='disable-model-invocation: true\n'))
        self.assertEqual(self.lint()['description_load_chars'], len('Use when a.'))

    def test_exit_code(self):
        self.write('alpha/SKILL.md', '# no frontmatter\n')
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(sl.main(['--root', self.root, '--no-syntax', 'alpha']), 1)


if __name__ == '__main__':
    unittest.main()
