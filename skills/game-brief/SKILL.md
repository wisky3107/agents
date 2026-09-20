---
name: game-brief
description: >-
  Author the full game-contract set (GAME_BRIEF, HOW_TO, EXPECT_GAMEPLAY_VISUAL,
  ASSET_MANIFEST, SCOPE, ARCHITECTURE, FOLLOWUPS, PLAYTEST, CONTEXT, ADR) plus the
  release plan (MILESTONES.md, numbered slice files, RELEASE_CHECKLIST.md) for an
  existing Cocos Creator project by spawning a configurable agent (default Fable 5.1) via
  Orca. Works from any source: an App Store reference pack (store-game-clone, optionally
  with a merged unity-apk-rip pack under the project's reference rip folder), a user-supplied media
  folder (screenshots / video / GDD / GLB), or a text-only idea, with optional director
  gameplay notes and amendments to existing contracts.
  Sits between store-game-clone / new-cocos-game and game-producer. Use when the
  user says "game-brief", "game brief", "fable brief", "brief sâu", "contracts",
  "HOW_TO/EXPECT", or wants deep contracts for a game that was NOT cloned from a store.
---

# Game Brief

Turn a source (store pack, media folder, or plain idea) into the project contracts the
producer and fleet read — including **every slice up front** so `game-producer` can run the
whole release without re-planning. S01 must be a presentation-ready playable: complete core
loop plus polished in-game UX/UI, responsive layout, and close visual correspondence to the
expected mock screen derived from screenshots or the brief. The brief author **only writes docs**: no
gameplay code, no Creator, no commit, no push.

Prereq: the project already exists (bootstrapped by `new-cocos-game`) and its MCP gate
passed. This skill never creates or opens a project.

## Constants

| Key | Value |
|-----|-------|
| Brief agent | Fable 5.1: `claude --model claude-fable-5-1`; resolve overrides at intake |
| Launcher | `~/.agents/skills/new-cocos-game/scripts/bootstrap.mjs agent-session` (handles trust, AGENTS.md boot, `tui-idle`) |
| Prompt | [reference/brief-prompt.md](reference/brief-prompt.md) |
| Slice schema | [reference/slice-schema.md](reference/slice-schema.md) — MILESTONES / slices / RELEASE_CHECKLIST format, cutting rules, release-polish content |
| Reference root in project | `<project>/reference/<slug>/` (`media` / `store`), absent for `idea` |
| Rip pack (optional add-on) | `<project>/reference/<slug>/rip/` — `unity-apk-rip` output merged by `store-game-clone` Step 1b (`RIP_PACK.json`, `README.md`, `images_ingame/` de-atlased sprites, `fonts/`, `meshes/`, `levels/`, `briefs/`, `*_GUIDE.md`, `*_catalog.json`); P0 GLBs already copied to `reference/<slug>/models/` |
| Contract templates | `<project>/.cursor/skills/vibe-game-director/templates/*.md` |
| Depth exemplars | `/Users/wikz/orca-global/*-brief/` (structure only) |
| Handoff file | `<project>/AGENT_NOTES.md` — this skill owns yaml `brief:` + `## Notes — game-brief` |

## Progress checklist

```
Game Brief:
- [ ] 0. Intake (project, slug, source mode, rip pack present?, gameplay notes?, orientation/design res, agent override?)
- [ ] 1. Seed source (media → reference/<slug>/; idea → reference/<slug>-brief/IDEA.md; rip → already under reference/<slug>/rip/)
- [ ] 2. Fill AGENT_NOTES.md brief: block (add block/section if skeleton is old)
- [ ] 3. Launch the brief author in the project (agent-session) with the filled prompt (+ optional rip / gameplay-notes blocks)
- [ ] 4. Gate: 8 root contracts + CONTEXT.md + ADR + MILESTONES.md + slices/ + RELEASE_CHECKLIST.md (+ rip rows / GP coverage)
- [ ] 5. Update notes section; report file list + slice table; stop (no commit unless asked)
```

## Step 0 — Intake

Ask only what's missing:

1. **Project path** — `/Users/wikz/Works/games/CocosCreator/cc-<slug>` (or `cc4-<slug>`). Abort if missing or no `AGENT_NOTES.md` / `.cursor/skills/vibe-game-director/`.
2. **Source mode** (announce in one line, do not ask when obvious):
   - `store` — `reference/<slug>/manifest.json` exists (came from `store-game-clone`)
   - `media` — user points at a folder / files of screenshots, video, GDD, GLB that are not a store crawl
   - `idea` — text only (chat message, `GAME_BRIEF.md` seed, a `.md` the user wrote)
2b. **Rip pack** (add-on to `store` or `media`, announce, never ask) — present when
   `reference/<slug>/rip/RIP_PACK.json` exists **or** `AGENT_NOTES.md` `store_clone.rip_path` is
   non-empty. Read `RIP_PACK.json` for what was merged (dirs, excluded `images/`, P0 GLB count) and
   skim `rip/README.md`. If the user points at a raw `unity-apk-rip` `output/` folder that was
   never merged, run `node ~/.agents/skills/store-game-clone/scripts/merge-rip-pack.mjs --rip <dir>
   --slug <slug> --assets-root "$PROJECT/reference"` so it lands at `reference/<slug>/rip/` with the
   same layout (that script also fills `reference/<slug>/models/`). `idea` + rip is not a thing —
   a rip pack is media, so the mode becomes `media`.
2c. **Gameplay notes** (optional, all source modes) — accept supplied chat text/files or
   detect `brief.gameplay_notes_path` / `reference/<slug>-brief/GAMEPLAY_NOTES.md`.
   Read [reference/gameplay-notes.md](reference/gameplay-notes.md) when present; it owns
   capture, evidence precedence, coverage, and late amendments. Absence requires no question.
   Existing contracts + new notes → use its late-notes flow before revising affected files.
3. **Orientation / design res** — default from media aspect if any; else portrait `720×1280`. Landscape → `1280×720`.
4. **Engine line** — from `AGENT_NOTES.md` `bootstrap:`: `Creator <creator_version>` (3.8 templates) or `COCOS 4 CLI <engine_version>` (cc4).
5. **Brief agent** — resolve in this order: explicit user/caller launch spec → existing
   `AGENT_NOTES.md` `brief.brief_agent` → `claude --model claude-fable-5-1` (Fable 5.1).
   Accept any agent supported by `bootstrap.mjs agent-session`, for example
   `claude --model opus`, `codex --model <requested-model>`, or `cursor --model auto`.
   Model and effort options belong to the selected provider; do not carry Fable's model into
   another provider. For a provider-only request, use that provider's default model. Announce the
   resolved spec, validate it with `bootstrap.mjs agent-cmd --agent "$BRIEF_AGENT"` (no launch),
   and record the canonical spec actually honored by the launcher. Do not silently fall back to
   a different model if validation or launch fails; report the exact failure.
6. **Release goal** — read `AGENT_NOTES.md` `release.goal` (`end_to_end` default | `playable`).
   The brief author always writes **all** slices either way; the goal only tells the producer where to
   stop. In either goal, S01 is self-sufficient and visually presentable: its own fail/restart,
   production-quality in-game HUD and controls, responsive safe-area layout, and an explicit
   expected mock screen based on the strongest screenshot evidence or the director brief.
   `playable` must never mean gray boxes, debug UI, placeholder layout, or a minimal HUD.

Never invent mechanics. `store` / `media` → the brief author must OBSERVE files and label
director statements GIVEN. In every mode its own fills are ASSUMPTION. `idea` has no
inspected media, so nothing may be marked OBSERVED.

Rip pack evidence rules (when present): files under `rip/images_ingame/`, `rip/meshes/`,
`rip/levels/`, and the `*_catalog.json` `how_to_use` fields are **OBSERVED** sources (cite the
path). `rip/briefs/*.md` and `*_GUIDE.md` prose are **research seeds** — the brief author may quote them
as `SEED (rip/briefs/GAMEPLAY_BRIEF.md §…)` but must re-derive v1 decisions itself; a rip brief
describing the shipped Unity meta (arena, store, live-ops) never widens v1 scope by itself;
explicit director requirements receive the scope decision defined in gameplay-notes.md.

## Step 1 — Seed the source into the project

```bash
PROJECT=/Users/wikz/Works/games/CocosCreator/cc-<slug>
```

- `store`: reuse `reference/<slug>/` seeded by `store-game-clone` Step 3.
- `media`:
  ```bash
  mkdir -p "$PROJECT/reference/<slug>"
  rsync -a --exclude '.DS_Store' <user media folder>/ "$PROJECT/reference/<slug>/"
  ```
  If a video is present and no frames exist, extract ~10 frames:
  `ffmpeg -i <video> -vf fps=1/3 "$PROJECT/reference/<slug>/video/frames/t%02d.jpg"` (skip if ffmpeg missing; note it).
- `idea`: write the user's text **verbatim** to `$PROJECT/reference/<slug>-brief/IDEA.md`
  (heading `# IDEA — <slug>`, then the text). The brief author reads this file, not the chat.

When gameplay notes exist, capture/reuse them per [gameplay-notes.md](reference/gameplay-notes.md)
and copy that reference to `$PROJECT/docs/gameplay-notes-contract.md` for the brief author.
Verify the notes source and GP index are readable before launch. Keep IDEA.md as the base
idea; gameplay amendments belong in GAMEPLAY_NOTES.md without duplicating the whole idea.

Read at least the key images / frames yourself with the Read tool before Step 3 so you can
judge the brief author's OBSERVED claims at the gate. With a rip pack also read `rip/README.md`,
`rip/briefs/GAME_BRIEF.md`, `rip/briefs/GAMEPLAY_BRIEF.md`, and the P0 tables of
`rip/IMAGES_INGAME_GUIDE.md` + `rip/MESHES_GUIDE.md`, and open 2–3 P0 PNGs (named de-atlased
sprites from Gameplay/HUD families — do not expect `sactx-*` pages under `rip/images_ingame/`;
also note `rip/fonts/` when text is in scope) so you know what "import" rows should look like.

## Step 2 — AGENT_NOTES.md

Edit only the `brief:` yaml block and `## Notes — game-brief`:

```yaml
brief:
  brief_agent: claude --model claude-fable-5-1      # launch spec actually used
  source: store | media | idea
  reference_path: reference/<slug>/      # "" for idea
  rip_path: reference/<slug>/rip/        # "" when no rip pack (intake 2b)
  gameplay_notes_path: reference/<slug>-brief/GAMEPLAY_NOTES.md  # "" when none
  orientation: landscape 1280x720        # or portrait 720x1280
  authored_at: ""                        # fill after Step 4 (ISO date)
```

Old skeleton without `brief:` → append the block at the end of the leading yaml and add an
empty `## Notes — game-brief` section after `## Notes — store-game-clone`; say so.
Skeleton with `brief:` but no `rip_path` → add the key; say so.
`gameplay_notes_path` is optional for older projects: absent means detect the conventional
path, then record it if found. Preserve a valid saved project-relative path; copy new
external/chat input into the project. A configured but unreadable path is an input error,
not absence. Do not clear existing notes when a later invocation supplies no new notes.
For an existing project, rename `## Notes — fable-game-brief` to `## Notes — game-brief`,
preserving its contents. If both sections exist, preserve both and append new notes only to the
new section. Retain the existing `brief:` schema; the skill rename does not reset saved settings.
Never touch `bootstrap:`, `store_clone:`, `fleet:`, or other skills' notes.

## Step 3 — Launch the brief author

Recipe context: when `~/.agents/skills/cocos-playbook/SKILL.md` is available (fallback
`/Users/wikz/Works/games/cocos-playbook/SKILL.md`), pass that exact path to the brief author.
It reads the small INDEX and only recipes matching engine, actual render mode, platform and
task; it records selected pinned `recipe_refs` in slices and technical rationale in the ADR.
Recipe-derived choices stay ASSUMPTION unless directed by the user; they are not observed
mechanics or runtime proof. Missing library/no match → recipe_refs=[] and normal authoring.

Fill placeholders in [reference/brief-prompt.md](reference/brief-prompt.md)
(`<PROJECT>`, `<SLUG>`, `<SOURCE_BLOCK>`, `<RIP_BLOCK>`, `<GAMEPLAY_NOTES_BLOCK>`, `<ORIENTATION>`, `<DESIGN_RES>`,
`<ENGINE_LINE>`, `<RELEASE_GOAL>`), pick the `<SOURCE_BLOCK>` variant for the mode, and paste
the `<RIP_BLOCK>` variant when intake 2b found a rip pack (delete the placeholder line
otherwise — never leave the literal `<RIP_BLOCK>` in the prompt). Copy
[reference/slice-schema.md](reference/slice-schema.md) to
`$PROJECT/docs/slice-schema.md` first so the brief author can read it inside the worktree. Then:

Fill `<GAMEPLAY_NOTES_BLOCK>` from the prompt reference only when notes exist, substituting
`<GAMEPLAY_NOTES_PATH>` with `brief.gameplay_notes_path`; otherwise remove the block placeholder.
For late amendments, include the affected paths/release state and revision scope from the
late-notes flow; its targeted revision rules override the prompt's initial full-authoring task.

Set `BRIEF_AGENT` to the resolved canonical spec from intake; the default assignment below is
only for projects with no override. Keep the prompt provider-neutral for every model.

```bash
BRIEF_AGENT='claude --model claude-fable-5-1' # replace with resolved spec when overridden
node ~/.agents/skills/new-cocos-game/scripts/bootstrap.mjs agent-session \
  --path "$PROJECT" \
  --agent "$BRIEF_AGENT" \
  --title "brief-<slug>" \
  --prompt "$(cat <<'EOF'
<filled prompt>
EOF
)"
```

`agent-session` sends the AGENTS.md boot prompt first, waits `tui-idle`, then the task. If the
JSON says `promptSent: false`, re-send with `orca terminal send <handle> --enter` (without
`--enter` the text stays in draft). Record the terminal handle.

## Step 4 — Gate

Wait for the brief author to print the 5-bullet v1 summary and go idle
(`orca terminal wait <handle> --for tui-idle --timeout-ms 900000`), then check:

```bash
cd "$PROJECT" && for f in GAME_BRIEF.md HOW_TO.md EXPECT_GAMEPLAY_VISUAL.md ASSET_MANIFEST.md \
  SCOPE.md ARCHITECTURE.md FOLLOWUPS.md PLAYTEST.md CONTEXT.md docs/adr/0001-tech-stack.md \
  MILESTONES.md RELEASE_CHECKLIST.md; do
  [ -s "$f" ] && echo "ok   $f" || echo "MISS $f"; done
ls slices/                                                # ≥ 1 file per id in MILESTONES.md
grep -c 'OBSERVED' EXPECT_GAMEPLAY_VISUAL.md HOW_TO.md slices/*.md   # idea mode: must be 0
```

Also confirm:

- `EXPECT_GAMEPLAY_VISUAL.md` has the **Game feel / VFX table**; `ASSET_MANIFEST.md` lists VFX assets as P0.
- `EXPECT_GAMEPLAY_VISUAL.md` satisfies [S01 visual target and review contract](reference/slice-schema.md#s01-visual-target-and-review-contract):
  an exact screenshot/frame with crop/dimensions and region annotations, or a visually inspected
  `docs/mockups/S01-ingame.svg` when no suitable image exists. Open the target yourself; text alone
  is insufficient. A static documentation mock is permitted by the docs-only scope.
- S01 includes concrete layout metrics, exact viewport sizes and safe-area insets, capture paths,
  measurable tolerances, and PASS/FAIL rules in its acceptance/playtest. It owns all required P0 UI
  art/fonts and the initial in-game layout/input/feel/visual checklist rows. Later slices cover new
  screens and regression checks. This gate checks the authored contract, not runtime completion.
- `MILESTONES.md` yaml has `slices`, `dag`, `v1_slice`, `release_slice`; every id has a
  `slices/S<nn>-*.md` whose front-matter carries `size`, `paths`, `acceptance`, `runtime_checks`,
  `change_budget` (the producer copies these straight into the PLAN). Budgets follow
  [slice-schema.md § Calibrating `change_budget`](reference/slice-schema.md) (estimate ×1.5,
  code-only counting); `SCOPE.md` carries `budget_count: code_only` and `budget_auto_bump_pct`.
- Last slice is `release-polish`; the union of all `release_items` covers every `RC-nn` row.
- `parallel_ok` pairs have disjoint `paths`.
- Optional `recipe_refs` carry id/revision/SHA-256/path; selected checks are in-scope, engine
  compatibility is explicit, and candidate status has not been upgraded by contract authoring.
- When gameplay notes exist, run the coverage gate in
  [reference/gameplay-notes.md](reference/gameplay-notes.md): all source statements indexed,
  every GP ID accounted for, included behaviors mapped into actual rules and slice scenarios,
  and unresolved decisions represented by affected slice risks/gates. Report outstanding
  decisions before handoff; an authored coverage table is not proof of implemented behavior.

Extra rows when a rip pack is present (`brief.rip_path` non-empty):

```bash
cd "$PROJECT" && grep -c 'reference/<slug>/rip/' ASSET_MANIFEST.md HOW_TO.md EXPECT_GAMEPLAY_VISUAL.md   # ASSET_MANIFEST must be > 0
grep -cE '\| *import *\|' ASSET_MANIFEST.md                                                        # ≥ 1 import row
grep -c 'SEED (' GAME_BRIEF.md HOW_TO.md                                                           # allowed, but no SEED row may be the only evidence for a v1 mechanic
```

- `ASSET_MANIFEST.md` has a **Source** column with `import` / `generate` per row; every `import`
  row names an existing file under `reference/<slug>/rip/images_ingame/`, `reference/<slug>/models/`
  or `reference/<slug>/rip/meshes/` (spot-check 3 paths with `ls`). Sprites are already de-atlased —
  cite the PNG filename, not a packed `sactx-*` page. Nothing from a P3 catalog entry appears as P0.
- When v1 loads levels: `HOW_TO.md` has a level-schema section citing `reference/<slug>/rip/levels/<file>.json`
  keys actually used (OBSERVED) and names the sample level(s) v1 ships.
- `SCOPE.md` / `CONTEXT.md` `_Avoid_` list rip-brief meta systems as out of v1 unless explicitly
  included by the director; verify any requested scope change is reflected across contracts.

| Result | Action |
|--------|--------|
| A contract missing | Nudge the brief author once with the missing file names |
| S01 target missing/unreadable, review criteria incomplete, or S01 UI checks deferred to later slices | Nudge the brief author with the exact gaps and the S01 visual contract; recheck before marking the brief complete |
| Rip present but `ASSET_MANIFEST.md` has no `import` rows / no `rip/` paths | Nudge the brief author with `reference/<slug>/rip/IMAGES_INGAME_GUIDE.md` + `MESHES_GUIDE.md` P0 tables; do not add rows yourself |
| An `import` path does not exist | Nudge with the exact row; the brief author must fix or flip it to `generate` |
| The brief author stuck after nudge | Write the remaining files in this chat under the same prompt rules; note it |
| `CONTEXT.md` / ADR missing | Write minimal versions here (domain terms + `_Avoid_`; engine, TS strict, web-mobile, design res, physics off unless the brief needs it) |
| `OBSERVED` in idea mode | Tell the brief author to relabel to `GIVEN` / `ASSUMPTION` |
| Gameplay notes missing coverage, mislabelled as OBSERVED, or contradicted by slice acceptance | Nudge the brief author with the GP IDs and conflicting rows; recheck before handoff |
| Slice missing a PLAN field / RC rows uncovered / parallel pair overlaps | Nudge the brief author with the exact ids; do not patch slices yourself (they are the brief author's contract) |

## Step 5 — Notes + report

- `brief.authored_at` → today.
- `## Notes — game-brief` → 3–5 bullets: source mode, what was OBSERVED vs ASSUMED (or
  GIVEN vs ASSUMED), media that could not be read, files written here instead of by the brief author; with a
  rip pack: how many `import` vs `generate` rows, and which rip-brief systems were kept out of v1.
- With gameplay notes, include their path and coverage counts by decision; for amendments,
  report changed GP IDs/files/slices and required fresh review scenarios for the current owner.
- Report the file list, the brief author's v1 summary, the slice table from `MILESTONES.md`
  (id · size · one-liner · `needs_director_ok`), and the terminal handle. Slices flagged
  `needs_director_ok: true` are the director's review list before `game-producer` starts.
  Do **not** commit unless asked; the caller (`store-game-clone` / `new-cocos-game`) decides
  what happens next (`/setup-project` Phase 1–3 skips Phase 0 because the root contracts now
  exist; then `game-producer` per `release.goal`).

## Out of scope

- Crawling stores (`store-game-clone`), bootstrapping projects (`new-cocos-game`)
- Implementing any slice, running `game-producer` or `cocos-orca-fleet`
- Editing slice files after the brief author wrote them (re-run the brief author with a nudge instead)
- Commit / push
