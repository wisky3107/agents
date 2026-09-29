# Slice study task template

Fill the angle-bracket fields and save as `<analysis_path>/slices/<Sxx>/study-task.md`. The
mapping table below is part of the task; keep it in the saved file.

```text
Role: slice presentation analyst for <PROJECT>, slice <SXX> (<SLICE_FILE>), source slug <SLUG>.
Agent locked by coordinator: <ANALYST_SPEC>.
Read fully: <ABSOLUTE_PORT_CONTRACT_PATH> § Slice studies, the Unity → Cocos table in this
file, and <SLICE_FILE>. From the parent analysis read RIP_ASSET_MAP.md (owning files) and
RIP_PORT_GAPS.md; open other reports only to answer a named question.
Parent analysis: <ANALYSIS_DIR>/RIP_PORT_MANIFEST.json, SHA-256 <PARENT_HASH>.
Sources (read-only): <SOURCE_IDS_AND_ROOTS>.
Topics (<slice | derived>):
<TOPICS_YAML>
Write only: <STUDY_DIR> — SLICE_STUDY_MANIFEST.json, RIP_SLICE_STUDY.md, extracts/.

Tool: X=~/.agents/skills/rip-port-analysis/scripts/extract-unity.mjs, R=<EXPORTED_PROJECT>.
Per topic:
1. Locate: start from the topic's source_dirs and RIP_ASSET_MAP rows; list candidates with
   `node $X --root $R --index --under <dir>` (per-file classes and scripts).
2. Orient: `node $X --root $R --file <prefab|unity> --summary --max-depth 3`; pick nodes by #id
   (ids repeat across files; always pair them with the file). --summary is for reading only.
3. Extract what you cite: `--node '#<id>'` or `--only <Class,...>` (add Transform for layout)
   with `--out <STUDY_DIR>/extracts/<topic>-<what>.json`. The tool prints sha256 (the extract
   → extractSha256) and sourceSha256 (the source file → evidence sha256). Extract clips,
   controllers and materials you cite the same way. Do not hand-edit extracts.
4. Answer every question with claims: serialized values with their units, label, disposition
   (adopt | adapt | reference | exclude), Cocos target from the table, deviation for adapt.
   Cite parent E/RP IDs where they apply (`refines`).
5. No data is an answer: noFields MonoBehaviours, missing references, stub behavior and
   runtime-driven values are UNKNOWN with a verification step (a store or gameplay video measured
   with the gameplay-video skill, or the director).
   Never fill them with Unity or Cocos defaults.
Read extracts, not raw YAML; open the raw file only to confirm a single value. Stay inside the
topics; anything else goes under Open questions.

RIP_SLICE_STUDY.md: one section per topic id with a table (RP ID, label, value, evidence,
disposition, Cocos target), then "Implementation notes" for the writer (node paths, unit and
axis conversions, import stems) and "Open questions".
Run: node ~/.agents/skills/rip-port-analysis/scripts/validate-rip-port.mjs <PROJECT> <SLUG> --slice <SXX> --allow-analyzed
Stop at status=analyzed. Return the study path, per-topic dispositions and the UNKNOWNs.
Do not edit contracts, AGENT_NOTES or source trees; no runtime code, no art, no commits, no workers.
```

## Unity → Cocos Creator 3.x

Values in extracts are raw Unity data. Record the conversion in the claim's `cocos` field; a
mapping without a direct equivalent is `adapt` with a deviation.

| Unity (extract) | Cocos target | Conversion notes |
|---|---|---|
| Transform `p`/`q`/`s` | Node position/rotation/scale | Unity is left-handed. Compare one node's `p` with the same node in the PrimaryContent GLB to learn the exporter's axis flip; apply that flip to cameras/lights/placements so they agree with imported meshes. Copy `q` (flipped), not `e`: Unity euler is ZXY, Cocos `Quat.fromEuler` is YZX |
| RectTransform anchors/pivot/sizeDelta/anchoredPosition | UITransform (contentSize, anchorPoint = pivot) + Widget | Equal anchors: fixed size = sizeDelta at anchoredPosition. Split anchors: Widget margins from offsetMin = anchoredPosition − sizeDelta·pivot, offsetMax = anchoredPosition + sizeDelta·(1 − pivot) |
| CanvasScaler referenceResolution, matchWidthOrHeight | design resolution + fit width/height | Scale UI by cocosDesign / unityReference on the matched axis |
| Image m_Type 0/1/2/3, m_Color, m_PreserveAspect | Sprite SIMPLE/SLICED/TILED/FILLED, color | Sliced borders live on the Unity sprite (texture `.meta` spriteBorder or Sprite asset `m_Border`) → spriteFrame insets. preserveAspect has no direct equivalent |
| TextMeshProUGUI / Text (size, color, alignment, font) | Label (fontSize, color, align, overflow) + rip font | Outline/shadow from TMP material properties → Label outline/shadow |
| Horizontal/Vertical/GridLayoutGroup, ContentSizeFitter | Layout (type, spacing, padding, cellSize, constraint), resizeMode CONTAINER | childAlignment and flexible sizes: adapt |
| ScrollRect, Mask/RectMask2D, Button, CanvasGroup | ScrollView, Mask, Button (COLOR/SPRITE/SCALE transition), UIOpacity | Animation-transition buttons: adapt |
| ParticleSystem main/modules | ParticleSystem (3D) main + shape/color/size/rotation/velocity/force/limitVelocity/textureAnimation/noise/trail modules, bursts | Unity angles are radians; Cocos rotation fields are radian-backed but shown in degrees in the Inspector: convert when typing, check one emitter. Unity-only shapes (Edge, Donut, Mesh, Rectangle) and sub-emitters: adapt |
| ParticleSystem moveWithTransform, scalingMode | simulationSpace, scaleSpace | Hierarchy scaling has no direct equivalent |
| ParticleSystemRenderer renderMode, material | renderer renderMode (Billboard, Stretched, Horizontal, Vertical, Mesh), particle material | Additive/alpha blend from the material → builtin-particle technique |
| TrailRenderer / LineRenderer / SpriteRenderer | MotionStreak (2D) or particle trail; Graphics or custom mesh; Sprite | adapt |
| Material shader + properties | builtin-standard / builtin-unlit / builtin-particle / custom effect | `_MainTex`/`_BaseMap` → mainTexture, `_Color`/`_BaseColor`/`_TintColor` → main/tint color, smoothness → roughness = 1 − smoothness, `_EmissionColor` → emissive. Custom or `builtin:*` shaders: behavior is INFERRED from name, properties and keywords |
| Camera fieldOfView / orthographic size / clip planes | Camera fov (fovAxis VERTICAL) / orthoHeight / near, far | Both FOVs are vertical degrees; orthographic size and orthoHeight are both half-height |
| Cinemachine virtual camera fields | Camera node pose + fov, tween between poses | Blends and damping: adapt |
| Light type/color/intensity, RenderSettings ambient/fog | Directional/Sphere/Spot light, scene ambient, fog (Linear/Exp/Exp2) | Intensity units differ: match visually (reference), keep color and direction |
| AnimationClip curves (`[t, v, in, out]`, sampleRate) | AnimationClip tracks (position/rotation/scale/color/opacity) | "Infinity" slope = constant (stepped) key; rotation keys need the same axis flip |
| AnimatorController params/states/transitions | animation graph (Marionette) or a code state machine | Trigger/bool/float/int conditions and exit times map directly; blend trees: adapt |
| PlayableDirector (Timeline) | tween/animation sequence in code | No equivalent: adapt, keep order and timing |
| AudioSource clip/volume/loop/playOnAwake | AudioSource | pitch and spatialBlend: adapt |
| MonoBehaviour `noFields: true` | — | UNKNOWN; measure from a store or gameplay video (gameplay-video skill) or ask the director |
