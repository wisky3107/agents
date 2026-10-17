# boot-idea

Starts a new game the way the director starts one by hand in orca-global: one Claude session in an
Orca terminal there, given `/new-cocos-game` (an idea), `/store-game-clone` (an App Store link) or
`/figma-game-clone` (a Figma link) plus the usual options from `~/orca-global/README.md`. The
director console's **Game mới** tab (quick action from Bản đồ) runs it as the `boot.idea` action.

```bash
node ~/.agents/tools/boot-idea/boot-idea.mjs --source idea --text "runner né thiên thạch, portrait" \
  [--slug cc-space-dash] [--template default|playable|cc4] [--brief deep|inline] [--goal e2e|playable] \
  [--deploy preview|prod|none] [--impl-agent "claude --model opus"] [--memory on|off] \
  [--agent "claude --model opus"] [--link URL] [--images-dir DIR] [--dry-run]
node --test ~/.agents/tools/boot-idea/test/boot-idea.test.mjs
```

- The prompt is one line, so the TUI submits it whole. Its parts are joined with " — ", so a link
  never ends on a full stop. `--dry-run` prints the prompt and starts nothing.
- The session is `claude [--model m] [--effort e] --dangerously-skip-permissions`, the same launch
  command as `bootstrap.mjs agent-session`. That command is not used itself: it would pin a Cocos MCP
  config and send an AGENTS.md boot turn in orca-global.
- The prompt is sent once `orca terminal wait --for tui-idle` (≤ 90 s) says the session is ready. If
  that fails, the error carries the prompt to paste by hand.
- Images in `--images-dir` are moved to `~/orca-global/misc/boot-inbox/<YYYYMMDD-HHMM>-<slug>/` and
  named in the prompt.
- Each boot is a row in `~/.agents/logs/boot-idea.jsonl` and one in the spawn registry with role
  `boot`, so token-report books it.
- The session's own questions (AskUserQuestion, or a turn ending on a question) appear in the
  console's Nhiệm vụ through `tools/agent-questions`.
