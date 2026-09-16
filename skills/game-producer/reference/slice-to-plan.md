# Slice front-matter → PLAN (plan-schema.md)

The fleet coordinator (or single-lane writer) copies these fields; nothing is re-derived.

| slice field | PLAN field | note |
|-------------|------------|------|
| `id` | `task_id: T-<id>` | e.g. `T-S03` |
| `size` | `task_size` | `L` → fleet; `S`/`M` → single lane |
| `one_liner` | `goal` | verbatim |
| `player_outcome` | `user_visible_behavior` | verbatim |
| `paths.code` + `paths.art` | `allowed_paths` | fleet splits into `code_paths` / `art_paths` |
| `paths.scene_objects` | `allowed_scene_objects` | |
| `scope.out` + dirty snapshot + SCOPE.md | `forbidden_changes` | |
| `acceptance[].text` (+ evidence label in parentheses) | `acceptance_criteria` | keep the label — reviewer cites it |
| `feel_rows` | extra `acceptance_criteria` | copy the matching rows of EXPECT_GAMEPLAY_VISUAL.md feel table verbatim; **blocking** |
| `runtime_checks` | `runtime_checks` | plus `playtest` steps as the reviewer script |
| `release_items` | `runtime_checks` (release slice: "RELEASE_CHECKLIST rows RC-… PASS") | |
| `assets.2d/3d/vfx/audio` | art-manifest rows (`stem`, `p`) | 3D stems → concept + mesh Tasks |
| `change_budget.{files,lines,nodes,assets}` | `change_budget.{max_files,max_lines,max_nodes,max_assets}` | `tripo_credits` → `change_budget.tripo_credits` |
| `risks` (unanswered) | — | producer resolves before dispatch; unresolved → slice stays `planned` |
| `depends_on` | — | producer only; merged deps are the precondition |

Static checks always: `tsc --noEmit` strict, lint, verify-scripts, verify-refs. Editor checks
always: `refresh_assets`, open scene, no MissingScript, refs filled.
