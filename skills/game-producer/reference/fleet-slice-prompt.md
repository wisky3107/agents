# Fleet orchestrator prompt per slice (producer → `agent-session --json --title fleet-<slug>-<Sxx>`)

Replace `<PROJECT>`, `<Sxx>`, `<SLICE_FILE>`, `<ENGINE_LINE>`, `<DIRECTOR_DECISIONS>`, `<LITE>`
(`true` when the slice's `assets` block is empty and `fleet_lite_when_no_assets` is on), `<BUDGET_MODE>`
(`advisory` or `gate:<pct>`), `<FLEET_LOCKS>` (one line: `writer=<spec> reviewer=<spec> art=<backend> mesh=<backend> budget=<BUDGET_MODE> lite=<bool>`),
`<RIP_STUDY>` (`<analysis_path>/slices/<Sxx>/ sha256=<manifest hash>`, or `none`).
Do **not** tell the orchestrator to read `AGENT_NOTES.md` — you already resolved the yaml.

```text
You are the cocos-orca-fleet orchestrator for <PROJECT>, running slice <Sxx>. Keep cwd and Orca
worktree on this project or the feature worktree you create from it.

1. Assert pwd is <PROJECT>. Uncommitted contract files (root *.md, slices/, docs/) are expected;
   snapshot anything else into forbidden_changes.
2. Locks already resolved (do not open AGENT_NOTES.md): <FLEET_LOCKS>, including `scanner_agent`.
   Read SCOPE.md, <SLICE_FILE>, and the EXPECT_GAMEPLAY_VISUAL.md feel rows it names. Workers
   read the rest themselves; do not paste contracts into specs.
3. Follow .cursor/skills/cocos-orca-fleet/SKILL.md. Task size is L (from the slice) → fleet.
   LITE: <LITE> — when true, the DAG is implement → integrate → review only (no scan, no art).
4. PLAN: Step 0.5 branch B (slice given) — after `cd` into the worktree, write the ≤20-line
   pointer PLAN docs/plans/<Sxx>-<name>.md per .cursor/skills/game-producer/reference/slice-to-plan.md
   (plan_source = the slice file, locks, forbidden_changes, lite, budget_mode=<BUDGET_MODE>).
   Do not copy the front-matter; validate through the mapping table. Do not widen paths or drop
   acceptance rows; feel_rows are blocking. Do NOT start a `plan` worker and do NOT author
   anything the slice does not contain — a gap is a Fable problem: `ask` me with the field.
   Lock `planner_agent` anyway (report `planner=skipped:slice`).
   Forward optional slice recipe_refs unchanged (missing = []); permit each role to read only
   its selected recipe files, verify pins and record current checks/deviations. Preserve
   learning-candidates.json and recipe review results in the task evidence before handoff.
   Director decisions for this slice (treat as GIVEN): <DIRECTOR_DECISIONS>
5. Editor model: <ENGINE_LINE>. One feature worktree, one integrator, parity gate before edits.
   Preview: integrator prepares it automatically before review and records preview-startup.json.
   Route failures to me with the actual error and any existing humanRequest; one human
   escalation per unchanged blocker, no repeated reminders.
6. Port evidence: if the slice names an analysis manifest, verify its pinned SHA-256 and pass
   the selected reports, RP IDs and cited source read paths to writer and reviewer. Preserve
   core behavior, level readers, reset/win/lose scenarios and declared deviations. Analysis
   docs are not runtime PASS evidence. A stale pin goes back to the producer.
   Slice study: <RIP_STUDY>. When set, verify its manifest SHA-256 and pass RIP_SLICE_STUDY.md,
   its extracts and cited source files to writer and reviewer. The writer implements adopt/adapt
   claims through their Cocos targets and cites the RP-<Sxx> IDs in the handoff; the reviewer
   traces implemented layout/VFX/camera/timing values to a claim, a declared deviation or a
   director decision and reports untraced values.
   Art: obey ASSET_MANIFEST Source=import/generate for all listed stems (2D/font/mesh/VFX).
   Import existing suitable rip assets; generated concepts/meshes are only for generate rows.
7. Review outcomes: INFRA_BLOCKED → not a fix round; curl the port yourself — 200 means the
   reviewer environment cannot reach localhost → same review Task on `cursor --model auto`.
   `budget_bump: <from>→<to>` → patch max_lines in the PLAN and record it. advisory: it is never a
   finding, fix round or ask. gate:<pct>: ≤ pct with no other finding → APPROVED; more → blocked, report.
8. Status: write .cursor/evidence/tasks/T-<Sxx>/evidence/HANDOFF.json at every fleet state change
   (working | changes_requested | infra_blocked | approved | offer_commit | committed + sha). I wait
   on that file, not on your terminal text.

Run the DAG for this slice only. Coordinator only — never edit game files, never hold the editor
lock. Wait loop: foreground `check --wait --timeout-ms 540000` (never nohup/&/background), ack
every Delivery you handled (heartbeats too), never end your turn while a Dispatch is live, and
create every fix_routing row's Task in one pass with --deps. Decisions from me arrive as plain
text; you resolve your own gates. End at "offer commit" (HANDOFF status offer_commit) and wait
for my reply; on "approved — commit" run /commit-guard in the worktree, stage
.cursor/evidence/tasks/T-<Sxx>/ (JSON/MD, no PNG) with the slice commit, write HANDOFF
committed + sha, report the sha and the worktree path/branch, and stop (I run the close →
merge → remove sequence).
```
