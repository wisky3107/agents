# proc-guard

Stops pattern kills that wipe the fleet. BSD `pkill`/`pgrep` (macOS) stop option parsing at the
first pattern, so `pkill -f "http.server 7781" -n` reads `-n` as a second pattern and kills every
process whose argv contains `-n`: every Orca terminal (`login … --noprofile`), every Cocos editor
(`--nologin`), agy-rotate (`--no-warnings`). Happened 2026-10-07 14:23Z, 16:07Z and 2026-10-08 02:53Z.

| Layer | Covers | Where |
|---|---|---|
| `pkill` shim (also `pgrep` via symlink) | every agent and human shell with `~/.agents/bin` first in PATH (`.zshenv`, `.zprofile`, `.zshrc`) | `bin/pkill`, `bin/pgrep` → `tools/proc-guard/pkill` |
| Claude Code hook | Claude sessions: denies any `pkill`/`killall`, and `pgrep` with a flag after the pattern | `~/.claude/hooks/block-pkill.py` (copy of `block-pkill.py`), PreToolUse `Bash` in `~/.claude/settings.json` |
| Rule | every game made from a template | `## Processes` in `.cursor/rules/00-guardrails.mdc` (agent-skills + 4 templates), worker prompts |

The shim refuses a flag after the pattern (exit 2) and otherwise execs `/usr/bin/<name>`.
Calling `/usr/bin/pkill` directly bypasses it. Agents should kill exact pids anyway (`$!`, or a
pid checked with `lsof -nP -iTCP:<port> -sTCP:LISTEN`).

Install / repair: `ln -sf ../tools/proc-guard/pkill ~/.agents/bin/pkill; ln -sf ../tools/proc-guard/pkill ~/.agents/bin/pgrep;
cp tools/proc-guard/block-pkill.py ~/.claude/hooks/`. Orca rewrites hook entries in
`~/.claude/settings.json`; if the `Bash` PreToolUse entry is gone, re-add
`{"matcher":"Bash","hooks":[{"type":"command","command":"python3 \"$HOME/.claude/hooks/block-pkill.py\"","timeout":10}]}`.
