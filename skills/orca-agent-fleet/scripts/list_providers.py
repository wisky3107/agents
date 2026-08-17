#!/usr/bin/env python3
"""List Orca TUI providers accepted by orca-agent-fleet, their launch model catalogs, and eligibility.

Usage:
  python3 list_providers.py [--orca-version]

Emits one JSON object on stdout:
  runtime        current runtime tag (darwin/linux/win32/wsl)
  accepted       every accepted Orca TUI agent id
  autoPickOrder  Orca's TUI_AGENT_AUTO_PICK_ORDER
  installed      ids whose detect binary (or alias) is on PATH
  eligible       installed AND required companions present AND runtime supported
  defaultProvider/defaultModel/defaultEffort  fleet defaults resolved from `eligible`
  providers      per-provider detail, including the Orca session-option model catalog

Eligibility here is PATH + runtime only. Auth is NOT checked; confirm it separately
(`orca account list --json` for Claude/Codex, provider CLI status for others).
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys

CATALOG_SOURCE = "Orca 1.4.180 TUI_AGENT_CONFIG / TUI_AGENT_AUTO_PICK_ORDER / agent session-option catalogs"

# Effort choice sets, keyed for reuse below.
_CODEX_EFFORT = ["minimal", "low", "medium", "high", "xhigh"]
_CODEX_EFFORT_NO_XHIGH = ["minimal", "low", "medium", "high"]
_CLAUDE_EFFORT = ["low", "medium", "high", "xhigh", "max"]
_LMH = ["low", "medium", "high"]


def _model(model_id: str, *, default: bool = False, effort=None, effort_default=None):
    return {
        "id": model_id,
        "isCatalogDefault": default,
        "effort": effort,
        "effortDefault": effort_default,
    }


# Session-option catalogs Orca ships. Only these providers expose selectable model ids;
# every other agent launches on its own CLI default.
MODEL_CATALOGS = {
    "claude": [
        _model("fable", effort=_CLAUDE_EFFORT, effort_default="high"),
        _model("opus", effort=_CLAUDE_EFFORT, effort_default="high"),
        _model("sonnet", default=True, effort=_CLAUDE_EFFORT, effort_default="high"),
        _model("haiku"),  # no effort option; do not pass --effort with haiku
    ],
    "codex": [
        _model("gpt-5.6-sol", effort=_CODEX_EFFORT, effort_default="medium"),
        _model("gpt-5.6-terra", effort=_CODEX_EFFORT, effort_default="medium"),
        _model("gpt-5.6-luna", effort=_CODEX_EFFORT_NO_XHIGH, effort_default="medium"),
        _model("gpt-5.5", effort=_CODEX_EFFORT, effort_default="medium"),
        _model("gpt-5.2-codex", effort=_CODEX_EFFORT, effort_default="medium"),
    ],
    "cursor": [
        _model("auto", default=True),  # no effort option
        _model("gpt-5.3-codex", effort=_LMH, effort_default="high"),
        _model("claude-opus-4-8", effort=_LMH, effort_default="high"),
    ],
    "gemini": [
        _model("gemini-3-pro-preview"),
        _model("gemini-3-flash-preview"),
        _model("gemini-2.5-pro"),
        _model("gemini-2.5-flash"),
    ],
    "grok": [
        _model("grok-4.5", default=True, effort=_LMH, effort_default="high"),
    ],
}

# Provider id is the value passed to `orca ... --agent`.
#   workerStartModel: whether `worker-start --model/--effort` forwards to this agent.
#     Orca advertises launch preferences for Claude, Codex, and Cursor only.
#   defaultSource: "orca-catalog" when Orca marks the model default; "skill-convention"
#     when this skill picks it; None when the provider launches on its CLI default.
PROVIDERS = [
    {
        "id": "claude",
        "label": "Claude",
        "detect": ["claude"],
        "launch": "claude",
        "defaultModel": "sonnet",
        "defaultEffort": "high",
        "defaultSource": "orca-catalog",
        "workerStartModel": True,
    },
    {
        "id": "claude-agent-teams",
        "label": "Claude Agent Teams",
        "detect": ["orca", "orca-dev", "orca-ide"],
        "required": ["claude"],
        "unsupportedRuntimes": ["win32", "wsl"],
        "launch": "orca claude-teams",
        "defaultModel": None,
        "defaultEffort": None,
        "defaultSource": None,
        "workerStartModel": False,
    },
    {
        "id": "openclaude",
        "label": "OpenClaude",
        "detect": ["openclaude"],
        "launch": "openclaude",
        "defaultModel": None,
        "defaultEffort": None,
        "defaultSource": None,
        "workerStartModel": False,
    },
    {
        "id": "codex",
        "label": "Codex",
        "detect": ["codex"],
        "launch": "codex",
        "defaultModel": "gpt-5.6-terra",
        "defaultEffort": "medium",
        "defaultSource": "skill-convention",
        "workerStartModel": True,
    },
    {
        "id": "grok",
        "label": "Grok",
        "detect": ["grok"],
        "launch": "grok",
        "defaultModel": "grok-4.5",
        "defaultEffort": "high",
        "defaultSource": "orca-catalog",
        "workerStartModel": False,
    },
    {
        "id": "copilot",
        "label": "GitHub Copilot",
        "detect": ["copilot"],
        "launch": "copilot",
        "defaultModel": None,
        "defaultEffort": None,
        "defaultSource": None,
        "workerStartModel": False,
    },
    {
        "id": "opencode",
        "label": "OpenCode",
        "detect": ["opencode"],
        "launch": "opencode",
        "defaultModel": None,
        "defaultEffort": None,
        "defaultSource": None,
        "workerStartModel": False,
    },
    {
        "id": "mimo-code",
        "label": "MiMo Code",
        "detect": ["mimo"],
        "launch": "mimo",
        "defaultModel": None,
        "defaultEffort": None,
        "defaultSource": None,
        "workerStartModel": False,
    },
    {
        "id": "ante",
        "label": "Ante",
        "detect": ["ante"],
        "launch": "ante",
        "defaultModel": None,
        "defaultEffort": None,
        "defaultSource": None,
        "workerStartModel": False,
    },
    {
        "id": "trae",
        "label": "Trae",
        "detect": ["traecli"],
        "launch": "traecli",
        "defaultModel": None,
        "defaultEffort": None,
        "defaultSource": None,
        "workerStartModel": False,
    },
    {
        "id": "pi",
        "label": "Pi",
        "detect": ["pi"],
        "launch": "pi",
        "defaultModel": None,
        "defaultEffort": None,
        "defaultSource": None,
        "workerStartModel": False,
    },
    {
        "id": "omp",
        "label": "OMP",
        "detect": ["omp"],
        "launch": "omp",
        "defaultModel": None,
        "defaultEffort": None,
        "defaultSource": None,
        "workerStartModel": False,
    },
    {
        "id": "gemini",
        "label": "Gemini",
        "detect": ["gemini"],
        "launch": "gemini",
        "defaultModel": "gemini-3-flash-preview",
        "defaultEffort": None,
        "defaultSource": "skill-convention",
        "workerStartModel": False,
    },
    {
        "id": "antigravity",
        "label": "Antigravity",
        "detect": ["agy"],
        "launch": "agy",
        "defaultModel": None,
        "defaultEffort": None,
        "defaultSource": None,
        "workerStartModel": False,
    },
    {
        "id": "aider",
        "label": "Aider",
        "detect": ["aider"],
        "launch": "aider",
        "defaultModel": None,
        "defaultEffort": None,
        "defaultSource": None,
        "workerStartModel": False,
    },
    {
        "id": "goose",
        "label": "Goose",
        "detect": ["goose"],
        "launch": "goose",
        "defaultModel": None,
        "defaultEffort": None,
        "defaultSource": None,
        "workerStartModel": False,
    },
    {
        "id": "amp",
        "label": "Amp",
        "detect": ["amp"],
        "launch": "amp",
        "defaultModel": None,
        "defaultEffort": None,
        "defaultSource": None,
        "workerStartModel": False,
    },
    {
        "id": "kilo",
        "label": "Kilocode",
        "detect": ["kilo"],
        "launch": "kilo",
        "defaultModel": None,
        "defaultEffort": None,
        "defaultSource": None,
        "workerStartModel": False,
    },
    {
        "id": "kiro",
        "label": "Kiro",
        "detect": ["kiro-cli"],
        "launch": "kiro-cli chat --tui",
        "defaultModel": None,
        "defaultEffort": None,
        "defaultSource": None,
        "workerStartModel": False,
    },
    {
        "id": "crush",
        "label": "Charm Crush",
        "detect": ["crush"],
        "launch": "crush",
        "defaultModel": None,
        "defaultEffort": None,
        "defaultSource": None,
        "workerStartModel": False,
    },
    {
        "id": "aug",
        "label": "Auggie",
        "detect": ["auggie"],
        "launch": "auggie",
        "defaultModel": None,
        "defaultEffort": None,
        "defaultSource": None,
        "workerStartModel": False,
    },
    {
        "id": "autohand",
        "label": "Autohand Code",
        "detect": ["autohand"],
        "launch": "autohand",
        "defaultModel": None,
        "defaultEffort": None,
        "defaultSource": None,
        "workerStartModel": False,
    },
    {
        "id": "cline",
        "label": "Cline",
        "detect": ["cline"],
        "launch": "cline",
        "defaultModel": None,
        "defaultEffort": None,
        "defaultSource": None,
        "workerStartModel": False,
    },
    {
        "id": "codebuff",
        "label": "Codebuff",
        "detect": ["codebuff"],
        "launch": "codebuff",
        "defaultModel": None,
        "defaultEffort": None,
        "defaultSource": None,
        "workerStartModel": False,
    },
    {
        "id": "command-code",
        "label": "Command Code",
        "detect": ["command-code"],
        "launch": "command-code --trust",
        "defaultModel": None,
        "defaultEffort": None,
        "defaultSource": None,
        "workerStartModel": False,
    },
    {
        "id": "continue",
        "label": "Continue",
        "detect": ["cn"],
        "launch": "cn",
        "defaultModel": None,
        "defaultEffort": None,
        "defaultSource": None,
        "workerStartModel": False,
    },
    {
        "id": "cursor",
        "label": "Cursor",
        "detect": ["cursor-agent"],
        "launch": "cursor-agent",
        "defaultModel": "auto",
        "defaultEffort": None,  # `auto` exposes no effort option
        "defaultSource": "orca-catalog",
        "workerStartModel": True,
    },
    {
        "id": "droid",
        "label": "Droid",
        "detect": ["droid"],
        "launch": "droid",
        "defaultModel": None,
        "defaultEffort": None,
        "defaultSource": None,
        "workerStartModel": False,
    },
    {
        "id": "kimi",
        "label": "Kimi Code",
        "detect": ["kimi"],
        "launch": "kimi",
        "defaultModel": None,
        "defaultEffort": None,
        "defaultSource": None,
        "workerStartModel": False,
    },
    {
        "id": "mistral-vibe",
        "label": "Mistral Vibe",
        "detect": ["vibe", "mistral-vibe"],
        "launch": "vibe",
        "defaultModel": None,
        "defaultEffort": None,
        "defaultSource": None,
        "workerStartModel": False,
    },
    {
        "id": "qwen-code",
        "label": "Qwen Code",
        "detect": ["qwen"],
        "launch": "qwen",
        "defaultModel": None,
        "defaultEffort": None,
        "defaultSource": None,
        "workerStartModel": False,
    },
    {
        "id": "rovo",
        "label": "Rovo Dev",
        "detect": ["rovo"],
        "launch": "rovo",
        "defaultModel": None,
        "defaultEffort": None,
        "defaultSource": None,
        "workerStartModel": False,
    },
    {
        "id": "hermes",
        "label": "Hermes",
        "detect": ["hermes"],
        "launch": "hermes --tui",
        "defaultModel": None,
        "defaultEffort": None,
        "defaultSource": None,
        "workerStartModel": False,
    },
    {
        "id": "devin",
        "label": "Devin",
        "detect": ["devin"],
        "launch": "devin",
        "defaultModel": None,
        "defaultEffort": None,
        "defaultSource": None,
        "workerStartModel": False,
    },
    {
        "id": "openclaw",
        "label": "OpenClaw",
        "detect": ["openclaw"],
        "launch": "openclaw",
        "defaultModel": None,
        "defaultEffort": None,
        "defaultSource": None,
        "workerStartModel": False,
    },
]

AUTO_PICK_ORDER = [
    "claude",
    "claude-agent-teams",
    "openclaude",
    "codex",
    "grok",
    "copilot",
    "opencode",
    "mimo-code",
    "ante",
    "trae",
    "pi",
    "omp",
    "gemini",
    "antigravity",
    "aider",
    "goose",
    "amp",
    "kilo",
    "kiro",
    "crush",
    "aug",
    "autohand",
    "cline",
    "codebuff",
    "command-code",
    "continue",
    "cursor",
    "droid",
    "kimi",
    "mistral-vibe",
    "qwen-code",
    "rovo",
    "hermes",
    "devin",
    "openclaw",
]

# This skill prefers codex over Orca's own auto-pick head (claude) for fleet workers.
PREFERRED_DEFAULT_PROVIDER = "codex"


def current_runtime() -> str:
    if sys.platform == "win32":
        return "win32"
    if os.environ.get("WSL_DISTRO_NAME") or os.environ.get("WSL_INTEROP"):
        return "wsl"
    return sys.platform


def command_on_path(name: str) -> bool:
    return shutil.which(name) is not None


def orca_app_version() -> str | None:
    """Best-effort Orca app version, for detecting a stale seed table."""
    try:
        proc = subprocess.run(
            ["orca", "status", "--json"],
            capture_output=True,
            text=True,
            timeout=20,
            check=False,
        )
        return json.loads(proc.stdout)["result"]["runtime"]["appVersion"]
    except Exception:
        return None


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--orca-version",
        action="store_true",
        help="also probe `orca status --json` for the running app version",
    )
    args = parser.parse_args()

    runtime = current_runtime()
    providers = []
    for spec in PROVIDERS:
        detect_found = [cmd for cmd in spec["detect"] if command_on_path(cmd)]
        required = spec.get("required", [])
        required_missing = [cmd for cmd in required if not command_on_path(cmd)]
        unsupported = runtime in spec.get("unsupportedRuntimes", [])
        installed = bool(detect_found)
        eligible = installed and not required_missing and not unsupported
        providers.append(
            {
                "id": spec["id"],
                "label": spec["label"],
                "detect": spec["detect"],
                "launch": spec["launch"],
                "defaultModel": spec["defaultModel"],
                "defaultEffort": spec["defaultEffort"],
                "defaultSource": spec["defaultSource"],
                "workerStartModel": spec["workerStartModel"],
                "models": MODEL_CATALOGS.get(spec["id"], []),
                "detectFound": detect_found,
                "requiredMissing": required_missing,
                "unsupportedRuntime": unsupported,
                "installed": installed,
                "eligible": eligible,
            }
        )

    eligible_ids = {row["id"] for row in providers if row["eligible"]}
    default_provider = (
        PREFERRED_DEFAULT_PROVIDER
        if PREFERRED_DEFAULT_PROVIDER in eligible_ids
        else next((a for a in AUTO_PICK_ORDER if a in eligible_ids), None)
    )
    default_row = next((row for row in providers if row["id"] == default_provider), None)

    payload = {
        "catalogSource": CATALOG_SOURCE,
        "runtime": runtime,
        "accepted": [row["id"] for row in providers],
        "autoPickOrder": AUTO_PICK_ORDER,
        "installed": [row["id"] for row in providers if row["installed"]],
        "eligible": [row["id"] for row in providers if row["eligible"]],
        "authChecked": False,
        "defaultProvider": default_provider,
        "defaultModel": default_row["defaultModel"] if default_row else None,
        "defaultEffort": default_row["defaultEffort"] if default_row else None,
        "providers": providers,
    }
    if args.orca_version:
        payload["orcaAppVersion"] = orca_app_version()

    json.dump(payload, sys.stdout, indent=2)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
