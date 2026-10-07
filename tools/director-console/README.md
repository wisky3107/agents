# Director console

One local page to read and steer the game workflow: runner questions, judge drafts, memory triage,
memory modes and records, pilots, the cocos-playbook, the workflow scorecard, and the live state of
every project (slice, step, merge journal, Orca terminals).

```bash
node ~/.agents/tools/director-console/server.mjs            # → {"url":"http://127.0.0.1:7792/?t=…"}
node --test ~/.agents/tools/director-console/test/console.test.mjs
```

The launchd job `com.agents.director-console` (plist in `launchd/`) keeps it running at login.
Open the printed URL once, in Orca's browser or any browser on this Mac; the page keeps the token
for the session. The token lives in `.token` (0600, made on first start, gitignored);
delete the file and restart to rotate it. Deep links: `#pending`, `#workflow/<project>`, `#memory`,
`#pilot`, `#playbook`, `#scorecard`, `#log`.

## How it reads and writes

- **Reads** come straight from each system's own code and files: orca-memory `src/*.ts` (config,
  archive, pilot report and pending, unregistered checkouts), the game-producer runner's
  `lib/state.mjs`, `project.mjs` and `answer.mjs` (questions, lock, control, release state),
  `cocos-playbook/registry.json` and `kits/registry.json`, `orca terminal list --json`, and
  `~/.agents/logs/scorecard-dashboard.html`.
- **Writes** run only the allowlisted CLI actions in `lib.mjs`, with the same argv a person would
  type, so each decision keeps its own audit trail:

| Action | Runs |
|---|---|
| `runner.answer` | `producer-runner.mjs answer --project … --id … --choice … [--text …]` |
| `runner.control` | `producer-runner.mjs pause \| stop \| clear \| stop-after <Sxx> --project …` |
| `memory.mode` | `orca-memory mode --project … <mode> --note …` |
| `memory.promote` / `memory.retract` | `orca-memory promote <id> --to … --note …` / `retract <id> --note …` |
| `memory.refresh` | `orca-memory refresh` |
| `triage.dismiss` | `orca-memory dismiss <source> --note …` |
| `draft.apply` | writes the director's verdict and confirmed edits into the judge draft, then `orca-memory pilot apply-draft --file …` |

Every action is appended to `~/.agents/logs/director-console.jsonl` (the **Nhật ký** tab).

## Safety

It listens on 127.0.0.1 only and refuses any other Host header, which blocks DNS rebinding. Every
`/api` call needs the token. Actions are POST with a JSON body only. File paths that come from the
page (judge drafts, recipes) must resolve inside their own directory. Page data is rendered as
text, never as HTML. The scorecard iframe is sandboxed without same-origin, so it cannot reach the
token or the API.

## Paths (env)

`CONSOLE_PORT` (7792), `CONSOLE_TOKEN`, `CONSOLE_GAMES_ROOT`, `CONSOLE_RUNNER_DIR`,
`CONSOLE_ORCA_MEMORY_SRC`, `CONSOLE_PLAYBOOK`, `CONSOLE_ORCA_BIN`, `CONSOLE_LOG_DIR`, and
`ORCA_MEMORY_HOME` (read by orca-memory itself).
