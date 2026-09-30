# video-probe guide

Command manual for `~/.agents/skills/gameplay-video/scripts/video-probe.mjs`: what each command
writes, how to read it, and where it fails. The workflow and the evidence labels live in the
gameplay-video skill (`SKILL.md`).

Measuring costs no tokens; only an opened image does (about w×h/750). Needs ffmpeg and ffprobe
on PATH; `fetch` also needs yt-dlp (`brew install yt-dlp`), and `shape` the Python env that
`sam-setup` installs. In zsh, spell every argument out: a
variable holding several arguments is passed as one word.

## Commands

`signals`, `overview`, `strips`, `zoom` and `track` take `--crop auto | x,y,w,h`; `shape` reuses
the crop of its track. `--crop auto` finds a phone recording pillarboxed in a landscape frame
(blurred or black side bars) and does nothing on a full-frame video. Boxes and regions are then
fractions of the cropped frame.

- `fetch <url> --out <dir> [--name <stem>] [--height 720]` downloads a YouTube, TikTok, store
  or direct .mp4 URL to `<dir>/<stem>.mp4`, capped at 720p. It retries a transient 403 up to three
  times, reuses an existing file, and writes the url, title and duration to `<stem>.source.json`.
- `signals <video> --out <dir> [--fps 15] [--grid 4x8] [--k 6]` decodes the video once and writes
  `signals.json` and `candidates.{json,md}`. It saves the crop so `strips` can reuse it.
- `overview <video> --out <dir> [--step 5]` writes contact sheets `overview_NN.jpg`, each 15×5
  tiles one `--step` apart, and `overview.md`. Use `--step 10` above 6 minutes.
- `strips <video> --out <dir> [--ids 3,7 | --top 20]` reads `<dir>/candidates.json` and writes one
  slow-motion strip per candidate: `strips/cNNN.jpg` (up to 40 tiles) and `.json` (tile times),
  plus `strips.md`.
- `zoom <video> --at <sec> --dur <sec> --out <file.jpg> [--fps <n>] [--region x0,y0,x1,y1]`
  writes the same kind of strip for any window (default 1.5 s), with tile times and the motion
  span inside `--region` in `<file>.json`.
- `track <video> --at <sec> --box x0,y0,x1,y1 --out <dir> [--dur 3] [--mode auto|hop|move]
  [--cell <px>] [--react x0,y0,x1,y1] [--band 0.15,0.72]` follows one object and writes
  `track.{md,json,jpg}`.
  - `--box` holds the object alone on the frame at `--at`.
  - Hops (a token jumping tile to tile) are found automatically. With fewer than three landings,
    or with `--mode move`, the path is cut into moves at stops (slides, drops, exits).
  - `--cell` adds cells and cells/s. `--react` follows a second box (a gate, a bumper) for its
    knock-back. `--band` is the rows used to measure the camera pan.
- `shape <track-dir> [--pos x,y;x,y] [--neg x,y] [--model tiny|small|base_plus] [--device cpu|mps]`
  is optional. It segments the tracked object on every frame of that track's window with SAM 2
  and writes `shape.{md,json,jpg}` next to `track.md`.
  - It measures what a fixed template cannot: squash and stretch by hop phase, the arc of the
    object's feet, its full length and width along a move, and when an exit is fully under.
  - It prompts with the track box. For an object drawn in layers (a shell over a core), give
    `--pos` on the part to follow and `--neg` on the other part, as fractions of the cropped
    frame at the track's `--at`. Check the points on a `zoom` of that frame first: a `--neg`
    on the object cuts that part out of the mask.
  - Its rest size comes from the frames before the object moves, so start the track `--at` a
    few frames before the move.
  - About 1–2 s per frame on a laptop CPU (2–3 min for a 3 s window at 26 fps) and about 13 MB
    of memory per frame. `--device mps` is not faster. `tiny` is the default model.
- `sam-setup [--model tiny|small|base_plus]` installs, once, the Python env for `shape` in
  `~/.cache/gameplay-video/` (torch and SAM 2, about 650 MB, through uv or python3 3.10–3.12) and the
  checkpoint (tiny 156 MB). Ask before running it: it downloads about 800 MB.

## Layout in a game project

game-brief's `index-source.mjs` finds a probe only at these paths:

```text
reference/<slug>/video/<name>.mp4             (+ <name>.source.json when fetched)
reference/<slug>/video/frames/                 still frames
reference/<slug>/video/probe/<name>/
  signals.json, candidates.{json,md}           event log
  strips.md, strips/cNNN.{jpg,json}            slow-motion strip per candidate
  overview/overview.md, overview/overview_NN.jpg
  track-<moment-id>/track.{md,json,jpg}        one measured motion
  track-<moment-id>/shape.{md,json,jpg}        its outline, when shape ran
  zoom-<sec>.{jpg,json}                        any other window
```

Outside a project, any folder works: `<dir>/<name>.mp4` with its probe in `<dir>/probe/<name>/`.

## Reading the outputs

- `overview.md` gives the time of every sheet tile. Sheet k (1-based), tile j (row-major,
  0-based) is at `((k-1)*75 + j) * step` seconds.
- `candidates.md` is an event log, not a list of feel moments: hundreds of rows per ten minutes,
  each with time, duration, peak, score, kind, region and luma. Kind is `cut`, `dim`, `brighten`
  or `whiteout`, plus the motion extent (`local`, `regional`, `wide`) and `sfx` when an audio
  onset falls inside. Pick the rows that fall inside a moment you already saw on a sheet.
- `strips.md` lists each strip's tile rate and a **motion span**: start, end and duration of the
  motion inside the candidate's region, measured at native fps. `clipped` means the motion runs
  past the window. Strip tiles are row-major; tile times are in `strips/cNNN.json`.
- `track.md`:
  - Hops: count, duration of each, ground easing (named ease and its fit), arc height and peak,
    camera follow lag.
  - Moves: start and stop times, distance, speed, easing, or the smooth tail of a move that ends
    out of sight (clipped under a gate, then gone).
  - React: peak offset and time, return time.
  - The Cocos Creator 3.x tween sketch at the end is a starting point, not a contract.
- `track.jpg` shows the followed object on sample frames. Open it once: it must show the object
  you meant, on every crop.
- A `WARNING` in `track.md` means the object looked different from its first frame (a selection
  outline, a layer on top); it fires when the median match is below 0.7. Rerun with `--at` a
  little later, once the object looks as it does while moving, or with a tighter box.
- `shape.md` states the rest size (up to three frames before the object moves, or the first frame
  when the window starts mid-move), the noise floor (twice the spread of those frames, at least
  ±5 %) and each frame's status: `ok`, `occluded` (area outside 0.7–1.5× rest, something covers
  it, or the mask spills onto the gate; left out), `clipped` (sliding under an edge) or `gone`.
  A `WARNING` there means the rest frames disagree by more than 10 %: the mask holds only part
  of the object on some. Reprompt with `--pos`/`--neg`.
  - Hops: stretch in the air and touchdown squash (median of the hops, with the per-hop values),
    time back to rest, the arc of the feet, the mask center and the NCC template, a scale table
    by hop phase, and a `scaleAt(u)` sketch for track.md's hop tween. Scales divide out a smooth
    size trend over the window (perspective, camera zoom), stated at the top.
  - Moves: length × width at rest against the NCC length, the extent while moving, and for an
    exit the edge contact, fully under and contact-to-under, beside track.md's times. An exit is
    a vanish, or a move after which the object never shows at full size again; the moves
    track.md cut after it are marked `part of move k's exit`.
  - A change under the floor is noise. `No squash or stretch above the floor` means none was seen.
- `shape.jpg`: tiles around the object (key frames first) with the mask tinted magenta, its box
  green and its feet yellow; the status under each tile; below them, the scale or extent curves.
  Open it once: the mask must cover the whole object and nothing else on the key frames.
- `only N landings found` comes only from a forced `--mode hop`. Widen `--dur`, check the box,
  or drop the flag and let it cut moves.

## Known limits

- Thresholds were tuned on two videos (a board game with hops, a sliding-block puzzle).
- 30 fps gives few frames for a fast move; a block crossing three cells in three frames gets no
  fitted tail.
- The motion measure misses small particle effects in busy regions. Count strip tiles for those.
- The track mask can cover only the bright rim of an object, so its measured length is short. A
  layered object (a shell over a core) can leave its core behind. `shape` measures the full
  extent; prompt it with `--pos`/`--neg` for a layered object, because a box covers both layers.
- Particles covering a gate drop those frames from the react fit; `track.md` says how many.
- Arc peaks are fitted on a grid that stops at 0.2 of the hop. The world height assumes a 45°
  orthographic view. On an object that stretches, the track template rides its top, so the track
  arc is an upper bound; `shape` gives the arc of the feet.
- In `track`, squash, scale and tilt sit inside ±5–8 % noise. `shape` measures squash and stretch
  above its floor; tilt is not measured.
- `shape` counts a frame as occluded when a popup or a hand covers the object, and leaves it out.
  After an exit the mask can jump to debris; `gone` is final for the rest of the window.
- `shape` does not measure a gate's knock (`track --react` does), and its window is the track's.
- The landing clock can follow audio onsets, so confirm a count from a frame.
