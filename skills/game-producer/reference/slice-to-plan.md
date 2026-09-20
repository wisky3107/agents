# Slice front-matter → PLAN (plan-schema.md)

**The slice file IS the PLAN.** Nothing is re-derived and nothing is copied: the fleet coordinator
(or single-lane writer) writes a *pointer PLAN* of ≤ 20 lines at `docs/plans/<Sxx>-<name>.md`
and every worker reads the slice file for the actual fields. Copying 150–200 lines of front-matter
per slice costs a write, N reads, and used to leak into the change-budget count.

## Pointer PLAN (write exactly this)

```yaml
task_id: T-<Sxx>
task_size: <size from slice>
plan_source: slices/<Sxx>-<name>.md      # every plan-schema key resolves through the table below
status: pending
# locks (facts, not planning — set by the coordinator / single agent at Step 0.2)
planner_agent: slice
writer_agent: <spec>
reviewer_agent: <spec>
art_backend: <backend>
mesh_backend: <backend>
studio_available: <bool | n/a>
lite: <true|false>                        # true when the slice has no assets (skip scan/art)
forbidden_changes: [<dirty snapshot verbatim>, <SCOPE.md exclusions>]
budget_bump: null                         # set to "<from>→<to> (auto ≤ budget_auto_bump_pct)" when used
rollback_point: <sha>
```

PLAN validation (fleet) runs against the slice file through this mapping; `max_lines` etc. are
read from `change_budget` in the slice.

## Field mapping

| slice field | PLAN field | note |
|-------------|------------|------|
| `id` | `task_id: T-<id>` | e.g. `T-S03` |
| `size` | `task_size` | `L` → fleet; `S`/`M` → single lane |
| `one_liner` | `goal` | verbatim |
| `player_outcome` | `user_visible_behavior` | verbatim |
| `paths.code` + `paths.art` | `allowed_paths` | fleet splits into `code_paths` / `art_paths` |
| `paths.scene_objects` | `allowed_scene_objects` | |
| `scope.out` + dirty snapshot + SCOPE.md | `forbidden_changes` | the only field materialised in the pointer PLAN |
| `acceptance[].text` (+ evidence label in parentheses) | `acceptance_criteria` | keep the label — reviewer cites it |
| `feel_rows` | extra `acceptance_criteria` | the matching rows of EXPECT_GAMEPLAY_VISUAL.md feel table; **blocking** |
| `runtime_checks` | `runtime_checks` | plus `playtest` steps as the reviewer script |
| `recipe_refs` (optional) | `recipe_refs` | missing = []; pinned id/revision/sha256/path, read through plan_source; do not copy recipe bodies |
| `release_items` | `runtime_checks` (release slice: "RELEASE_CHECKLIST rows RC-… PASS") | |
| `assets.2d/3d/vfx/audio` | art-manifest rows (`stem`, `p`) | 3D stems → concept + mesh Tasks; all empty → `lite: true` |
| `change_budget.{files,lines,nodes,assets}` | `change_budget.{max_files,max_lines,max_nodes,max_assets}` | `tripo_credits` → `change_budget.tripo_credits` |
| `risks` (unanswered) | — | producer resolves before dispatch; unresolved → slice stays `planned` |
| `depends_on` | — | producer only; merged deps are the precondition |

## Budget counting — one rule for everyone

`change_budget.lines` / `max_lines` counts **hand-authored code/config/tests/`docs/flows`** only.
Never counted: `.meta`, `.scene`, `.prefab`, `*.index.json`, `docs/plans/**`, `.cursor/**`,
`slices/**`, binaries. The number is produced by one command and pasted, never re-counted by hand:

```bash
git add -A -n >/dev/null; git add -A && bash .cursor/skills/setup-pre-commit/check-change-budget.sh --report
# → change-budget report (mode=code_only): files=9 lines=412 scene_lines_excluded=5759 budget=15/650
```

(Stage, report, then `git reset` if you are not the committer.) Writer, reviewer, coordinator and the
pre-commit hook all quote that line. A `max_lines` overrun of ≤ `budget_auto_bump_pct` (SCOPE.md,
default 15 %) with no other finding is **APPROVED with `budget_bump`** recorded — no fix round, no
director gate. Larger overruns stop the slice for re-planning.

Static checks always: `tsc --noEmit` strict, lint, verify-scripts, verify-refs. Editor checks
always: `refresh_assets`, open scene, no MissingScript, refs filled.
