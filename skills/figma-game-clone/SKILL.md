---
name: figma-game-clone
description: >-
  Build a Cocos Creator game from a Figma design link plus director notes: read the Figma
  file through Orca's embedded browser (Plugin API, no token), optionally rename layers to
  name-name, export assets, fonts, mockups, verbatim designer notes and per-view layout JSON
  into orca-global games/<slug>/, seed GAME_BRIEF, then bootstrap via new-cocos-game, author
  contracts via game-brief (source=media) and hand off game-producer inside the new project.
  Use when the user pastes a figma.com/design (or /file) link and wants a game, assets or a
  brief from it: "làm game từ figma", "figma → cocos", "boot dự án từ figma", "lấy asset từ
  figma", "figma clone", or the love-train-style pipeline.
---

# Figma Game Clone

End-to-end pipeline: **Figma URL (+ director notes) → reference pack in `orca-global/games/<slug>/` → agent combo → Cocos project → game-brief contracts (media) → game-producer**.

It is the Figma twin of [store-game-clone](../store-game-clone/SKILL.md). It was distilled
from the love-train boot (2026-10-06, `games/love-train/`). Steps 1–7 build the pack; Steps
8–12 reuse `new-cocos-game`, `game-brief` and `game-producer` unchanged.

Evidence labels: designer notes in Figma and the director's notes are **GIVEN**; what you saw
in exported mockups or layout JSON is **OBSERVED**; anything you fill in is **ASSUMPTION**.
Never invent mechanics that neither the notes nor the screens show.

## Constants

| Key | Value |
|-----|-------|
| Game folder | `/Users/wikz/orca-global/games/<slug>/` (docs at root, `assets/`, `data/`, `tools/figma/`) |
| Figma CLI | `scripts/figma.mjs` (this skill). `init` copies it to `<game>/tools/figma/figma.mjs`; run that copy from the game folder |
| Figma config | `<game>/tools/figma/figma.json` (file key, URL, root node, file name, design res) + `views.json` (view key → node) |
| Guide template | `reference/figma-guide-template.md` → `<game>/FIGMA_GUIDE.md` via `figma.mjs guide` |
| Games root / slug | `/Users/wikz/Works/games/CocosCreator`, project `cc-<slug>` |
| Bootstrap | `~/.agents/skills/new-cocos-game` (`bootstrap.mjs`, Step 0b agent combo) |
| Brief author | `~/.agents/skills/game-brief`, **source mode `media`**, reference `reference/<slug>/` |
| Producer | `<project>/.cursor/skills/game-producer` (default handoff) |
| Batch art (only when notes ask for new art) | `codex-image-gen`; hero art `orca-gpt-image-gen` |

## Progress checklist

```
Figma Game Clone:
- [ ] 0. Intake (figma URL, slug, notes, rename ok?, implement?, goal, design res)
- [ ] 1. Connect: figma.mjs init + open (Figma tab logged in inside Orca)
- [ ] 2. Survey: frames + overview → register screen/part views → read every screen mockup
- [ ] 3. Notes: FIGMA_NOTES.md verbatim; director notes → GAMEPLAY_NOTES.md
- [ ] 4. Rename layers to name-name (only when allowed): plan → dry-run → apply (auto backup)
- [ ] 5. Assets: draft-jobs → curated jobs → export → QA montage → resize → fonts → manifest
- [ ] 6. Layout JSON for every view + FIGMA_GUIDE.md
- [ ] 7. GAME_BRIEF.md seed + note-driven extras (API/mock, missing art, spine placeholder, multi-res) → pack gate
- [ ] 8. Agent combo (new-cocos-game Step 0b with the pack) → wait for the director's pick
- [ ] 9. Bootstrap cc-<slug> via new-cocos-game (MCP gate)
- [ ] 10. Seed reference/<slug>/ (+ <slug>-brief/GAMEPLAY_NOTES.md), AGENT_NOTES, commit, orca-memory register
- [ ] 11. game-brief source=media → contracts + slices
- [ ] 12. Hand off game-producer IN the project; report; stop coordinating
```

---

## Step 0 — Intake

Ask only what is missing, in one message:

1. **Figma URL**: required. A link with `node-id=` points at the root frame that holds the
   game (screens + notes). Without it, `open` falls back to the current page.
2. **Slug**: default is the slugified game name from the notes, else the file name (`LoveTrain-Dev` → `love-train`).
3. **Notes**: chat text or files. Save them all verbatim in Step 3. Typical kinds, each
   handled in Step 7: art to add ("vfx tim bay gen mới"), animation coming later ("mỗi con
   vật có spine riêng, bổ sung sau"), backend ("drop rate / lượt chăm lấy từ server, làm data
   tạm"), resizing, platform, orientation.
4. **Rename layers in Figma?** Renaming edits the designer's shared file. Do it only when the
   user asked, or answers yes here. It needs edit access. If no, Step 4 is skipped and Step 5
   names files in the jobs instead.
5. **Implement?**: default yes + producer. "chỉ lấy asset / brief" → stop after Step 7.
   "1 slice" → one-slice fleet, as in store-game-clone Step 6.
6. **Release goal / deploy** (announce, do not ask): `end_to_end` + `preview` by default.
   "playable first" → `playable`.
7. **Design resolution**: default = size of the screen frames (Step 2). Ask only when the
   screens disagree or the user mentioned multi-device support.

Agent choices are never asked here. Step 8 settles them, and an agent the user already named is pre-noted.

## Step 1 — Connect

```bash
S=~/.agents/skills/figma-game-clone/scripts/figma.mjs
G=/Users/wikz/orca-global/games/<slug>
node $S init --url "<FIGMA_URL>" --game $G
cd $G && node tools/figma/figma.mjs open
```

`open` finds the tab by file key, or opens it, and waits up to 90 s for the `figma` global. It
writes `fileName` and `rootNode` into `figma.json`.

**Done when:** `open` prints `{page, file, pages, rootNode}`.
**If it fails with "not ready":** the Orca browser tab is on the Figma login page. Ask the user
to log in there (an account that can view the file; edit access for Step 4), then rerun.

## Step 2 — Survey and views

```bash
node tools/figma/figma.mjs survey --depth 3   # assets/reference/figma-tree.txt, figma-frames.json, figma-overview.jpg
```

Read `figma-overview.jpg` and the frame list. Then register each view:

- **screen**: a full-screen frame (e.g. 1080×1920). Key `screen-NN-<what>` in flow order;
  variants `screen-<what>-<variant>`.
- **part**: a block worth its own prefab (header, popup body, bar, action row). Key `part-<what>`.

```bash
node tools/figma/figma.mjs views add screen-01-pet-select 1:735 --kind screen --desc "01 chọn thú (carousel)"
node tools/figma/figma.mjs views add part-love-bar 1:1643 --kind part --desc "thanh yêu thương"
```

Note frames, labels and moodboards are **not** views. Export every screen at half scale now
(`draft-jobs` in Step 5 also includes them) and **Read** each image before you describe the
game. Record the design resolution in `figma.json` as `"designResolution": {"width": 1080, "height": 1920}`.

**Done when:** `views` lists every screen in the flow, and each one has been looked at.

## Step 3 — Notes

```bash
node tools/figma/figma.mjs notes     # FIGMA_NOTES.md: every text/sticky outside screen views, grouped by frame, with node ids
```

Read the whole file. It is the designer's spec (flows, rules, API hints, events) and stays
verbatim; rerun the command, never edit it by hand. Use `--all` only when the notes sit
inside screen frames. Figma comments are not reachable through the Plugin API. Ask the user to
paste any that matter.

Write the director's notes from intake to `$G/GAMEPLAY_NOTES.md` following
[gameplay-notes.md](../game-brief/reference/gameplay-notes.md): source text verbatim plus a
`GP-nn` index.

## Step 4 — Rename layers (only when allowed in intake)

Goal: every layer that becomes a Cocos node or an asset has a semantic kebab name. Examples:
`Group 1000007069` → `love-bar`, `Rectangle 4847` → `love-bar-fill`, `Opt 1` →
`screen-01-pet-select`. That name is also the asset filename.

1. `node tools/figma/figma.mjs sigs`: lists the unique `parent > TYPE:name` signatures in
   screens, with counts, and the non-kebab ones. Use `tree <view> 4` for context.
2. Write `tools/figma/rename-plan.json`:
   - `names` renames everywhere outside library instances (`"Rectangle 4795": "window-cutout-mask"`).
   - `ids` targets one node and wins over `names`. Use it for context-dependent names: the
     same `Icon` as back button vs arrow, `fence-picket-1..n` numbered left to right, pet
     names by variant.
   Generate the `ids` part with a small script over `figma-tree.txt` when a pattern repeats
   across variant screens.
3. Dry-run: `node tools/figma/figma.mjs rename --plan tools/figma/rename-plan.json`. Fix the
   `sample` and the remaining `nonKebab` list (auto-named text layers are already ignored).
4. Apply: add `--apply`. It writes `assets/reference/figma-names-backup.json` first; a second
   apply makes a timestamped backup. To undo: `rename --restore`.

Leave alone: note frames, layers inside external library components (their text shows up in
layout `texts`), and anything outside the game's root frame.

**Done when:** `nonKebab` is empty (or only lists layers that will never become nodes) and
`applied: true`. If it reports `failed`, there is no edit access: tell the user and continue
without renaming.

## Step 5 — Assets

```bash
node tools/figma/figma.mjs images        # image fills grouped by hash → assets/reference/figma-images.json
node tools/figma/figma.mjs draft-jobs    # tools/figma/export-jobs.json: 1 raw job per unique visible image + screen shots
```

Curate `export-jobs.json` before exporting. Each job is
`{id, out, mode: raw|node, hash?, scale?, fmt?, hideTexts?, hideIds?, hideChildrenExcept?, unclip?}`.

| Asset | Job |
|---|---|
| Bitmap art (pets, characters, props, photos) | `mode: raw`, keep `hash`. Original bytes; the extension comes from the data |
| Vector UI (buttons, pills, bars, panels, icons drawn in Figma) | `mode: node` @1x. Use `hideTexts: true` for buttons/pills so the label stays a Label |
| Full-bleed background built from layers | `mode: node` on the screen with `hideIds: [<UI groups>]`, or per layer with `unclip: true` |
| Panel without its content | `hideChildrenExcept: ["card-bg", "card-border"]` |
| Mockups | `reference/screens/<view>.jpg`, `fmt: JPG`, `scale: 0.5` (already drafted) |

Folders: `backgrounds/`, `characters/`, `ui/common/`, `ui/<screen>/`, `icons/`, `vfx/`,
`fonts/`, `reference/`. Use one file per visual. Placeholder text from mockups (`10000`,
`80%`) is never baked into art.

```bash
node tools/figma/figma.mjs export --jobs tools/figma/export-jobs.json   # → assets/, log assets/reference/export-log.json
node tools/figma/figma.mjs resize            # shrink raw bitmaps to cover their Figma slot (love-train: 43 → 24 MB)
node tools/figma/figma.mjs fonts --download  # Google Fonts TTFs (full glyph set, Vietnamese OK)
node tools/figma/figma.mjs manifest          # assets/manifest.json + generated table in ASSET_MANIFEST.md
```

QA: build a montage of the exported files (PIL, `python3 -I`) and **Read** it. Look for
missing pieces, baked text, clipped edges and stray backgrounds. Export one-offs with
`export <nodeId> assets/<dir>/<name>.png [--hide-text] [--unclip] [--raw]`, then rerun
`manifest`. Write usage notes (9-slice borders, which screen uses the asset, fallbacks) in
`ASSET_MANIFEST.md` **above** the generated block; `manifest` keeps them.

A font that is not on Google Fonts: ask the director for the file and never substitute
silently. Note it in GAME_BRIEF.

**Done when:** every job is `ok`, the montage looks right, every font has a status of `ok`
or is listed as pending, and `manifest` has run last.

## Step 6 — Layout + guide

```bash
node tools/figma/figma.mjs layout-all   # data/layout/<view>.json: Cocos coords, sizes, colours, text, fonts, asset links
node tools/figma/figma.mjs guide        # FIGMA_GUIDE.md: how workers read Figma per view
```

Add a per-view checklist below the `<!-- game-specific -->` marker in `FIGMA_GUIDE.md` (view
→ layout files → proposed prefabs → gotchas such as layer order, 9-slice, placeholder text).
`guide` reruns keep it.

## Step 7 — Brief seed + note-driven extras

Write `$G/GAME_BRIEF.md`, the research seed. game-brief rewrites it into contracts and reads
it fully as a director statement. Use the love-train shape:

- Header links to `FIGMA_NOTES.md`, `ASSET_MANIFEST.md`, `FIGMA_GUIDE.md`, `data/layout/`,
  `assets/reference/screens/` and the Figma URL.
- A summary table: genre, engine, design res + resize policy, fonts, main colours (from
  layout fills), characters, animation, backend.
- Core loop (ASCII flow), then one section per screen: purpose, entry/exit, buttons → result,
  server data, events. Cite note node ids.
- Data / catalog tables (characters, items, rewards), open questions, and what is pending
  from the director.

Do the extras **only when the notes or the director ask**. Record each in GAME_BRIEF.

| Note says | Do |
|---|---|
| Values come from the server / "chừa sẵn API" / "data tạm để test" | `API_CONTRACT.md` (endpoints, payloads, errors), `data/config/*.json`, `data/mock/fixtures/*.json` + `scenarios.json`, a tiny stateful `data/mock/mock-server.mjs` |
| New art in the current style (VFX, missing icons) | `codex-image-gen` with exported Figma art as style reference → `assets/vfx/…`, plus particle presets if asked |
| Animation comes later (spine per character) | Keep static art as fallback. If a sample spine was supplied, normalise its file names to the asset key and map all characters to it in `data/config` |
| Multi-device / wide screens | Fit policy in the brief §1b; bleed backgrounds extended past the design frame (love-train: 1080×1920 → 1920×2520) |
| Resize oversized images | `resize --factor <n>` (Step 5) |

**Pack gate** (the input `game-brief` expects in media mode). All of these exist and are non-empty:
`GAME_BRIEF.md`, `FIGMA_NOTES.md`, `FIGMA_GUIDE.md`, `ASSET_MANIFEST.md`,
`assets/manifest.json`, `assets/reference/screens/*.jpg`, `data/layout/*.json`,
`tools/figma/{figma.mjs,figma.json,views.json}`, plus `GAMEPLAY_NOTES.md` when notes were
given. Check JSON validity and that every path cited in the docs exists.

Asset-only / brief-only requests stop here. Report the folder and the gaps.

## Step 8 — Agent combo (the only planned stop after intake)

Run [new-cocos-game Step 0b](../new-cocos-game/SKILL.md) with the pack as the brief: screen
count, asset count, backend/API scope, animation needs, notes. A UI-heavy 2D game with most
art already exported makes the art role light; say so in the `why` cell. Send the combo
table, then stop and wait. Steps 9–12 never ask again.

## Step 9 — Bootstrap

Follow `new-cocos-game` (its Step 0b is settled by Step 8):

```bash
node ~/.agents/skills/new-cocos-game/scripts/bootstrap.mjs create --name cc-<slug> --timeout-ms 240000
```

**MCP gate:** `/health` reports `projectName == cc-<slug>` (`bootstrap.mjs wait-mcp --path …`).
For hangs, use the failure notes in store-game-clone Step 2.

## Step 10 — Seed reference, AGENT_NOTES, commit, memory

```bash
PROJECT=/Users/wikz/Works/games/CocosCreator/cc-<slug>
mkdir -p "$PROJECT/reference/<slug>" && rsync -a --exclude '.DS_Store' $G/ "$PROJECT/reference/<slug>/"
# notes given:
mkdir -p "$PROJECT/reference/<slug>-brief" && cp $G/GAMEPLAY_NOTES.md "$PROJECT/reference/<slug>-brief/"
```

The whole game folder goes in, `tools/figma/` included. Workers then run
`node reference/<slug>/tools/figma/figma.mjs layout <view>` from the project, and the copy
finds its own config.

Fill `AGENT_NOTES.md`. Leave the `bootstrap:` block alone.
- `fleet:` and `release:` come from the Step 8 lock and intake item 6, as in store-game-clone Step 3.
- `orientation`: the design res.
- Add `## Notes — figma-game-clone` with 3–6 bullets:
  - the Figma URL, file key and root node, and whether layers were renamed (backup path);
  - view count, asset count and size;
  - fonts pending;
  - extras done (API mock, VFX, spine placeholder);
  - an `agent combo:` line;
  - "contracts pending" (update it after Step 11).

Initial commit (`chore: bootstrap game from cc-game-template` + `Seed reference/<slug> from Figma <file>.`).
Register with orca-memory per new-cocos-game Step 6a.

## Step 11 — Contracts (game-brief, media)

Follow `~/.agents/skills/game-brief/SKILL.md` with: project, slug, **source mode `media`**,
reference `reference/<slug>/`, design res from Step 2, the brief agent from Step 8, and
`reference/<slug>-brief/GAMEPLAY_NOTES.md` when notes exist. Its gate is the done condition.

Then review semantically:
- Visual targets cite `reference/<slug>/assets/reference/screens/*.jpg`.
- ASSET_MANIFEST rows **import** the exported files and do not regenerate them.
- Mock data matches the mockups (love-train: balance 10010 vs Figma 10000).
- Server-owned values are not hard-coded.

## Step 12 — Producer handoff

Same as store-game-clone Step 6. Spawn the `game-producer` orchestrator inside the project
(never run it from this chat). Report the terminal handle and any `needs_director_ok`
slices, then stop.

---

## Branches

| User ask | Stop after |
|---|---|
| Assets only ("lấy asset từ figma") | Step 5 (+ 6 if they want layout) |
| Brief / data pack only | Step 7 |
| Project + contracts, no implement | Step 11 |
| Playable first | Step 12 with `release.goal: playable` |
| Figma changed after boot | In `reference/<slug>/`: `layout-all`, re-export the changed jobs, `manifest`, `notes`; then game-brief late-notes flow for rule changes |

## Failure notes

| Problem | Action |
|---|---|
| `Figma tab not ready` | The user logs in to Figma inside the Orca browser, then rerun |
| `rename` → `failed` | No edit access. Skip renaming; name files in the jobs |
| `node not found` on export | Stale id after a designer edit. Rerun `survey`, fix the views/jobs |
| Export clipped at the screen edge | `unclip: true` (or `--unclip`) |
| Button image has its label baked in | `hideTexts: true` |
| Same picture twice in `draft-jobs` | A node with two image fills. Keep the job whose `hash` is visible in the mockup |
| Raw bitmap huge (4K for a small slot) | `resize`, then `manifest` |
| Font `missing` | Not on Google Fonts. Ask for the file; list it as pending in GAME_BRIEF |
| `browserPageId` changed | Expected. The CLI looks the tab up by file key every call |
| Notes empty | Notes sit inside screens → `notes --all`; or there are none → rely on the director's notes and mark rules ASSUMPTION |

## Out of scope

- Editing the design itself in Figma (renaming layers is the only write, and only with consent)
- FigJam boards and prototype interactions (flows come from notes and screen order)
- Coordinating producer / fleet workers from this chat
- Replacing `new-cocos-game`, `game-brief`, `game-producer` internals

## References

- Love-train pack (worked example): `/Users/wikz/orca-global/games/love-train/` (GAME_BRIEF, FIGMA_NOTES, FIGMA_GUIDE, API_CONTRACT, data/, tools/figma/)
- Guide template: [reference/figma-guide-template.md](reference/figma-guide-template.md)
- Gameplay notes format: [../game-brief/reference/gameplay-notes.md](../game-brief/reference/gameplay-notes.md)
- Sibling skills: `store-game-clone`, `new-cocos-game`, `game-brief`, `game-producer`, `codex-image-gen`, `orca-cli`
