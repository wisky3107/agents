# token-report

Token report for the Cocos producer / fleet pipeline (plan
`docs/plans/2026-10-01-coordinator-token-optimization`, milestone M0). Python 3 stdlib only.

```bash
python3 ~/.agents/tools/token-report/token_report.py --since 2026-09-24 --until 2026-10-01T12:41:00Z
python3 ~/.agents/tools/token-report/token_report.py --project cc-lego-stack --omniroute
python3 ~/.agents/tools/token-report/token_report.py --since 2026-09-30 --schema --json --out /tmp/r.json
```

| Flag | Meaning |
|---|---|
| `--since` / `--until` | ISO date or time, normalised to UTC (naive = UTC); `since` inclusive, `until` exclusive (default: last 7 days → now) |
| `--project` | project slug (`cc-lego-stack`) or a substring of the session cwd |
| `--sources` | `claude,codex` (default both) |
| `--omniroute` | per-client totals from `~/.omniroute/storage.sqlite`, compared with transcripts over the period `call_logs` still covers (~7 days); not filtered by `--project` |
| `--schema` | tool-schema bytes per MCP server from OmniRoute request bodies (only days that kept bodies; the directory is live, so the sample varies); not filtered by `--project` |
| `--sessions` | add the per-session list to the JSON (contains prompt heads — keep it out of git) |
| `--json`, `--out` | JSON to stdout / to a file |

## What it measures

- **Context of a turn** = every input token of one API call (cache read + cache write + fresh input).
  Spend is almost all cache read, so cost ≈ turns × context.
- **Claude** (`~/.claude/projects/**/*.jsonl`, subagents included): one turn per `message.id`; Claude
  writes one entry per content block, so usage is deduplicated and output takes the largest value.
  A `message.id` is counted once across all files (resumed or forked sessions and copied subagent
  files repeat history); the earliest file keeps it.
- **Codex** (`~/.codex/sessions/**`): one turn per `token_count` event whose totals changed;
  tool calls attach to the next turn.
- **Cursor** is not measurable from these sources; the report says so instead of showing 0.

## Roles

Roles: `producer`, `fleet-orch`, `fleet-worker`, `slice-agent` (single-lane writer/reviewer),
`helper` (rip analysts, slice studies, brief authors, recovery agents), `subagent`, `orca-boot-only`,
`interactive`.

`v2` (default) uses, in order: the M2 guard log (`~/.agents/logs/coordinator-guard.jsonl`, by
`session_id`), the M1 spawn registry (`~/.agents/logs/spawns.jsonl`, same cwd, written 0–300 s
before the first turn, each row used once), then markers in the first task prompt **of the file**
(not of the window): boot preambles, `/model` echoes and paste wrappers are skipped, the earliest
marker wins, and an Orca "Continue work from the prior Orca session" handoff inherits the role of the
transcript it names. Env vars and terminal titles are never used (transcripts do not record them,
and agent CLIs rewrite titles).

The `baseline` classifier is the old `role2.py` logic, kept only to reproduce §0 of the plan (it is
summarised before the cross-file dedupe, as §0 was). It labels any session whose first 20k
characters mention `game-producer` as a producer, which pulls fleet orchestrators and interactive
sessions into that bucket.

## Turn split

Producer and fleet-orchestrator turns are split into `wait`, `overhead` (SKILL/reference reads,
`--help`), `mechanical` (git, rsync, editor scripts, spawns, state files) and `judgement` (reading
reviews or contracts, decisions, asks). The first three are what a script can replace. The ceiling
is printed as a range: `strict` counts short tool-less turns ("still running…") as judgement,
`default` counts them as waiting. It is a heuristic, not an exact measure.

## Tests

```bash
cd ~/.agents/tools/token-report && python3 -m unittest test_token_report.py
```
