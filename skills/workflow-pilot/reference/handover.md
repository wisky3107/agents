# Handover: a fresh pilot session (template)

Every wake re-reads the whole session context, so a pilot session that has grown large makes
every event expensive (pilot 12: about 920k per call). Hand the pilot to a fresh session between
slices or batches, ideally right after a merge (`slice_changed`). This is not Close: the pilot
keeps running.

## Old session

1. **Do not run `pilot --clear`.** The registration (`n`, `auto`) and any handed questions stay
   in the runner file. The new session picks them up as they are.
2. Write the handover note into the project's memory note (`<project>-pilot.md`) under
   `Handover <UTC>`. Keep it to 15 lines or fewer. It covers:
   - where the run stands: the slice, its phase, and the runner pid and terminal;
   - the authority, with the director's words quoted verbatim;
   - every suspicion, finding or workaround not yet in results.md, with its evidence path;
   - the commands in flight, if any;
   - this session's name, so the new session can message it.
   Put the findings that belong in results.md into results.md first, and commit only that file.
3. Delete the watch cron (CronDelete) and stop the background `pilot-wait` (TaskStop). Then
   `producer-runner.mjs pilot --project <p>` shows `waiter_alive: false`.
4. Start the new session in `~/.agents`, with the same permission mode as this one:
   `orca terminal create --worktree path:/Users/wikz/.agents --title "pilot-<N>" --command 'claude --permission-mode bypassPermissions "Read ~/.agents/skills/workflow-pilot/reference/handover.md, section New session, and take over pilot <N> for <project path>."' --json`
5. Wait until the new session confirms with a cross-session message. Then tell the user in one
   line, and stay quiet: no cron and no waiter, so this session costs nothing. The user can close
   its tab.

## New session

1. Read these, in order:
   - the user's memory index, then the project's memory note, then its newest `Handover` entry;
   - the newest `### Pilot <N>` entry in
     `~/.agents/docs/plans/2026-10-01-coordinator-token-optimization/results.md`;
   - `workflow-pilot/SKILL.md` §4–§6.
2. Run `producer-runner.mjs status --project <p>` and `pilot --project <p>`. Confirm three things:
   the pilot is still registered (and `auto` when the authority is delegated), there is no
   waiter, and the runner lock is alive.
3. Recreate the safety-net cron from [watch-cron-prompt.md](watch-cron-prompt.md) at
   `7 */2 * * *`, keeping the authority sentence verbatim. Start
   `pilot-wait --once` with Bash `run_in_background`.
4. Act at once on any handed question that is already open.
5. Send the old session one cross-session line: `taken over: cron <id>, waiter running`. The
   name is in the handover note. Then continue the pilot.
