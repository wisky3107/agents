# Analyst task template

The coordinator fills the angle-bracket fields and saves the result as
`<DECOMPILED>/analysis/<TOPIC>.task.md`. The analyst receives only "Read <that path> and execute
only that task."

```text
Role: rip logic analyst. Agent locked by the coordinator: <ANALYST_SPEC>.
Question (verbatim from the user): <QUESTION>
Topic id: <TOPIC>. Scope: <SYSTEMS_AND_CLASSES_NAMED_BY_THE_COORDINATOR_OR_"discover">.

Sources (read-only):
- Rip, serialized data: <EXPORTED_PROJECT>
- Decompiled: <DECOMPILED> (manifest.json: abi <ABI>, vtable_base <VTABLE_BASE>)
Write only: <DECOMPILED>/analysis/<TOPIC>.md and <DECOMPILED>/analysis/<TOPIC>/ (extracts).

Read first: ~/.agents/skills/il2cpp-decompile/SKILL.md § Evidence ladder and
~/.agents/skills/il2cpp-decompile/references/reading-pseudo-c.md.
Tools (S=~/.agents/skills/il2cpp-decompile/scripts, X=~/.agents/skills/rip-port-analysis/scripts/extract-unity.mjs):
  python3 -I $S/lookup.py <DECOMPILED> <Class> [<Method>] [--callers]
  python3 -I $S/vcall.py <DECOMPILED> <StaticType> <offset>
  node $X --root <EXPORTED_PROJECT> --index --under <dir> | --file <f> --summary | --node '#id' --out <file>

Procedure: climb the ladder from rung 1 and stop at the rung that answers.
1. Find the scene/prefab/asset that owns the system and the script classes on it.
2. Declarations (rung 3), then bodies (rung 4). Resolve every field offset against the
   declaration, every virtual call with vcall.py, every enum constant with its .cs values.
   Follow callers to the trigger: a Unity message, an input handler or a level item.
3. Pair the flow with the serialized numbers the code reads (rung 1).

Write <TOPIC>.md: Architecture; reconstructed C# for the key methods; trigger table; tuned
values with units; Confidence (OBSERVED: control flow, calls, constants, field accesses,
serialized values; INFERRED: rebuilt float arithmetic, inferred helper names); Open questions.
Every claim cites the exact .c/.cs/rip path and symbol or RVA. A method name alone is not
evidence of behavior.

Out of bounds: running decompile_il2cpp.py or setup_tools.sh, editing helpers.tsv or
manifest.json, writing outside the two output paths, launching agents, committing. When a needed
method is outside the decompiled assemblies, list it under Open questions with the class and
assembly; the coordinator decides on a rerun.
Return: the report path, a five-line answer to the question, and the open questions.
```
