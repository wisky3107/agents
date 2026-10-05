---
name: codex-image-gen
description: Batch image generation and reference-image edits through Codex via OmniRoute (gpt-image-2-codex), with no browser and six images in parallel. Use when a workflow or user needs several images at once, variants or candidates to score, a side / back / three-quarter view edited from a front image, a concept pack, or a fallback when Antigravity image generation hits 429 ("codex image", "omniroute image", "gen nhiều ảnh", "ảnh side từ ảnh front"). Hero / final art goes through orca-gpt-image-gen (ChatGPT, Images 2.5) instead.
---

# Codex Image Gen

Codex makes images in **batches**: one jobs file, six calls in flight, every file checked on disk.
It is the fast lane for OpenAI images. The ChatGPT browser lane (`orca-gpt-image-gen`) stays
for hero art.

## Pick the backend

Workflows point here for this routing rule:

| Work | Backend |
|---|---|
| **hero**: key art, splash / title, store and marketing images, logo, full-scene backgrounds, character hero or portrait art, anything the director calls final, and any image that failed the Codex lane twice | `orca-gpt-image-gen` (ChatGPT, GPT Image 2.5) |
| **batch**: everything else, including sprite / icon / prop / tile sets, variants and candidates, concept packs, and edits from a reference (side, back or ¾ view from a front, recolours, state variants) | `codex-image-gen` (this skill) |

Why the split: the Codex backend pins its image tool to `gpt-image-2-codex` (GPT Image 2), and
any model you ask for is replaced with that one. It takes about 45–70 s per image, runs on six
accounts in parallel, and edits from a reference while keeping the design. ChatGPT runs Images
2.5, which has sharper detail, but it is one browser chat per image with four tabs at most. On
the S11 toy-brick concepts (2026-10-05), both lanes scored the same.

## 1. Resolve the run

Collect the brief, the image count and one absolute destination per image, as in
`orca-gpt-image-gen` §1. That includes its classification: `game background`, `other game
asset`, or `non-game image`. Settle these per job:

- `alpha: true` for every `other game asset` (sprites, icons, props, UI, VFX). Leave it off for
  backgrounds and for concepts that feed image-to-3D, which need a plain light background
  because Tripo reads alpha edges badly.
- `ref`: the image(s) an edit starts from. A side view refs the front. The front can be a job
  in the same run, and its dependents wait for it.

Completion criterion: every job has a prompt subject, an absolute `out`, `alpha` decided, and
its refs named.

## 2. Improve prompts

Run `orca-gpt-image-gen` §2: the style-library pass, a faithful expansion and one art bible per
project. Then apply the Codex differences:

- The art bible goes in a text file passed with `--prefix-file`. There is no ChatGPT Project.
- State the aspect ratio in words, for example "portrait 2:3, subject fills 90% of the height".
  The backend ignores `size`, `quality` and `background`.
- With `alpha: true`, the tool appends the transparency contract when the prompt does not say
  "transparent". Never describe a backdrop, floor or matte for such a job.
- An edit prompt names the subject as "the exact same <subject> from the reference" and states
  only what changes. Across a view set, only the VIEW line differs.

Show the art bible and every prompt before running. The request is the authorization to run.

Completion criterion: each prompt is faithful, states the aspect, and was shown.

## 3. Check and run

```bash
CI=~/.agents/skills/codex-image-gen/scripts/codex-image.mjs
node $CI check                                   # 0 usable · 2 unavailable
node $CI gen --jobs jobs.json --prefix-file art-bible.txt --report report.json
node $CI gen --prompt "<text>" --out /abs/file.png [--ref /abs/front.png] [--alpha]
```

`jobs.json` is `[{ "out": "/abs/front.png", "prompt": "…" }, { "out": "/abs/side.png",
"prompt": "…", "ref": "/abs/front.png" }, { "out": "/abs/coin.png", "prompt": "…", "alpha": true }]`.

What the tool does:

- It checks every job before the first call: a missing ref, a duplicate `out` or a ref cycle is
  exit `64`.
- An existing file is never replaced. The image goes to `name-2.png`, `-3` and so on unless you
  pass `--overwrite`, which you use when regenerating a failed round.
- It retries transient failures up to 3 calls: 502 "declined the tool" (about 1 call in 7), 429
  and 5xx.
- An `alpha` job whose PNG has no alpha-0 pixel is regenerated once with stronger wording. If it
  still fails, the file is saved as `<name>.alpha-fail.png` and the job fails.
- Exit codes: `0` every job ok · `1` some failed (the report says why) · `2` OmniRoute or its
  Codex image models are down.

On exit `2`, switch the run to `orca-gpt-image-gen` and say so in the report.

Completion criterion: exit `0`, or every failed job is listed with its error.

## 4. Verify

The report gives each file's size, mode (`RGBA` / `RGB`) and `transparentPct`. Open and look at
every PNG anyway: subject, style, consistency across a view set, and no stray text. Re-run only
the failing jobs, with a jobs file holding just those rows and `--overwrite`.

When a destination needs exact pixels, scale the image after generation (`sips -z <h> <w>`, or
crop then scale) and record that.

When a pipeline keys on a solid backdrop such as magenta, flatten any RGBA result Codex returns
onto that colour. Codex sometimes hands back a cut-out even when asked for a backdrop.

Completion criterion: every file was looked at, and every one that failed is either regenerated
or reported.

## 5. Report

Report:
- the art bible and every prompt
- each file as a clickable path, with its size and mode
- each failed job and its error
- `tool: codex-image-gen (gpt-image-2-codex)`, which goes in the manifest's `verify.tool`

## Limits

- `node $CI check --probe` spends one generation (about 60 s) and prints the image model the
  Codex backend pins. When it shows a `gpt-image-2.5*` model, the hero/batch split above is
  worth revisiting.
- Free-plan Codex accounts cannot generate (403). A content-policy refusal is an error and is
  not retried.
- Endpoint: `OMNIROUTE_BASE_URL` / `OMNIROUTE_API_KEY`, else the `omniroute` provider in
  `~/.codex/config.toml`, else `http://localhost:20128`.
