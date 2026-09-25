# Rig-ready concept: prompt + check

The pipeline measures the mesh from horizontal slices. It finds the crotch on the midline, the
hands as the outermost material beyond the torso, and the legs as two separate columns. It
then bone-heats a voxel proxy. Every rule below exists because breaking it breaks one of those
steps.

## Pose: A-pose, not T-pose

Pick **A-pose** by default. Authored clips (`idle/walk/run/jump/attack`) rotate bones relative to
the rest pose and are tuned for arms hanging 20–75° below horizontal. With a T-pose rest they
come out with the arms wrong, and rig reports `pose: T` with a WARN. Mocap retarget handles
T or A, so T-pose is acceptable only when **every** clip is mocap. Even then, A-pose deforms
the shoulders better, because the mesh is tessellated for the common range of motion.

| Rule | Why (pipeline step it protects) |
|---|---|
| Arms 35–45° below horizontal, straight, clear of the torso with a visible gap to the hip | hand detection (beyond 0.27 × height from centre) + `pose: A` |
| Palms facing the thighs, fingers together, empty hands | no finger bones; a fist or prop fuses into a blob |
| Legs straight, feet shoulder-width apart, visible gap between the thighs | crotch detection; legs split cleanly |
| Feet flat and pointing forward, simple shoes | ground solve + `forward_axis: auto` (toe direction) |
| Upright, facing the camera, symmetric, neutral face, mouth closed | centred head check; mirrored weights |
| Normal human proportions (head ≈ 1/7 of height; no chibi or big-head) | crotch must sit at 0.36–0.56 × height |
| Short or tied-up hair; fitted clothes; no cape, long skirt, loose sleeves, tail or wings | no cloth physics: loose parts clip through the legs |
| No weapon, shield, bag, base, pedestal, shadow, text or UI | every mesh part becomes body skin |
| **One figure per image**, full body, head to feet, with margin | a multi-view sheet makes Tripo merge the figures |
| Plain light-grey or white background, even lighting, no strong shadows | clean image-to-3D silhouette and texture |

Weapons or props for gameplay are made separately (as cocos-asset-gen props) and attached in
the engine.

## Prompt template

Fill in `<…>` and keep the fixed lines verbatim. One prompt per view: only the `VIEW` line
changes, and the design text stays identical so the three images match.

```text
Character design reference for 3D modelling, single character, full body head to toe.
<NAME>: <age/build>, <outfit with colours and materials>, <hair: short or tied>, <distinctive features>.
Style: <game art style, e.g. stylized PBR, hand-painted, anime cel> — style lives in the design, not the pose.
POSE: neutral A-pose — standing straight, arms straight and angled 40 degrees down away from the body
with a clear gap between arms and torso, palms facing the thighs, fingers together, hands empty,
legs straight with feet shoulder-width apart and a visible gap between the thighs, feet flat pointing forward,
neutral expression, mouth closed.
VIEW: <see below>
Orthographic-looking camera at chest height, no perspective distortion, centred, whole body visible with margin.
Plain flat light-grey background, soft even lighting, no cast shadow, no ground plane.
Exactly one figure in the image. No props, no weapons, no base, no text, no labels, no extra views, no turnaround sheet.
```

| File | `VIEW` line |
|---|---|
| `concept-front.png` | `front view, facing the camera directly` |
| `concept-threequarter.png` | `three-quarter front view, body turned 45 degrees to the character's left` |
| `concept-back.png` | `back view, facing directly away from the camera` |

Generate the front first, then pass it as the reference image for the other two if the
backend accepts one. Aspect is portrait (for example 2:3), and the figure fills about 80% of
the height.

## concept-check.md

```markdown
## <id> — concept round <n>
files: concepts/<id>/concept-front.png, concept-threequarter.png, concept-back.png
single figure: PASS|FAIL — exactly one full-body figure per image, nothing cropped at the edges
a-pose: PASS|FAIL — arms ≈35–45° down, gap to torso, straight; legs apart with thigh gap; feet forward
hands: PASS|FAIL — open, empty, fingers together
proportions: PASS|FAIL — head ≈1/7 of height, crotch around mid-height
rig-hostile parts: PASS|FAIL — no cape / long skirt / loose sleeves / long loose hair / props / base
background: PASS|FAIL — plain, no shadow, no text
style: PASS|FAIL — matches the brief
cross-angle consistency: PASS|FAIL — front / three-quarter / back are the same design
view angles: PASS|FAIL — front faces the camera; three-quarter is visibly turned ≈45° (far half of the face and torso clearly foreshortened, nose breaks the cheek line; a ~10–15° turn is a FAIL); back shows no face
CONCEPT: PASS | CONCEPT: FAIL — <reason>
```

Every line must pass. Look at the images themselves: a small second figure in a corner, or an
arm touching the hip, is enough to fail.

A rig failure in step 3 comes back here. Add a round with `rig feedback: <RIG_REPORT reason>`
and fix that rule explicitly in the prompt.
