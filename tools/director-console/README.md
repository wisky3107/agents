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
for the session. The token lives in `.token` (0600, made on first start, gitignored); delete the
file and restart to rotate it. Deep links: `#map`, `#quests`, `#worlds/<project>`, `#memory`,
`#pilot/<project>`, `#playbook`, `#scorecard`, `#log`.

## The page

`public/index.html` loads `app.css`, `graph.js` (the SVG kit: icons, tooltip, level map, workflow
graph, verdict columns) and `app.js` (shell, router, overlays and views). There is no inline script,
so the page CSP can forbid it.
- **Bản đồ**: HUD tiles, the workflow ↔ memory loop as a node graph with live counts (click a node
  to go where it is handled), and every project as a level map of its slices.
- **Nhiệm vụ**: one list of everything waiting on you, filterable by kind, project or text. Runner
  questions are answered in place; judge drafts take verdict pills and per-row confirmation;
  triage rows can be dismissed; system issues come with their fix.
  - A runner question card shows everything the runner's own dialog shows, in Vietnamese:
    - where the run stands (`questionContext`);
    - the question;
    - why the judge left it to you;
    - every option, with its Vietnamese label, its full text, the exact English choice the runner receives, and whether it needs a note.
  - The English original, the judge's reason and the technical ids (key, gate/ref, obs, also) sit in two expandable sections.
  - A note you type survives the 20 s refresh.
  - The Vietnamese comes from the runner's `q.lang` when it was made from this exact question. Otherwise the server starts the runner's own `translate.mjs` in the background: one `claude -p` sonnet call, for every project, not only those with `release.question_lang: vi`. The call is cached on the question the same way the dialog caches it, so neither one asks twice. `CONSOLE_TRANSLATE=off` turns this off.
- **Dự án**: a project's level map (pick a slice to see its merge-journal timeline, memory and
  deferred checks), the runner control deck and live Orca terminals.
- **Memory / Pilot / Playbook / Scorecard / Nhật ký**: modes as segmented controls, archive
  bars, a record explorer and drawer (promote/retract), stacked verdict columns with a table view,
  and recipe cards with filters plus a rendered recipe drawer.

Search everything with ⌘K or `/`. The theme follows the OS, or the toggle in the top bar.

## Notifications

`lib.attention()` lists everything that needs you now, one row per item with a stable key. It covers:
- open runner questions;
- a runner that died mid-slice (step `lane`, no live lock, no stop/pause);
- judge drafts and triage rows;
- a failed or stale memory refresh;
- active unregistered checkouts.

Deferred manual checks are left out, because they wait for ship. The rows come with
`/api/overview` and alone from `/api/attention`.

The page announces each key once per browser:
- **In the page:** a card at the top right (runner questions and a failed refresh stay until closed), an unread entry under the bell, and `(n)` in the tab title.
- **On macOS and Windows:** once you allow it, through the browser, also an OS notification while the tab is hidden or unfocused. A banner asks for that permission, and the bell drawer can test, mute or explain a block.

A key that goes away marks its entry resolved and closes its OS notification. The first look in a new browser takes what is already waiting as read, with no alerts. More than three new rows at once become one summary.

A hidden tab keeps polling `/api/attention` every 20 s, which browsers slow to about once a minute. Nothing arrives while no console tab is open. The bell's state lives in localStorage, per browser. Verdict
colors are the validated categorical slots 1-5 in both themes; status colors always come with an
icon and a label. On phones a bottom tab bar replaces the sidebar, and wide graphs scroll inside
their own panel.

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
| `manual.signoff` | `producer-runner.mjs sign-off <Sxx> --note "done\|waived: …" --project …` (deferred manual checks; signed-off files leave the quest list) |
| `triage.dismiss` | `orca-memory dismiss <source> --note …` |
| `draft.apply` | writes the director's verdict and confirmed edits into the judge draft, then `orca-memory pilot apply-draft --file …` |

Every action is appended to `~/.agents/logs/director-console.jsonl` (the **Nhật ký** tab).

There is one write outside that table: the Vietnamese translation of an open runner question. It
goes onto the question's `lang` field through the runner's own `translated()`, under the runner
file lock. It is a cache, not a decision, and the runner's dialog reads the same field.

## Tailnet access

`tailscale serve --bg --https=443 http://127.0.0.1:7792` publishes the page to this Mac's tailnet
name only (`https://wikzs-macbook-pro.tail12c0c4.ts.net/?t=<token>`); the server itself still
listens on 127.0.0.1. Never use `tailscale funnel`: that puts the page on the public internet.
Tailscale replaces any client-sent `Tailscale-User-Login` header with the caller's real identity.
A request through it must carry a login listed in `CONSOLE_TAILNET_USERS`, so tagged and shared
nodes are refused, and it still needs the token. Undo with `tailscale serve --https=443 off`.

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
