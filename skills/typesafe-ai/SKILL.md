---
name: typesafe-ai
description: Use TypeSafe System One models for bounded semantic decisions that code consumes, including classification, scoring, detection, routing, ranking, and verification. Use when a workflow needs typed judgments or confidence-aware routing; do not use it for generation, planning, deterministic calculations, authorization, or replacing an independent reviewer.
---

# TypeSafe AI

Use TypeSafe as a decision layer inside ordinary software. Code owns control flow and side
effects; Jev supplies narrow judgments over text or JSON state.

## Read current documentation

The live docs are authoritative because models, limits, SDKs, and response fields can change.

1. Read `https://docs.typesafe.ai/llms.txt`.
2. Read only the pages relevant to the task. Start with:
   - `https://docs.typesafe.ai/concepts/system-one.md`
   - `https://docs.typesafe.ai/concepts/how-to-build-with-system-one.md`
   - `https://docs.typesafe.ai/primitives.md`
   - `https://docs.typesafe.ai/confidence.md`
3. Before implementation, read the selected SDK/API page and the nearest cookbook.
4. Pin a versioned model after evaluation. Do not silently put `jev-latest` into production.

## Decide whether TypeSafe fits

Use it when the answer is a bounded semantic judgment:

| Need | Primitive |
|---|---|
| Exactly one option from a closed set | `Choice` |
| Probability that a condition holds | `Noul` |
| Position on ordered, independently described levels | `Score` |

Good fits include intent or skill suggestion, task/model routing, relevance ranking,
guardrails, evidence triage, and citation or artifact verification.

Keep generation, planning, code authoring, arithmetic, counting, date comparison, exact
lookups, permissions, and side effects outside TypeSafe. Use a generative model when the
answer space is open-ended.

## Design the request

- Put only relevant evidence in `state`; prefer named JSON fields for multi-part context.
- Ask one coherent judgment per question. Decompose broad ratings into independent factors.
- Write complete instructions and explicit criteria; question IDs are only code identifiers.
- Include `none` when no option may fit. Use separate Nouls when several labels may apply.
- Batch independent questions over the same state. Make speculative premises explicit.
- Keep questions, criteria, model ID, and thresholds together in one reviewable module.

Jev is text-only and strongest in English. For Vietnamese workloads, keep original text in
state when meaning matters, write stable evaluation criteria in English where practical, and
benchmark representative Vietnamese examples before enabling active routing.

## Compose decisions safely

Treat results as evidence, not authority.

- `Choice` and `Score` return probabilities plus confidence; `Noul` returns a yes probability.
- Confidence measures distribution concentration, not truth, workflow correctness, or
  permission to act.
- Tune thresholds on project data and by consequence. Use stricter policy for higher stakes.
- Record model version, question-set version, probabilities, confidence, route, fallback
  reason, latency, and observed outcome.
- On timeout, API failure, unsupported input, or uncertainty, use the existing deterministic
  fallback. Never make core workflow availability depend on TypeSafe during a pilot.

## Agent and Orca policy

TypeSafe is **opt-in only**; no Orca/game skill calls it automatically. Lane, task-size, and
human-gate routing were piloted in shadow mode (cc-tiki-smash, 2026-09) and removed: those
answers are already fixed by the slice contract (`size`, `needs_director_ok`) and deterministic
lane rules, so Jev only echoed its input or answered below `min_confidence`.

Before wiring TypeSafe into a workflow again, it must pass an offline backtest:

1. Pick a fuzzy, high-volume judgment that code cannot derive and that has observable ground
   truth (e.g. reviewer-finding triage: real bug / infra / out-of-scope / nit; test failure:
   `INFRA_BLOCKED` vs code bug).
2. Replay historical cases from project evidence against Jev, a rule baseline, and a cheap LLM.
3. Integrate only if Jev clearly beats both baselines at the precision the consequence needs,
   then run `shadow` with every `(prediction, confidence, outcome)` logged before `active`.

When a user explicitly asks for it, `scripts/route.mjs --config AGENT_NOTES.md --preset
game-routing` still works for a project whose `AGENT_NOTES.md` sets `typesafe.enabled: true` and
`typesafe.auto_route: true` (both default to `false`). Pass a minimized JSON state on stdin;
never put the API key or sensitive state in CLI arguments. Missing keys, API failures, and
uncertainty return a structured fallback and must not block the workflow.

Precedence is always:

1. explicit user/director instruction;
2. authorization, safety rules, project contracts, and deterministic invariants;
3. existing routing policy;
4. TypeSafe recommendation.

TypeSafe may suggest a skill, lane, provider/model tier, or evidence category. It may not:

- create or resolve a human gate;
- authorize credentials, billing, destructive actions, merge, push, deploy, or production;
- remove worktree/editor isolation or change path ownership;
- replace a planner, writer, runtime verification, independent reviewer, or completion audit;
- turn an advisory review triage into `APPROVED`.

For skill suggestion, shortlist from name plus description, then re-evaluate the top few with
their full descriptions. The agent still applies skill trigger rules and reads the selected
`SKILL.md` before acting.

Example dry run, which does not call the service:

```bash
printf '%s' '{"request":"Add inventory UI and save state"}' |
  node .cursor/skills/typesafe-ai/scripts/route.mjs \
    --config AGENT_NOTES.md --preset game-routing --dry-run
```

## Data handling

Keep credentials server-side. Redact secrets and minimize proprietary or personal data before
transmission. Review TypeSafe's current legal and retention terms before sending real project
or customer data; zero-data-retention is not implied by this skill.
