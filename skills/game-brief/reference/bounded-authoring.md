# Bounded authoring operations

The helper scripts are under this skill's `scripts/`; all paths below refer to the installed
skill, never a game's similarly named scripts. Node 20+ and the pinned `yaml` dependency are
required. Once per installation run `npm ci --ignore-scripts --no-audit --no-fund` in the skill
directory. No service, API key or model is needed for these tools.

## Prepare and launch

1. Preserve existing contracts. For amendments, follow gameplay-notes.md before touching affected
   files; never scaffold over an authored release. Read the configured depth (`full` by default).
2. Run `node ~/.agents/skills/game-brief/scripts/index-source.mjs --project <project>` in all
   modes. It writes a compact index and a separate queryable asset-candidate list. `--dry-run`
   reports without writes. `--slug` resolves unconventional idea-folder names. A configured
   missing source is an error. Warnings require targeted inspection, not guessing.
3. For a new contract set only, optionally run `scaffold-contracts.mjs --project <project>
   --slices 8`. It creates missing drafts exclusively, skips existing files/same-ID slices,
   and produces a GP coverage draft when notes exist. Decide slice count from scope. Drafts
   contain BRIEF_DRAFT and cannot pass validation; placeholders never count as usable contracts.
4. After scaffolding, run `brief-progress.mjs --project <project> --init`. Save its `runId` and
   update `--run-id <id> --phase indexed`. Unfinished runs cannot be reset; inspect and resume
   the existing run. Copy this reference to `docs/brief-workflow.md`, and pass the exact scripts
   path as BRIEF_TOOLS plus BRIEF_RUN_ID and CONTRACT_DEPTH in the author prompt.
5. Launch the selected author once. Keep the handle and run ID together. The helper does not
   launch agents, send nudges, terminate jobs, or confer authority on a replacement author.

The default shortlist is up to five screenshots/frames, three diverse P0 PNGs, three mesh
candidates and three early production level files. This is an initial research budget, not a
hard quality ceiling. Missing visual states or a director-requested physics lookup justify extra
reads. Record `--read <path> --reason <decision>`; open the raw evidence before labeling OBSERVED.
Use an existing gameplay screenshot as the visual target when suitable; otherwise make and inspect
the required small mock. Do not decode all GLBs or build a full contact sheet by default.

## Monitor meaningful progress

Run `brief-progress.mjs --project <project> --watch` once per 30–60 second wait cycle using the
product's wait mechanism. This is a one-shot check, not a resident daemon. It writes only
`docs/brief-watch.json` and emits JSON; the coordinator acts on it. It tracks changed contract
hashes and new evidence paths, not spinner text or updatedAt alone. Keep checking through a long
generation call; a slow call is not automatically a hung agent.

Default actions: no index by 5 minutes → nudge_index; no changed GAME_BRIEF by 10 minutes →
nudge_first_contract; no meaningful progress for 8 minutes → nudge_progress. After delivering
one precise nudge, record `--run-id <id> --ack-nudge <reason>`. Recovery becomes a candidate only
after another 8 minutes with the same files/evidence. Inspect outstanding tool/provider jobs first.
Repeated watchdog calls or heartbeat updates do not shorten that grace period.

Before any replacement writes, verify the old author and its background jobs have ceased. A
queued STOP prompt, apparent TUI idle or stable mtime alone is insufficient. If cessation cannot
be verified, report the ownership blocker; do not start a second writer. Revoke old ownership,
rotate the run ID through a reviewed state edit, preserve drafts/index, and hand off the exact
remaining files. Do not automatically restart or reset thresholds in a loop.

## Mechanical and semantic gate

Run both validate-contracts.mjs and validate-gameplay-coverage.mjs with `--project`. Exit 0 is
mechanical pass, 1 is findings, 2 is a tool/input error. Unknown YAML or missing inputs fail
closed. Keep all failures visible and nudge the owner with exact codes/files. The GP validator
checks GP citations or resolvable H-row pointers in HOW_TO, GP references in owning
acceptance/playtest and PLAYTEST.md. It accepts legacy GP01 spellings and bounded GP ranges.
It checks linkage, not whether the prose faithfully implements the user requirement.

The coordinator separately checks source-index completeness, evidence labels, the opened visual
target, concrete S01 viewport/capture/tolerance requirements and consistency between contracts.
Use the current `--watch` output's contractHash and runId to write `docs/brief-review.json`:

```json
{
  "runId": "actual run ID",
  "contractHash": "actual current contract hash",
  "visualTargetInspected": true,
  "evidenceLabelsChecked": true,
  "sourceCoverageChecked": true,
  "gameplaySemanticsChecked": true
}
```

Only record checks actually performed. Then call `brief-progress.mjs --project <project>
--run-id <id> --phase done --review docs/brief-review.json`. It reruns the mechanical checks and
rejects a stale review hash. Authoring completion does not approve unresolved director choices or
prove runtime quality. Files altered after done produce gate_stale and require fresh review.

## Optional playable depth

Keep `brief.contract_depth: full` as the compatible default. Opt-in `playable` is valid only with
`release.goal: playable`; persist it in AGENT_NOTES before indexing. All root contracts, the full
milestone DAG/checklist and every slice file still exist. S01 and its assets/visual/GP scenarios
remain fully specified. Later slices keep all YAML fields with concrete outcome, scope, dependency,
paths, budget, RC ownership and evidence-labeled acceptance; runtime/playtest details and asset
expansion may be concise outlines. No BRIEF_DRAFT/TODO passes the gate. Their detailed narrative
and research wait until the release expands. Included GP requirements still need real rules and
scenarios, even if their owning slice is later.

Only v1_slice can dispatch in this mode. Before any later slice or end_to_end release, route a
targeted amendment to game-brief, expand remaining contracts without renumbering or rewriting
merged slices, set contract_depth=full, and rerun both gates plus semantic review. This is an
explicit authoring boundary, not permission for a producer to improvise missing details.

## Measurement

Watch output reports firstContractMinutes, completionMinutes, evidenceCount, extraReads and
nudges. First-contract time is the first observed non-scaffold file-content change after the launch baseline;
the coordinator still judges usability. Record provider/model, source mode and input counts with
these metrics. Compare idea, store without rip and store+rip+GP trials on isolated fixtures.
The proposed 8-minute first contract / 20-minute complete medians are experimental targets,
not benchmarked guarantees or automatic reasons to reduce contract quality.
