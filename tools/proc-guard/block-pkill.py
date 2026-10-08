#!/usr/bin/env python3
"""PreToolUse(Bash) guard: block pattern-based process kills.

macOS (BSD) pkill/pgrep stop option parsing at the first pattern, so
`pkill -f "http.server 7781" -n` treats `-n` as a second pattern and kills
every process whose argv contains "-n" (all Orca terminals via `--noprofile`,
every Cocos editor via `--nologin`). This happened on 2026-10-07 and again on
2026-10-08. Agents must kill exact pids instead.

Blocks:
  - pkill / killall in command position (any form)
  - pgrep with a flag after its pattern (the same trap when fed to kill)

Text that is never executed as shell is ignored, so docs and scripts may mention pkill:
quoted strings (unless run by `bash -c` / `eval`) and heredoc bodies fed to a non-shell
(python, node, cat > file ...). ~/.agents/bin/pkill guards what this hook cannot see.
"""
import json
import os
import re
import shlex
import sys

SHELL_CONSUMERS = {"bash", "sh", "zsh", "dash", "ksh", "eval", "ssh", "source", "."}
HEREDOC_RE = re.compile(r"<<-?\s*(['\"]?)([A-Za-z_][A-Za-z0-9_]*)\1")
SHELL_C_RE = re.compile(r"(?:\b(?:bash|sh|zsh|dash|ksh)\s+(?:-\w+\s+)*-\w*c\s*|\beval\s+)$")


def strip_heredocs(cmd: str) -> str:
    lines = cmd.split("\n")
    out = []
    i = 0
    while i < len(lines):
        line = lines[i]
        out.append(line)
        m = HEREDOC_RE.search(line)
        if m:
            seg = re.split(r"[;&|(]|\$\(", line[: m.start()])[-1].split()
            words = [w for w in seg if not w.startswith(("-", ">", "<")) and "=" not in w]
            consumer = os.path.basename(words[0]) if words else ""
            if consumer in ("sudo", "env", "exec", "command", "nohup", "time") and len(words) > 1:
                consumer = os.path.basename(words[1])
            body = []
            i += 1
            while i < len(lines) and lines[i].strip() != m.group(2):
                body.append(lines[i])
                i += 1
            if consumer in SHELL_CONSUMERS:
                out.extend(body)
            if i < len(lines):
                out.append(lines[i])
        i += 1
    return "\n".join(out)


def mask_quotes(cmd: str) -> str:
    """Blank the inside of quoted strings that the shell will not execute."""
    out = []
    i, n = 0, len(cmd)
    while i < n:
        ch = cmd[i]
        if ch == "\\" and i + 1 < n:
            out.append(cmd[i : i + 2])
            i += 2
            continue
        if ch in ("'", '"'):
            j = i + 1
            while j < n and cmd[j] != ch:
                j += 2 if (ch == '"' and cmd[j] == "\\") else 1
            inner = cmd[i + 1 : j]
            runs = SHELL_C_RE.search(cmd[:i]) or (ch == '"' and ("$(" in inner or "`" in inner))
            out.append(ch + (inner if runs else re.sub(r"[^\n]", " ", inner)) + (cmd[j] if j < n else ""))
            i = j + 1
            continue
        out.append(ch)
        i += 1
    return "".join(out)

CMD_POS = r"(?:^|[;&|(\n`{'\"]|\$\(|\bthen\b|\bdo\b|\belse\b)\s*(?:(?:sudo|exec|command|nohup|time)\s+|xargs\s+(?:-\S+\s+)*|env\s+(?:\S+=\S*\s+)*)*(?:/usr/bin/|/bin/)?"
KILL_RE = re.compile(CMD_POS + r"(pkill|killall)\b")
PGREP_RE = re.compile(CMD_POS + r"pgrep\b([^;&|)\n`]*)")
# pgrep options that take a value (BSD)
PGREP_ARG_OPTS = {"-F", "-G", "-g", "-P", "-s", "-t", "-U", "-u", "-M", "-N", "-J"}

ADVICE = (
    "Kill exact pids instead: list first with `pgrep -lf 'PATTERN'` (all flags BEFORE the "
    "pattern), read the list, then `kill <pid>`. For a server you started, save `$!` and "
    "`kill $PID`. For a port: `kill $(lsof -nP -iTCP:PORT -sTCP:LISTEN -t)`."
)


def pgrep_flag_after_pattern(args: str) -> bool:
    try:
        toks = shlex.split(args, comments=False, posix=True)
    except ValueError:
        toks = args.split()
    seen_pattern = False
    skip = False
    for t in toks:
        if skip:
            skip = False
            continue
        if t.startswith(">") or t.startswith("2>") or t.startswith("<"):
            break
        if t.startswith("-") and len(t) > 1:
            if seen_pattern:
                return True
            if t in PGREP_ARG_OPTS:
                skip = True
            continue
        seen_pattern = True
    return False


def deny(reason: str) -> None:
    print(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": reason,
        }
    }))
    sys.exit(0)


def main() -> None:
    try:
        data = json.load(sys.stdin)
    except Exception:
        return
    cmd = (data.get("tool_input") or {}).get("command") or ""
    if not cmd:
        return
    cmd = mask_quotes(strip_heredocs(cmd))
    m = KILL_RE.search(cmd)
    if m:
        deny(
            f"BLOCKED `{m.group(1)}`: pattern kills are banned on this Mac. BSD pkill treats any "
            f"flag after the pattern as another pattern (`pkill -f X -n` killed every Orca "
            f"terminal and Cocos editor on 2026-10-07 and 2026-10-08). {ADVICE}"
        )
    for pm in PGREP_RE.finditer(cmd):
        if pgrep_flag_after_pattern(pm.group(1)):
            deny(
                "BLOCKED `pgrep` with a flag after the pattern: on macOS that flag becomes a "
                f"second pattern and matches unrelated processes. Put every flag before the pattern. {ADVICE}"
            )


if __name__ == "__main__":
    main()
