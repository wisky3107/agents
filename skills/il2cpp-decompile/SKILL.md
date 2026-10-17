---
name: il2cpp-decompile
description: >-
  Recover and read the game logic of a Unity IL2CPP Android build with REA, Cpp2IL,
  Il2CppInspector and Ghidra: C# declarations with field offsets, pseudo-C method bodies and a
  named Ghidra project under <workdir>/decompiled/. Use when a question about how a ripped game
  works (camera, movement, scoring, triggers, spawning) needs method bodies the rip's stub
  scripts lack; when the user asks to decompile an APK/XAPK or libil2cpp.so; or when
  unity-apk-rip or rip-port-analysis reaches code recovery.
---

# IL2CPP decompile

An AssetRipper rip of an IL2CPP game keeps serialized data (scenes, prefabs, `.asset` values)
but its scripts are stubs: names, fields and signatures, no bodies. The logic is ARM code in
`libil2cpp.so`. This skill turns it into readable evidence and reads it.

## Evidence ladder

Answer every behavior question by climbing this ladder from the bottom rung, stopping at the
first rung that answers it. Numbers come from rungs 1–2, control flow from rungs 2–4.

1. **Rip serialized data** (`ripped/UnityProject/ExportedProject`): scene/prefab wiring,
   component parameters, ScriptableObject values, curves, levels. Read with
   `~/.agents/skills/rip-port-analysis/scripts/extract-unity.mjs` (`--index`, `--summary`,
   `--node`, `--only`). OBSERVED data, but no behavior.
2. **Rip scripts with bodies** (Mono builds, or a non-Dummy `.cs`). OBSERVED behavior.
3. **`decompiled/cpp2il_cs`**: declarations, enums with values, field offsets, method RVAs.
   Structure only (INFERRED), the map for rung 4.
4. **`decompiled/pseudo_c`**: method bodies. Control flow, call targets, constants and field
   accesses are OBSERVED; reconstructed float arithmetic and helper names are INFERRED.
5. **Ghidra project / REA**: methods outside the decompiled assemblies (rerun with
   `--assemblies`), engine/native code, data xrefs. REA's `decompile`/`xrefs` with
   `--provider ghidra` re-analyze the whole library on every CLI call (slow on 50 MB); prefer the
   Ghidra project or a rerun.

Rungs 3–5 need `decompiled/`. When it is missing and a question reaches rung 3, run the
Decompile branch first. The camera study in
`/Users/wikz/Works/agent/assets-ripper/duet-dash/decompiled/analysis/camera_system.md` is the
worked example: rungs 4 for flow, 1 for the tuned numbers.

## Branch: Decompile

Input: an unity-apk-rip workdir (`apk_base/` with `lib/<abi>/libil2cpp.so` and
`assets/bin/Data/Managed/Metadata/global-metadata.dat`, `extracted/*.apk`, `output/manifest.json`).

1. `~/.agents/skills/il2cpp-decompile/scripts/setup_tools.sh` — installs or verifies JDK 21,
   REA (`~/.local/bin/rea`), the JADX engine (SHA-256 pinned), Ghidra 12.1.4 with macOS arm64
   natives, Cpp2IL and Il2CppInspectorRedux. Done when it prints the `export` block.
2. Run the pipeline in the background (≈5 min for a 50 MB libil2cpp.so on Apple silicon):

   ```bash
   python3 -I ~/.agents/skills/il2cpp-decompile/scripts/decompile_il2cpp.py --workdir "<workdir>"
     # --assemblies Assembly-CSharp Assembly-CSharp-firstpass <studio libs>
     # --abi armeabi-v7a   --from <stage>   --helpers <file>
   ```

   A metadata magic other than `af1bb1fa` stops it: the metadata is encrypted and needs a
   decrypted dump first; report that as the code-recovery gap. Done when it prints
   `functions_decompiled` and `decompiled/manifest.json` exists.
3. Name the runtime helpers: `suggest_helpers.py <workdir>/decompiled`, match each top callee
   against [references/reading-pseudo-c.md](references/reading-pseudo-c.md) § Runtime helpers,
   write the matches to `decompiled/helpers.tsv`, rerun with `--from symbols`. Done when every
   callee above ~2 000 calls is named or recorded as uncertain.
4. Calibrate the vtable base on one certain virtual call with `vcall.py … --save-base`
   (§ vtable base). Done when `manifest.json` has `vtable_base`.
5. If `other_game_assembly_candidates` lists studio libraries that the questions touch, rerun
   with them in `--assemblies` (`--from symbols`).
6. Report: ABI, Unity/metadata version, functions named/decompiled, failures, helpers named,
   `vtable_base`, assemblies left out.

The pipeline also records `source_paths.decompiled` and `code_recovery` in
`output/manifest.json`, which unity-apk-rip and rip-port-analysis read.

## Branch: Answer a behavior question

1. Rung 1: find the owning scene/prefab/asset and the components involved (extract-unity
   `--index --under`, `--summary`). Note the script classes on those objects.
2. Rung 3: `lookup.py <decompiled> <Class>` for fields, offsets, enums and methods.
3. Rung 4: `lookup.py <decompiled> <Class> <Method>` for bodies; `--callers` for who triggers
   it. Resolve each field offset against the declaration, each virtual call with `vcall.py`,
   each enum constant with its `.cs` values. Follow callers until the trigger is a Unity message
   (`Update`, `LateUpdate`, `OnTriggerEnter2D`, …), an input handler or a level item.
4. Pair flow with numbers: read the serialized parameters for the components the code drives.
5. Write `decompiled/analysis/<topic>.md`: architecture, reconstructed C# for key methods,
   trigger table, tuned values, and a confidence section separating OBSERVED from INFERRED.
   Done when every claim cites a `.c`/`.cs`/rip path and every inferred rule says why.

## Guardrails

- Analyze only builds the user supplied; never download APKs.
- Source trees (`ripped/`, `apk_*`, `extracted/`) are read-only; outputs go to `decompiled/`.
- A method name is not evidence of its behavior; read the body.
