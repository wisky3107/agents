# workflow-scorecard

Scorecard for the Cocos producer / fleet pipeline (plan
`docs/plans/2026-10-02-workflow-effectiveness-tracking`, steps S0–S1). Python 3 stdlib only.
Read-only towards every source; a failed source is logged and skipped, never fatal.

```bash
python3 ~/.agents/tools/workflow-scorecard/scorecard.py daily                  # what launchd runs
python3 ~/.agents/tools/workflow-scorecard/scorecard.py snapshot               # OmniRoute + Orca only
python3 ~/.agents/tools/workflow-scorecard/scorecard.py collect --project cc-block-out [--no-tokens]
python3 ~/.agents/tools/workflow-scorecard/scorecard.py report --project cc-block-out --out /tmp/r.md
python3 ~/.agents/tools/workflow-scorecard/scorecard.py join-check
python3 -m unittest test_scorecard                                             # from this directory
```

Database: `~/.agents/logs/scorecard.sqlite` (`--db` or `SCORECARD_DB` to override).
Latest report: `~/.agents/logs/scorecard-latest.md`. Default projects: `DEFAULT_PROJECTS` in
`scorecard.py` (pilots cc-block-out and cc-lego-stack, plus cc-meowdoku and cc-monopoly-go).

## Sources

| Source | Read by | Notes |
|---|---|---|
| `~/.omniroute/storage.sqlite` `call_logs` | `snapshot` | Kept ~7 days. Stored per day/provider/model as sums plus duration and TTFT histograms. A day is replaced only when the new count is at least the stored one, so retention never shrinks a snapshot. `tokens_in` already includes cache read |
| `~/.omniroute/call_logs/<day>/*.json` | `snapshot` | Kept ~3 days. Only Claude bodies carry `metadata.user_id.session_id`; that joins calls to `~/.claude/projects/<dir>/<session>.jsonl` and so to a project |
| `orca orchestration run-list` / `task-list --run` | `snapshot` | Runs are re-read only when `updated_at` changes |
| `<project>/.cursor/evidence/tasks/T-S*/evidence/review*.md`, `stats.json`, `**/*check*.md` | `collect` | Verdicts, `fix_routing` owners, art gates |
| `<project>/.cursor/evidence/lessons.jsonl` | `collect` | Cost events (attributed to a system) and learning rows |
| `<project>/AGENT_NOTES.md`, `EXPECT_GAMEPLAY_VISUAL.md`, git log | `collect` | `fix_rounds=` notes, locked agents, GIVEN/ASSUMPTION tags, merges and producer PLAN commits |
| `<project>/.cursor/evidence/tasks/T-S*/producer-state.json`, `merge-journal.json`, `producer-log.md` | `collect` | Producer runner slices: e2e = `selected_at` → journal `record`, fix rounds, verify, and every runner stop (`blocked …` until the next `answer`/`blocked`/`phase`) with its wait in minutes. The runner makes no `chore(producer): Sxx PLAN` commit, so its timestamps replace the git e2e |
| `~/.agents/logs/spawns.jsonl`, `coordinator-guard.jsonl` | `collect` | Spawn registry (role, agent spec) and guard verdicts (in `shadow`, `block` = would have blocked) |
| token-report (`~/.agents/tools/token-report` or the `coordinator-token-opt` worktree) | `collect` | Tokens per project/slice/role; skipped when absent |
| `~/.orca-memory/pilot/hook-log.jsonl`, `cocos-playbook/registry.json` | `report` | Memory hooks, recipe statuses |

## Caveats

- Orca marks a CHANGES_REQUESTED review, a stalled dispatch and a task superseded by its retry all
  as `failed` (a superseded task can also be `blocked`). `task_outcome` splits them; only `stalled`
  and `failed` count against Orca.
- Lessons rows that carry `system` (S1) are taken as written; older rows go through the heuristic.
- `review.md` is often rewritten every round, so first pass uses `fix_rounds` when known
  (stats.json, then AGENT_NOTES, then lessons) and the review files only otherwise.
- `system` for old lessons rows is a keyword heuristic (`SYSTEM_RULES`); the matched rule is in
  `events.rule`. Step S1 of the plan adds an explicit `system` field.
- Small numbers are a directional signal, not a rate to compare across projects.

## Daily job

`launchd/com.agents.workflow-scorecard.plist` runs `daily` at 09:17 local (on wake if asleep),
logging to `~/.agents/logs/scorecard-daily.log`.

```bash
cp launchd/com.agents.workflow-scorecard.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.agents.workflow-scorecard.plist
launchctl kickstart gui/$(id -u)/com.agents.workflow-scorecard          # run now
launchctl bootout gui/$(id -u)/com.agents.workflow-scorecard            # remove
```
