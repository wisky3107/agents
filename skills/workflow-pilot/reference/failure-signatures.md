# Failure signatures (seen in pilots 1–7)

Match a symptom here before treating it as new. "Fixed" names the commit that removed the
cause. When a fixed signature returns, the fix regressed or did not load (a runner started
before the merge keeps old code).

| Symptom | Check | Cause | Action / fix |
|---|---|---|---|
| HANDOFF in the worktree says `offer_commit`, `producer-log.md` silent 15+ min | `producer-state.json` has no `worktree`; `git worktree list` basename | runner only matched worktrees named `^Sxx-` (orca named it `feature-S12-…`) | fixed ~/.agents 28668a9 (Sxx token anywhere); restart the runner to load it |
| HANDOFF updates never reach the runner | HANDOFF is at `T-Sxx/HANDOFF.json` instead of `T-Sxx/evidence/HANDOFF.json` in the worktree | coordinator wrote the task-root path (pilot 7) | tell the coordinator to write `evidence/HANDOFF.json`; candidate fix: runner reads the newer of the two |
| `q… prompt_not_sent` right after spawn | coordinator screen | codex update menu (or a trust dialog) swallowed the prompt | in the terminal choose "Skip until next version"; answer "close it and spawn again"; never update mid-run |
| `coordinator_missing` while the coordinator works | `orca terminal show` finds it; HANDOFF mtime moves | `terminal wait` answered `terminal_handle_stale` | answer "taken over, continue"; fixed ~/.agents c0671e1 (orca-wait rechecks show; 30-min stale stall rule) |
| `unknown_status` with a sentence as status ("fix-r1 …") | newest review file verdict | coordinator wrote prose into `status` | choose "treat as working"; c0671e1 hides "treat as offer_commit" unless the review is APPROVED |
| `approval_evidence` asked again every few seconds | evidence file mtimes unchanged between asks | "check again" re-read the same files | c0671e1: same files wait; choose "back to the lane (fix round still running)" while a fix round runs |
| The same smoke check fails in every slice | baseline smoke JSON shows it red before the slice | pre-existing check bug (S03-04 compared "n/a-or-true" with a boolean) | fix the check in its own small task before the next slice; until then authorize "commit with documented baseline failure" only after the baseline proves it |
| `fleet_gate` about a schema sample or node-order list | grep the named check | the slice changed something a check hard-codes (S04-03 schema sample, S12-01 Root order) | pre-declare the edit in the slice (step 2 pre-check) |
| `fleet_gate`: a decided position cannot meet 44 px | layout rects at compact | the decision was made without reading the geometry | amend the decision; pre-check geometry next time |
| Judge "deferred: quote is not a sentence" | judge line in producer-log | judge quoted a row with different punctuation | answer by hand; candidate fix: punctuation-tolerant quote match |
| A label passes the font check but looks small | `Label.actualFontSize` vs `fontSize` | `Overflow.SHRINK` renders below the nominal size | checks must assert rendered size (lesson T-S13-rendered-label-floor-shrink) |
| Preview stuck at frame 0 after reload | fresh tab vs `location.reload` | Orca tab reload leaves the engine unbooted | open a fresh tab per run (lesson T-S13-fresh-tab-per-run…) |
| `git merge` fails "beyond a symbolic link" / "stash failed" | checkout has tracked skill dirs replaced by symlinks | autostash cannot stash those paths | merge with merge-tree (fix-loop.md) |
| Memory pack exists but no role used it | specs MEMORY path; stub in main after merge | relative path; rsync copied a "none" stub over the pack | fixed ~/.agents dcf5dea (absolute path, evidence/memory/plan excluded) |
| A deploy dir gets `.env.local` | after `vercel link` | link pulls env into the cwd | link before copying the build in, or delete `.env.local` before `deploy`; check the URL returns 404 |
