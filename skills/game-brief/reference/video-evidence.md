# Video evidence

Gameplay video is the only source for feel: how long a hop takes, how a block slides out, how
far a gate knocks back. Neither a model watching the video nor a few frames can supply those
numbers. A model gets the content right but guesses durations (every moment comes back as
200–600 ms) and its timestamps drift late on long input. Frames 3 s apart lose all motion. So
the timing comes from `scripts/video-probe.mjs`, which measures decoded frames and audio. The
agent looks only at the images it needs to name what was measured.

Measuring costs no tokens; only opened images do (about w×h/750): an overview sheet 0.6–1.4k,
a strip 0.4–1.1k, a track.jpg about 1.4k. A normal probe plus four track runs stays under 10k.

Needs ffmpeg and ffprobe on PATH; `fetch` also needs yt-dlp (`brew install yt-dlp`).

## Inputs

Any of these counts as a video, in every source mode (a video turns an idea into `media`):

- a video file in the user's media folder (mp4, mov, m4v, webm, mkv);
- the store trailer `video/preview.mp4` from store-game-clone;
- a video URL (YouTube, TikTok, a store page, a direct .mp4 link), downloaded with `fetch`.

## Layout

```text
reference/<slug>/video/<name>.mp4             (+ <name>.source.json when fetched)
reference/<slug>/video/frames/                 still frames for the shortlist
reference/<slug>/video/probe/<name>/
  signals.json, candidates.{json,md}           event log: cuts, flashes, motion bursts, audio onsets
  strips.md, strips/cNNN.{jpg,json}            slow-motion strip per top candidate
  overview/overview.md, overview_NN.jpg        contact sheets every --step seconds
  track-<feel-id>/track.{md,json,jpg}          one measured motion (brief author)
```

`index-source.mjs` lists each video under `videos` in `docs/brief-input-index.json` with its
probe outputs, and warns `Video not probed` until `candidates.md` exists.

## Coordinator (game-brief Step 1)

Set `P=~/.agents/skills/game-brief/scripts/video-probe.mjs` and `V=reference/<slug>/video`
(paths relative to the project). In zsh, spell every argument out; a variable holding several
arguments is passed as one word.

1. URL: `node $P fetch "<url>" --out $V [--name gameplay]`. It keeps 720p or less, retries a
   transient 403, reuses an existing file and writes the url, title and duration to
   `<name>.source.json`.
2. Frames, only when `video/frames/` is empty: `ffmpeg -i $V/<name>.mp4 -vf fps=12/<duration>
   -q:v 3 $V/frames/t%02d.jpg` (about 12 frames spread over the video).
3. Per video, with `D=$V/probe/<name>`:
   - `node $P signals $V/<name>.mp4 --out $D --crop auto`
   - `node $P overview $V/<name>.mp4 --out $D/overview --crop auto --step 5` (`--step 10` above 6 min)
   - `node $P strips $V/<name>.mp4 --out $D --top 20` (reuses the saved crop)
4. Read `overview.md` and one sheet, and skim `candidates.md` and two or three strips, so the
   intake notes can say what the video shows (core loop, which moments carry the feel). Do not
   run `track` here; the brief author measures the moments that its S01 feel rows need.

`--crop auto` finds a phone recording pillarboxed in a landscape frame (blurred or black side
bars) and is a no-op on a full-frame video. Boxes are then fractions of the cropped frame.

## Brief author

- `overview.md` gives `t` for every sheet tile; `candidates.md` is an event log (hundreds per
  10 min), not a list of feel moments. `strips/cNNN.jpg` tiles are row-major; the time of tile k
  is in `strips.md`.
- To look at any other window: `node $P zoom <video> --at <sec> --dur 2 --out <probe>/zoom-<t>.jpg
  --crop auto`.
- To measure a motion: `node $P track <video> --at <sec> --box x0,y0,x1,y1 --crop auto --out
  <probe>/track-<feel-id>`. The box holds the object alone on the frame at `--at`, as fractions
  of the (cropped) frame.
  - Hops (a token or piece jumping tile to tile) are found automatically; with fewer than three
    landings, or with `--mode move`, the path is cut into moves at stops (slides, drops, exits).
  - `--cell <px>` adds cells and cells/s; `--react x0,y0,x1,y1` follows a second box (a gate, a
    bumper) for its knock-back; `--dur` sets the window (default 3 s).
  - `only N landings found` comes from a forced `--mode hop`: widen `--dur`, check the box, or
    drop the flag and let it cut moves.
- Keep it to about four runs, one per S01 feel row that has a moving object.

## Reading track.md

- Hops: count, duration each, ground easing (named ease and its fit), arc height and peak,
  camera follow lag. Moves: start and stop times, distance, speed, easing, or the smooth tail of
  a move that ends out of sight (clipped under a gate, then gone). React: peak offset and time,
  return time.
- Open `track.jpg` once: it shows the followed object on sample frames. It must be the object
  you meant, on every crop.
- A `WARNING` means the object looked different from its first frame (a selection outline, a
  layer on top). Rerun with `--at` a little later, once the object looks as it does while moving.
- The Cocos tween sketch at the end is a starting point for HOW_TO, not a contract.

## Labels

- A number from `track.md` is `OBSERVED (reference/<slug>/video/probe/<name>/track-<feel-id>/track.md)`.
- A candidate or overview time is OBSERVED only after the strip, sheet or frame was opened.
- Squash, scale and tilt below about 8 % sit inside the measuring noise: label them ASSUMPTION.
- A user drag is not a game tween: its easing and speed describe the player's finger.

## Known limits

- Thresholds were tuned on two videos (a board game with hops, a sliding-block puzzle).
- 30 fps gives few frames for a fast move (three cells in three frames has no fitted tail).
- The mask can cover only the bright rim of an object, so its measured length is short; a layered
  object (shell over a core) can leave its core behind.
- Particles covering a gate drop those frames from the react fit; the md says how many.
- Arc peaks are fitted on a grid that stops at 0.2 of the hop; the world height assumes a 45°
  orthographic view.
- Always confirm a count (hops, moves) from a frame, not from the audio.
