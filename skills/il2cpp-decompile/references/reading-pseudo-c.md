# Reading IL2CPP pseudo-C

Pseudo-C is Ghidra's rendering of compiled ARM code, with names from the IL2CPP metadata.
Control flow, call targets, constants and field offsets are reliable; local variable names,
types and float arithmetic are not. Translate back to C# with the declaration file open.

## Parameters and fields

- Instance method: `param_1` is `this`; the last parameter is the `MethodInfo*` (often 0).
  Static methods start at `param_1` = first C# argument.
- `*(int *)(param_1 + 0x18)` reads a field: find `//Field offset: 0x18` in the type's `.cs`
  (base types' fields too). `lookup.py <decompiled> <Class>` prints the declaration.
- Struct fields of a value type inside an object are flattened at their offsets
  (`_currentVirtualData` at 0x3C spans 0x3C–0x53 when the struct is 0x18 bytes).
- Statics: `*(int *)(TypeInfo_X + 0x5c)` is `X.static_fields` on 32-bit (`+0xb8` on 64-bit);
  the offset after that is the static field's offset in the `.cs`.
- Floats arrive as `undefined4` hex: `0x3f333333` = 0.7, `0x40000000` = 2.0,
  `0x41200000` = 10.0, `0x43b40000` = 360.0. Convert with
  `python3 -c "import struct;print(struct.unpack('<f',(0x3f333333).to_bytes(4,'little')))"`.
- Vector2/Vector3 returns use an out pointer as the first argument
  (`UnityEngine_Transform__get_position(&local, transform, 0)`).

## Calls

- Direct calls are named `Namespace_Type__Method(...)` (Ghidra turns `.`, `$`, `$$` into `_`/`__`).
- Generic instances use shared code (`System_Collections_Generic_Dictionary__TryGetValue`);
  the concrete instantiation is the `MethodInfo_…` argument
  (`MethodInfo_Dictionary<VirtualCameraType,VirtualCameraData>__TryGetValue`).
- Virtual call: `(**(code **)(*obj + 0x1c0))(obj, …, *(undefined4 *)(*obj + 0x1c4))`.
  Name it with `vcall.py <decompiled> <StaticTypeOfObj> 0x1c0`. The static type comes from the
  field or variable the object was loaded from.
- Interface call: `il2cpp_codegen_get_interface_invoke_data(obj, TypeInfo_IFoo, slot)` then an
  indirect call; `slot` indexes `IFoo__VTable`.
- Delegate invoke: `(**(code **)(d + 0xc))(*(d + 0x20), args…, *(d + 0x14))` on 32-bit
  (`Action<T>.Invoke` inlined): read it as `d(args)`.
- Coroutines/async: the body lives in the nested `<Name>d__N$$MoveNext`; state is a field.
- Lambdas: `<Outer>b__N_M` methods on `<>c` (static) or `<>c__DisplayClass…` (captures).

## Runtime helpers

Name a helper only when its call sites match a pattern below; record it in `helpers.tsv`.
`suggest_helpers.py` lists candidates with samples.

| Pattern at call sites | Name |
| --- | --- |
| Inside `if (!flag) { f(&MethodInfo_/TypeInfo_/StringLiteral_…) … flag = 1; }` at method start; body has `dmb` | `il2cpp_codegen_initialize_runtime_metadata` |
| `if (*(int *)(TypeInfo_X + 0x74) == 0) f();` (32-bit `cctor_finished`; 64-bit offset differs) | `il2cpp_codegen_runtime_class_init` |
| `obj = f(TypeInfo_X); X__ctor(obj, …)` | `il2cpp_codegen_object_new` |
| `if (p == 0) f();` with no arguments, after every dereference guard | `ThrowNullReferenceException` |
| `if (array->max_length <= index) f();` | `ThrowIndexOutOfRangeException` |
| `if (*obj != TypeInfo_X) f(obj);` before a cast | `ThrowInvalidCastException` |
| `r = f(obj, TypeInfo_X); if (r != 0) …` | `IsInst` |
| `o = f(TypeInfo_int, &value)` (value type + address in, object out) | `Box` |
| `f(&field, value)` right after a reference-field store | `Il2CppCodeGenWriteBarrier` |
| `f(obj, TypeInfo_IFoo, n)` followed by an indirect call | `il2cpp_codegen_get_interface_invoke_data` |

## vtable base

Slot = (offset − base) / (2 × pointer size). The base is the runtime `Il2CppClass` size up to
`vtable`. Il2CppInspector's header gives a nearby value that can be off by a pointer
(Cat Dash armv7, Unity 2022.3: header 0xBC, runtime 0xC0). Calibrate once per binary on a call
whose target is certain, e.g. a `set_Follow` on a Cinemachine camera passed a Transform, or an
override whose own body is being called, then `vcall.py … --base 0x… --save-base`.

## Noise to ignore

- `if (x == 0) { ThrowNullReferenceException(); }` blocks (`lookup.py` strips them).
- `in_fpscr`, `VectorSignedToFloat`, `SUB41(...)`, `CONCAT44(...)`: ARM VFP flag and int/float
  conversions. Rebuild the arithmetic from the intent (e.g. `Round`, `(int)`, `/ 2`) and label it
  INFERRED.
- `cRam0301xxxx` byte flags are the per-method "metadata initialized" statics.
- `WARNING: Could not recover jumptable … Treating indirect jump as call` on vcalls is expected.

## Limits

- Only the assemblies passed to `decompile_il2cpp.py --assemblies` have pseudo-C; other methods
  are named but not decompiled (`lookup.py` says so).
- Inlined engine calls (Unity internal calls, `Mathf`) can appear as unnamed `FUN_` thunks into
  `libunity.so` resolvers.
- Serialized values (inspector numbers, curves, scene wiring) are not in code: read them from
  the rip (`rip-port-analysis/scripts/extract-unity.mjs`).
