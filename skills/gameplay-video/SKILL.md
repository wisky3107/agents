---
name: gameplay-video
description: >-
  Gameplay video evidence: turn a game video file or URL into a feature list, animation
  phases and measured game-feel numbers (duration, easing, distance, speed, arc, camera lag,
  knock-back, squash and stretch) with the ffmpeg-based video-probe tool instead of a model's
  guess. Use when the
  user wants to watch, analyze or study a gameplay video, trailer or YouTube/TikTok link;
  extract game feel, animation, VFX or tween timing from it; or list the features and core
  loop it shows ("xem video", "phân tích video game", "trích xuất game feel / anim / feature
  từ video"). game-brief, store-game-clone and other skills use it whenever their input
  includes a gameplay video.
---

# Gameplay video

A model watching a video gets the content right and the timing wrong: every duration comes back
as 200–600 ms, and its timestamps drift late on long input. Frames a few seconds apart lose all
motion. `scripts/video-probe.mjs` measures decoded frames and audio instead, at no token cost;
you open only the images needed to name what it measured.

Command flags, output formats, how to read them and the known limits are in
[reference/probe-guide.md](reference/probe-guide.md). Needs ffmpeg and ffprobe; `fetch` also
needs yt-dlp.

## What each ask needs

| Ask | It answers | Command | You open |
|---|---|---|---|
| Feature | screens, modes, core loop, HUD, progression, what happens when | `overview` | contact sheets |
| Anim | the phases of one moment (anticipation, motion, impact, VFX, UI pop), their order and length | `strips`, `zoom` | strips, zoom images |
| Feel | duration, easing, distance, speed, arc, camera lag and knock-back of one moving object | `track` | `track.md`, `track.jpg` once |
| Shape (optional) | squash and stretch, the object's full size, when it is fully under an edge | `shape` on a track | `shape.md`, `shape.jpg` once |

A request for all three runs the feature pass first: it shows which moments carry the feel.

## Steps

Set `P=~/.agents/skills/gameplay-video/scripts/video-probe.mjs`, keep the video in a folder `V`
and its probe in `D=$V/probe/<name>`. Inside a game project, use the layout in
[probe-guide § Layout](reference/probe-guide.md#layout-in-a-game-project) so game-brief finds it.
In zsh, keep one path per variable and spell every flag out.

1. **Get the file.** URL: `node $P fetch "<url>" --out $V --name <name>`. A local file stays
   where it is. Done when `$V/<name>.mp4` exists, plus `<name>.source.json` for a URL.
2. **Measure.** `node $P signals $V/<name>.mp4 --out $D --crop auto`, then
   `node $P overview $V/<name>.mp4 --out $D/overview --crop auto --step 5` (`--step 10` above
   6 min). Done when `$D/candidates.md` and `$D/overview/overview.md` exist.
3. **Features.** Read `overview.md` and open the sheets: all of them up to about 5 minutes,
   above that every other one plus those around an open question. Done when every feature or
   screen you report cites a sheet path and a time.
4. **Anim**, when asked or to name the feel moments. Pick the rows of `candidates.md` that fall in
   the moments from step 3 and run `node $P strips $V/<name>.mp4 --out $D --ids <id,id>`. For a
   window with no candidate, run `node $P zoom $V/<name>.mp4 --at <sec> --dur 2 --crop auto
   --out $D/zoom-<sec>.jpg`. Name each phase with its tile time. Done when every anim moment
   lists its phases in order with times, each citing an opened strip or zoom image.
5. **Feel**, for moving objects only. Run `node $P track $V/<name>.mp4 --at <sec> --box
   x0,y0,x1,y1 --crop auto --out $D/track-<moment-id>`, then read `track.md` and open
   `track.jpg` once to confirm the followed object. On a WARNING, rerun once with a later `--at`
   or a tighter box. About four runs, unless the user wants more. Done when every feel moment
   has numbers from a `track.md`, or is labeled ASSUMPTION with the reason.
   - When squash and stretch, the object's full size or its exit timing matter, run
     `node $P shape $D/track-<moment-id>` on that track, then read `shape.md` and open `shape.jpg`
     once: the magenta mask must cover the whole object. For an object drawn in layers, or on a
     `WARNING` in `shape.md`, add `--pos x,y` on the part to follow and `--neg x,y` on the other
     part. Its rest size comes from the frames before the move, so start that track a few frames
     early. It takes 2–3 minutes per 3 s window.
   - `shape` needs `node $P sam-setup` once (about 800 MB). Run it only with the user's OK;
     without it, label squash and stretch ASSUMPTION.
6. **Report** in the format below. Done when every row has a label.

## Output

One table per ask, one row per moment:

| id | t (s) | moment | what happens | numbers | label (evidence) |
|---|---|---|---|---|---|
| feel-hop | 34.2–36.6 | token moves 9 tiles | hops tile to tile, camera follows | 9 hops × 0.266 s, sineOut, arc 0.54 tile, camera lag 0.21 s | OBSERVED (`probe/gameplay/track-feel-hop/track.md`) |

When the asker builds the game, add the Cocos tween sketch from each `track.md` (and the
`scaleAt` keys from a `shape.md`) under the table; it is a starting point, not a contract.

## Labels

- `OBSERVED (<path>)`: a file you opened, or a number from `track.md`, `shape.md` or the motion
  span in `strips.md` / a zoom `.json`.
- A candidate or overview time is OBSERVED only after its strip, sheet or frame was opened.
- `ASSUMPTION`: squash and stretch without a `shape.md` (`track` cannot see them under about
  8 %), a change under the floor `shape.md` states, tilt, any timing a video-watching model
  reported, and anything not measured.
- On an object that stretches, `track.md`'s arc rides its top and is an upper bound; take the
  arc of the feet from `shape.md` when it ran.
- Confirm a count (hops, moves, hits) from frames, not from audio onsets.
- A user drag is not a game tween: its easing and speed belong to the player's finger.

## Budget

Each opened image costs about w×h/750 tokens: an overview sheet 0.6–1.4k, a strip 0.4–1.1k, a
`track.jpg` about 1.4k, a `shape.jpg` about 1.2k. All three asks on a 10-minute video stay around 15k. Open a sheet before
its strips, and only the strips of moments you will report.
