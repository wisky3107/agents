# skill-lint

Static linter for the skills under `~/.agents/skills` and the links that install them
(`~/.claude/skills`, the templates' `.cursor/skills` and `.claude/skills`). Python 3 stdlib only.
Run it after editing a skill, before merging skill changes to master (projects symlink into it).

```bash
python3 ~/.agents/tools/skill-lint/skill_lint.py                 # every skill + install links
python3 ~/.agents/tools/skill-lint/skill_lint.py game-producer   # one skill (links skipped)
python3 ~/.agents/tools/skill-lint/skill_lint.py -v --no-syntax  # with INFO, without node/python/bash checks
python3 ~/.agents-wt/<branch>/tools/skill-lint/skill_lint.py     # a worktree lints its own skills/
```

Exit 1 when a skill this repo owns (or an install link) has an ERROR. Vendored skills (listed in
`.skill-lock.json`) are reported but never fail the run: fix them upstream.

| Check | Severity | What |
|---|---|---|
| `frontmatter` | ERROR | no `---` block; `name` missing, not 1-64 chars of a-z 0-9 and single inner hyphens, or not the folder name ([agentskills.io spec](https://agentskills.io/specification)) |
| `description` | ERROR / WARN | missing or over 1024 chars (ERROR); a model-invoked skill whose description never says when to use it (WARN) |
| `size` | WARN | SKILL.md over 500 lines: disclose reference into linked files |
| `ref` | ERROR | a markdown link, or a path into the skill system, that does not exist: `~/.agents/{skills,tools,bin,hooks}/…`, `${CLAUDE_SKILL_DIR}/…`, `.cursor/skills/<skill>/…`, `../<skill>/…`, `<skill>/…` |
| `ref` (outside skills) | WARN | an anchored `~/.agents/tools|bin|hooks/…` path that does not exist |
| `ref-unresolved` | INFO | `reference/…`, `scripts/…` in a skill that has that folder but not that file — usually a project path or another skill's file, so only shown with `-v` |
| `syntax` | ERROR | `node --check` (.mjs/.js/.cjs), `compile()` (.py), `bash -n` (.sh) |
| `link` | ERROR | a dangling install symlink |

Not checked: placeholders (`<slug>`, `S<nn>`, `T-Sxx`, `*`), URLs, project-relative paths
(`docs/…`, `evidence/…`), docs under `evidence/` or kit `files/` folders, and files named `*template*`
— they resolve inside a project, not here. A `../<skill>/…` path is resolved by skill name (projects
install every skill side by side), falling back to the templates for skills that live only there
(`smoke-test`, `ship`, `vibe-game-director`, …). Run from a worktree, a path under `~/.agents` also
counts when the main checkout has it (untracked shims such as `bin/pkill`).

The summary line also gives the **description load**: the characters of every model-invoked
description, which sit in each agent's context every turn.

Tests: `cd ~/.agents/tools/skill-lint && python3 -m unittest test_skill_lint.py`
