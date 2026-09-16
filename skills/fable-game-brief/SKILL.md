---
name: fable-game-brief
description: >-
  Author the full game-contract set (GAME_BRIEF, HOW_TO, EXPECT_GAMEPLAY_VISUAL,
  ASSET_MANIFEST, SCOPE, ARCHITECTURE, FOLLOWUPS, PLAYTEST, CONTEXT, ADR) plus the
  release plan (MILESTONES.md, slices/S<nn>-*.md, RELEASE_CHECKLIST.md) for an
  existing Cocos Creator project by spawning Claude Fable inside that project via
  Orca. Works from any source: an App Store reference pack (store-game-clone, optionally
  with a merged unity-apk-rip pack under reference/<slug>/rip/), a user-supplied media
  folder (screenshots / video / GDD / GLB), or a text-only idea.
  Sits between store-game-clone / new-cocos-game and game-producer. Use when the
  user says "fable brief", "viết brief bằng fable", "brief sâu", "contracts",
  "HOW_TO/EXPECT", or wants deep contracts for a game that was NOT cloned from a store.
---

# Fable Game Brief

Turn a source (store pack, media folder, or plain idea) into the project contracts the
producer and fleet read — including **every slice up front** so `game-producer` can run the
whole release without re-planning. Fable **only writes docs**: no gameplay code, no Creator,
no commit, no push.

Prereq: the project already exists (bootstrapped by `new-cocos-game`) and its MCP gate
passed. This skill never creates or opens a project.

## Constants

| Key | Value |
|-----|-------|
| Brief agent | `claude --model fable` (override only if user names another) |
| Launcher | `~/.agents/skills/new-cocos-game/scripts/bootstrap.mjs agent-session` (handles trust, AGENTS.md boot, `tui-idle`) |
| Prompt | [reference/fable-brief-prompt.md](reference/fable-brief-prompt.md) |
| Slice schema | [reference/slice-schema.md](reference/slice-schema.md) — MILESTONES / slices / RELEASE_CHECKLIST format, cutting rules, release-polish content |
| Reference root in project | `<project>/reference/<slug>/` (`media` / `store`), absent for `idea` |
| Rip pack (optional add-on) | `<project>/reference/<slug>/rip/` — `unity-apk-rip` output merged by `store-game-clone` Step 1b (`RIP_PACK.json`, `README.md`, `images_ingame/`, `meshes/`, `levels/`, `briefs/`, `*_GUIDE.md`, `*_catalog.json`); P0 GLBs already copied to `reference/<slug>/models/` |
| Contract templates | `<project>/.cursor/skills/vibe-game-director/templates/*.md` |
| Depth exemplars | `/Users/wikz/orca-global/*-brief/` (structure only) |
| Handoff file | `<project>/AGENT_NOTES.md` — this skill owns yaml `brief:` + `## Notes — fable-game-brief` |

## Progress checklist

```
Fable Game Brief:
- [ ] 0. Intake (project, slug, source mode, rip pack present?, orientation/design res, agent override?)
- [ ] 1. Seed source (media → reference/<slug>/; idea → reference/<slug>-brief/IDEA.md; rip → already under reference/<slug>/rip/)
- [ ] 2. Fill AGENT_NOTES.md brief: block (add block/section if skeleton is old)
- [ ] 3. Launch Fable in the project (agent-session) with the filled prompt (+ <RIP_BLOCK> when rip present)
- [ ] 4. Gate: 8 root contracts + CONTEXT.md + ADR + MILESTONES.md + slices/ + RELEASE_CHECKLIST.md (+ rip rows)
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
3. **Orientation / design res** — default from media aspect if any; else portrait `720×1280`. Landscape → `1280×720`.
4. **Engine line** — from `AGENT_NOTES.md` `bootstrap:`: `Creator <creator_version>` (3.8 templates) or `COCOS 4 CLI <engine_version>` (cc4).
5. **Brief agent** — default Fable; honor an explicit override (`--model opus`, `codex`, …) and record it.
6. **Release goal** — read `AGENT_NOTES.md` `release.goal` (`end_to_end` default | `playable`).
   Fable always writes **all** slices either way; the goal only tells the producer where to
   stop, and tells Fable to make `S01` self-sufficient (its own fail/restart + minimal HUD)
   when goal=`playable`.

Never invent mechanics. `store` / `media` → Fable must OBSERVE files. `idea` → Fable labels
user statements `GIVEN` and its own fills `ASSUMPTION`; nothing may be marked `OBSERVED`.

Rip pack evidence rules (when present): files under `rip/images_ingame/`, `rip/meshes/`,
`rip/levels/`, and the `*_catalog.json` `how_to_use` fields are **OBSERVED** sources (cite the
path). `rip/briefs/*.md` and `*_GUIDE.md` prose are **research seeds** — Fable may quote them
as `SEED (rip/briefs/GAMEPLAY_BRIEF.md §…)` but must re-derive v1 decisions itself; a rip brief
describing the shipped Unity meta (arena, store, live-ops) never widens v1 scope.

## Step 1 — Seed the source into the project

```bash
PROJECT=/Users/wikz/Works/games/CocosCreator/cc-<slug>
```

- `store`: nothing to do (`store-game-clone` Step 3 already seeded `reference/<slug>/`).
- `media`:
  ```bash
  mkdir -p "$PROJECT/reference/<slug>"
  rsync -a --exclude '.DS_Store' <user media folder>/ "$PROJECT/reference/<slug>/"
  ```
  If a video is present and no frames exist, extract ~10 frames:
  `ffmpeg -i <video> -vf fps=1/3 "$PROJECT/reference/<slug>/video/frames/t%02d.jpg"` (skip if ffmpeg missing; note it).
- `idea`: write the user's text **verbatim** to `$PROJECT/reference/<slug>-brief/IDEA.md`
  (heading `# IDEA — <slug>`, then the text). Fable reads this file, not the chat.

Read at least the key images / frames yourself with the Read tool before Step 3 so you can
judge Fable's OBSERVED claims at the gate. With a rip pack also read `rip/README.md`,
`rip/briefs/GAME_BRIEF.md`, `rip/briefs/GAMEPLAY_BRIEF.md`, and the P0 tables of
`rip/IMAGES_INGAME_GUIDE.md` + `rip/MESHES_GUIDE.md`, and open 2–3 P0 PNGs (one `sactx-*` atlas
page, one door/color kit sprite) so you know what "import" rows should look like.

## Step 2 — AGENT_NOTES.md

Edit only the `brief:` yaml block and `## Notes — fable-game-brief`:

```yaml
brief:
  brief_agent: claude --model fable      # launch spec actually used
  source: store | media | idea
  reference_path: reference/<slug>/      # "" for idea
  rip_path: reference/<slug>/rip/        # "" when no rip pack (intake 2b)
  orientation: landscape 1280x720        # or portrait 720x1280
  authored_at: ""                        # fill after Step 4 (ISO date)
```

Old skeleton without `brief:` → append the block at the end of the leading yaml and add an
empty `## Notes — fable-game-brief` section after `## Notes — store-game-clone`; say so.
Skeleton with `brief:` but no `rip_path` → add the key; say so.
Never touch `bootstrap:`, `store_clone:`, `fleet:`, or other skills' notes.

## Step 3 — Launch Fable

Fill placeholders in [reference/fable-brief-prompt.md](reference/fable-brief-prompt.md)
(`<PROJECT>`, `<SLUG>`, `<SOURCE_BLOCK>`, `<RIP_BLOCK>`, `<ORIENTATION>`, `<DESIGN_RES>`,
`<ENGINE_LINE>`, `<RELEASE_GOAL>`), pick the `<SOURCE_BLOCK>` variant for the mode, and paste
the `<RIP_BLOCK>` variant when intake 2b found a rip pack (delete the placeholder line
otherwise — never leave the literal `<RIP_BLOCK>` in the prompt). Copy
[reference/slice-schema.md](reference/slice-schema.md) to
`$PROJECT/docs/slice-schema.md` first so Fable can read it inside the worktree. Then:

```bash
node ~/.agents/skills/new-cocos-game/scripts/bootstrap.mjs agent-session \
  --path "$PROJECT" \
  --agent "claude --model fable" \
  --title "brief-fable-<slug>" \
  --prompt "$(cat <<'EOF'
<filled prompt>
EOF
)"
```

`agent-session` sends the AGENTS.md boot prompt first, waits `tui-idle`, then the task. If the
JSON says `promptSent: false`, re-send with `orca terminal send <handle> --enter` (without
`--enter` the text stays in draft). Record the terminal handle.

## Step 4 — Gate

Wait for Fable to print the 5-bullet v1 summary and go idle
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
- `MILESTONES.md` yaml has `slices`, `dag`, `v1_slice`, `release_slice`; every id has a
  `slices/S<nn>-*.md` whose front-matter carries `size`, `paths`, `acceptance`, `runtime_checks`,
  `change_budget` (the producer copies these straight into the PLAN).
- Last slice is `release-polish`; the union of all `release_items` covers every `RC-nn` row.
- `parallel_ok` pairs have disjoint `paths`.

Extra rows when a rip pack is present (`brief.rip_path` non-empty):

```bash
cd "$PROJECT" && grep -c 'reference/<slug>/rip/' ASSET_MANIFEST.md HOW_TO.md EXPECT_GAMEPLAY_VISUAL.md   # ASSET_MANIFEST must be > 0
grep -cE '\| *import *\|' ASSET_MANIFEST.md                                                        # ≥ 1 import row
grep -c 'SEED (' GAME_BRIEF.md HOW_TO.md                                                           # allowed, but no SEED row may be the only evidence for a v1 mechanic
```

- `ASSET_MANIFEST.md` has a **Source** column with `import` / `generate` per row; every `import`
  row names an existing file under `reference/<slug>/rip/images_ingame/`, `reference/<slug>/models/`
  or `reference/<slug>/rip/meshes/` (spot-check 3 paths with `ls`). `sactx-*` atlas rows say which
  region to slice, not "use the page". Nothing from a P3 catalog entry appears as P0.
- When v1 loads levels: `HOW_TO.md` has a level-schema section citing `reference/<slug>/rip/levels/<file>.json`
  keys actually used (OBSERVED) and names the sample level(s) v1 ships.
- `SCOPE.md` / `CONTEXT.md` `_Avoid_` list the rip-brief meta systems (arena, store, live-ops, …) as out of v1.

| Result | Action |
|--------|--------|
| A contract missing | Nudge Fable once with the missing file names |
| Rip present but `ASSET_MANIFEST.md` has no `import` rows / no `rip/` paths | Nudge Fable with `reference/<slug>/rip/IMAGES_INGAME_GUIDE.md` + `MESHES_GUIDE.md` P0 tables; do not add rows yourself |
| An `import` path does not exist | Nudge with the exact row; Fable must fix or flip it to `generate` |
| Fable stuck after nudge | Write the remaining files in this chat under the same prompt rules; note it |
| `CONTEXT.md` / ADR missing | Write minimal versions here (domain terms + `_Avoid_`; engine, TS strict, web-mobile, design res, physics off unless the brief needs it) |
| `OBSERVED` in idea mode | Tell Fable to relabel to `GIVEN` / `ASSUMPTION` |
| Slice missing a PLAN field / RC rows uncovered / parallel pair overlaps | Nudge Fable with the exact ids; do not patch slices yourself (they are Fable's contract) |

## Step 5 — Notes + report

- `brief.authored_at` → today.
- `## Notes — fable-game-brief` → 3–5 bullets: source mode, what was OBSERVED vs ASSUMED (or
  GIVEN vs ASSUMED), media that could not be read, files written here instead of by Fable; with a
  rip pack: how many `import` vs `generate` rows, and which rip-brief systems were kept out of v1.
- Report the file list, Fable's v1 summary, the slice table from `MILESTONES.md`
  (id · size · one-liner · `needs_director_ok`), and the terminal handle. Slices flagged
  `needs_director_ok: true` are the director's review list before `game-producer` starts.
  Do **not** commit unless asked; the caller (`store-game-clone` / `new-cocos-game`) decides
  what happens next (`/setup-project` Phase 1–3 skips Phase 0 because the root contracts now
  exist; then `game-producer` per `release.goal`).

## Out of scope

- Crawling stores (`store-game-clone`), bootstrapping projects (`new-cocos-game`)
- Implementing any slice, running `game-producer` or `cocos-orca-fleet`
- Editing slice files after Fable wrote them (re-run Fable with a nudge instead)
- Commit / push
