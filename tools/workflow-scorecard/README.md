# workflow-scorecard

Scorecard for the Cocos producer / fleet pipeline (plan
`docs/plans/2026-10-02-workflow-effectiveness-tracking`, steps S0–S3). Python 3 stdlib only.
Read-only towards every source; a failed source is logged and skipped, never fatal.

```bash
python3 ~/.agents/tools/workflow-scorecard/scorecard.py daily                  # what launchd runs
python3 ~/.agents/tools/workflow-scorecard/scorecard.py snapshot               # OmniRoute + Orca only
python3 ~/.agents/tools/workflow-scorecard/scorecard.py collect --project cc-block-out [--no-tokens]
python3 ~/.agents/tools/workflow-scorecard/scorecard.py report --project cc-block-out --out /tmp/r.md
python3 ~/.agents/tools/workflow-scorecard/scorecard.py join-check
python3 ~/.agents/tools/workflow-scorecard/scorecard.py scorecard              # KPI flags, weekly file, dashboard
python3 -m unittest test_scorecard                                             # from this directory
```

Database: `~/.agents/logs/scorecard.sqlite` (`--db` or `SCORECARD_DB` to override). Outputs, all
rewritten by `daily`:

- `~/.agents/logs/scorecard-latest.md`: the full report, one section per system.
- `~/.agents/logs/weekly/scorecard-<YYYY>-W<ww>.md`: KPI flags (ĐỎ / VÀNG / XANH / chưa đủ dữ liệu),
  slices finished in the last 7 days, top recurring `fix_target`, configuration arms. Rewritten
  daily, so the file for a week keeps that week's last state.
- `~/.agents/logs/scorecard-dashboard.html`: the same as a local page (light and dark). Default projects: `DEFAULT_PROJECTS` in
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

## Thresholds and experiments

`THRESHOLDS` in `scorecard.py` holds `(warn, crit, direction, min_n)` per KPI, from plan §4. Below
`min_n` a KPI reads "chưa đủ dữ liệu" instead of a colour; `memory.promotion` is yellow-only.
`ACTIONS` is the step to take when a KPI is yellow or red.

`experiments()` groups slices by reviewer, writer and art backend. A slice's own label
(stats.json `agents`, the stats reviewer) wins over the AGENT_NOTES lock. A dimension reads
"so được" only when every arm has ≥5 slices **and** some project ran more than one arm; arms
that are just different projects compare projects, not configurations.

A slice's label comes from its own record first: stats.json `agents`, then the producer runner's
`spawned <role> term_… (<spec>, …)` lines in producer-log.md. A slice with neither takes the lock
that held when it finished: `experiments.json` records each switch (`project`, `dim`,
`switched_at`, `from`, `to`), so changing AGENT_NOTES never relabels older slices. Add an entry
whenever a lock changes for an experiment. When the lock goes back, set `ended_at` (UTC) and
`ended_note` on that entry instead of adding a reverse switch: slices finished after `ended_at`
leave the experiment, and the table shows "dừng sớm" if an arm is still under 5.

## Resolutions

`resolutions.json` records fixes: a runner stop reason, a project's `fix_target`, or budget bumps
measured by a broken counter, each with `fixed_by` and `fixed_at` (UTC). An occurrence before
`fixed_at` is corrected (`recount`) or left out of the KPI's residual. A red or yellow KPI takes the
residual's colour, or reads "ĐÃ SỬA · chờ xác nhận" when the residual is fine. A repeat after
`fixed_at` counts again, so a regression shows. Add an entry when a fix lands; never delete one.

Runner stops split into decisions (`director_gate`, `fleet_gate`: the director's time, KPI
`orca.director_wait_min`) and avoidable stops (everything else, KPI `orca.runner_avoidable_wait`);
only stops inside the slice's own window (`selected_at` → `record`) count toward its share.
OmniRoute's `connection-test` probes are kept out of the gateway error rate and feed
`gateway.dead_connections` instead.

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
