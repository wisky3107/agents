# Watch cron prompt (template)

Fill the `<…>` fields and pass the result to CronCreate with `7,37 * * * *` (recurring).
Delete the cron when the slice merges. Keep the authority sentence verbatim from the
director.

```text
Pilot <N> watch: <project-slug> <Sxx> <slice-name> (<lane>) under the producer runner.

Authority. On <date> the director said "<exact words>". That allows <auto-answer: answering runner questions inside the slice's decisions | delegated: answering every runner question and deciding contract gates as the delegated director> for this <Sxx> run, until it is merged.
- Project: <abs path>.
- Runner: pid <pid>, terminal <handle>.
- Coordinator: <handle>.

Each run:
0. Handoff watch. If no `pilot <N> handed questions` Monitor is running, arm one (timeout_ms 1800000) with `node ~/.agents/skills/game-producer/scripts/producer-runner.mjs pilot-wait --project <project>`. Each line it prints is a question the director handed to me ("resolve by pilot agent"): answer it as in step 2 with `--by pilot`, whatever the authority above, using the director's note in it. On its `pilot_wait: timeout` line or the Monitor's expiry, re-arm it at once.
1. Status. Run `node ~/.agents/skills/game-producer/scripts/producer-runner.mjs status --project <project>`.
   - Summarize it with node, never by dumping the JSON: lock alive, control, slice, step, unanswered questions.
   - Also check AGENT_NOTES release.slices.<Sxx>, the tail of .cursor/evidence/tasks/T-<Sxx>/producer-log.md, and HANDOFF.json in the worktree (`git worktree list`).
   - If the HANDOFF says offer_commit or committed but producer-log has been silent for 15+ minutes, check that the runner sees the worktree.
2. Questions. For an unanswered question, check the facts first: HANDOFF.json, the newest review file (it can be review-rN.md), git, and `orca terminal read` of the coordinator.
   - Match the symptom against ~/.agents/skills/workflow-pilot/reference/failure-signatures.md.
   - Answer with `producer-runner.mjs answer --project <project> --id qN --choice "<exact option>" [--text "..."] --by pilot`. Choose the option that keeps <Sxx> going with its evidence intact.
   - Decide from slices/<slice file>, its mock and EXPECT rows, and decisions <Sxx-D1..Dn, one line each>.
   - <delegated only: When a gate needs a contract change the slice did not foresee, decide it as the delegated director. Prefer the option that keeps every acceptance row measurable, and record the decision.>
   - Never choose stop, mark blocked or skip.
   - Never accept, or treat as approved / offer_commit, while the newest review file does not end APPROVED.
   - <slice-specific never-rules, e.g. no schema bump, no loosened floors, GAME_BRIEF exclusions>
   - Merge-step options only after their precondition holds.
   - "check again" only when the evidence files changed; otherwise "back to the lane".
   - If codex shows its update menu, choose "Skip until next version".
   - Send a coordinator question's answer to the coordinator too, as a plain follow-up.
   - If no option is safe, give it back with `producer-runner.mjs pilot --project <project> --return qN --note "<why + recommendation>"` (the runner then calls the director); for a question nobody handed me, send a PushNotification with a recommendation and leave it open.
3. Runner. Relaunch the runner only if its lock is dead after a crash. If the control file says stop or pause, do not relaunch; send a PushNotification.
4. Never start Step 3, deploy, tag or push.
5. On merge (release.slices.<Sxx>: merged), follow workflow-pilot step 6 (Close):
   - Run token-report since <launch UTC>.
   - Read stats.json, producer-log.md and the questions.
   - Run the memory-trial greps.
   - Append "Pilot <N> — kết quả" to results.md and commit only that file, without pushing.
   - Delete this cron, stop the pilot-wait Monitor, and run `producer-runner.mjs pilot --clear --project <project>`.
   - Tell the director in a few Vietnamese lines.
Only report when something changed: a question answered, a phase change, a merge, or a problem. Otherwise end quietly.
```
