---
name: store-game-clone
description: >-
  Clone any Apple App Store game into a Cocos Creator project: crawl store
  metadata/screenshots/trailer into orca-global assets, optionally merge a
  unity-apk-rip output pack (ripped PNG/GLB/levels + rip briefs/guides) into the
  same reference pack, bootstrap cc-<slug> via new-cocos-game, author
  GAME_BRIEF/HOW_TO/EXPECT/ASSET_MANIFEST via the fable-game-brief skill
  (source=store), then hand off game-producer (end_to_end by default, or playable)
  — or a single cocos-orca-fleet slice — inside the new project (art backend
  antigravity by default). Use when the user pastes an apps.apple.com link and
  wants a Cocos clone, "crawl store", "store brief", "clone game từ App Store",
  "store → cocos", "xài thêm assets rip", or the Nitelore-style pipeline.
---

# Store Game Clone

End-to-end pipeline: **App Store URL (+ optional rip pack) → reference pack → Cocos project → Fable contracts (+ slices) → game-producer (fleet per slice → commit/merge → ship)**.

Do **not** invent mechanics from marketing copy alone — OBSERVE screenshots/trailer (and rip assets / models if present). Mark ASSUMPTION vs OBSERVED in briefs.

A **rip pack** is the `output/` folder produced by `~/.agents/skills/unity-apk-rip` (`manifest.json`
with `unity_version` + `counts`, `images_ingame/`, `meshes/`, `levels/`, `briefs/*.md`, `*_GUIDE.md`,
`*_catalog.json`, `README.md`). It is **additive** to the store crawl, never a replacement: the store
pack gives feel / HUD / marketing look, the rip gives exact in-game art, mesh topology, and level schema.

## Constants

| Key | Value |
|-----|-------|
| Assets root | `/Users/wikz/orca-global/assets/<slug>/` |
| Research brief (optional) | `/Users/wikz/orca-global/<slug>-brief/` |
| Games root | `/Users/wikz/Works/games/CocosCreator` |
| Project slug | `cc-<slug>` |
| Bootstrap | `~/.agents/skills/new-cocos-game` (`bootstrap.mjs`) |
| Crawl script | `scripts/crawl-app-store.mjs` (this skill) |
| Rip pack (optional) | any `unity-apk-rip` `output/` dir, e.g. `/Users/wikz/Works/agent/assets-ripper/<game>/output` |
| Rip merge script | `scripts/merge-rip-pack.mjs` (this skill) → `assets/<slug>/rip/` + P0 GLBs into `assets/<slug>/models/` |
| Brief author | `~/.agents/skills/fable-game-brief` (Claude `--model fable`; override only if user names another) |
| Producer | `<project>/.cursor/skills/game-producer` (default handoff; runs slices per `AGENT_NOTES.md` `release.goal`) |
| Fleet | `<project>/.cursor/skills/cocos-orca-fleet` (one slice only, when the user asks for just that) |
| Art backend default | `antigravity` |
| Orchestrator default | `cursor --model auto` (`cursor-agent --trust --model auto`); user may name agent + model, e.g. `claude --model opus` → stored in `AGENT_NOTES.md` `fleet.orchestrator_agent`, passed to `agent-session --agent` |
| Fleet workers default | `planner_agent: claude --model opus --effort high`, `writer_agent: claude --model opus --effort high`, `reviewer_agent: claude --model opus` (from the `AGENT_NOTES.md` skeleton; override only if user names one) |
| Agent handoff file | `<project>/AGENT_NOTES.md` — this skill fills `store_clone:` + `fleet:` overrides in the yaml block and `## Notes — store-game-clone`; `fable-game-brief` fills `brief:`; the fleet reads `fleet:` (prompt > file > skill default) |

## Progress checklist

```
Store Game Clone:
- [ ] 0. Intake (store URL, slug, orientation?, design res?, implement?, goal=end_to_end|playable, art backend?, fleet workers?, rip pack?)
- [ ] 1. Crawl App Store → assets/<slug>/ (+ optional <slug>-brief/STORE_DATA.md)
- [ ] 1b. Rip pack given → merge-rip-pack.mjs → assets/<slug>/rip/ + models/ (skip when none)
- [ ] 2. Bootstrap cc-<slug> via new-cocos-game (MCP gate = projectName match)
- [ ] 3. Seed reference/<slug>/ into the project; fill AGENT_NOTES.md; initial commit if not done
- [ ] 4. fable-game-brief (source=store) authors GAME_BRIEF + HOW_TO + EXPECT + ASSET_MANIFEST + contracts
- [ ] 5. Verify CONTEXT.md + docs/adr/0001-tech-stack.md (fable-game-brief gate normally writes them)
- [ ] 6. Hand off game-producer IN the project (default) — or cocos-orca-fleet for one slice
- [ ] 7. Report paths + terminal handles; stop coordinating from this chat
```

---

## Step 0 — Intake

Ask only what's missing:

1. **App Store URL** (or numeric id) — required
2. **Slug** — default from store name (`nitelore` → assets + `cc-nitelore`)
3. **Orientation / design res** — default landscape `1280×720` if store shots are landscape; else portrait `720×1280`
4. **Implement?** — default **yes + producer** when user asked to clone/build; **crawl-only** if they only want assets/brief; **one fleet slice** only when they say "1 slice" / "fleet thôi"
4b. **Release goal** (announce, do not ask) → `AGENT_NOTES.md` `release.goal`: default
   `end_to_end` (all slices then ship); `playable` when they say "bản chơi được trước" /
   "playable first" / "v1 thôi" / "prototype". `release.deploy` default `preview`
   ("lên prod" → `prod`, "không deploy" → `none`).
5. **Art backend** — default `antigravity`; honor `cursor` / `gpt-image-gen` if named
6. **Brief agent** — default Claude Fable (via `fable-game-brief`); honor explicit override
7. **Fleet workers** — never ask. Only when the user names an agent for the fleet's
   writer / reviewer / "workers" ("fleet chạy cursor agent", "reviewer dùng opus", …):
   record `writer_agent` / `reviewer_agent` / `planner_agent` as launch specs (`cursor agent` → `cursor --model auto`;
   bare `claude` → `claude --model opus`). Unnamed → keep the `AGENT_NOTES.md` skeleton defaults
   (`claude --model opus …`). Note that the orchestrator (item in Step 6, default `cursor`) is a
   different knob from the workers.
8. **Rip pack** — never ask. Accept when the user gives a folder path and says "assets rip",
   "ripped assets", "unity-apk-rip output", "xài thêm assets rip", or the path ends in `/output`
   and contains `manifest.json` + one of `images_ingame/` `meshes/` `levels/` `briefs/`.
   Record the absolute path for Step 1b. Sub-options (only if the user says so):
   `--include-full-images` (they want the 200 MB+ `images/` dump too), `--models-priority P1`
   (obstacle/booster meshes as well), `--models-priority none` (2D-only game, skip GLB import).
   A folder that has media but no rip `manifest.json` is **not** a rip pack → treat it as extra
   media: rsync into `assets/<slug>/extra/` and tell Fable about it in Step 4; do not fake catalogs.

Optional: existing models at `assets/<slug>/models/` (GLB + Blender script) — prefer import over regen.
Step 1b fills `models/` from the rip catalog when a rip pack is given.

---

## Step 1 — Crawl

```bash
node ~/.agents/skills/store-game-clone/scripts/crawl-app-store.mjs \
  --url "<STORE_URL>" \
  --slug <slug>
# or: --id <numericId> --country us
```

**Done when:** `assets/<slug>/manifest.json` exists, `icon-1024.png` present, ≥1 screenshot, trailer `video/preview.mp4` if store has one.

Then write a short research pack (can be agent-authored, not required for implement):

- `/Users/wikz/orca-global/<slug>-brief/STORE_DATA.md` — identity, IAP, full description, release notes
- Optional shallow `GAME_BRIEF.md` seed — Fable will rewrite at project root

Read screenshots (and key trailer frames) with the Read tool before claiming feel/HUD facts.

---

## Step 1b — Merge rip pack (only when intake item 8 gave one)

Run **after** Step 1 so the store `manifest.json` already exists (the script appends a `rip` key to it):

```bash
node ~/.agents/skills/store-game-clone/scripts/merge-rip-pack.mjs \
  --rip /Users/wikz/Works/agent/assets-ripper/<game>/output \
  --slug <slug>
# optional: --include-full-images | --models-priority P0|P1|none | --force | --dry-run
```

What it does (deterministic — do not redo by hand):

| Source (rip `output/`) | Destination in `assets/<slug>/` | Rule |
|------------------------|----------------------------------|------|
| `README.md`, `manifest.json`, `*_GUIDE.md`, `*_catalog.json`, `images_ingame_manifest.json` | `rip/` | always |
| `images_ingame/`, `meshes/`, `levels/`, `briefs/` | `rip/…` | always |
| `images/` (full Texture2D dump) | `rip/images/` | **skipped** when `images_ingame/` exists, unless `--include-full-images` |
| `meshes/<file>.glb` with `meshes_catalog.json` `priority == P0` | `models/<file>.glb` (flat) | default; `--models-priority P1` widens, `none` skips; existing files kept unless `--force` |
| — | `rip/RIP_PACK.json` | summary: source, dirs copied/excluded, counts, models list |
| — | `manifest.json` → `rip: {…}` | lets Fable / fleet detect the pack from the store manifest |

**Done when:** stdout JSON has `ok: true`, `format: "unity-apk-rip"`, `rip/RIP_PACK.json` exists and
`models/` holds the P0 GLBs (`models.copied + models.skipped_existing == models.files.length`).
`format: "unknown"` (no `unity_version` / `counts` in the rip manifest) is allowed but must be
called out in `## Notes — store-game-clone` — the catalogs may be missing, so Fable has to read
the folders directly.

Then **read** `rip/README.md`, `rip/briefs/GAME_BRIEF.md`, `rip/briefs/GAMEPLAY_BRIEF.md`, and skim
`rip/IMAGES_INGAME_GUIDE.md` + `rip/MESHES_GUIDE.md` before Step 3 so you can (a) fill the Notes
bullets and (b) judge Fable's OBSERVED claims at the Step 4 gate. Rip briefs are **research seeds**:
they say what the shipped Unity game does, not what v1 of the Cocos clone should be — Fable must
rewrite, not rubber-stamp.

---

## Step 2 — Bootstrap Cocos

Follow **`new-cocos-game`** end-to-end (read that skill; do not reimplement rsync/MCP pinning):

```bash
node ~/.agents/skills/new-cocos-game/scripts/bootstrap.mjs resolve --name cc-<slug>
node ~/.agents/skills/new-cocos-game/scripts/bootstrap.mjs create \
  --name cc-<slug> --timeout-ms 240000
```

**MCP gate:** `/health` on the project's pinned port must report `projectName == cc-<slug>`.

**If `create` hangs after "open Cocos Creator":** `openEditor` uses `spawnSync` and can block while Creator stays open. Kill only the stuck `bootstrap.mjs` process (not Creator), then:

```bash
node ~/.agents/skills/new-cocos-game/scripts/bootstrap.mjs wait-mcp \
  --path /Users/wikz/Works/games/CocosCreator/cc-<slug>
```

Proceed only when wait-mcp JSON has `mcp.ok: true`.

---

## Step 3 — Seed reference + commit

```bash
PROJECT=/Users/wikz/Works/games/CocosCreator/cc-<slug>
mkdir -p "$PROJECT/reference/<slug>"
rsync -a --exclude '.DS_Store' \
  /Users/wikz/orca-global/assets/<slug>/ \
  "$PROJECT/reference/<slug>/"
# if research brief exists:
mkdir -p "$PROJECT/reference/<slug>-brief"
rsync -a /Users/wikz/orca-global/<slug>-brief/ "$PROJECT/reference/<slug>-brief/" || true
```

Then fill `$PROJECT/AGENT_NOTES.md` (skeleton shipped by the template; `new-cocos-game`
already wrote `bootstrap:` — do not touch it):

- yaml `store_clone:` → `store_url`, `slug`, `reference_path: reference/<slug>/`, and
  `rip_path: reference/<slug>/rip/` + `rip_source: <absolute rip output path>` when Step 1b ran
  (both `""` otherwise). Old skeleton without `rip_path` / `rip_source` → add the two keys under
  `store_clone:` and say so. (`brief_agent` / `orientation` live in the `brief:` block, written
  by `fable-game-brief` in Step 4.)
- yaml `fleet:` → set `art_backend` from intake item 5, and `writer_agent` / `reviewer_agent` /
  `planner_agent` **only** if intake item 7 named them; otherwise leave the skeleton defaults untouched.
  `orchestrator_agent` stays whatever `new-cocos-game` wrote unless the user named one — then
  write it as a launch spec (`claude --model opus`, `cursor --model gpt-5 --effort high`); Step 6
  passes that string to `agent-session --agent`.
- yaml `release:` → `goal` + `deploy` from intake item 4b. Leave `auto_commit` / `auto_merge`
  at skeleton defaults unless asked; never touch `current_slice` / `slices` / `*_url`
  (owned by `game-producer`).
- `## Notes — store-game-clone` → 3–6 bullets: what was OBSERVED (screenshots/trailer frames
  read) vs ASSUMED, what the crawl could not fetch (no trailer, no m3u8, lookup country),
  whether `models/` exists, and that Fable contracts are pending (update this bullet after
  Step 4 with the file list Fable produced). With a rip pack add one bullet: source path,
  `format`, dirs merged / excluded (`images/` dump skipped?), P0 GLB count in `models/`, which
  rip briefs/guides exist, and "rip briefs = seed, Fable rewrites".

Never edit `## Notes — new-cocos-game` or `## Notes — cocos-orca-fleet`. Skeleton missing →
copy from `/Users/wikz/Works/games/template/cc-game-template/AGENT_NOTES.md` and say so.

Initial commit if none yet:

```bash
cd "$PROJECT" && git add -A && git commit -m "$(cat <<'EOF'
chore: bootstrap game from cc-game-template

Seed reference/<slug> from App Store crawl.
EOF
)"
```

(With a rip pack, mention it in the commit body: `+ unity-apk-rip pack under reference/<slug>/rip/`.
`rip/` is typically 50–100 MB without the `images/` dump — acceptable for a reference folder; if the
user asked for `--include-full-images` (200 MB+), say so before committing.)

**Done when:** `reference/<slug>/manifest.json` readable inside the project,
`AGENT_NOTES.md` `store_clone.slug` == `<slug>`, and — when Step 1b ran —
`reference/<slug>/rip/RIP_PACK.json` exists and `store_clone.rip_path` points at it.

---

## Step 4 — Fable contracts (via `fable-game-brief`)

Read `~/.agents/skills/fable-game-brief/SKILL.md` and follow it end-to-end with:

- project = `$PROJECT`, slug = `<slug>`
- **source mode = `store`** (`reference/<slug>/manifest.json` exists from Step 3)
- `<STORE_URL>` filled in the `store` source block; orientation / design res from intake item 3
- brief agent from intake item 6 (default `claude --model fable`)
- **rip pack present** (`reference/<slug>/rip/RIP_PACK.json` exists) → that skill detects it from
  `store_clone.rip_path`, fills `<RIP_BLOCK>` in the Fable prompt, and adds the rip gate rows
  (ASSET_MANIFEST `import` vs `generate` column, level schema in HOW_TO when v1 loads levels).
  Do not paste rip paths into the prompt yourself — `fable-game-brief` owns that block.

That skill seeds nothing new for `store`, fills `AGENT_NOTES.md` `brief:`, launches Fable through
`bootstrap.mjs agent-session` in `$PROJECT`, and gates on the 8 root contracts + `CONTEXT.md` +
`docs/adr/0001-tech-stack.md` + `MILESTONES.md` + `slices/` + `RELEASE_CHECKLIST.md`.

**Done when:** its gate passes (Fable printed the 5-bullet v1 summary + slice table; files
non-empty). Then update the `## Notes — store-game-clone` bullet with the file list Fable
produced. Slices flagged `needs_director_ok: true` go into the report for the user — the
producer will `ask` about them before dispatch.

Do not commit contracts unless the user asks.

---

## Step 5 — CONTEXT + ADR (verify)

`fable-game-brief` Step 4 already writes minimal `CONTEXT.md` / `docs/adr/0001-tech-stack.md`
when Fable skipped them. Only re-check they exist and mention the right engine
(Creator 3.8.x or COCOS 4) and design res.

Skip interactive `/setup-matt-pocock-skills` unless the user wants it — fleet needs the five root contracts + CONTEXT/ADR, not the full grill.

---

## Step 6 — Producer handoff (implement=yes, default)

**Hard rule (from new-cocos-game):** never run `game-producer` or `cocos-orca-fleet` from the
bootstrap chat. Spawn the orchestrator inside the project.

Default = `game-producer`: use the prompt in
`$PROJECT/.cursor/skills/game-producer/reference/producer-prompt.md` (fill `<PROJECT>`, slug;
title `producer-cc-<slug>`; `--agent "<fleet.orchestrator_agent>"`). Keep the Overrides block
only for values the user changed after Step 3 — the producer reads `release:` and `fleet:` from
`AGENT_NOTES.md`. With a rip pack, `ASSET_MANIFEST.md` already carries the `import` rows (Step 4
gate), so the art lane imports from `reference/<slug>/rip/…` + `reference/<slug>/models/` instead
of generating — no extra prompt line needed. It runs the director gate, the slice loop (`cocos-orca-fleet` per L slice),
commits/merges per `release.auto_*`, and ships per `release.deploy`; stops after `v1_slice`
when `release.goal: playable`.

**Done when:** producer terminal handle is returned and the agent is reading contracts /
asking its director gate. Report the handle + the `needs_director_ok` slices, then stop
monitoring.

### One-slice fleet (only when the user asked for a single slice / fleet only)

```bash
# --agent takes the spec from AGENT_NOTES.md fleet.orchestrator_agent verbatim
# (default "cursor --model auto"; e.g. "claude --model opus" when the user asked for it).
node ~/.agents/skills/new-cocos-game/scripts/bootstrap.mjs agent-session \
  --path "$PROJECT" \
  --agent "<fleet.orchestrator_agent>" \
  --title "fleet-cc-<slug>" \
  --prompt "$(cat <<'EOF'
…see reference/fleet-orchestrator-prompt.md…
EOF
)"
```

Preview the launch command first if the user named a model:
`bootstrap.mjs agent-cmd --agent "<spec>"` → check `command` carries `--model` and the
skip-permissions flag. Compare the result's `session.agentSpec` with the yaml; fix the yaml if
they differ.

The prompt points the orchestrator at `AGENT_NOTES.md` `fleet:` for `art_backend`,
`writer_agent`, `reviewer_agent`. Because `AGENT_NOTES.md` already carries the intake values,
the prompt's override line is only for something the user changed *after* Step 3; otherwise
delete that line. Before handoff, re-read the yaml block once and confirm it matches intake
(`art_backend`, workers) — the file is the source the fleet will trust.

**MCP approval dialog** on first Cursor agent open: send `a` + `--enter`, then **re-send the full fleet prompt** (approval can swallow the first payload). The fleet still finds its config in `AGENT_NOTES.md` even if a prompt payload was lost.

Name `slices/S01-*.md` in the prompt so the fleet copies its PLAN from it.

**Done when:** orchestrator terminal handle is returned and the agent is working (reading contracts / creating worktree). Then **stop monitoring** — report handle to the user.

---

## Crawl-only / brief-only branches

| User ask | Stop after |
|----------|------------|
| Crawl / screenshots / trailer only | Step 1 (+ 1b if a rip pack was given) |
| Brief docs only (no Cocos) | Step 1 (+ 1b) + write into `<slug>-brief/` without bootstrap |
| Rip pack only, no store URL | Not this skill — use `fable-game-brief` mode `media` with the rip `output/` as the media folder |
| Project + contracts, no implement | Through Step 5 |
| Playable first | Through Step 6 with `release.goal: playable` (producer stops after `v1_slice`) |
| One slice via fleet | Through Step 6, one-slice fleet branch |
| Full clone (default) | Through Step 6, producer with `release.goal: end_to_end` |

---

## Failure notes

| Problem | Action |
|---------|--------|
| Lookup empty | Wrong id/country; try `us` |
| No m3u8 | Screenshots-only pack OK; note in manifest |
| ffmpeg missing | Install ffmpeg or skip trailer |
| Target `cc-<slug>` exists | Abort; pick another slug |
| Funplay wrong `projectName` | `bootstrap.mjs mcp-config` → new port → restart Creator → `wait-mcp` |
| Fable stuck after one file | Handled by `fable-game-brief` Step 4 (nudge once, then finish contracts in-chat) |
| Fleet / producer idle after MCP approve | Resend the prompt with `--enter` |
| Producer says no `MILESTONES.md` / `slices/` | Step 4 gate was skipped — re-run `fable-game-brief` (nudge Fable for H/I/J) before handing off |
| Fleet locked `claude opus` although user asked cursor workers | `AGENT_NOTES.md` `fleet.writer_agent` was not written in Step 3, or the prompt override line contradicts it. Fix the yaml, tell the orchestrator to re-read AGENT_NOTES.md before Step 0.2 (only possible before any Task started) |
| `merge-rip-pack.mjs` dies "no images/ … under" | Wrong folder — point `--rip` at the `output/` dir, not the workdir or `ripped/` |
| `merge-rip-pack.mjs` `format: "unknown"` | Not a `unity-apk-rip` manifest; merge still happened. Note it; Fable reads folders directly (no catalogs) |
| `models.copied: 0` with a rip pack | No `meshes_catalog.json` or no P0 rows — 2D-only game or catalog not enriched. Fine for sprite games; otherwise rerun `unity-apk-rip` Step 4 then `--force` |
| Fable ASSET_MANIFEST has no `import` rows although rip exists | Step 4 gate (fable-game-brief) missed the rip — nudge Fable with `reference/<slug>/rip/IMAGES_INGAME_GUIDE.md` + `MESHES_GUIDE.md` |
| Fleet regenerates art that exists in `rip/images_ingame/` | `ASSET_MANIFEST.md` row says `generate` for it — fix the manifest via a Fable nudge, not the fleet prompt |

## Out of scope

- Google Play crawl (extend script later; do not fake Apple fields)
- Running the rip itself (`unity-apk-rip` owns APK → `output/`); this skill only merges an existing `output/`
- Coordinating producer / fleet workers from this chat
- Push / remotes
- Replacing `new-cocos-game`, `fable-game-brief`, `game-producer`, or `cocos-orca-fleet` internals

## References

- [fleet-orchestrator-prompt.md](reference/fleet-orchestrator-prompt.md) — one-slice fleet branch
- Producer prompt: `<project>/.cursor/skills/game-producer/reference/producer-prompt.md`
- Fable prompt: `~/.agents/skills/fable-game-brief/reference/fable-brief-prompt.md` (`<RIP_BLOCK>` variant for rip packs)
- Rip pack format: `~/.agents/skills/unity-apk-rip/reference/output-readme-template.md`
- Sibling skills: `new-cocos-game`, `fable-game-brief`, `game-producer`, `cocos-orca-fleet`, `unity-apk-rip`, `orca-cli`
