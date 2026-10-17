# decompiled/: recovered IL2CPP code

Written by the `il2cpp-decompile` skill (`~/.agents/skills/il2cpp-decompile`). Facts about
this binary (ABI, Unity/metadata version, counts, calibrated `vtable_base`) are in
`manifest.json`. How to read the pseudo-C: `references/reading-pseudo-c.md` in that skill.

| Path | Contents |
| --- | --- |
| `cpp2il_cs/DiffableCs/<Assembly>/…/*.cs` | Every type: fields with `//Field offset`, signatures, `[Address(RVA=…)]`. Bodies empty. |
| `pseudo_c/<Assembly>/…/*.c` | Ghidra pseudo-C bodies of the decompiled assemblies, one file per C# file, `// signature` + `// RVA` above each function |
| `dummy_dll/*.dll` | Stub assemblies for ILSpy/dnSpy browsing |
| `symbols.tsv` | rva, length, `Namespace.Type$Nested$$Method`, assembly, source file, signature, decompiled flag |
| `labels.tsv` | StringLiteral_/TypeInfo_/TypeRef_/MethodInfo_ labels and extra function names; full text in column 4 |
| `helpers.tsv` | Runtime helper names for this binary, inferred from call patterns |
| `il2cppinspector/metadata.json` | Address map (string literals, TypeInfo, MethodInfo, generic instances, APIs) |
| `il2cppinspector/cpp/appdata/il2cpp-types.h` | Struct layouts: `<Type>_Fields`, `<Type>__VTable`, `<Type>__Class` |
| `ghidra_project/il2cpp.gpr` | Ghidra project with every name applied (GUI or REA) |
| `rea_evidence/` | REA (JADX) Evidence for the Java side |
| `logs/` | Tool logs per stage |

Quick queries (S=~/.agents/skills/il2cpp-decompile/scripts):

```sh
python3 -I $S/lookup.py decompiled <Class> [<Method>] [--callers]
python3 -I $S/vcall.py decompiled <Class> <vtable offset>
python3 -I $S/suggest_helpers.py decompiled
```

Pseudo-C addresses are Ghidra addresses = file RVA + `ghidra_address_delta`; `// RVA`
comments and `.cs` attributes are file RVAs.
