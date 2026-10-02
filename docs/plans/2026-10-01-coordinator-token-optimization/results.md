# Pilot results (PLAN §7)

One row per pilot slice. Tokens are context tokens (cache read + cache write + fresh input) from
`tools/token-report` (`--project <slug> --since <slice start>`), per role. Baseline = the same
project's last comparable slice before the plan.

## cc-lego-stack

**Baseline**: S01 (L, fleet). Producer: codex gpt-6-luna-high. Coordinator: codex. Source: token-report from 2026-09-24, slice attribution.

| Role | Sessions | Turns | Context tokens |
|---|---|---|---|
| producer (LLM) | 1 | 1025 | 145.9M |
| fleet-orch | 1 | 191 | 24.8M |
| fleet-worker (claude + codex) | 15 | 1072 | 225.0M |

Project totals 2026-09-24 → 2026-10-02: producer 167.9M (27%), fleet-orch 196.7M (31%), fleet-worker 225.0M (36%).

| Pilot | Slice | Size / lane | Setup | Producer tokens | Fleet-orch tokens | Runner stops (blocked / human / LLM) | Notes |
|---|---|---|---|---|---|---|---|
| 1 | S08 | L / fleet | `producer_mode: runner`, no judge, guard `shadow`, M1 roles + M3 cheatsheets live (master f5fc21e) | | | | started 2026-10-02 |
