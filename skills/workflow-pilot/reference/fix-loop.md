# Workflow fix loop

For a finding that is a bug in the workflow code (runner, orca-wait, fleet scripts, skills,
templates). The live pilot keeps running while this happens.

1. **Root cause.** Read the runner log, the state files and the tool's raw output. Reproduce
   the failing call when you can (e.g. run the exact `orca terminal wait` the script runs).
   Name the cause in one sentence before writing code.
2. **Worktree.** `git -C ~/.agents worktree add ~/.agents-wt/<name> -b fix/<name> master`
   (templates: `~/Works/games/template-wt/…`). Never edit `~/.agents` directly: running
   runners and other sessions load code from it.
3. **Regression test** next to the existing ones (game-producer `tests/runner-*.test.mjs`
   with `harness.mjs`; fleet `tests/orca-wait.test.mjs` with its fake orca). Prove it fails
   on the old code (swap the old file in, run, swap back). Tests that expect the runner to
   keep waiting pass `{ timeout: 4000 }` and `PRODUCER_RUNNER_IDLE_MS` to `runner()`;
   `PRODUCER_RUNNER_ORCA_WAIT` swaps orca-wait for a stub.
4. **Suites.** In the worktree symlink `skills/game-brief/node_modules` from `~/.agents`,
   run `node --test skills/game-producer/tests/*.test.mjs` and
   `node --test skills/cocos-orca-fleet/tests/*.test.mjs`, then remove the symlink.
5. **Independent review** by a subagent. The prompt must say: read-only; no `git stash`,
   `checkout` or `reset` in `/Users/wikz/.agents`; tests only inside the review worktree.
   Fix findings or answer them with evidence; repeat until APPROVED.
6. **Merge into a dirty checkout.** List the branch's files against `git status`.
   - No overlap: `git merge --no-ff --no-autostash <branch>`.
   - Overlap with another session's uncommitted file, or a checkout with symlinked skill
     dirs: build the merge without touching the work tree —
     `T=$(git merge-tree --write-tree HEAD <branch>)`,
     `C=$(git commit-tree "$T" -p HEAD -p <branch> -m "Merge …")`; for each overlapping file
     `git merge-file <file> <base> <new>` (on conflict restore the backup and resolve by
     hand); `git update-ref refs/heads/<branch-name> "$C" "$OLD"`; `git reset -q -- <overlap>`;
     `git checkout HEAD -- <non-overlapping files>`. Compare `git status --short` before and
     after: it must be identical.
7. **Load the fix.** orca-wait is spawned per wait, so it loads at once. Runner modules
   (lanes.mjs, merge.mjs, …) need a runner restart: `kill -TERM <pid>`, check the lock is
   dead, `launch`. Do not restart a runner the director stopped without their go-ahead.
8. **Unblock the live slice** with the smallest safe action (answer the question, move a
   phase back with a state-file edit only when the runner offers no option), and log it.
9. Remove the worktree and branch; record the finding in the memory note and in the pilot
   results.
