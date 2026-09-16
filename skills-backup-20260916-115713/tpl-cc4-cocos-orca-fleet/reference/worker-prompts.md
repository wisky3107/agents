# Worker dispatch specs

Copy the block for each role into `.cursor/evidence/tasks/<TASK_ID>/specs/<role>.md`, fill the
`<...>` placeholders from `docs/plans/<feature>.md`, then pass the file content to
`orca orchestration task-create --spec`. Orca injects the lifecycle preamble (`worker_done`,
`ask`, `heartbeat`, `escalation`) on dispatch; do not paraphrase it here.

Shared header — prepend to every spec:

```text
Project rules are binding: AGENTS.md, .cursor/rules/*. Read docs/plans/<feature>.md (the PLAN)
before anything. Task id <TASK_ID>. Evidence root .cursor/evidence/tasks/<TASK_ID>/.
Before your first edit: run `pwd` and `git status`; the cwd must be worktree <WORKTREE_PATH>.
Preserve unrelated dirty files listed in PLAN.forbidden_changes. Ask via `orca orchestration ask`
only at real decision gates (behavior, scope, dependency, destructive, identity). Report with
`worker_done`; use `--outcome failed` for any failure, never prose alone.
```

---

## plan (per locked `planner_agent`; default `claude --model opus --effort high`; Step 0.5 branch C only)

Launch only when the coordinator has neither a `PLAN:` path nor a slice file. Recipe A for
`cursor …`, recipe B otherwise (boot prompt from the *implement* section). Put
`planner_agent=<spec>` in the spec header line. The Run already exists (Step 0.7 runs first in
branch C) and the worktree is created, so `<TASK_ID>` and `<WORKTREE_PATH>` are known. The
shared header applies, with one exception: the PLAN does not exist yet, so replace "Read
docs/plans/<feature>.md" by "You are writing docs/plans/<FEATURE>.md".

```text
ROLE: planner (read-only on the project; writes exactly two files).

Owns: docs/plans/<FEATURE>.md and <EVIDENCE_ROOT>/specs/plan-notes.md. Nothing else — no
game files, no Editor, no lock, no Funplay, no `orca orchestration` sub-dispatch.

Director's request (verbatim): <REQUEST>
Locks already decided by the coordinator — copy them into the PLAN, never change them:
art_backend=<ART_BACKEND> mesh_backend=<MESH_BACKEND> studio_available=<BOOL>
planner_agent=<SPEC> writer_agent=<SPEC> reviewer_agent=<SPEC>
Dirty-worktree snapshot (goes into forbidden_changes verbatim): <DIRTY_FILES>

Do:
1. Read GAME_BRIEF.md, SCOPE.md, ARCHITECTURE.md, PLAYTEST.md, FOLLOWUPS.md,
   EXPECT_GAMEPLAY_VISUAL.md and ASSET_MANIFEST.md when present; docs/flows/docs-index.md
   and the flow docs of every system the request touches; then a focused walk of
   assets/Scripts (+ scene/prefab names) for the systems involved. Note what is OBSERVED in
   code vs what you ASSUME.
2. Write docs/plans/<FEATURE>.md in .cursor/skills/vibe-game-director/reference/plan-schema.md
   format, task_size: L, task_id: <TASK_ID>, with:
   - allowed_paths split into code_paths / art_paths, each path justified by a line in
     plan-notes.md (which system owns it, why it must change); nothing outside SCOPE.md.
   - allowed_scene_objects as concrete node paths / prefab names that exist or are to be
     created (say which).
   - forbidden_changes = SCOPE.md exclusions + the dirty snapshot + shared systems you decided
     not to touch.
   - acceptance_criteria as observations only; include EVERY matching row of
     EXPECT_GAMEPLAY_VISUAL.md's feel table verbatim (tween durations, particles, shake,
     transitions) — these are blocking, not polish.
   - runtime_checks as a reviewer script (steps → expected reads); static_checks and
     editor_checks per plan-schema defaults.
   - change_budget from task size and SCOPE.md; tripo_credits when > ~5 studio-route meshes.
   - 3D assets: one row per mesh stem with a complexity hint (simple | complex) and its
     target name, so art-manifest can skeleton it without guessing.
3. Write <EVIDENCE_ROOT>/specs/plan-notes.md: OBSERVED vs ASSUMPTION list, the 3–5 riskiest
   decisions (with the alternative you rejected), and any question that changes product
   behavior — phrase each as a yes/no the director can answer at the gate.
4. Self-check against the "PLAN validation" list in cocos-orca-fleet/SKILL.md before reporting.

Never: touch assets/**, .scene/.prefab/.meta, scripts/, AGENT_NOTES.md; open Creator; start
the preview; widen scope to "while we're here" items — those go to FOLLOWUPS-style notes in
plan-notes.md, not into allowed_paths.
Done: worker_done whose body is the PLAN path, the plan-notes path, and the list of
questions for the gate (empty list is a valid answer).
```

Gate round (director rejected the PLAN): re-attach the same terminal with a new `plan` Task
whose spec is the director's notes verbatim + "revise the PLAN in place; change only what the
notes require; report the diff of changed keys". Max 2 rounds.

---

## scan (cursor --model auto)

```text
ROLE: discover (read-only). You may write only under the evidence root.

Do:
1. docs/flows/docs-index.md and the flow docs for every system named in the PLAN — if the
   index does not exist yet (fresh project), say so in discovery.md and fall back to
   ARCHITECTURE.md + a folder walk of assets/Scripts; do not fail on the missing file.
2. Focused path/symbol search for PLAN.allowed_paths and allowed_scene_objects.
3. /understand-explain <target> only if ownership is still unclear.
4. Write evidence/discovery.md: entry points, owning modules and layer (core/systems/entities/ui),
   patterns to follow, event registry constants involved, existing art conventions (folder,
   naming, sizes), preview/test commands.
5. Write evidence/baseline/: `git status`, `git diff --stat`, and a scene-tool index of every scene
   or prefab in allowed_scene_objects (BEFORE any change).
6. `orca orchestration send --type status --to <IMPLEMENT_HANDLE> --subject "discovery ready"
   --body "<paths>"` and the same to <ART_HANDLE>.

Never: edit any file outside the evidence root; open Creator; call Funplay mutations.
Done: worker_done listing both artifact paths.
```

## art-* roles → `cocos-asset-gen`

Every art spec (`art-manifest`, `art-concept-<stem>`, `art-mesh-<stem>` with its Blender /
3D Gen Studio route, `art-2d`, legacy single `art`, and the art variant of `fix`) lives in
`../../cocos-asset-gen/reference/worker-prompts-art.md`. Prepend the shared header above, fill
`<MESH_BACKEND>` / `<PROJECT_SLUG>` / `studio_available` from the PLAN, and keep the ownership
rows disjoint per stem exactly as that file states.

---

## implement (per locked `writer_agent`; default `claude --model opus --effort high`)

Launch with the exact spec locked in `docs/plans/<feature>.md` → `writer_agent`
(resolved from prompt > `AGENT_NOTES.md` `fleet.writer_agent` > default). Write it into the
spec header line `writer_agent=<spec>` so the evidence shows who wrote the code.

Every **non-Cursor** plan / implement / review worker is started with SKILL.md **recipe B**:
`orca terminal create` → `terminal wait tui-idle` → send the boot prompt below →
`terminal wait tui-idle` → confirm the reply is exactly
`AGENTS.md loaded — workspace rules understood, existing changes preserved, ready for the next task.`
→ `worker-start --task <id> --terminal <handle> --worktree id:<wt>`. Never merge the boot
prompt into the spec; never `worker-start --agent claude|codex|antigravity` directly.
A Cursor writer (`writer_agent: cursor --model auto`) uses **recipe A** and skips the boot
prompt; the ROLE block below is still the spec.

**Art gen roles do not use this boot.** `art-concept-*` / `art-mesh-*` / `art-2d` / legacy `art`
on non-Cursor use **recipe C** (terminal create → first `tui-idle` → `worker-start --terminal`
with the art spec as the first turn). See `../cocos-asset-gen/reference/worker-prompts-art.md`.

```text
Before performing any task in this session:
1. Find and read every AGENTS.md and .cursor/rules files that applies to the current workspace.
2. Run git status once.
3. Do not edit files, run side-effect commands, commit, or push during startup.
When startup is complete, respond with only: AGENTS.md loaded — workspace rules understood, existing changes preserved, ready for the next task.
Then stop and wait for my next task.
```

```text
ROLE: writer. Owns PLAN.code_paths only (TypeScript under assets/**).

Inputs: PLAN, evidence/discovery.md, <ART_PATHS>/manifest.json (code against manifest names).

Do:
1. Pure core/systems logic → /tdd (red-green-refactor). Keep deps one-way
   core <- systems <- entities <- ui; events via the named registry only.
2. Feel/VFX acceptance_criteria in the PLAN are YOUR scope, not optional polish: tween
   code (easing + durations as specified), particle triggering, screen shake / hit-stop,
   transition logic — all driven from code with @property hooks for the integrator.
   Skipping them because "mechanics work" is an incomplete task, not a FOLLOWUPS item.
3. Expose scene wiring as @property refs; do NOT attach scripts, create nodes, or wire refs.
4. Write evidence/integration-notes.md: exact nodes/components/refs the integrator must create
   or wire, in `{Kind} - {label}` form with parent path, ensure_* semantics, and which manifest
   asset goes where.
5. `tsc` clean; no console.log left behind; stay within change_budget (stop and `ask` if you
   would exceed it — the budget is a tripwire, not a quota).

Never: Funplay, editor lock, .scene/.prefab/.meta, art_paths, refresh_assets, starting preview.
Done: worker_done whose body is cocos-output-contract.md YAML with
serialized_data_changed: false, files_changed listed, remaining_risks honest.
```

## integrate (reuse the implement terminal via `worker-start --terminal <handle>`)

```text
ROLE: integrator. The only role that mutates the live Editor.

Do:
1. cocos-orca-worktree MCP parity, two layers, both required:
   a. `node .cursor/skills/vibe-game-director/scripts/probe.mjs --only funplay` in <WORKTREE_PATH>
      → `funplay.parity` must be `true` (this checkout's pinned port answers with this
      worktree's projectName). `false` → another Creator holds the port: stop and `ask`.
   b. Funplay get_project_info → data.projectPath == <WORKTREE_PATH> (normalize slashes),
      packagePath under this worktree's extensions/.
   Wrong → close the wrong Creator, reopen via scripts/open-editor.sh (`.cmd` on Windows),
   retry. Do not edit blind. The MCP client you use must be the project-local one
   (`.cursor/mcp.json` / `.mcp.json` / `.codex/config.toml` in the worktree), never a global
   8765 entry.
2. node .cursor/skills/cocos-editor/scripts/editor-lock.js acquire --owner integrator
   --task <TASK_ID> --scene <SCENE>. If HELD → stop and `ask`; never --force.
3. Probe just-in-time: node .cursor/skills/vibe-game-director/scripts/probe.mjs --only <channel>
   --name <project> --task <TASK_ID> before each channel's first use → evidence/preflight.json.
4. Before refresh_assets: for every 3D model in <ART_PATHS>/manifest.json, confirm
   evidence/art/<stem>/concept-check.md has `CONCEPT: PASS`, evidence/art/<stem>/model-check.md
   ends in `VERDICT: PASS`, and the cited concept-front, contact-sheet.png, AND compare-sheet.png
   all exist. Missing or FAIL → do not import; `ask` (concept fail → art-concept Task; mesh/
   compare fail → art-mesh Task). Then refresh_assets → verify every file in the manifest has a
   .meta pair and no import errors (editor-log.txt via get_recent_logs); for meshes also confirm
   the imported prefab/mesh sub-assets appear and the model shows at the manifest's scale.
5. Apply evidence/integration-notes.md: scene-tool first for identity-preserving edits; Funplay
   for structural/identity work; one mutation contract per structural change; ensure_* so a retry
   cannot duplicate. Stay within allowed_scene_objects and max_nodes.
6. Sync + reopen the scene; confirm no MissingScript, refs filled → editor-log.txt.
7. evidence/diff-stat.txt after the task.
8. editor-lock.js release --owner integrator.

Never: review your own work; start the preview; edit TypeScript beyond what a ref rename forces
(if more is needed, `ask` — it goes back to a code fix Task).
Done: worker_done body = cocos-output-contract.md YAML with serialized_data_changed: true and
editor_verification pointing at editor-log.txt including the scene-reopen check.
```

## review (per locked `reviewer_agent`; default `claude --model opus`; FRESH terminal — never the implement/integrate handle)

Launch with the spec locked as `reviewer_agent` (prompt > `AGENT_NOTES.md`
`fleet.reviewer_agent` > default); recipe A for `cursor …`, recipe B otherwise. The terminal
is always new, even when `reviewer_agent` equals `writer_agent`. Put `reviewer_agent=<spec>`
in the spec header line.

```text
ROLE: reviewer. Read-only. No editor lock, no edits, no live-scene mutation.

Inputs: PLAN, evidence/baseline/, full diff vs baseline, both output contracts,
evidence/integration-notes.md, <ART_PATHS>/manifest.json.

Static (commit-guard gates 1–4, read-only):
- SCOPE: every changed path in allowed_paths / art_paths; budget respected.
- ARCHITECTURE: no upward deps, no cycles, events from the registry only.
- ASSETS: every asset has a .meta pair; no raw-edited .scene/.prefab/.meta. Every 3D model
  has `CONCEPT: PASS` + `VERDICT: PASS`; open compare-sheet.png (concept|model rows) and
  contact-sheet.png together — missing either sheet is a blocker (owner asset). Overturn when
  any compare row diverges (cite front / threequarter / back) or iso views show holes/hollow/
  flipped faces (cite ne/nw/sw/se).
- STATIC: tsc + lint clean (read the tool output, do not assume).

Runtime:
1. Port-scan 7456..7465 and title-match "Cocos Creator - <project>" (preview-interact-playbook).
   None → `orca orchestration ask --question "Start Project → Preview in the worktree Creator?"
   --options "started,skip"` once. Still none → write evidence/runtime-state.json =
   {"runtime_verification":"manual_required","reason":"..."} and never write "verified".
2. Attach with the Orca browser (Orca first; Cursor Browser fallback). Play every
   PLAN.acceptance_criteria as written; run /smoke-test if checks exist.
3. Feel/VFX criteria: judge them with the reference pack open side by side — Read the cited
   reference frames/screenshots (reference/<slug>/video/frames/, iphone/) and compare against
   what you see in the preview. A missing tween, particle, shake, or transition that the PLAN
   or EXPECT_GAMEPLAY_VISUAL.md lists is a finding (major by default), even when the mechanic
   itself works. "Plays dry vs reference" is a valid, reportable finding.
4. evidence/preview.png per failure; evidence/runtime-state.json with real reads.

Output evidence/review.md: severity-ranked findings (blocker / major / minor), each with an id
(F1, F2, …), repro steps, expected vs actual, screenshot path, suspected owner
(code | scene | concept | mesh).

When the verdict is CHANGES_REQUESTED, end the file with a `## fix_routing` table. The
coordinator is a cheap mechanical agent and will copy each row group into a fix Task verbatim
— you are the one doing the scoping, so be exact:

| ids | owner | scope paths (subset of PLAN.allowed_paths / allowed_scene_objects) | change | acceptance (observation, re-testable) |
|---|---|---|---|---|
| F1,F3 | code | assets/Scripts/systems/Merge.ts | add scale tween 180ms easeOutBack on merge | merge pops within ≤200ms, no console error |
| F2 | scene | Canvas/Board (MergeFx particle ref) | wire MergeFx prefab to @property | ref non-null after scene reopen |

Rules for the table: one row per (owner, coherent change); never mix owners in a row; `scope
paths` must already be inside the PLAN — a fix that needs a new path is `owner: unclear` with a
one-line reason (the coordinator will ask the director). Mesh rows name the stem and say
whether the concept or the model is at fault. Only blocker/major ids must appear; minors may be
listed as `owner: followup`.

Last line of review.md is exactly APPROVED or CHANGES_REQUESTED.
Done: worker_done --outcome succeeded for APPROVED, --outcome failed for CHANGES_REQUESTED,
body = the verdict line plus the review.md path (and "fix_routing: <n> rows" when failed).
```

## fix (round ≤ 2; scoped to review findings)

```text
ROLE: <writer | integrator> — same rules as that role above.
Scope: ONLY the fix_routing rows pasted below from evidence/review.md round <n> (one owner per
Task; the coordinator copies the rows, it does not rewrite them). No other change.
<paste the fix_routing rows for this owner verbatim: ids · scope paths · change · acceptance>
Integrator variant: re-acquire and release the editor lock around the scene work.
Art variant (3D): see "fix — art variant" in cocos-asset-gen/reference/worker-prompts-art.md
(concept re-PASS, Blender re-export or gen3d_studio.py --source-glb finishing rerun, re-render with
--concepts into round-<n+1>). Closed only by CONCEPT: PASS (when needed) + VERDICT: PASS with both
sheets on disk, never by prose.
Done: worker_done body = output-contract YAML delta + which finding ids are addressed.
```
