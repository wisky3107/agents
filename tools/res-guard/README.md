# res-guard

Keeps the 16 GB Mac usable while many agent sessions and Cocos editors run for days. Built
2026-10-07 after the machine froze, killed apps or reset under that load. On that day, with one
editor open, memory was already at 15 GB used and 4 GB compressed. Each Creator 3.8 editor costs
about 2–3 GB with its helpers, each `claude` session about 250 MB, OmniRoute about 1 GB, and
Playwright Chrome about 1 GB.

| file | role |
|---|---|
| `probe.mjs` | one snapshot: `ps`, `top` (footprints incl. compressed pages), `sysctl`, `vm_stat`, `df` → memory, swap, disk, editors, smoke browsers, claude, OmniRoute |
| `policy.mjs` | pure decisions: admission gate, alerts + cooldown, OmniRoute restart, reaper; `DEFAULTS` |
| `lifecycle.mjs` | which Cocos editors to keep or close, from lane agents (`CC_ROLE`/`CC_PROJECT`), client connections and the producer runner's files |
| `res-guard.mjs` | the CLI that runs the passes and the launchd job |

## Commands

```bash
node res-guard.mjs status                 # what the machine holds right now
node res-guard.mjs editors                # each editor: keep / close / gone, and why
node res-guard.mjs gate lane --project <checkout> [--free] [--wait]   # exit 0 go, 75 not now
node res-guard.mjs tick --dry-run         # one watcher pass, nothing killed or closed
node res-guard.mjs reap --dry-run
node res-guard.mjs close-editor --project <checkout> [--if-unused]
node res-guard.mjs install-launchd        # com.agents.res-guard, `tick` every 60 s
```

## What a tick does

1. Appends one sample to `~/.agents/logs/res-guard/samples-<day>.jsonl` (kept 14 days).
2. **Alerts** (macOS notification, 30 min cooldown per state):
   - pressure critical;
   - swap over 4 GB (critical over 8 GB);
   - disk under 20 GB (critical under 10 GB);
   - more editors than `maxEditors`.

   The live rows also go to the director console (tab *Tài nguyên*, and the bell).
3. **Reaper** kills only these:
   - an editor whose checkout was deleted;
   - a Playwright browser older than 30 min;
   - a `claude` orphaned to launchd, with no terminal, whose CPU time has not moved for 2 h.
4. **Editor lifecycle.** Rules are checked in this order; the first match decides.
   - Keep:
     - opened by hand (no `--nologin`);
     - in `editors.keep`;
     - the runner's merge step on main;
     - the worktree a live fleet works in;
     - used by a lane agent (`CC_ROLE=worker` with `CC_PROJECT` = this checkout);
     - opened less than 10 min ago.
   - Close: **main while a slice runs in one of its worktrees**.
   - Keep: main while a live runner of older code runs (it would not reopen it).
   - Keep: an agent client connected to its MCP or preview port (an MCP client, a Playwright smoke).
     A preview viewer never keeps an editor (director, 2026-10-08): a desktop browser with no
     Playwright root, Safari's network service, Tailscale, the director console's probe, a peer on
     another machine, or a local port no user process owns. The verdict names the viewers it ignored.
   - Otherwise close after **20 min idle**.

   Closing goes through the checkout's `scripts/close-editor.sh`, then SIGTERM.
5. **OmniRoute** restarts past 1.5 GB footprint, once no client has held a connection to :20128 for
   2 ticks in a row. Past 3 GB it restarts regardless. Never twice within an hour. The restart runs
   `omniroute stop` and then starts `node ~/.local/bin/omniroute` detached, with logs in
   `~/.agents/logs/omniroute.out`.

## The runner's side (game-producer `scripts/lib/editors.mjs`)

- **`admit`.** Every lane spawn (writer, reviewer, coordinator, verifier) asks `gate lane --free`.
  - When the answer is not now, the step pauses and asks again every idle tick (60 s).
  - After 30 min it goes ahead anyway. The gate slows a slice and never blocks it.
- **`ensureEditor`.** Single-lane writer and reviewer spawns reopen main's Creator first
  (`open-editor.sh` + `wait-mcp`), behind `gate editor`.
- **`closeMain`.** Once a fleet worktree appears, main's editor is closed.
- The runner's lock carries `reopens_editor: true`. That is how the lifecycle knows it may close main
  while this runner waits.
- `PRODUCER_RUNNER_RES_GUARD=off` turns all of this off. The test harness sets it.

## Config

`~/.agents/run/res-guard/config.json` overrides any key of `policy.DEFAULTS`. Example:

```json
{ "maxEditors": 1, "editors": { "idleMin": 30, "keep": ["/Users/wikz/Works/games/CocosCreator/cc-lego-stack"] } }
```

## Tests

```bash
node --test tools/res-guard/test/*.test.mjs
node --test skills/game-producer/tests/runner-res-guard.test.mjs
node --test tools/director-console/test/console.test.mjs
```
