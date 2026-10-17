# agent-questions

Every question a Claude Code agent asks the director in an Orca terminal, in one queue that the
director console shows in **Nhiệm vụ → Agent hỏi**, next to the runner's own questions. You answer it
there or in the agent's chat. Whichever side answers first closes the question.

```bash
node ~/.agents/tools/agent-questions/agent-questions.mjs install-hook      # once: ~/.claude/settings.json
node ~/.agents/tools/agent-questions/agent-questions.mjs list [--all]
node ~/.agents/tools/agent-questions/agent-questions.mjs answer --id <id> --pick "1=<label>" [--text "…"]
node ~/.agents/tools/agent-questions/agent-questions.mjs dismiss --id <id> --note "…"
node ~/.agents/tools/agent-questions/agent-questions.mjs focus --id <id>
node --test ~/.agents/tools/agent-questions/test/agent-questions.test.mjs
```

## What the hook records

`install-hook` adds one entry per event, so the hook never starts for other tool calls. Other hooks
are left alone, and a `.bak-agent-questions` copy is kept. A running Claude session picks the hook up
only after a restart.

- `PreToolUse` AskUserQuestion → one `ask` question with every question, option, description and
  preview, what the agent said just before (from the transcript), and the images the text names.
- `Stop` → a `stop` question when the last two paragraphs ask something: a `?` once code, inline code
  and URLs are stripped, or a confirm phrase ("ok không", "được không", "should I", …). A later
  turn end supersedes it.
- `UserPromptSubmit` → every open question of the session is answered in the chat. `PostToolUse`
  does the same for the dialog. `SessionEnd` marks them gone and prunes week-old closed files.
- A question is recorded only from an interactive session in an Orca terminal
  (`ORCA_TERMINAL_HANDLE`, `CLAUDE_CODE_ENTRYPOINT=cli`), so there is somewhere to answer into.
- The runner's lane roles (`CC_ROLE` worker/reviewer/…) record dialogs only: the runner watches their
  idle turns itself.
- The hook prints nothing (UserPromptSubmit stdout would become context) and always exits 0. It takes
  ~40 ms.

The store is one JSON file per question in `~/.agents/run/agent-questions/<session>--<id>.json`, and
the events go to `~/.agents/logs/agent-questions.jsonl`.

## Quick replies

`store.mjs quickReplies(text)` gives ≤ 4 rule replies for a plain question:
- the action it names: "Commit đi", "Push đi", "Merge đi", "Deploy đi", "Chạy đi", "Tiếp tục đi", with
  "Chưa, để sau";
- otherwise the options it lists (`1.` / `a)` / `A:`), sent as "Chọn 2: …";
- otherwise the two sides of a short "A hay B?" / "A or B?" (≤ 3 words each);
- otherwise "Có, làm đi" / "Không" for a yes/no question.

An open question (gì, nào, mấy, which, what) or a statement gets none. The console adds better replies
from a model.

## How an answer reaches the agent

`answer` first checks that the terminal is still connected (else the question is `gone`) and claims
the question, so the hooks our own keys fire do not close it as a chat answer.

- **A dialog** takes keys, not text, and Orca refuses a prompt while one is open
  (`agent_prompt_blocked`). `--interrupt` does not close it, but a raw Esc does (the agent sees "User
  declined to answer"). Orca still holds the pane as blocked after that, so the answer is typed raw and
  submitted with a separate raw Enter, once the screen shows no dialog. The agent gets
  `[director console] Trả lời câu hỏi bạn vừa hỏi (hộp chọn đã đóng): (1) <header>: <picks> · Ghi chú: … .`
- **A plain question**: `[director console] <text>` goes in as a normal prompt (raw typing if Orca
  says the pane is blocked and the screen shows no dialog).

Verified live on Claude Code 2.1.302 (2026-10-17), for a dialog and for a plain question.

Not covered: codex, agy and other TUI agents; a dialog answered with Esc in the TUI stays open until
the next prompt.
