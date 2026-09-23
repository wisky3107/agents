---
name: cocos-orca-fleet
description: >-
  Run one Cocos Creator L-lane feature as a supervised Orca orchestration fleet:
  cheap mechanical coordinator, planner (PLAN given by the director > copied from a
  slice file > authored by a `plan` worker on planner_agent, default claude opus, then
  director-gated once), scanner (cursor auto), writer (default claude opus),
  integrator (editor lock + Funplay), art per the cocos-asset-gen contract
  (antigravity | cursor | gpt-image-gen; meshes via Blender or 3D Gen Studio), and an
  independent reviewer (default claude opus) that playtests via the Orca
  browser. Writer/reviewer agents and art backend are locked once at task start
  from prompt > AGENT_NOTES.md > default, planner_agent likewise. Maps every role onto the AGENTS.md role table,
  plan-schema.md, cocos-output-contract.md, and the per-task evidence bundle.
  Use when the director asks for a fleet, team, multi-agent, parallel agents,
  orchestrator, or "use Orca to split this feature across agents" on a Cocos
  project. Not for S/M tweaks or BUG fixes — those stay single-agent.
disable-model-invocation: true
---

# Cocos Orca Fleet

You are the **coordinator**: a mechanical role (create Run/Tasks, wire the DAG, poll, transfer
terminals, gate) that is normally launched on a cheap agent (`fleet.orchestrator_agent`,
default `cursor --model auto`). The **planner** hat — deciding scope, paths, acceptance, budget
— is therefore *not* yours to improvise: the PLAN is either handed to you, copied from a slice
file, or authored by a dedicated `plan` worker on `planner_agent` and gated by the director
(Step 0.5). Triage after review is likewise copied from the reviewer's `fix_routing`, not
reasoned by you. You never edit game files, never touch the Editor, and never hold the editor
lock. `AGENTS.md`, `.cursor/rules/*`, and the Orca orchestration guide are binding for every
worker; this skill only assigns hats and wires the DAG.

## When to use / not use

| Situation | Action |
|---|---|
| `Task size: L` — new module, multi-system, needs art + scene + code | Run this fleet |
| `M` with scene work **and** new art | Fleet is optional; justify the overhead in one line |
| `S`, `M` code-only, `BUG` | Do **not** orchestrate; run the normal `10-vibe-loop` single-agent |
| Director says "hand off" / "give this to another agent" | Full handoff via `orca-cli`, not this skill |

When `typesafe.enabled: true` and `typesafe.auto_route: true`, read the `typesafe-ai` skill and
run its `game-routing` adapter once after PLAN validation only when no producer/upstream handoff
already carries a result for this task. This is automatic and does not require a prompt mention.
In `shadow` mode it is telemetry only. In `active` mode it may assist only where the table leaves
a genuine low-risk choice; it cannot downgrade an L task, override the director, alter the
approved PLAN/DAG, relax ownership or editor locks, skip runtime evidence, or replace the
independent reviewer. Missing key, failure, or low confidence falls back to this table without a
retry in the same run.

## Preconditions

1. `orca skills get orchestration --full` — read it; it is the authority for every Orca command.
2. `orca status --json` shows a running runtime; orchestration is enabled in Settings.
3. Project has `orca.yaml` with the Cocos setup/archive hooks (`cocos-orca-worktree` skill).
   The template ships them (`orca.yaml` + `scripts/`); if missing, copy from
   `/Users/wikz/Works/games/template/cc-game-template/` first and say so.
4. The five root contracts exist (`GAME_BRIEF`, `SCOPE`, `ARCHITECTURE`, `FOLLOWUPS`, `PLAYTEST`).
   Missing → `/setup-project` before any fleet.
5. Extract only the leading yaml fence of `AGENT_NOTES.md` at the project root (shipped by the
   template; `/new-cocos-game` and `/store-game-clone` fill it). Do not load Notes sections —
   they are producer history and cost tokens. The yaml supplies the defaults for the locks in
   the next two sections. When the producer already passed locks in the prompt, use those and
   skip the file.
   **Precedence for every lock:** director's prompt override > `AGENT_NOTES.md` value >
   default in this SKILL. Missing file, missing key, or empty value (`""`, `0`) → that field
   is unset → default applies; say so in one line. The file is optional: a fleet started
   directly in an older project without it runs exactly as before.

## Hard constraints that shape the fleet

- **One editor channel per checkout, one port pin per checkout.** Every checkout (main project or
  Orca worktree) pins its own MCP (+ preview for cc4) and carries project-local MCP client configs
  (`.cursor/mcp.json`, `.mcp.json`, `.codex/config.toml`) that point at it — written by
  `setup-orca-worktree.sh` → `bootstrap.mjs mcp-config` (3.8: `funplay-cocos-mcp.config.json`;
  cc4: `cocos-cli-mcp.config.json`). Two editors (main + feature worktree, or two different games)
  can therefore run side by side; the rule is that **this fleet edits through exactly one of them**:
  the feature worktree's. Hence: one feature worktree per fleet, one integrator, one editor lock.
  Writer and Art share that worktree with disjoint path allowlists. The main-checkout editor opened
  by `/new-cocos-game` may stay open (it owns a different port) but nobody in the fleet touches it;
  close it if RAM is tight (`scripts/close-mcp.sh --kill` on cc4; `scripts/close-editor.sh` on 3.8).
- **Parity is by project identity, not by a global port.** Before any editor mutation the integrator
  runs `probe.mjs` in the worktree against the pinned URL. Wrong project / unreachable → stop, `ask`;
  never edit through another checkout's channel.
- **Writer never touches the live Editor.** Script attachment, node/component creation, ref
  wiring, and asset import belong to the **integrator** Task.
- **`.meta` is generated, never authored.** Art produces raw files only; the integrator imports
  them (`refresh_assets`) and verifies every pair.
- **3D pipeline is fan-out, concept always Antigravity, route per mesh.** Coordinator creates
  parallel `art-concept-<stem>` (always `agy`) and `art-mesh-<stem>` Tasks with disjoint path
  allowlists. Mesh work starts only after that stem's `CONCEPT: PASS`; the mesh worker follows
  `cocos-asset-gen` routing (simple → Blender script, complex → 3D Gen Studio, studio down →
  Blender). Verify reads both the 4 iso contact sheet **and** the concept|model compare sheet.
  Integrator needs `CONCEPT: PASS` + `VERDICT: PASS` per mesh.
- **Integrator prepares preview before review.** For 3.8, verify the pinned Funplay
  `projectPath`, discover the tools, reuse a healthy browser URL or call
  `run_project_preview({mode: "browser"})`, then verify the returned URL/readiness. For cc4,
  use the pinned CLI preview command. Record `evidence/preview-startup.json` and hand it to
  the reviewer; details in the project's `preview-interact-playbook.md` §Automatic preview startup.
  Reviewer stays read-only and requests recovery through the coordinator. Escalate to the human
  only after a recorded automatic-start failure; share one request across review rounds and
  producer/coordinator layers. An unchanged blocker must not trigger reminders or new reviewers.
  Missing runtime evidence remains `manual_required` and blocks approval.
- **Nested dispatch depth is 1.** Workers cannot dispatch. Reviewer findings come back to you;
  you create the fix Task.
- **Fleet ends at "offer commit".** Commit, push, close Creator, merge, `worktree rm` are the
  director's, via the `cocos-orca-worktree` finish sequence.

## Art contract → `cocos-asset-gen`

Everything about *how* art is produced lives in `../cocos-asset-gen/SKILL.md`: the 2D
`art_backend` lock, the Antigravity concept pack, the per-mesh **route** (`mesh_backend`:
Blender generator for simple props · 3D Gen Studio for complex/organic models · automatic
Blender fallback when the studio is unavailable), the game-ready budgets, and the
`render_model_iso.py` verify + `model-check.md` format. This skill only wires the Tasks.

Resolve `art_backend` **and** `mesh_backend` once at Step 0.2 (prompt > `AGENT_NOTES.md`
`fleet.art_backend` / `fleet.mesh_backend` > defaults `antigravity` / `auto`). Record both in
`docs/plans/<feature>.md` and in the art specs. Never re-ask or switch mid-fleet. Announce in
one line together with the worker locks.

| `art_backend` | `worker-start` | Recipe |
|---|---|---|
| `antigravity` (default) | `--agent antigravity` | **C** (no AGENTS.md boot) |
| `cursor` | `--agent cursor --model auto` | A |
| `gpt-image-gen` | `--agent codex` | **C**; worker must follow `orca-gpt-image-gen` |

`mesh_backend` does not change the agent — the `art-mesh-<stem>` worker (locked `art_backend`)
runs whichever route the contract selects. When `mesh_backend` resolves to `3dgenstudio` or
`auto` **and** the PLAN has complex meshes, the coordinator runs
`python3 .cursor/skills/cocos-asset-gen/scripts/gen3d_studio.py --check` once at Step 0.2 and
records the result in the PLAN (`studio_available: true|false`) so mesh workers do not each
discover the outage; `false` under `auto` → say `mesh=auto (studio down → blender)`.

## 3D art topology (parallel concepts + meshes)

Whenever `manifest.json` lists one or more meshes (`.glb` / `.gltf` / `.fbx` / `.obj`), the
coordinator **splits art into parallel Tasks** — workers never dispatch (nested depth stays 1).

```
scan
  ├─ art-manifest          (skeleton manifest.json incl. complexity per mesh; recipe A cursor --model auto)
  ├─ art-2d *              (optional; locked art_backend; textures / sprites only)
  ├─ art-concept-<stem> ×N (ALWAYS antigravity / recipe C)  ─┐
  │         ↓ CONCEPT: PASS                                  │ parallel per stem
  └─ art-mesh-<stem> ×N    (locked art_backend; route per mesh_backend) ┘
implement ∥ art-manifest (codes against skeleton); waits on mesh names only via status
integrate ← all art-mesh + art-2d + implement
```

| Task | Agent | Owns (disjoint) | Never |
|---|---|---|---|
| `art-manifest` | `cursor --model auto` | `art_paths/manifest.json` skeleton only (rows carry `complexity`, `tri_budget`) | concepts, meshes, evidence art |
| `art-concept-<stem>` | **always** `agy --dangerously-skip-permissions` | `art_paths/concepts/<stem>/**` + `evidence/art/<stem>/concept-check.md` | other stems' concepts, any `.glb`, `manifest.json` |
| `art-mesh-<stem>` | locked `art_backend` (default antigravity) | `art_paths/gen_<stem>_*.py`, `art_paths/gen3d/<stem>/**`, `art_paths/<stem>.glb` (or PLAN name), `evidence/art/<stem>/**`, its `model-check.md`; may patch **only** its manifest row (`complexity`/`concepts`/`verify`) | other stems' files, Creator, `.meta` |
| `art-2d` | locked `art_backend` / `gpt-image-gen` | 2D files under `art_paths` that are not concepts/meshes | 3D |

**Parallel rules**

- One stem = one concept Task + one mesh Task. N stems → 2N art Tasks after `art-manifest`.
- Start every `art-concept-*` together as soon as `art-manifest` is done (and in parallel with
  `implement` + `art-2d`).
- Start `art-mesh-<stem>` only when that stem's concept worker reports `worker_done` with
  `CONCEPT: PASS` (peer `status` to the mesh handle is enough; coordinator also gates).
- Disjoint allowlists are mandatory so parallel writers never collide. Shared `manifest.json`:
  `art-manifest` writes the skeleton; each mesh worker updates **only its own asset row** with a
  read-modify-write; concept workers do not edit the manifest.
- `max_assets` caps total raw files across all art Tasks; when more than ~5 meshes route to
  3D Gen Studio, put a `tripo_credits` cap in `change_budget` (≈30 credits per image→3D).
- Studio-route meshes may run in parallel (Tripo tasks are independent); the local mesh-tools
  service serialises bake/collision, so expect those steps to queue.

**Gates the fleet enforces downstream:** integrator imports a mesh only with
`evidence/art/<stem>/concept-check.md` → `CONCEPT: PASS`, `evidence/art/<stem>/model-check.md`
→ `VERDICT: PASS` (with `route:` line), and both `contact-sheet.png` + `compare-sheet.png` on
disk; reviewer opens the **compare-sheet** and may overturn. Blender missing → one `ask`.

## Worker agents (choose once)

Resolve `planner_agent`, `writer_agent` and `reviewer_agent` **once**, together with
`art_backend`, before any Task starts (prompt > `AGENT_NOTES.md` `fleet.planner_agent` /
`fleet.writer_agent` / `fleet.reviewer_agent` > default). Record all three in
`docs/plans/<feature>.md` (`planner_agent:`, `writer_agent:`, `reviewer_agent:`) and in
`evidence/specs/plan.md` / `implement.md` / `review.md`. Never re-ask or switch mid-fleet.
`scan` is always `cursor --model auto` and is not configurable.

| Field | Default | Accepted values (launch spec) | Start recipe |
|---|---|---|---|
| `planner_agent` | `claude --model opus --effort high` | `cursor --model <m>` · `claude --model <m> [--effort <e>]` · `codex` · `antigravity` | `cursor` → **A**; anything else → **B** |
| `writer_agent` | `claude --model opus --effort high` | `cursor --model auto` · `claude --model <m> [--effort <e>]` · `codex` · `antigravity` | `cursor` → **A**; anything else → **B** |
| `reviewer_agent` | `claude --model opus` | same set | same rule |

`planner_agent` is only *launched* on Step 0.5 branch **C** (no PLAN path, no slice file); it is
still locked and recorded on every fleet so the evidence shows who would have planned. A
`planner_agent` of `cursor --model auto` is accepted but say `planner=cursor auto (weak for
authoring)` in the lock line — the point of the field is to keep planning off the cheap tier.

Synonyms at first resolve only: `cursor agent`, `cursor-agent`, `agent` → `cursor --model auto`;
`agy` → `antigravity`; a bare `claude` → `claude --model opus`. Announce the locks in one line
(`Workers: planner=<spec|skipped:<reason>> · writer=<spec> · reviewer=<spec> · art=<backend>`)
and proceed — no choice gate when a value resolves. The reviewer terminal is always fresh even
when `reviewer_agent` equals `writer_agent`. If the resolved CLI is not on PATH
(`which cursor-agent|claude|codex|agy`), one `ask` for a substitute from the accepted set, then
lock that.

## Role map

| Fleet role | AGENTS.md hat | Agent | Owns | Never |
|---|---|---|---|---|
| coordinator | planner hat, **validation only** (AGENTS.md has no separate coordinator row; the "produce a PLAN" right is delegated to `plan` / the director / the slice) | this session — default spawn is `cursor --model auto` when the director did not name an agent (`/new-cocos-game` / `agent-session`; `AGENT_NOTES.md` `fleet.orchestrator_agent`) | Run, Tasks, DAG, gates, PLAN **validation**, final-report | files, Editor, lock, authoring a PLAN from scratch, re-deriving fix scope |
| plan (branch C only) | planner | per locked `planner_agent` (default `claude --model opus --effort high`) | `docs/plans/<feature>.md`, `evidence/specs/plan-notes.md` | any other file, Editor, lock, Funplay |
| scan | discover | `cursor --model auto` | `evidence/discovery.md`, `evidence/baseline/` | writes outside evidence dir |
| art-manifest | writer (assets) | `cursor --model auto` | `art_paths/manifest.json` skeleton | concepts, meshes |
| art-concept-<stem> | writer (assets) | **always antigravity** | `concepts/<stem>/**`, concept-check block | meshes, other stems |
| art-mesh-<stem> | writer (assets) | locked `art_backend` (default antigravity); route per `mesh_backend` (Blender script ∣ 3D Gen Studio ∣ fallback Blender) | generator or `gen3d/<stem>/**` + `.glb` for stem, iso/compare evidence, model-check block | other stems, Creator |
| art-2d | writer (assets) | locked `art_backend` / `gpt-image-gen` | 2D textures/sprites under `art_paths` | 3D concepts/meshes |
| implement | writer | per locked `writer_agent` (default `claude --model opus --effort high`) | `code_paths` TS | Funplay, lock, scene files, `art_paths` |
| integrate | integrator | same terminal as implement, reused | editor lock, Creator on worktree, scene-tool/Funplay, import, editor evidence | reviewing its own work |
| review | reviewer | per locked `reviewer_agent` (default `claude --model opus`), **fresh** terminal | `evidence/review.md`, `runtime-state.json`, `preview.png` | edits, live scene, lock |

## Step 0 — plan (coordinator, read-only)

```
Fleet Progress:
- [ ] 0.1 First reply line: `Task size: L — <reason> → fleet`
- [ ] 0.2 Extract ONLY the leading yaml fence of AGENT_NOTES.md (python/sed — do not load
          Notes sections). Lock art_backend (antigravity | cursor | gpt-image-gen),
          mesh_backend (auto | blender | 3dgenstudio), planner_agent, writer_agent,
          reviewer_agent once (prompt > AGENT_NOTES.md > default); if mesh_backend is
          auto/3dgenstudio and the PLAN has complex meshes, run
          `python3 .cursor/skills/cocos-asset-gen/scripts/gen3d_studio.py --check`
          → studio_available; announce all locks in one line; never re-ask later
          Also detect the PLAN source now (see 0.5): `PLAN: <path>` in the prompt → A;
          `slices/S<nn>-*.md` named → B; neither → C. Say which in the lock line.
          (Branch C: the studio check moves to right after the plan worker's `worker_done`,
          since the mesh list is not known before the PLAN exists; patch `studio_available`
          into the PLAN yourself — it is a fact, not a planning decision.)
- [ ] 0.3 git status once; snapshot dirty files → forbidden_changes
- [ ] 0.4 orca worktree create --repo path:<PROJECT> --name <feature> --setup run --json
          (setup seeds library/+extensions/, pins a Funplay port for the worktree, writes its
          MCP client configs, opens Creator — that Creator is the integrator's)
          → record the exact `<repo-id>::<path>` worktree id
          → `cd <wt> && node .cursor/skills/vibe-game-director/scripts/probe.mjs --only funplay`
            must report `parity: true` before any Task starts (retry up to ~2 min while Creator boots)
          → `cd <wt>` NOW and stay there: the PLAN, evidence and every file you write from here
            live in the worktree, never in the main checkout (a PLAN left untracked in main
            blocks the producer's merge later).
- [ ] 0.5 Obtain docs/plans/<feature>.md by exactly ONE of three branches (never author it
          yourself from scratch — the coordinator is the cheap tier):
          A. PLAN given — prompt says `PLAN: docs/plans/<x>.md` (director wrote it in their
             own, stronger session). Copy nothing; run the PLAN validation below. Fail → one
             `ask` listing the violated rows; do not "fix" the PLAN.
          B. Slice given — prompt names `slices/S<nn>-*.md` (e.g. spawned by `game-producer`).
             Write the ≤20-line **pointer PLAN** from `../game-producer/reference/slice-to-plan.md`
             (`plan_source: <slice file>` + locks + forbidden_changes + `lite`); do NOT copy the
             front-matter — workers read the slice file. Validate through the mapping table.
             `lite: true` when the slice's `assets` block is empty and `release.fleet_lite_when_no_assets`
             is not `false`: skip `scan`, `art-manifest` and every `art-*` Task; `implement` reads
             `docs/flows/docs-index.md` itself (that is what scan produced anyway).
          C. Neither — create Task `plan` and `worker-start` it on the locked `planner_agent`
             (recipe A/B by spec) with `evidence/specs/plan.md` from worker-prompts.md; it reads
             the contracts + code and writes the PLAN. On its `worker_done`: validate, then
             `orca orchestration gate-create --task <plan_task_id> --question "PLAN approval:
             <path> — <n> open questions from plan-notes.md" --options '["approve","revise"]'`
             and wait for the director. `revise` → the director's notes become the spec of a
             new `plan` Task on the same handle (max 2 rounds), then a new gate. Only an
             approved PLAN unblocks 0.6.
          In every branch the PLAN must carry: art_backend, mesh_backend, studio_available,
          planner_agent (or `given`/`slice`), writer_agent, reviewer_agent; allowed_paths split
          into code_paths / art_paths; allowed_scene_objects; acceptance_criteria as
          observations — including feel/VFX observations (e.g. "merge pops with particles +
          scale tween ≤200ms"), lifted from EXPECT_GAMEPLAY_VISUAL.md's feel table when the
          project has one, never logic-only; change_budget; runtime_checks
- [ ] 0.6 task_id = T-<n>; evidence root = .cursor/evidence/tasks/T-<n>/
- [ ] 0.7 orca orchestration run-create --objective "<feature>" --json
          (branch C creates the Run before the `plan` Task — the plan worker needs it;
          in that case 0.7 happens between 0.4 and 0.5 and 0.6's task_id is known up front)
- [ ] 0.8 task-create for scan, art-manifest, art-concept-<stem>×N (if any meshes),
          art-mesh-<stem>×N, art-2d (if any), implement, integrate, review (deps below).
          `lite: true` → only implement, integrate, review (implement has no deps).
- [ ] 0.9 worker-start scan (lite: worker-start implement) and nothing else yet
```

### PLAN validation (coordinator, all branches — mechanical, no rewriting)

Check and report as a short pass/fail list; any fail → `ask` (A/B) or bounce to the plan worker (C).
In branch B every key is read from the slice file through the slice-to-plan mapping table — the
pointer PLAN itself only carries locks:

- Every key of `plan-schema.md` is present (B: resolvable via `plan_source`); `task_size: L`.
- `change_budget` is understood as **code_only** (scene/prefab/index/meta/plan lines never count);
  `budget_auto_bump_pct` resolved (AGENT_NOTES `release:` > SCOPE.md > 15) and written into the PLAN.
- `allowed_paths` split into `code_paths` / `art_paths`; every path is under `SCOPE.md`'s
  allowed area and none is in `forbidden_changes`.
- `acceptance_criteria` has ≥1 observation-phrased row **and** every matching feel row of
  `EXPECT_GAMEPLAY_VISUAL.md` (when the project has one) is present verbatim.
- `runtime_checks` non-empty (or an explicit line saying why runtime cannot be affected).
- `change_budget.{max_files,max_lines,max_nodes,max_assets}` set; `tripo_credits` when > ~5
  studio-route meshes.
- Locks recorded: `planner_agent|given|slice`, `writer_agent`, `reviewer_agent`,
  `art_backend`, `mesh_backend`, `studio_available`.
- 3D: every mesh stem in the PLAN has a `complexity` hint for `art-manifest`.
- Optional `recipe_refs` resolve through the slice/PLAN (absent = []). Validate id, revision,
  SHA-256 and readable path; pass only selected recipe pointers to relevant worker roles.
  Candidate checks need current evidence. A mismatch returns to the planning owner; the
  coordinator does not silently replace a recipe or extend the allowed scope.

Write each worker spec to `evidence/specs/<role>.md` from
[reference/worker-prompts.md](reference/worker-prompts.md) (plan / scan / implement / integrate /
review / fix) and `../cocos-asset-gen/reference/worker-prompts-art.md` (every `art-*` role),
then pass its content to `task-create --spec`. For 3D, use the `art-manifest` / `art-concept` /
`art-mesh` sections (not a single monolithic art Task). Every spec carries: PLAN path, evidence root, owned paths,
non-goals, verification, evidence files to write, "assert `pwd` + `git status` before edits",
and the lifecycle instruction to report with `worker_done` / `ask` / `escalation`.

## DAG

| Task | Deps | Start with | Done when |
|---|---|---|---|
| plan (branch C only) | — | recipe A/B per `planner_agent` | PLAN on disk, passes validation, director gate approved; terminal closed (recipe B) or released (A) |
| scan | plan (C) / — (A, B) | recipe **A**: cursor auto | `discovery.md` + `baseline/`; `status` to implement + art-manifest |
| art-manifest | scan | recipe **A** | `manifest.json` skeleton with every mesh/2D row; `status` to concept + mesh + implement handles |
| art-concept-<stem> | art-manifest | recipe **C** **antigravity only** (no AGENTS.md boot) | concept PNGs on disk; `CONCEPT: PASS` in `concept-check.md`; `status` to matching mesh handle |
| art-mesh-<stem> | art-concept-<stem> | recipe A (cursor) / **C** (antigravity · gpt-image-gen/codex) | `.glb` + generator; `contact-sheet` + `compare-sheet` + `VERDICT: PASS`; own manifest row `verify` set |
| art-2d | art-manifest | recipe A (cursor) / **C** (antigravity · gpt-image-gen/codex) | 2D files ≤ budget; no 3D |
| implement | scan, art-manifest | recipe A/B per `writer_agent` | tsc clean; `integration-notes.md`; output-contract YAML |
| integrate | implement, all art-mesh-*, art-2d | reuse implement terminal | lock cycle; `.meta` pairs; preflight / editor-log / diff-stat; preview-startup.json with verified URL or exact blocker |
| review | integrate | recipe A/B per `reviewer_agent`, **fresh** | `review.md` ends `APPROVED` or `CHANGES_REQUESTED` |

Start `art-manifest` + `implement` together when `scan` finishes. Start **all**
`art-concept-*` (and `art-2d`) together when `art-manifest` finishes. Start each
`art-mesh-<stem>` as soon as **that** stem's concept reports `CONCEPT: PASS` — do not wait
for other stems. N models ⇒ N concept agents + N mesh agents in flight.

When the PLAN has **no** meshes, keep the legacy single `art` Task (2D-only) from the shared
art contract — skip concept/mesh fan-out. When the PLAN is `lite: true` (no assets at all), the
DAG is `implement → integrate → review` only — no scan, no art Tasks, no manifest.

### Worker start recipes

Pick the recipe by **role**, then by launch spec:

| Role | Recipe |
|---|---|
| `scan`, `art-manifest`, Cursor `writer` / `reviewer` / `planner` | **A** |
| `plan`, `implement`, `review` on non-Cursor (`claude` / `codex` / `antigravity`) | **B** (conditional boot) |
| every art gen role (`art-concept-*`, `art-mesh-*`, `art-2d`, legacy `art`) on non-Cursor | **C** (no AGENTS.md boot) |
| art gen on `cursor` | **A** |

The AGENTS.md startup prompt is for code/plan/review sessions only. Art workers follow
`cocos-asset-gen` + their art spec; do **not** send them the boot turn.

**A — Cursor worker (no boot turn needed).** `cursor-agent` reads `AGENTS.md` on its own and
`worker-start` creates the terminal and injects the spec. When implement/review run on Cursor,
the spec still carries the full role block from `worker-prompts.md`; only the boot turn is
skipped:

```bash
orca orchestration worker-start --task <task_id> --worktree id:<wt> \
  --agent cursor --model auto --json
```

**B — non-Cursor plan / implement / review — create in the worktree, then attach (conditional boot).**
Current Orca supports `worker-start --agent claude|codex|cursor --model ... --effort ...`.
Use that managed path when its launch permissions match the user's Orca settings. Model/effort
alone is not a reason to create a custom terminal. For an explicit command matching the settings
baseline, resolve it through the shared launcher, preserving the provider and all locked options:

```bash
CMD=$(node ~/.agents/skills/new-cocos-game/scripts/bootstrap.mjs agent-cmd \
  --agent "<locked spec>" --json | jq -er '.command')
H=$(orca terminal create --worktree id:<wt> --title "<role>" \
  --command "$CMD" --json | jq -er '.result.handle // .result.terminal.handle')
orca terminal wait --terminal "$H" --for tui-idle --timeout-ms 90000 --json
orca orchestration worker-start --task <task_id> --terminal "$H" --worktree id:<wt> --json
```

Codex uses `--dangerously-bypass-approvals-and-sandbox`, Cursor `--yolo`, Claude
`--dangerously-skip-permissions`; never append a Claude-only flag to another provider.
Claude Teams must retain the Orca `claude-teams` wrapper. Inspect `agent-cmd`'s `needsBoot`
with `--path <checkout>`: code/plan/review agents without native rules loading need the
legacy startup turn from worker-prompts.md before task attachment. Art always skips it.

**C — non-Cursor art gen (antigravity / codex for gpt-image-gen) — no AGENTS.md boot.**
Same terminal create as B, but after the first `tui-idle` attach the Task immediately. Do not
send the boot prompt; do not wait for `AGENTS.md loaded — …`. The art spec from
`cocos-asset-gen/reference/worker-prompts-art.md` is the first real turn.

```bash
H=$(orca terminal create --worktree id:<wt> --title "<art-role>" \
  --command "<command resolved by bootstrap.mjs agent-cmd for the locked art spec>" --json \
  | jq -r '.result.handle // .result.terminal.handle')
orca terminal wait --terminal "$H" --for tui-idle --timeout-ms 90000 --json
# NO boot prompt here
orca orchestration worker-start --task <task_id> --terminal "$H" --worktree id:<wt> --json
```

Trust dialogs are pre-seeded by `setup-orca-worktree.sh` (Cursor `.workspace-trusted`, Claude
`hasTrustDialogAccepted` + `enabledMcpjsonServers`, Codex `trust_level`). If `tui-idle` never
arrives on recipe B, `orca terminal read` the handle — do not attach blind.

Terminals you created with `terminal create` are **not** closed by `worker-release` (it only
closes worker-start-owned terminals). After such a Dispatch settles, close it yourself with
`orca terminal close --terminal "$H" --json` unless you are transferring it (implement →
integrate). Recipe C art terminals are always closed after `worker_done` (never transferred).

Launch recovery: before switching a reviewer provider for localhost failure, verify the actual command matches Orca settings. Correct an old restricted launch once using the same locked provider/model, after confirming its old process and jobs have stopped; retry the preflight. Provider identity alone does not prove a sandbox failure. The fallback below applies only to a remaining observed failure.

## Coordinator loop

```bash
orca orchestration check --wait --types worker_done,escalation,question --timeout-ms 900000 --json
```

Pipe **stdout only** (keepalives go to stderr). Per Delivery:

1. `question` → `orca orchestration reply --id <msg> --body <answer> --json`. For preview
   requests, read `evidence/preview-startup.json`: return its verified URL or route recovery to
   the integrator (coordinator never takes the editor lock). Human fallback only after the
   integrator records the attempted tool and actual error. Record/reuse `humanRequest` in that
   shared file, including the blocker key and request id/timestamp; relay an existing request
   through the producer once, not as a new question at every layer or review round. While the
   blocker is unchanged, continue independent tasks and report it once; no repeated reminders.
2. `worker_done` succeeded → decide the terminal's next owner **before** acking:
   implement → `worker-start --task <integrate> --terminal <handle> --worktree id:<wt>`;
   everything else → `worker-release --dispatch <id>` (recipe A) or `orca terminal close`
   (recipe B/C terminals, which `worker-release` leaves open).
3. `worker_done` failed from review with last line `INFRA_BLOCKED` → not a fix round. Read the
   curl lines in `review.md`: coordinator's own `curl 127.0.0.1:<port>` → 200 means the
   reviewer environment cannot reach localhost → close that terminal and start the
   **same** review Task on `cursor --model auto` (record `reviewer=<locked> → cursor auto
   (localhost)` in the PLAN and final report — this is the one allowed lock change, it is a
   observed environment failure, not a provider assumption). Coordinator's curl also fails → integrator
   recovery Task, then the same review on a fresh terminal once readiness is observed.
   `worker_done` succeeded with a `budget_bump: <from>→<to>` line → patch `max_lines` in the
   PLAN to `<to>` (a recorded fact), note it for the final report, continue as APPROVED.
   `worker_done` failed from review (`CHANGES_REQUESTED`) → if the only blocker is preview
   infrastructure, route it to integrator recovery; do not consume a code-fix round or spawn
   another reviewer until readiness is observed. Otherwise read the `## fix_routing` table
   at the end of `evidence/review.md` and create one `fix` Task **per owner row group by
   copying it** (finding ids, owner, scope paths, acceptance). Do not re-derive scope: the
   reviewer is the strong model, you are not. Owner → handle: `code` → implement handle;
   `scene` → integrate handle (it re-acquires the lock); `concept` → new
   `art-concept-<stem>` (antigravity); `mesh` → `art-mesh-<stem>` (must re-run render with
   `--concepts`). A `review.md` without `fix_routing`, or a row whose owner is `unclear`, is
   not actionable → one `ask` to the director with the row(s), never a guess.
   Then a **new** review Task on a **fresh** reviewer terminal.
   Max 2 fix rounds; then `gate-create` for the director.
4. `escalation` → surface to the director; never silently do the worker's job.
5. `check --ack <delivery_id> --wait ...` and continue until every Dispatch settles.

Timeouts and `{count:0}` are checkpoints, not failures. Never `task-update --status completed`
after a valid `worker_done`; never release on idle/heartbeat.

## Messaging rules

- Peer bridge is **data-only**: scan / art-manifest / art-concept `send --type status` an
  artifact path to another worker's handle. `worker_done` / `ask` / `escalation` always go to
  the Run.
- The editor lock (`editor-lock.js`) is the only live-Editor mutation authority. Holding an
  Orca Dispatch grants nothing.
- Workers never dispatch sub-workers.

## Finish (coordinator)

1. Assemble `evidence/final-report.md` (delta per `10-vibe-loop` REPORT) and `stats.json`.
   Preserve `learning-candidates.json` when there are concrete reusable findings and recipe
   results from review.md. Include successful patterns even without a fix round; producer
   collects these once before checkout cleanup. Standalone fleet reports candidate paths for
   later curation. Workers/coordinator do not promote the shared recipe library.
2. Emit one `cocos-output-contract.md` YAML for the whole feature; every `*_verification`
   entry points at a file in the evidence dir.
3. Completion audit: Tasks with valid `worker_done`, reviewer verdict, evidence files present,
   anything `manual_required` or unreviewed — labelled honestly.
4. Confirm every terminal was released or transferred.
5. If `AGENT_NOTES.md` exists in the main checkout, **rewrite** the one line for this feature
   under `## Notes — cocos-orca-fleet` (never append a second line for the same feature):
   `- <date> <feature> source=<given|slice|plan-worker> writer=<spec> reviewer=<spec> art=<backend> verdict=<APPROVED|CR> fix_rounds=<n> manual=<none|…>`.
   Details stay in the evidence dir. Never edit the yaml block or another skill's section.
   No file → skip; do not create one.
6. **Offer** a commit: write `<evidence>/HANDOFF.json` `{"role":"coordinator","status":"offer_commit",
   "detail":"<verdict> fix_rounds=<n> budget_bump=<…|null>","sha":null,"updatedAt":"<ISO>"}` —
   the producer waits on this file, not on your terminal text. On approval run `/commit-guard`
   in the worktree; **stage `.cursor/evidence/tasks/<task-id>/` with the slice commit** (JSON/MD
   only — PNGs stay untracked) so `stats.json` survives `worktree rm`; then write HANDOFF.json
   `status: committed, sha: <sha>`. Then hand the director the `cocos-orca-worktree` finish
   sequence (close Creator → merge → `worktree rm --run-hooks`).
   When the director is `game-producer` (prompt names a slice file), wait for its
   "approved — commit" reply, commit, update HANDOFF.json, report the sha + worktree path/branch,
   and stop — the producer runs the finish sequence and updates `AGENT_NOTES.md` `release:` itself.

## Anti-patterns

- Editing through two Creators in one fleet (main + worktree). Two Creators may be *open*;
  only the worktree's is the fleet's mutation target, proven by `probe.mjs` `parity: true`.
- Assuming Funplay is on 8765. The port is whatever this checkout pinned.
- Hardcoding launch commands that differ from Orca settings, treating workspace trust as tool
  approval, or dropping provider/model/effort when creating a custom terminal.
- Sending the AGENTS.md boot prompt to `art-concept-*` / `art-mesh-*` / `art-2d` / legacy `art`.
- Art or writer calling Funplay, `refresh_assets`, or creating `.meta`.
- Re-asking or switching `art_backend`, `mesh_backend`, `writer_agent`, or `reviewer_agent`
  after the first lock; opening a choice gate when the prompt, `AGENT_NOTES.md`, or the default
  already resolves the value.
- Routing a simple prop to 3D Gen Studio, or shipping a raw Tripo high-poly as the asset — the
  route table and finishing pass in `cocos-asset-gen` are the contract.
- Skipping `AGENT_NOTES.md` and falling straight to the SKILL defaults (`claude opus`) when the
  director configured workers there.
- The cheap coordinator authoring `docs/plans/<feature>.md` from scratch (no `PLAN:` path, no
  slice file, no `plan` worker) — planning is a `planner_agent` job with a director gate.
- Coordinator "fixing" a PLAN that failed validation instead of `ask`ing (A/B) or bouncing it
  to the plan worker (C).
- Coordinator inventing fix-Task scope from prose findings when `review.md` has no
  `fix_routing` table, or merging rows with different owners into one Task.
- `gpt-image-gen` art inventing final pixels without `orca-gpt-image-gen` (or skipping the
  style-library pass when that skill is installed).
- Shipping a 3D model without a PASSed Antigravity concept pack, or without Reading both
  `contact-sheet.png` and `compare-sheet.png` before `VERDICT: PASS`.
- Giving 3D concepts to `orca-gpt-image-gen` / ChatGPT when the gate requires Antigravity.
- One monolithic art Task that serializes every stem while other stems could run in parallel.
- Two mesh/concept workers sharing the same path allowlist (parallel collision).
- Authoring a mesh before that stem's `CONCEPT: PASS`, or writing `concept match: PASS` from
  stats alone without opening the compare-sheet rows.
- Integrator importing a mesh that has no PASS block in `model-check.md` "because it looks
  fine in Creator" — Creator's viewport is not the gate; the evidence is.
- Reviewer on the implement/integrate terminal (self-review dressed as independent).
- Coordinator editing files "to speed things up".
- Reporting "verified" while `runtime-state.json` says `manual_required`.
- Reporting done when mechanics run but the feel/VFX acceptance rows (tween, particles,
  transitions per EXPECT/PLAN) were never implemented or reviewed — "works but plays dry"
  is a failed slice, not a FOLLOWUPS item.
- Marking the Run successful when a review, integration, or evidence file was skipped.
- `worktree rm` while Creator is still open (Windows file locks).

## Resources

- [reference/worker-prompts.md](reference/worker-prompts.md) — dispatch spec templates for
  plan / scan / implement / integrate / review / fix.
- `../cocos-asset-gen/SKILL.md` — art contract: `art_backend` + `mesh_backend` locks, concept
  pack, Blender vs 3D Gen Studio routing + fallback, verify, budgets;
  `reference/worker-prompts-art.md` (all `art-*` specs), `scripts/gen3d_studio.py`,
  `scripts/render_model_iso.py`.
- `../cocos-orca-worktree/SKILL.md` — seed, open, MCP parity, close, merge, remove.
- `../vibe-game-director/reference/plan-schema.md` — PLAN format the coordinator writes.
- `../vibe-game-director/reference/cocos-output-contract.md` — `worker_done` body format.
- `../vibe-game-director/reference/verification-playbook.md` — evidence bundle layout.
- `../vibe-game-director/reference/preview-interact-playbook.md` — reviewer's browser channel.
- `../smoke-test/SKILL.md` — reviewer's assertion runner.
