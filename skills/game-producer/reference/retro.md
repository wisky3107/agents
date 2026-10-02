# Milestone / release retro

Write or update `docs/retro.md` at release or playable completion, including deploy=none and
missing ship skill. A reviewed technical milestone may request an interim retro. Reconcile
processed candidate ids when updating; keep previous decisions and evidence. Default output
is project-local proposals; shared-library curation uses existing director authorization.

## Inputs

- `.cursor/evidence/lessons.jsonl`: legacy cost rows, `recipe_candidate`, `recipe_reuse`.
  Missing file means empty input; continue with the remaining sources.
- `.cursor/evidence/tasks/T-*/**/learning-candidates.json` and `stats.json` (including files
  directly under the task). Dedupe candidate/reuse ids and count a task's stats once.
- Workflow scorecard (when `~/.agents/logs/scorecard-latest.md` exists): per-system cost,
  recurrence and runner stops for this project. Cite its rows instead of recounting by hand.
- Integration/review evidence referenced by a candidate or reuse record. Read only relevant
  sections. Missing evidence is a finding, never an inferred PASS.
- Recipe library INDEX/registry when available; read matching recipes to decide add vs merge.
  Use `cocos-playbook/references/workflow.md` and `recipe-format.md` for curation rules.
- Kit candidates (when `<playbook>/kits/kit.mjs` exists): `node <playbook>/kits/kit.mjs candidates
  --project <game dir name>`, plus `kit.mjs check <project> <files>` for each candidate group and
  each `kit_signal` in learning-candidates. Read only the verdict lines; never open the other games.
- Policy already resolved by producer; do not reread Notes history.
- Optional memory (run only if `~/.orca-memory/bin/orca-memory` exists; use a pack only on
  `inject: true`): for each proposed operational fix or candidate topic, at most one
  `hook retro --query "<cause or topic in English>"`; read the `pack` path it prints. A match
  counts toward recurrence only after you check its cited source. Matches feed proposals only:
  no promotion, curation, or change to the memory archive.

For explicitly requested extraction from a finished older project, also inspect its committed
implementation/tests and surviving review evidence. Mark extraction as retrospective.

## Selection

Operational proposals keep the previous threshold: recurrence on at least two slices or
at least one review round / 30 minutes / extra spawn, with an understood cause and fix target.
Successful patterns and recipe candidates are evaluated independently of cost: reusable task,
meaningful value, bounded compatibility, source evidence, observable checks, and no duplicate
recipe. Keep missing runtime checks as limitations; only actually exercised behavior is proven.
One project can supply a candidate; verified/default need the library's later-reuse criteria.

## Output

- Policy and completed scope; date and milestone/release boundary.
- Operational fixes: source slices, measured cost, cause, proposed file/change.
- Recipe candidates: stable candidate id, proposed recipe id or merge target, applicability,
  evidence, limitations, decision (propose/published candidate/deferred) and library path.
- Recipe reuse: pinned id/revision, project, actual pass/fail/manual_required, review evidence.
- Kit proposals: feature files, `check` verdict (kit-ready / kit-possible / needs-extraction),
  games it appears in, blockers, and target (new kit or new part of an existing kit). Forks of one
  game do not count as independent reuse. Building a kit is curator work (kits/README.md).
- Missing evidence and dropped items with reasons.
- Stats rollup using only present data; list missing tasks, never invent zero retries.

Curator publishes candidates only when authorized, and preserves compact source evidence before
worktrees disappear. Candidate publication does not promote verified/default or change template
behavior. An ordinary producer leaves shared skills and templates unchanged and reports the
concrete promotion proposals for a later authorized task.
