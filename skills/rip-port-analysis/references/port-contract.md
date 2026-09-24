# Rip port evidence contract

## Resolve sources

Accept an original workdir (`output/` plus `ripped/`), an output pack, a `ripped/` directory,
or a UnityProject/ExportedProject tree. Normalize explicit user paths first. For an output
pack use `manifest.source_paths` when present; otherwise inspect its original sibling
`../ripped/`, then `manifest.workdir/ripped/`. For a merged reference use
`RIP_PACK.json.source`/`source_paths` to find the original. Check existence; stale paths are
reported rather than invented. Recognize Unity exports by UnityProject/PrimaryContent or
Assets plus ProjectSettings, including UnityProject/ExportedProject nesting.

Assign stable source IDs, one per supplied version/project. `root` is an existing absolute
directory enclosing the evidence for that source. When output and Unity trees are in
unrelated locations, use separate source IDs linked by `version` instead of a filesystem-root
root. Preserve input APK identity/version when present; do not infer that every source is
the same version. A root is an allowed read source, never a write target.

The source list in AGENT_NOTES is input state owned by the caller/coordinator. Analyst records
the same IDs and roots in the manifest, adding `codeAvailability`: `readable`, `stubs`, `none`,
or `mixed`, based on actual inspected method bodies. IL2CPP/Mono is recorded separately;
backend alone never proves code recovery. Read source hashes before reusing a previous report.

For multiple packs, stage canonical output at `reference/<slug>/rip/` and alternatives at
`reference/<slug>/rip-sources/<id>/`. Preserve catalogs and filenames per source. Record
system-level canonical choices/conflicts; do not merge versions by basename. No whole
`ripped/` copy is required. Missing output is valid: analyst maps usable raw assets and names
deterministic extraction/conversion work for the implementation slice.
After analysis, the caller stages selected directly reusable raw assets under a source-specific
reference directory before brief launch. Preserve originals and record the staging mapping.
The docs-only brief author never performs extraction/conversion. For conversion needs, cite
the exact existing source and future task/destination; runtime outputs belong to implementation.

## Manifest

Write `RIP_PORT_MANIFEST.json` with these fields. This example is a schema illustration;
replace sample values with inspected evidence and actual hashes.

```json
{
  "schemaVersion": 1,
  "status": "analyzed",
  "analystAgent": "cursor --model auto",
  "logicCoverage": "partial",
  "sources": [{"id": "main", "root": "/absolute/workdir", "version": "unknown", "codeAvailability": "mixed"}],
  "evidence": [{"id": "E-001", "source": "main", "path": "ripped/PrimaryContent/Scripts/Game/Board.cs", "sha256": "64 lowercase hex characters", "kind": "code", "symbol": "Board.Resolve"}],
  "claims": [{"id": "RP-001", "label": "OBSERVED", "summary": "Concrete behavior from method body", "evidence": ["E-001"]}],
  "unknowns": ["Missing lose-condition implementation"],
  "files": ["RIP_LOGIC_MAP.md", "RIP_STATE_MACHINE.md", "RIP_LEVEL_SCHEMA.md", "RIP_ASSET_MAP.md", "RIP_PORT_GAPS.md"],
  "reportHashes": {"RIP_LOGIC_MAP.md": "actual sha256 for each required report"}
}
```

Hashes are SHA-256 of file bytes. Hash only files actually used as evidence and all reports;
do not claim this fingerprints every file in the Unity tree. Evidence `kind` is `code`,
`data`, `asset`, `prefab`, `scene`, `metadata`, or `seed`. Citations in reports use stable
`RP-001` claim IDs and `E-001 (main:path#symbol)` evidence locators. Reuse IDs across revisions.
`OBSERVED`/`INFERRED` claims need non-seed evidence; `UNKNOWN`, `PORT_DECISION`, and `SEED`
stay distinct. `readable_logic` means core paths were read, not that every system was recovered.
`partial`/`assets_only` require a nonempty unknowns list. Unavailable behavior stays UNKNOWN.

The five reports contain: core rules and data mutations; state triggers/guards/reset/win/lose;
level keys/types/reader locations/examples; system-to-file mapping with staged paths and import
or conversion candidates; gaps/substitutions/variant conflicts. Cover one or many sources in
each report as relevant, with explicit absence when a category has no data. The coordinator
verifies semantics and sets `status: reviewed`; the worker stops at analyzed.

## Contracts and implementation handoff

`game-brief` uses `source: store|media` for media provenance and `rip_port.enabled: true` for
the port workflow; these are independent. Before brief launch, require reviewed analysis and
fresh evidence hashes. Read the reports, then targeted primary evidence for critical rules;
avoid redoing the whole forensic pass on the stronger brief model.

Use existing contract/slice fields rather than inventing incompatible PLAN keys:

- HOW_TO: port coverage table (RP ID, source/version, rule, keep/adapt/defer/unknown, reason,
  owning slice, scenario). Every in-scope core rule needs a disposition.
- ARCHITECTURE: Unity behavior → Cocos system mapping; record lifecycle/config/event/animation
  replacements separately from behavior changes.
- ASSET_MANIFEST: Source=import when a suitable existing asset is available; exact staged
  source, runtime destination, needed conversion, owning slice. Generated gaps have reasons.
- Slice acceptance/playtest: source RP IDs and initial state → input → expected result for
  affected rules. Add the analysis report path to the slice body under `Port evidence` so the
  writer/reviewer have an explicit permitted read path. Pin the manifest SHA-256 there.
- EXPECT: visual targets from observed store/runtime images; include deliberate deviations.

Translate forensic `INFERRED`/`PORT_DECISION` into contract `ASSUMPTION`, retaining RP citations;
UNKNOWN stays a risk and a scoped decision, never OBSERVED. Explicit director changes are
GIVEN and override default parity. A screenshot of a different version does not silently
replace a code-backed rule; record the conflict and selected source. Research scope may cover
the shipped game's meta, but release scope is still the director/brief author's decision.

The implementation reviewer checks current Cocos behavior against the scenarios and declared
deviations, including reset and win/lose. A forensic report is expected-behavior evidence, not
proof that a running implementation passed. Missing original runtime means no claimed
differential runtime equivalence; use source-derived scenarios and report that limitation.
On amendments, preserve merged slice contracts and historical pins. Refresh pins/scenarios
for affected unmerged or follow-up slices before dispatch; new findings do not retroactively
certify or rewrite already reviewed gameplay.
