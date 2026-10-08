# Worker dispatch specs

Copy the block for each role into `.cursor/evidence/tasks/<TASK_ID>/specs/<role>.md`, fill the
`<...>` placeholders from `docs/plans/<feature>.md`, run
`python3 ~/.agents/skills/orca-agent-fleet/scripts/clean_spec.py <file>` (strips invisible
Unicode that stalls Claude's submit), then pass the file content to
`orca orchestration task-create --spec`. Orca injects the lifecycle preamble (`worker_done`,
`ask`, `heartbeat`, `escalation`) on dispatch; do not paraphrase it here.

Shared header — prepend to every spec:

```text
Project rules are binding: AGENTS.md, .cursor/rules/*. Read docs/plans/<feature>.md (the PLAN —
a pointer; its `plan_source` slice file holds the real fields) before anything. Task id <TASK_ID>.
Evidence root .cursor/evidence/tasks/<TASK_ID>/.
Before your first edit: run `pwd` and `git status`; the cwd must be worktree <WORKTREE_PATH>.
Preserve unrelated dirty files listed in PLAN.forbidden_changes. Ask via `orca orchestration ask`
only at real decision gates (behavior, scope, dependency, destructive, identity). Report with
`worker_done`; use `--outcome failed` for any failure, never prose alone.
Nobody answers prompts in this terminal: never open an interactive question menu or plan mode
(Claude: AskUserQuestion, EnterPlanMode) — questions go through `orca orchestration ask`. Never
spawn subagents, workflows or worktrees (Claude: Agent, Workflow, EnterWorktree) and never write
agent auto-memory; reusable findings belong in your evidence files.
Never stop a process by pattern (pkill / killall / kill $(pgrep …)): on macOS `pkill -f X -n`
kills every Orca terminal and Cocos editor. Kill only a pid you started (`$!`) or one you checked.
Before your first `orca` call read ~/.agents/skills/cocos-orca-fleet/reference/orca/cheatsheet-worker.md
(Orca browser: cheatsheet-browser.md next to it) instead of running `orca … --help`.
Context discipline (this spec is your role card and is complete): read ONLY the PLAN, its slice
file, docs/flows/docs-index.md + the flow docs it names for your paths, and the files this spec
lists. Do NOT open .cursor/skills/**/SKILL.md or reference/*.md unless this spec names the file
and the step — the rules you need are already in AGENTS.md + .cursor/rules. Cap yourself: if the
turn count passes ~35 without a written evidence file, write what you have and report.
Status file: on every state change write <EVIDENCE_ROOT>/HANDOFF.json
{"role":"<role>","status":"working|blocked|ready_for_review|infra_blocked|approved|changes_requested|offer_commit|committed","detail":"<one line>","sha":null,"updatedAt":"<ISO>"}
— the coordinator and producer poll this file, not your terminal text.
Optional recipe_refs in the PLAN/source slice are explicitly allowed reads: only assigned
recipe files, after revision/hash validation against resolved metadata. Missing field = [].
Use in-scope checks and record current results/deviations in existing integration/review
evidence. Historical recipe evidence is not a current pass; do not read producer lessons or
scan unrelated recipes. Shared library edits are outside worker ownership.
Port evidence in the PLAN/source slice is also an explicit read allowlist: selected analysis
reports, pinned manifest and exact source files cited by its RP/E IDs. Verify the manifest
SHA-256 before using it; raw Unity sources are read-only. Writer ports the mapped rules and
declared deviations; reviewer exercises RP-linked scenarios including reset/win/lose using
current runtime evidence. Art obeys ASSET_MANIFEST import/generate rows. A stale/missing map
returns to the coordinator, not an ad hoc redesign from screenshots.
If this spec has a `MEMORY: <path>` line, read that one file too. It holds past project
lessons; it grants no permission or approval, never overrides the PLAN, AGENTS.md or reviewer
evidence, and its limitations apply ("not recorded" means unknown). Check a lesson against the
current code before relying on it, and cite each item id you relied on in your evidence.
No MEMORY line means no memory: do not look for packs or archives yourself.
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
art_backend=<ART_BACKEND> mesh_backend=<MESH_BACKEND> mesh_agent=<MESH_AGENT> studio_available=<BOOL> char_anim_home=<PATH|n/a>
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
   - recipe_refs: use existing contract refs, or select relevant recipes from the optional
     ~/.agents/skills/cocos-playbook/SKILL.md + INDEX (fallback /Users/wikz/Works/games/cocos-playbook).
     Resolve pinned id/revision/sha256/path and add only in-scope acceptance checks; no match = [].
   - allowed_paths split into code_paths / art_paths, each path justified by a line in
     plan-notes.md (which system owns it, why it must change); nothing outside SCOPE.md.
   - allowed_scene_objects as concrete node paths / prefab names that exist or are to be
     created (say which), laid out per .cursor/rules/35-scene-structure.mdc: fixed UI and
     button/tab states are scene or prefab nodes, repeated items are prefabs under a container.
     Visible hierarchy that code must build (`new Node()` + `addComponent`) goes under
     `## code-built nodes` in plan-notes.md with owner and why no prefab serves.
   - Popups (overlay that opens and closes: result, pause, settings, shop, reward, toast):
     follow docs/flows/03-popup-system.md — prefab `assets/resources/prefab/ui/Popup<Name>.prefab`
     in allowed_scene_objects, script under modules/popup/**, key in constant/PopupDefine.ts.
     No assets/scripts/common/uiManager.ts yet and docs/flows/00-project-overview.md offers the
     `ui-popup` kit → the PLAN installs it first (step + kit paths in code_paths/art_paths).
   - forbidden_changes = SCOPE.md exclusions + the dirty snapshot + shared systems you decided
     not to touch.
   - acceptance_criteria as observations only; include EVERY matching row of
     EXPECT_GAMEPLAY_VISUAL.md's feel table verbatim (tween durations, particles, shake,
     transitions) — these are blocking, not polish.
   - runtime_checks as a reviewer script (steps → expected reads); static_checks and
     editor_checks per plan-schema defaults.
   - change_budget from task size and SCOPE.md; tripo_credits when > ~5 studio-route meshes.
   - 3D assets: one row per mesh stem with a complexity hint (simple | complex) and its
     target name, so art-manifest can skeleton it without guessing. A character that moves
     gets `animated: {clips: [...], mocap: {clip: take}, export: fbx|fbf|both}`; authored
     clips are idle/run/jump/attack, any other clip needs a mocap take or a gate question.
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

## scan (per locked `scanner_agent`; default `cursor --model auto`)

```text
ROLE: discover (read-only). scanner_agent=<SPEC>. You may write only under the evidence root.

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
3D Gen Studio route, `art-anim-<stem>`, the **animated addenda** for concept and mesh, `art-2d`,
legacy single `art`, and the art variant of `fix`) lives in
`../../cocos-asset-gen/reference/worker-prompts-art.md`. Prepend the shared header above, fill
`<MESH_BACKEND>` / `<PROJECT_SLUG>` / `studio_available` / `<CHAR_ANIM_HOME>` from the PLAN, and keep the ownership
rows disjoint per stem exactly as that file states.

---

## implement (per locked `writer_agent`; default `claude --model opus --effort high`)

Launch with the exact spec locked in `docs/plans/<feature>.md` → `writer_agent`
(resolved from prompt > `AGENT_NOTES.md` `fleet.writer_agent` > default). Write it into the
spec header line `writer_agent=<spec>` so the evidence shows who wrote the code.

Use SKILL.md recipe B for non-Cursor scan / plan / implement / review and recipe A for Cursor.
Managed `worker-start --agent` supports model/effort for Claude/Codex/Cursor; custom commands
must come from the shared `bootstrap.mjs agent-cmd --role worker --slice <Sxx>` resolver to preserve
Orca permissions and tag the launch.
Codex/Cursor load rules natively; Claude/Teams use the template's `CLAUDE.md` import.
For scan/code/plan/review only, when `agent-cmd --path <checkout>` reports `needsBoot: true`, send
this once after the first `tui-idle`, wait again, then attach the Task:

```text
Read AGENTS.md and .cursor/rules/*, run git status once, change nothing, then reply only:
AGENTS.md loaded — workspace rules understood, existing changes preserved, ready for the next task.
```

**Art gen roles never boot.** `art-concept-*` / `art-mesh-*` / `art-anim-*` / `art-2d` / legacy `art` on
non-Cursor use **recipe C** (terminal create → first `tui-idle` → `worker-start --terminal`
with the art spec as the first turn). See `../cocos-asset-gen/reference/worker-prompts-art.md`.

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
   Kits: if the PLAN installs one, run `node ~/.agents/skills/cocos-playbook/kits/kit.mjs install
   <kit> <worktree>` first (copies scripts/prefabs with their .meta, patches boot, records
   .kits.json — not a raw edit; the integrator refreshes the asset-db), then read only the doc
   `kit.mjs show <kit>` names. A new popup: `kit.mjs scaffold ui-popup popup <worktree> <Name>`
   (script extending PopupBase + POPUP key), opened only via `UIManager.instance.showDialog(POPUP.X)`;
   its prefab step (printed `next:`) goes in integration-notes for the integrator.
4. Write evidence/integration-notes.md: exact nodes/components/refs the integrator must create
   or wire, in `{Kind} - {label}` form with parent path, ensure_* semantics, and which manifest
   asset goes where. It also carries `## acceptance map` (one line per acceptance row, by its id: the check file, spec or
   `manual: <reason>` that measures it), `## gaps` (every gap you know of, each with a disposition:
   fixed / followup F-n added to FOLLOWUPS.md / director D-n; `none` when there are none — a gap
   that breaks an acceptance row is never a followup: fix it, or HANDOFF blocked), and
   `## negative controls` (each new or changed smoke check and spec: the broken state you ran it
   against and the red line it printed — a check you never saw fail proves nothing).
   Structure follows .cursor/rules/35-scene-structure.mdc (state children saved inactive and
   wired to `@property` slots, prefab containers); code you wrote that builds visible nodes and
   the PLAN does not list goes under `## code-built nodes` (what, owner, why no prefab).
5. Smoke checks are part of the code, not the review: for EVERY acceptance row that state can
   answer (score, panel open, saved value, node count, no console error) add one
   `scripts/smoke/checks/<Sxx>-<nn>-<id>.check.js` (≤30 lines, format in
   .cursor/skills/smoke-test/SKILL.md §Check files; copy from its templates/). Feel rows (tween,
   particle, shake) stay manual. The reviewer runs these first; a missing check for a
   state-answerable row is a finding against you. Write every fail guard so a NaN/undefined
   value fails: `if (!(x <= limit)) fail(...)` or Number.isFinite in the same condition.
   Run smoke with `--channel auto`: a frozen Orca tab falls back to Chrome headless by itself
   (~/.agents/skills/cocos-orca-fleet/reference/orca/frozen-tab.md); never infra_blocked for it.
6. `tsc` clean; no console.log left behind. Before worker_done, `node .cursor/skills/cocos-orca-fleet/scripts/check-slice.mjs --slice <PLAN's plan_source slice file> --skip evidence --out evidence/static-check.txt`
   must not end RESULT FAIL (tsc, the ES5 web build, EVERY spec in tests/, scope, smoke-guard
   lint, the integration-notes sections); declare each WARN scope line in integration-notes.md; measure each WARN assumptions value
   from the art or list it under `## gaps`. docs/evidence/ is the integrator's. Budget: run
   `bash .cursor/skills/setup-pre-commit/check-change-budget.sh --report` (stage, report, unstage)
   and paste the line into integration-notes.md — that number is the only one anyone quotes.
   Over budget → add `budget_bump: <from>→<to>` + one-line reason. PLAN `budget_mode: advisory`
   (default) → keep going; never trim code, tests, VFX or assets to fit. `gate` → over by ≤
   budget_auto_bump_pct continue and say so; more → stop and `ask`. tripo_credits → always a cap.
7. If a reusable finding emerged, record evidence/learning-candidates.json as an array:
   {id,kind:failure_fix|successful_pattern,topic,context:{engine,mode,platform},finding,reuse_value,
   existing_recipe:null|id,evidence:[relative paths],limitations:[]}. Omit when empty; reviewer
   supplies validation in review.md. This evidence file is an allowed handoff output.
   Schema: cocos-playbook references/workflow.md §Capture. If `~/.orca-memory/bin/orca-memory`
   exists, run it as `capture --validate-only <file>` and fix every error it prints.
   Write limitations you observed; leave unknown ones out rather than guessing.

Never: Funplay, editor lock, .scene/.prefab/.meta, art_paths, refresh_assets, starting preview.
Done: HANDOFF.json status ready_for_review, then worker_done whose body is cocos-output-contract.md
YAML with serialized_data_changed: false, files_changed listed, remaining_risks honest.
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
   Source=import rows have route=import, source/hash, conversion and source-comparison
   evidence in model-check.md ending VERDICT: PASS; they skip the concept gate below.
   For Source=generate rows confirm
   evidence/art/<stem>/concept-check.md has `CONCEPT: PASS`, evidence/art/<stem>/model-check.md
   ends in `VERDICT: PASS`, and the cited concept-front, contact-sheet.png, AND compare-sheet.png
   all exist. Animated rows (manifest `animated`) also need evidence/art/<stem>/anim-check.md
   ending `ANIM: PASS` and the row's `anim_verify`; the model import is the rigged <stem>.fbx
   (one take per clip → AnimationClips; use `anim_verify.clips` for seconds / loop / events) and/or
   the FBF atlas + animations.json under the row's fbf_dir. Missing or FAIL → do not import; `ask`
   (concept fail → art-concept Task; mesh/compare fail → art-mesh Task; anim fail → art-anim
   Task). Generated 2D rows on any art_backend but cursor need evidence/art/2d/2d-check.md ending
   `ART2D: PASS` (missing or FAIL → do not import; `ask`, owner art-2d). Then refresh_assets →
   verify every file in the manifest has a .meta pair and no import errors (editor-log.txt via
   get_recent_logs); for meshes also confirm the imported prefab/mesh sub-assets appear and the
   model shows at the manifest's scale.
5. Apply evidence/integration-notes.md: scene-tool first for identity-preserving edits; Funplay
   for structural/identity work; one mutation contract per structural change; ensure_* so a retry
   cannot duplicate. Stay within allowed_scene_objects; max_nodes is an estimate (advisory mode) —
   report the count, never drop a required node to fit.
6. Sync + reopen the scene; confirm no MissingScript, refs filled → editor-log.txt.
   Record selected recipe checks/deviations and any scene-specific reusable finding in
   evidence/learning-candidates.json as an array of
   {id,kind:failure_fix|successful_pattern,topic,context:{engine,mode,platform},finding,reuse_value,
   existing_recipe:null|id,evidence:[relative paths],limitations:[]}; retain existing candidate
   ids. If `~/.orca-memory/bin/orca-memory` exists, run it as `capture --validate-only <file>`
   and fix every error it prints.
7. Prepare browser preview before reviewer handoff, while holding the editor lock:
   follow the project's preview-interact-playbook §Automatic preview startup. Verify pinned
   Funplay projectPath; discover get_preview_mode/run_project_preview (bridge if needed),
   reuse a healthy URL or call run_project_preview({mode: "browser"}), verify the returned
   URL/title and bounded readiness. For cc4 use its pinned CLI preview command instead.
   Write evidence/preview-startup.json with projectPath, funplayUrl (or cc4 endpoint), previewUrl, status,
   checkedAt, exact attempt/error details, and humanRequest (preserve any existing request).
   This is startup evidence, not an independent playtest. Failure → report to coordinator;
   do not ask the human directly or repeat an unchanged attempt.
8. evidence/diff-stat.txt after the task, plus the `check-change-budget.sh --report` line.
   Produce every docs/evidence/ path the slice names, then run check-slice in full
   (`node .cursor/skills/cocos-orca-fleet/scripts/check-slice.mjs --slice <plan_source> --out evidence/static-check.txt`):
   an `evidence` FAIL line is yours (produce it, or list it under `## evidence deferred` in
   integration-notes.md with the reason); an `evidence` WARN means a file predates the last
   code/data change — regenerate it. Other FAIL lines go to the coordinator as code findings.
9. editor-lock.js release --owner integrator, including on startup failure.
10. Screenshots: at most ONE editor screenshot (hierarchy/refs) and none of the preview — the
    reviewer takes preview shots. Evidence is JSON/text first; PNGs are for visual questions only.

Never: review your own work; edit TypeScript beyond what a ref rename forces
(if more is needed, `ask` — it goes back to a code fix Task).
Done: HANDOFF.json status ready_for_review (detail = preview URL or blocker), then worker_done
body = cocos-output-contract.md YAML with serialized_data_changed: true and
editor_verification pointing at editor-log.txt including the scene-reopen check; include the
preview-startup.json path and verified preview URL or exact startup blocker in the handoff.
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
Memory: a `MEMORY:` line here names the reviewer pack, built from acceptance and the diff
only. Use it to decide what to check, then gather your own current evidence. A memory item,
a writer candidate or the writer's verdict is never a pass.

Step 0 — INFRA PREFLIGHT (first 60 seconds, before reading anything else):
  read evidence/preview-startup.json → `curl -sS -o /dev/null -w '%{http_code}' --max-time 5
  http://127.0.0.1:<port>/` three times, 5 s apart. Any 200 → continue. Three non-200 while the
  file says ready → the reviewer environment cannot reach localhost or the preview is
  down. Either way write evidence/review.md with the curl outputs and the single last line
  INFRA_BLOCKED, HANDOFF.json status infra_blocked, worker_done --outcome failed, and stop.
  INFRA_BLOCKED is not CHANGES_REQUESTED: it consumes no fix round and routes to the
  integrator (preview) or to the coordinator (swap reviewer agent), never to the writer.

Step 1 — SMOKE FIRST: `node .cursor/skills/smoke-test/scripts/run-smoke.mjs --port <port> --channel auto`.
  Its JSON is the verdict for every state-answerable acceptance row; do not re-play those by
  hand. A row that has no check although state could answer it → finding (owner code, minor).
  `--channel auto` reruns in Chrome headless when the Orca tab is frozen; then play the feel rows,
  pointer rows and viewport matrix in that Chrome too (frozen-tab.md §3, real mouse/touch), and
  name the channel in review.md and runtime-state.json. A frozen tab is never INFRA_BLOCKED.
  Then play ONLY the feel rows and the rows smoke cannot express, per the slice `playtest`.

Static (commit-guard gates 1–4, read-only):
- SCOPE: every changed path in allowed_paths / art_paths. Budget: quote the writer's
  `check-change-budget.sh --report` line (re-run it yourself only if missing); code_only rule —
  scene/prefab/index/meta/plan lines are never counted. Any overrun → `budget_bump: <from>→<to>`
  line above the verdict (the coordinator patches the PLAN). PLAN `budget_mode: advisory`
  (default): the overrun is **never a finding** at any size — flag extra code only when it is
  outside allowed_paths, implements `scope.out` work, is dead/duplicated, or breaks
  ARCHITECTURE. `gate`: overrun ≤ budget_auto_bump_pct (default 15 %) with no other
  blocker/major → APPROVED; larger → finding, owner code.
- ARCHITECTURE: no upward deps, no cycles, events from the registry only. Popups only via
  `UIManager.showDialog/hideDialog(POPUP.X)` with key = prefab name = root node name =
  `@ccclass`; no popup node parented to the Canvas by hand, no second popup manager.
  Scene structure (.cursor/rules/35-scene-structure.mdc): visible hierarchy built with
  `new Node()` + `addComponent` that neither plan-notes.md nor integration-notes.md lists under
  `## code-built nodes` is a finding (owner code; files of a kit the PLAN lists count as
  declared); so is a state faked in code where the rule
  wants pre-authored children. New UI nodes off `{Kind} - {label}` (`Label - ` for cc.Label),
  or same-named siblings, are a minor finding (owner scene).
- ASSETS: every asset has a .meta pair; no raw-edited .scene/.prefab/.meta. Every 3D model
  has `CONCEPT: PASS` + `VERDICT: PASS`; open compare-sheet.png (concept|model rows) and
  contact-sheet.png together — missing either sheet is a blocker (owner asset). Overturn when
  any compare row diverges (cite front / threequarter / back) or iso views show holes/hollow/
  flipped faces (cite ne/nw/sw/se). Every animated row (manifest `animated`) also has
  `ANIM: PASS` in evidence/art/<stem>/anim-check.md and a filled `anim_verify`; open the clip
  contact sheets in evidence/art/<stem>/anim/ — a missing anim-check or sheet is a blocker
  (owner anim). In preview, play every clip listed in `anim_verify`: wrong clip, broken loop,
  sliding/floating feet or a missing event is a finding (owner anim). Generated 2D on any
  art_backend but cursor has `ART2D: PASS` in evidence/art/2d/2d-check.md (missing → blocker,
  owner asset); an `image-gen` row whose `verify.tool` is a script (gen_2d.py, Pillow, SVG) is a
  blocker (owner asset); a sprite with matte/halo, a seam on a tileable, or off-style art in preview is a
  finding (owner asset).
- STATIC: tsc + lint clean (read the tool output, do not assume). Run check-slice yourself
  (`node .cursor/skills/cocos-orca-fleet/scripts/check-slice.mjs --slice <plan_source> --out evidence/static-check.txt`):
  each FAIL line is a finding (owner code; `evidence` lines owner scene), and so is each WARN
  scope line integration-notes.md does not declare and each WARN assumptions line (a "tune on the
  preview" note left in code; minor, major if it positions art). Redo one `## negative controls` line: a check
  that stays green on the broken state is a finding (owner code). A `## gaps` disposition that
  leaves an acceptance row broken is a finding (owner code).

Runtime:
1. Read evidence/preview-startup.json and validate the handed-off URL/title/readiness for this
   checkout (preview-interact-playbook). Missing/stale/unreachable → request integrator recovery
   through the coordinator; do not start preview, change preview mode, or ask the human directly.
   Reuse the shared humanRequest across review attempts; never require "preview started" text.
   If recovery is blocked, write evidence/runtime-state.json =
   {"runtime_verification":"manual_required","reason":"<actual startup/connection error>"};
   report the infrastructure blocker, complete independent static checks, and never write "verified".
   Route preview infrastructure to owner scene (integrator), scoped to preview startup only;
   do not invent a gameplay-code fix. The coordinator resumes runtime review when readiness is observed.
2. Attach with the Orca browser (Orca first; Cursor Browser fallback). Play every
   PLAN.acceptance_criteria as written; run /smoke-test if checks exist.
3. Feel/VFX criteria: judge them with the reference pack open side by side — Read the cited
   reference frames/screenshots (reference/<slug>/video/frames/, iphone/) and compare against
   what you see in the preview. When a feel row cites a `track.md` measured by the gameplay-video skill, its duration,
   easing and distance are measured targets: time the preview's tween against them. A missing tween, particle, shake, or transition that the PLAN
   or EXPECT_GAMEPLAY_VISUAL.md lists is a finding (major by default), even when the mechanic
   itself works. "Plays dry vs reference" is a valid, reportable finding.
   Composed art fit: for every sprite layered onto base art that has cut-outs or outlines (wheels
   in arches, faces/eyes in windows, items in slots, hood on body), crop that spot at 2x (read it in the page, not saved as an extra
   PNG; the screenshot limit below holds). The base outline must not cross the part and the part must sit inside its cut-out; a position
   inside the mock's px tolerance is not evidence (finding, major, owner scene or asset).
   State vs visual: for each entity whose look depends on data (ticket, level, fault, unlocked),
   inspect at least one case where the data says "no" and check the visual agrees (a flat tyre
   only when the ticket has a tyre job). A smoke run that only feeds the "yes" case proves nothing.
4. evidence/runtime-state.json with real reads (smoke JSON + eval reads). Screenshots: one
   evidence/preview.png at the end, plus at most one per blocker/major finding — never per step,
   never per acceptance row. Batch state reads into one eval returning one object.

Output evidence/review.md: severity-ranked findings (blocker / major / minor), each with an id
(F1, F2, …), repro steps, expected vs actual, screenshot path, suspected owner
(code | scene | concept | mesh | anim).
Include a recipe-results section when recipe_refs is nonempty: id/revision, checked behavior,
PASS/FAIL/manual_required, current evidence and deviations. Validate any learning candidate
claims relevant to this review; source-project evidence cannot replace this run's checks.

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
whether the concept or the model is at fault; anim rows name the stem and the clips (a rig
failure caused by the model is a mesh or concept row, not anim). Only blocker/major ids must appear; minors may be
listed as `owner: followup`.

Last line of review.md is exactly APPROVED, CHANGES_REQUESTED, or INFRA_BLOCKED (Step 0 only).
Done: HANDOFF.json status approved | changes_requested | infra_blocked, then worker_done
--outcome succeeded for APPROVED, --outcome failed otherwise, body = the verdict line plus the
review.md path (and "fix_routing: <n> rows" when CHANGES_REQUESTED, "budget_bump: …" when used).
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
