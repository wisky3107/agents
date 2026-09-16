# Level detection heuristics

`rip_apk.py` copies level data into `output/levels/` using, in order:

1. **`--levels-glob`** (relative to `ripped/UnityProject/ExportedProject/`) if given → copy matches, stop.
2. **Directory-name match** under `Assets/`: any dir whose name matches
   `(?i)^(levels?|stages?|maps?|puzzles?|boards?|definitions)$` containing ≥ 5 `.json|.bytes|.txt|.asset` files.
3. **Catalog match**: a JSON file whose top-level object has a single array key (`Levels`, `levels`, `stages`, `ids`) and
   whose sibling directory holds ≥ 50 % of the listed ids as files.
4. **Bulk-JSON fallback**: any dir with ≥ 20 `.json` files sharing ≥ 3 identical top-level keys.

Each hit is copied to `output/levels/<dir-name>/` (flattened to `output/levels/` when only one hit).
`.meta` files are always skipped.

If the manifest reports `levels_detected: []`, look in:

- `ripped/PrimaryContent/Assets/**/*.bytes` (TextAssets — many games store JSON as `.bytes`)
- `ripped/UnityProject/ExportedProject/Assets/Resources/`
- `ripped/UnityProject/ExportedProject/Assets/MonoBehaviour/*.asset` (ScriptableObject levels, YAML)
- `apk_base/assets/aa/` (Addressables bundles → already loaded by AssetRipper; check `Assets/_*/`)

Then rerun with `--skip-rip --levels-glob "<pattern>"`.

## Known layouts

| Studio pattern | Path | Format |
|----------------|------|--------|
| Thrive / PhysicsFun (Tiki Smash) | `Assets/_Games/Cores/PhysicsFunCore/Definitions/Levels/*.json` + `levels.json` catalog | Newtonsoft JSON `LevelDocument` |
| ScriptableObject per level | `Assets/MonoBehaviour/Level_*.asset` | Unity YAML |
| Scene per level | `Assets/Scenes/Level*.unity` | Unity YAML scene (copy `.unity` files) |
