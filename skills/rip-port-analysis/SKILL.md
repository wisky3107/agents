---
name: rip-port-analysis
description: >-
  Analyze a recovered Unity rip project before a Cocos port. Use when a clone or port
  includes one or more unity-apk-rip outputs, recovered Unity projects, or asset-only
  rip packs. Assign the forensic pass to a configurable mid-tier agent such as Cursor Auto,
  Claude Sonnet, or Codex Terra and produce evidence-backed logic, state, level, asset,
  and port-gap maps for game-brief and implementation workers.
---

# Rip port analysis

This skill is the forensic phase of a **port flow**. When a recovered Unity project is
available, its readable code, serialized data, scenes, prefabs, levels, and asset wiring
are the primary evidence for behavior. Store screenshots and video validate visual target
and visible HUD details. The analyst does not implement Cocos code and does not turn every
Unity feature into v1 scope.

## Inputs

The caller supplies:

```text
PROJECT=/Users/wikz/Works/games/CocosCreator/cc-<slug>
SLUG=<slug>
RIP_OUTPUT=/absolute/path/to/unity-apk-rip/output
UNITY_PROJECT=/absolute/.../ripped/UnityProject/ExportedProject # analysis root; required for code/data forensics
PRIMARY_CONTENT=/absolute/.../ripped/PrimaryContent              # optional; GLB lookup only
ANALYST_AGENT=cursor --model auto                                # optional
```

Resolve these from `output/manifest.json` `source_paths` (`unity_project`, `primary_content`)
when the caller gives only a workdir/output. **Never point the analysis at `ripped/`.**
`UnityProject/ExportedProject` is the complete tree: every script stub, every serialized
`.asset` (MonoBehaviour/ScriptableObject, Mesh, Sprite), prefabs, scenes, anim/controllers,
materials, TextAssets, audio, fonts and textures. `PrimaryContent` has no scripts and no
`.asset` files; it only adds GLB conversions of meshes/prefab hierarchies (plus Unity
built-in PNG/TTF). Pointing at `ripped/` lets the analyst sample the wrong tree and miss the
serialized data.

Read [references/port-contract.md](references/port-contract.md) before preparing sources or
dispatching. It defines source resolution, multi-source isolation, the evidence manifest,
report schema, contract handoff, and coverage levels. A raw Unity tree can be analyzed without
an output pack. An output-only pack takes this same flow with `assets_only` coverage.
The workspace may be a Cocos project or a research workspace for a docs-only request.

## Output location and contract

Write into the project so later agents can use the evidence without the large Unity export:

```text
PROJECT/reference/<slug>/rip-port/
├── RIP_PORT_MANIFEST.json
├── RIP_INVENTORY.json      # whole-tree counts from scripts/inventory-rip.mjs
├── RIP_LOGIC_MAP.md
├── RIP_STATE_MACHINE.md
├── RIP_LEVEL_SCHEMA.md
├── RIP_ASSET_MAP.md
└── RIP_PORT_GAPS.md
```

`RIP_PORT_MANIFEST.json` follows the linked contract: source IDs/roots, actual code
availability, hashed evidence files, stable claim IDs, report hashes, coverage, and unresolved
questions. Source citations are relative to their identified source root; reports/assets in
the Cocos project use project-relative paths. Never invent a project-local copy of external code.

## Analyst assignment

Resolve explicit caller override → saved `rip_port.analyst_agent` → `cursor --model auto`.
Accepted examples are `cursor --model auto`, `claude --model sonnet`, and
Codex Terra using its configured provider model ID (do not assume the literal alias `terra`
exists); validate the launch spec with
`~/.agents/skills/new-cocos-game/scripts/bootstrap.mjs agent-cmd --agent '<spec>'` before
launching. This checks command construction, not provider model availability; an actual
model rejection is surfaced, never silently replaced. The analyst is a bounded reader and
mapper. It must not choose release scope, edit contracts, implement runtime code, or generate art.

Default to one analyst, including several small source projects. For large sources, the
coordinator may split by subsystem/source using the same locked mid-tier spec. Give each
worker a disjoint `rip-port/parts/<id>/` output directory; workers never dispatch. One
consolidator writes the canonical reports after all parts return. Preserve source/version
identity and record canonical choices in `RIP_PORT_GAPS.md`; never mix same-name enum/asset
files across versions without a documented choice. Unresolved choices remain UNKNOWN.

## Launch and ownership

The coordinator prepares `rip_port` in AGENT_NOTES (add only this block if absent):

```yaml
rip_port:
  enabled: true
  analysis_path: reference/<slug>/rip-port/
  analyst_agent: cursor --model auto
  status: pending                     # pending | analyzing | reviewed
  logic_coverage: pending
  sources:
    - id: main
      root: /absolute/original/workdir
      output: /absolute/original/workdir/output # empty when no output; SEED only
      unity_project: /absolute/original/workdir/ripped/UnityProject/ExportedProject # analysis root; empty when unavailable
      primary_content: /absolute/original/workdir/ripped/PrimaryContent # GLB lookup only; empty when unavailable
      log: /absolute/original/workdir/assetripper.log # empty when unavailable
      staged_assets: reference/<slug>/rip/ # empty until mapped/importable
```

Before launch, the coordinator writes the whole-tree inventory (one run per source ID, same
output file):

```bash
node ~/.agents/skills/rip-port-analysis/scripts/inventory-rip.mjs --id main \
  --source /absolute/original/workdir/output \
  --out "$PROJECT/reference/<slug>/rip-port/RIP_INVENTORY.json"
```

It resolves ExportedProject/PrimaryContent/output/log (override with `--unity-project`,
`--primary-content`, `--output`, `--log`) and prints counts, dummy-script share,
`codeAvailability`, `coverageFloor` and `metadataFailure`. Include that summary in the
analyst task. The analyst reads the inventory; it does not re-sample to decide what exists.

Read `~/.agents/skills/orca-cli/SKILL.md` for terminal operations. Read
[references/analyst-prompt.md](references/analyst-prompt.md), fill it with the source list,
absolute contract path and allowlisted output directory, and save the filled spec under
`rip-port/analyst-task.md`. Launch from PROJECT through the installed bootstrap launcher:

```bash
node ~/.agents/skills/new-cocos-game/scripts/bootstrap.mjs agent-session --json \
  --path "$PROJECT" --agent "$ANALYST_AGENT" --title "rip-analysis-<slug>" \
  --prompt "Read <absolute analyst-task.md> and execute only that forensic task."
```

Record the returned handle and actual session.agentSpec; set status=analyzing. If promptSent
is false, send the same task once using the terminal API. Wait in intervals no longer than
60 seconds, inspecting report/evidence progress after idle. One precise nudge for missing
artifacts is appropriate; verify the old process/jobs have stopped before replacing a failed
analyst. A spinner, idle terminal, or analyst's prose is not completion. No automatic stronger
model escalation. A launch failure leaves analysis pending and is reported with its error.

## Procedure

1. Read `RIP_INVENTORY.json` first, then `output/manifest.json`, `output/README.md`,
   catalogs, guides and representative levels as SEED. The inventory, not the output README,
   defines what exists: script assemblies (total vs `Dummy class`), serialized MonoBehaviours
   with fields grouped by directory, prefabs, scenes, anim/controllers, TextAssets, audio,
   fonts, textures, PrimaryContent GLBs and output levels. Record Unity version and scripting
   backend. When `metadataFailure` is true, quote the `assetripper.log` lines (e.g. Cpp2IL
   "magic number check failed" → Unknown backend → every script a Dummy class), state the
   cause in `codeRecovery`, and name the recovery path (decrypted `global-metadata.dat` +
   Il2CppDumper/Cpp2IL re-run, or a Mono build) as a gap. Do not attempt it yourself.
2. Trace core behavior. Readable bodies: follow callers and data readers from `*Model`,
   `*Core`, `*Sim`, `*State*`, `*Manager`, `*Level*`, config objects and enums. **Stubs are
   still evidence of declarations**: game-assembly type names, namespaces, field names, enums
   and ScriptableObject class names (cite as `code` with `INFERRED`, never as behavior).
   Pair them with the serialized MonoBehaviour `.asset` values in `Assets/**` (tuning, curves,
   tables, art locators, spline/camera configs), which are `OBSERVED` data. Scan the game
   assemblies from `gameAssemblyCandidates`, not only `Assembly-CSharp`. Read the
   `withFieldsByDir` directories that touch the core loop; do not rely on a sampled subtree.
3. Map the runtime loop and level schema. Record triggers, guards, state changes, reset and
   win/lose paths, plus the exact JSON keys or serialized fields actually read by the core
   loop. Choose one to three representative level files; do not assert that every key is
   gameplay data merely because it appears in a dump.
4. Map logic to assets. Link classes/prefabs/enums/serialized locators to de-atlased PNGs,
   fonts, audio (sfx/music by feature directory), GLBs, VFX and catalog rows. Resolve GLBs by
   stem in PrimaryContent; everything else comes from ExportedProject. Flag uGUI/popup/
   toolbar/leaderboard mesh noise and missing references.
5. Record Cocos substitutions and uncertainty. Map `MonoBehaviour` lifecycle, prefab,
   ScriptableObject, Animator, UnityEvent, Addressables, and ParticleSystem concepts to
   Cocos equivalents only when evidence shows they matter. Put unknown or conflicting
   behavior in `RIP_PORT_GAPS.md` with a proposed verification step.
6. Dispose of every nonzero inventory category in `inventoryCoverage`: `mapped` with the RP
   claims that use it, or `excluded` with a reason (e.g. "SDK/third-party", "out of v1
   scope", "port renders 2D"). Nothing in the inventory may be silently skipped.
7. The analyst writes `status: analyzed`, not reviewed. The coordinator runs the validator
   with `--allow-analyzed --recheck-inventory`, then reads all reports and verifies the cited
   input, resolution, win/lose/reset rules, level readers, and representative import mappings
   against source. Stubs prove declarations only. Check inference/unknown labels,
   source-version conflicts and report completeness; a content hash alone cannot prove
   semantics. Walk the review checklist below. Send exact gaps to the same analyst. After a
   successful review only the coordinator sets status=reviewed, records a short review in
   `rip-port/review.md` (including the checklist result), and updates AGENT_NOTES.

## Coverage rule

Coverage follows the inventory, not the analyst's impression:

- `readable_logic` — method bodies of the core paths were read (`codeAvailability`
  readable/mixed).
- `partial` — minimum whenever the inventory has any scripts (even 100% stubs) or any
  serialized MonoBehaviour with fields. Declarations + serialized values are real evidence.
- `assets_only` — only when the inventory has zero scripts and zero serialized fields
  (output-only pack or a tree with nothing but media).

`codeAvailability` must equal the inventory value (all Dummy → `stubs`, none → `readable`,
some → `mixed`, no `.cs` → `none`). The validator enforces both.

## Review checklist

The coordinator answers each line in `review.md` with the claim IDs or the exclusion reason:

- [ ] Analysis root is `UnityProject/ExportedProject`; PrimaryContent cited only for GLBs,
      output only as SEED.
- [ ] Inventory is current (`--recheck-inventory` passes) and every nonzero category has a
      disposition.
- [ ] Coverage matches the rule above; `codeRecovery` explains any metadata failure.
- [ ] Script declarations: game assemblies (not only Assembly-CSharp) scanned for core
      types/enums/config classes.
- [ ] Serialized data: the core `withFieldsByDir` directories read; values cited as OBSERVED.
- [ ] Levels/TextAssets: reader keys vs dump keys separated.
- [ ] Prefabs/scenes/animation: core board/actor/HUD wiring mapped or excluded.
- [ ] Audio: SFX/music mapped per feature or explicitly excluded.
- [ ] Fonts/textures/GLB: import candidates vs generated gaps; Unity built-ins excluded.
- [ ] Every UNKNOWN has a verification step; no stub method name used as behavior.

## Evidence labels

Use these labels on every substantive row:

- `OBSERVED` — direct code, serialized field, level JSON, scene/prefab, or asset evidence;
- `INFERRED` — conclusion that combines multiple observed facts; cite each fact;
- `UNKNOWN` — insufficient or contradictory evidence;
- `PORT_DECISION` — Cocos implementation mapping, never a claim about shipped Unity behavior.

Rip briefs and guides describe the shipped game as research seeds. Cite them as `SEED` and
corroborate mechanics with code/data/assets before treating them as port evidence.
Catalog priorities and agent-authored how_to_use prose are indexes/seeds, not independent
proof of behavior. A stub containing a method name cannot establish what the method does.

## Required report content

`RIP_LOGIC_MAP.md` contains a subsystem table with evidence paths, inputs/outputs, state
mutations, confidence, and Cocos target. `RIP_STATE_MACHINE.md` contains the boot → session
→ input → resolve → win/lose → result transitions, including guards and reset behavior.
`RIP_LEVEL_SCHEMA.md` contains observed keys, types/examples, reader symbols, sample files,
and unsupported/unknown fields. `RIP_ASSET_MAP.md` links systems to exact files and catalog
priority, with import candidates separated from generated gaps. `RIP_PORT_GAPS.md` lists
Unity-to-Cocos substitutions, unresolved behavior, missing assets, conflicts between rip
versions, and the verification needed before implementation.

Every report ends with a short `Open questions` section. Do not silently resolve a conflict.

## Completion gate

Run `node ~/.agents/skills/rip-port-analysis/scripts/validate-rip-port.mjs "$PROJECT" <slug>`
(add `--recheck-inventory` during review to rebuild counts from the source trees).
For a nonstandard analysis path use `--analysis-path <project-relative directory>` instead
of the slug. Exit 0 plus coordinator semantic review permits contract handoff. Coverage is
`readable_logic`, `partial`, or `assets_only`; reviewed partial research can proceed with
explicit unknowns in contract risks. Missing/changed evidence, missing reports or unreviewed
analysis blocks handoff. Reuse only when this gate passes for the same supplied source list;
a newly supplied version/subsystem requires targeted re-analysis. Never rerun extraction
or generate game assets as part of forensic analysis. The final manifest status is
`reviewed` (the analyst may only write `analyzed`). Bundles with `schemaVersion: 1` predate
the inventory gate and fail as `rip_schema_legacy`; re-run the analysis (targeted re-analysis
reuses existing RP/E IDs) and refresh the manifest pins of unmerged slices only.
