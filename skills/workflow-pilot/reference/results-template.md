# Pilot results entry (results.md)

Two sections per pilot, written in Vietnamese, appended to
`~/.agents/docs/plans/2026-10-01-coordinator-token-optimization/results.md`.

## At launch — `### Pilot N — <Sxx> <name> (<lane>), từ <UTC>`

One paragraph each:
- the purpose (general, token cost, memory trial, a named fix) and the contract commit;
- which recent workflow fixes it exercises for the first time;
- the config: runner pid and terminal, coordinator and its model, writer, reviewer, judge, autopilot, manual_required, memory mode, and pack size;
- the policy line decision.

## At merge — `### Pilot N — kết quả (<Sxx> merge <date UTC>)`

1. Merge, slice commit and bookkeeping commits; verify result; elapsed time, including any stopped time and why.
2. Review rounds, fix rounds, and the manual checks that were deferred.
3. Table, with the previous pilots as columns:

| Role | S01 (baseline) | S08 | S09 | … | <this slice> |
|---|---|---|---|---|---|
| fleet-orch | sessions / turns / context | … | … | … | … |
| fleet-worker | … | … | … | … | … plus verifier |
| producer (LLM) | … | … | … | … | judge calls |

4. Coordinator target: −40% vs S01. State the % against S01 and against the nearest
   comparable slices, and say why (turns versus context per turn).
5. Runner questions, one line each: id, kind, cause, who answered, and the answer. Mark the bad answers and why they were bad.
6. Incidents and fixes: symptom, cause, fix commit, and whether it is in failure-signatures.md.
7. Memory trial (when the mode is shadow or assist): pack delivered (path, items, tokens), ids cited per role, and whether a lesson prevented a known failure. Give a verdict: useful, redundant or irrelevant.
8. Lessons for slice authoring and for the workflow, one line each.

Commit only results.md (`docs(plan): pilot N …`). Do not push unless asked.
