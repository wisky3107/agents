# Project and parallel-generation reference

Load this reference only for project mode or multi-image runs. Keep the main skill's completion criteria authoritative.

## Project identity

Use the local project root name as the ChatGPT Project name. Normalize only cosmetic separators; do not add dates or random IDs, so later runs can find and reuse the same project. If two local projects have the same basename, include the smallest stable parent qualifier needed to distinguish them and state that choice.

Do not copy source files, secrets, or unrelated repository content into ChatGPT. The project description should contain only the user-approved visual direction and stable style rules.

Wrap the managed art bible as:

```text
[ORCA GPT IMAGE STYLE]
<art bible>
[/ORCA GPT IMAGE STYLE]
```

When reusing a project, replace only this block. If no block exists, append it after the existing instructions. Preserve all user-authored content outside the block.

## Art-bible template

Write a short, durable instruction in this order:

1. **Medium and rendering:** e.g. polished anime key art, cel-shaded illustration, painterly concept art, or 3D render.
2. **Linework and shapes:** line weight, edge treatment, silhouette clarity, geometry.
3. **Palette and contrast:** dominant colors, accent colors, tonal range, saturation.
4. **Lighting:** key-light direction, shadow character, rim light, atmosphere.
5. **Camera language:** framing, lens feel, perspective, depth of field.
6. **Surface and finish:** material treatment, texture, detail density, cleanup.
7. **Quality guardrails:** coherent anatomy, readable focal point, no accidental text/logos/watermarks unless requested.

Keep subject, pose, environment, story, and props in each image prompt. If the user did not specify a style, choose a restrained default and label it as an inferred choice in the pre-submit commentary.

## Game-asset transparency

Classify an image by its gameplay role, not by whether scenery appears inside it:

- `game background`: a full scene or parallax layer designed to sit behind gameplay; transparency is optional unless requested.
- `other game asset`: characters, animations, sprite sheets, enemies, props, collectibles, weapons, tiles, tilesets, platforms, obstacles, UI, icons, VFX, foreground pieces, and midground pieces; true transparency is mandatory.

For an `other game asset`, keep every requested component but place it on a truly transparent RGBA canvas. Avoid descriptive phrases such as “dark background,” “clean backdrop,” or “studio floor,” which conflict with the alpha contract. When a request combines a scenic background and reusable assets in one image, make separate workers and separate output files.

After download, verify the PNG alpha plane. The file must expose an alpha channel, include at least one `alpha = 0` pixel, and include at least one `alpha > 0` pixel. Visual appearance alone is insufficient because checkerboards and matte colors can imitate transparency.

## Project UI fallback

The Projects UI can vary by account and ChatGPT rollout. Use the visible accessibility snapshot to find controls; do not rely on fixed refs or guessed URLs. The normal sequence is:

1. Open the sidebar and choose `Projects`.
2. Search for the exact project name.
3. Reuse the matching project or choose `New`/`New project` and create it.
4. Inside the project, open its menu/settings and locate project instructions/custom instructions/description.
5. Insert or update only the managed `ORCA GPT IMAGE STYLE` block, save, re-snapshot, and confirm it remains visible.

If the description editor is absent, disabled, or cannot be verified, prepend a clearly delimited `PROJECT ART BIBLE` block to every worker prompt. This preserves consistency while making the limitation explicit in the report.

## Worker-tab map

Maintain a map like:

```text
01 -> page A -> /output/subject-01.png -> prompt A
02 -> page B -> /output/subject-02.png -> prompt B
```

Create each page with Orca's typed tab command, then navigate through the project UI and verify the project name before submitting. Only after all workers are verified should independent fill/send operations run concurrently. Keep at most four active workers by default; queue the rest in deterministic index order.

Use a fresh snapshot for every action on every page. A page ID remains stable, but snapshot refs are page-local and invalidated by navigation. Never issue a command with a ref copied from a sibling worker.

## Parallel recovery

- **One worker is blocked by login/CAPTCHA/quota:** leave other workers running, record the blocker, and retry only the blocked index after the UI is usable.
- **One worker has a stale ref:** snapshot that page and retry the action once.
- **One worker errors during generation:** open a fresh project chat in a fresh tab and retry that index once.
- **A download collides with another worker:** use the preassigned unique destination; do not let ChatGPT's suggested filename decide the final path.
- **The browser becomes unstable:** finish the current batch, then process the remaining queue with no more than two workers at a time.
