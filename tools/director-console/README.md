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
file and restart to rotate it. Deep links: `#map`, `#quests`, `#worlds/<project>`, `#boot`, `#memory`,
`#pilot/<project>`, `#playbook`, `#scorecard`, `#log`.

## The page

`public/index.html` loads `app.css`, `graph.js` (the SVG kit: icons, tooltip, level map, workflow
graph, verdict columns) and `app.js` (shell, router, overlays and views). There is no inline script,
so the page CSP can forbid it.
- **Bản đồ**: HUD tiles, the workflow ↔ memory loop as a node graph with live counts (click a node
  to go where it is handled), and every project as a level map of its slices.
  - The **Boot game mới** tile is the quick action to the Game mới tab, with the last boot in its foot.
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
  - **Agent hỏi**: every question a Claude agent asks in an Orca terminal, in any
    project (a slice plan to confirm, a boot session's choices), from `tools/agent-questions`. Its
    hook records an AskUserQuestion dialog (each question, its options with descriptions and previews)
    and a turn that ends on a question, plus the images the text names (absolute, `~/` or relative to
    the agent's cwd), shown as thumbnails.
    - **Gửi cho agent** types the answer into the agent's own terminal. A dialog is closed with a raw
      Esc first; the picks then go in as one chat message, typed raw with a separate Enter, because
      Orca keeps the pane marked blocked after the Esc.
    - **Trả lời nhanh**: one-click replies. A click opens the reply in the confirm box, where you
      can edit it before it is sent.
      - A plain question first gets rule replies (`quickReplies` in tools/agent-questions: the
        action it names such as commit/push/merge/deploy, a listed option, a short "A hay B" side,
        yes/no). Then 2–4 replies from one `claude -p` haiku call over the message's end, made in the
        background and cached in `run/director-console-vi/suggest-<id>.json` ("gợi ý theo ngữ cảnh").
        `CONSOLE_SUGGEST=off` keeps the rule replies only.
      - A dialog gets "Gửi lựa chọn đề xuất" when every question has an option marked
        Recommended/đề xuất, and one button per option when it is a single single-choice question.
    - **Mở terminal** shows the terminal in Orca, so you can answer in the chat yourself. Whichever
      side answers first closes the card: the chat's next prompt (UserPromptSubmit) or the dialog's
      own answer (PostToolUse) does it.
    - **Bỏ qua** closes the card with a note; the agent is not told.
    - A card whose terminal Orca no longer lists is dropped. The runner's own lanes (`CC_ROLE`
      worker/reviewer/…) count only for their dialogs: the runner watches their idle turns itself.
- **Dự án**: a project's level map (pick a slice to see its merge-journal timeline, memory and
  deferred checks), the runner control deck and live Orca terminals.
  - **Slice đang chạy** (else **Slice gần nhất**): the runner's slice and every phase-2 lane. Each
    shows its phase, lane (main or worktree), HANDOFF, the review verdict (the last verdict line of
    review.md), static result, rounds, its writer/reviewer terminals, the runner log's last 8 lines and
    the 6 newest images in its evidence (the lane's worktree first). A click opens an image full size.
    Images come through `/img?p=<abs>&t=<token>`: image files under $HOME or a temp dir, ≤ 25 MB.
- **Game mới** (`#boot`): starts a game the way the director does it in orca-global. The form takes an
  idea, an App Store link or a Figma link, the usual options (template, brief, goal, deploy,
  implement agent, orca-memory + playbook) and reference images (picked or pasted, ≤ 10 × 12 MB).
  It shows the one-line prompt live. **Boot** runs `tools/boot-idea/boot-idea.mjs`: one
  `claude --dangerously-skip-permissions` terminal in `~/orca-global`, then `/new-cocos-game`,
  `/store-game-clone` or `/figma-game-clone` with the options once the TUI is idle. The images go to
  `~/orca-global/misc/boot-inbox/<stamp>-<slug>/` and are named in the prompt. The last boots are
  listed under the form (`logs/boot-idea.jsonl`). The session's own questions come to Nhiệm vụ.
- **Preview**: every open Cocos Creator 3.x editor (main or an Orca worktree) and its live preview
  in a 390×844 phone frame, with Dọc / Ngang. It is live only while the editor runs and
  `http://127.0.0.1:<port>/` answers with the Creator preview page. The port is found once per
  editor pid (`lsof` listen ports, then a probe), and the list refreshes every 15 s.
  - The starting orientation is the checkout's AGENT_NOTES `orientation:`, else the
    `designResolution` in `settings/v2/packages/project.json`, else portrait.
  - The frame loads the preview from this browser, so it shows only on the Mac that runs the
    editors. Through the tailnet the frame says so.
  - One way only: a preview lives while its editor runs and never keeps it open. res-guard counts
    a browser (and this server's no-keep-alive probe) as a viewer, not a client. While the frame
    is shown the list is polled every 5 s. When the editor closes (its worktree is done, the director
    or res-guard closed it), the frame is dropped with the reason. It comes back if that checkout's
    editor reopens. A hidden tab unloads the frame too.
  - Not covered yet: cc4 projects (the COCOS CLI preview is a different process).
- **Tài nguyên**: res-guard's last sample, editors, a 24 h trend and events, plus **Quota** for
  the OmniRoute accounts.
  - The accounts are the `claude`, `codex` and `agy` rows of `provider_connections`, read with
    `sqlite3 -readonly`, never the token columns.
    - An account switched off there is listed greyed with its last snapshot. It is never asked,
      and it is left out of the totals.
  - Each account's live windows come from `GET /api/usage/<id>` with OmniRoute's machine token
    (`x-omniroute-cli-token`, from its own `cliToken.mjs`). The token stays in this server.
  - Claude/Codex are cached 2 min and agy 10 min, because agy asks Google (~4 s per account).
    **Làm mới** forces a refetch at most once a minute.
  - When OmniRoute fails, the newest `quota_snapshots` row is shown, marked "số cũ".
  - What each block shows:
    - Claude: a 5 h and a 7 d meter per account.
    - Codex: one share bar, where every account is 1/N filled by its weekly remainder, plus a thin
      session bar.
    - agy: one share bar of usable image quota for the valid accounts, where usable =
      min(`gemini-3.1-flash-image`, `gemini_weekly`). An account is invalid when it reports no image
      window or agy-rotate marked it invalid.
  - The colours are dataviz slots 1–7, validated light and dark. An account keeps its colour.
  - Bars wear the slice progress look (`.xp`: ink border, striped fill, an ink edge per segment).
  - Each account list is a fold (`<details>`) whose summary carries the lowest window.
    - Claude's list opens on every load.
    - Codex and agy start folded and keep their open state per browser (`console-quota-open`).
  - The machine token needs `ioreg` (/usr/sbin), so the launchd PATH has /usr/sbin:/sbin.
- **Memory / Pilot / Playbook / Scorecard / Nhật ký**: modes as segmented controls, archive
  bars, a record explorer and drawer (promote/retract), stacked verdict columns with a table view,
  and recipe cards with filters plus a rendered recipe drawer.

The top bar keeps every tab in sight: when the labelled tabs do not fit, only the open tab keeps its label and the others show their icon (with the name as a tooltip).

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
`CONSOLE_ORCA_MEMORY_SRC`, `CONSOLE_PLAYBOOK`, `CONSOLE_ORCA_BIN`, `CONSOLE_LOG_DIR`, `CONSOLE_WORKSPACES`
(Orca worktrees, `~/orca/workspaces`), `CONSOLE_OMNIROUTE_HOME` / `_URL` / `_CLI` / `_TOKEN`,
`CONSOLE_AGY_ROTATE_STATE`, and
`ORCA_MEMORY_HOME` (read by orca-memory itself).
