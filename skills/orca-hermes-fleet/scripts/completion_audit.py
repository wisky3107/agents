#!/usr/bin/env python3
"""Audit a normalized Orca/Hermes completion manifest."""

from __future__ import annotations

import argparse
import json
from pathlib import Path


def audit(data: dict) -> dict[str, object]:
    tasks = data.get("tasks", [])
    issues: list[str] = []
    for task in tasks:
        name = task.get("name", task.get("id", "unknown"))
        completion = task.get("completion")
        if completion == "worker_done":
            if not task.get("task_id") or not task.get("dispatch_id"):
                issues.append(f"{name}: worker_done missing task_id or dispatch_id")
        elif completion == "manual_override":
            if not task.get("override_reason"):
                issues.append(f"{name}: manual override lacks a reason")
        else:
            issues.append(f"{name}: no valid completion classification")
        if task.get("requires_review"):
            review = task.get("review", {})
            if review.get("verdict") not in {"APPROVED", "CHANGES_REQUESTED"}:
                issues.append(f"{name}: missing reviewer verdict")
            if review.get("reviewer_session") == task.get("author_session"):
                issues.append(f"{name}: reviewer is not independent")
            if review.get("source") == "coordinator_authored":
                issues.append(f"{name}: coordinator-authored report is not independent review")
        if not task.get("verification"):
            issues.append(f"{name}: no verification evidence")
    valid_worker_done = sum(1 for task in tasks if task.get("completion") == "worker_done")
    overrides = sum(1 for task in tasks if task.get("completion") == "manual_override")
    return {
        "ok": not issues,
        "issues": issues,
        "task_count": len(tasks),
        "valid_worker_done": valid_worker_done,
        "manual_overrides": overrides,
        "end_to_end_success": bool(tasks) and not issues and overrides == 0,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("manifest", type=Path)
    args = parser.parse_args()
    result = audit(json.loads(args.manifest.read_text(encoding="utf-8")))
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
