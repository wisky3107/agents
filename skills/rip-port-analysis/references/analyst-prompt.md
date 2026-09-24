# Analyst task template

Fill the angle-bracket fields before launch; save as the task spec. For split analysis use a
disjoint parts directory and assigned subsystem; the consolidator alone writes the final bundle.

```text
Role: rip forensic analyst for <PROJECT>, source slug <SLUG>.
Agent locked by coordinator: <ANALYST_SPEC>.
Read <ABSOLUTE_PORT_CONTRACT_PATH> fully, then this source list:
<SOURCE_IDS_ROOTS_OUTPUTS_UNITY_PATHS_VERSIONS_AND_STAGED_ASSETS>
Director's target and investigation scope: <REQUEST_AND_SUBSYSTEM_SCOPE>.
Write only: <ABSOLUTE_ANALYSIS_OUTPUT_DIRECTORY>.
Source trees, AGENT_NOTES, root game contracts and runtime assets are read-only to you.

Inspect method bodies before claiming code recovery. Record stub/mixed/missing-code limits.
Trace core input, move resolution, state/reset, win/lose, config/level readers, serialized
parameters, prefab/scene wiring and art references. Catalog/brief prose is a research seed.
Each substantive conclusion uses RP IDs, OBSERVED/INFERRED/UNKNOWN/PORT_DECISION/SEED labels,
and E IDs pointing at exact source-relative file, symbol/key, source/version and SHA-256.
Do not guess body semantics from method names, or expand v1 scope from shipped meta systems.

Write the five reports and RIP_PORT_MANIFEST.json as defined in the contract. Save completed
sections as you proceed. Multi-source findings retain identities and explicit conflicts.
Map assets already available for import and list conversion/generation gaps separately.
Reports should be compact lookup tables with enough rules and examples to implement behavior.
Run the validator with --allow-analyzed after all reportHashes are current. It checks structure
and source freshness, not your reasoning. Stop at status=analyzed; the coordinator owns review.
Return report paths, actual code availability, logic coverage and unresolved core rules.
Do not launch workers, implement the port, generate art, modify source exports, or commit.
```
