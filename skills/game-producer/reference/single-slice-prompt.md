# Single-lane prompts for S / M slices (producer → `agent-session`)

Replace `<PROJECT>`, `<Sxx>`, `<SLICE_FILE>`, `<DIRECTOR_DECISIONS>`, `<EVIDENCE_DIR>`.

## Writer (`fleet.writer_agent`, title `slice-<slug>-<Sxx>`)

```text
You are in the Cocos project at <PROJECT>, implementing slice <Sxx> as a single agent.
Read AGENT_NOTES.md, GAME_BRIEF.md, SCOPE.md, ARCHITECTURE.md, PLAYTEST.md,
EXPECT_GAMEPLAY_VISUAL.md and <SLICE_FILE>, then follow .cursor/skills/vibe-game-director/SKILL.md.

Task size is <S|M> (from the slice). Your PLAN is the slice front-matter mapped per
.cursor/skills/game-producer/reference/slice-to-plan.md: touch only paths.code / paths.art /
paths.scene_objects; every acceptance row and feel_row is a verifiable observation you must meet.
Director decisions (GIVEN): <DIRECTOR_DECISIONS>

Discover → Plan → Build → Verify. Write the evidence bundle to <EVIDENCE_DIR> (integration-notes,
preflight, preview.png when a preview channel exists, runtime-state.json). Before review, wear
the integrator hat: verify the pinned editor identity, reuse/start preview automatically per
preview-interact-playbook, and write preview-startup.json with the verified URL or exact blocker.
Release the editor lock before handoff. Do not commit; when
verified, print the cocos-output-contract YAML and "READY FOR REVIEW", then stop.
```

## Reviewer (`fleet.reviewer_agent`, **fresh** terminal, title `review-<slug>-<Sxx>`)

```text
You are the independent reviewer for slice <Sxx> in <PROJECT>. You did not write this code.
Read <SLICE_FILE>, EXPECT_GAMEPLAY_VISUAL.md, PLAYTEST.md and the evidence in <EVIDENCE_DIR>.
Follow the review role in .cursor/skills/cocos-orca-fleet/reference/worker-prompts.md and
.cursor/skills/smoke-test/SKILL.md.

Playtest the slice's `playtest` script at the verified URL in preview-startup.json. If missing
or unreachable, request integrator recovery through the producer; do not start preview or ask
the human directly. Reuse the existing startup blocker/request across review rounds.
Every acceptance row and feel_row is a finding when missing — "plays dry" is a valid major.
Write <EVIDENCE_DIR>/review.md ending with APPROVED or CHANGES_REQUESTED (+ findings list) and
runtime-state.json (verified | manual_required). Write review evidence only; do not edit game files. Then stop.
```

On `CHANGES_REQUESTED` the producer re-prompts the writer terminal with the findings (max 2 fix
rounds), then spawns a **new** reviewer terminal. Preview infrastructure alone routes to integrator
recovery without consuming a code-fix round; resume runtime review only after readiness is observed.
After APPROVED and "approved — commit", the writer runs `/commit-guard` on the main checkout.
