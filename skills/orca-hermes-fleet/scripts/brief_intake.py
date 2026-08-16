#!/usr/bin/env python3
"""Scan an Orca/Hermes project brief for missing, excessive, or conflicting signals."""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path


CATEGORIES = {
    "outcome": ("outcome", "goal", "mục tiêu", "kết quả", "build", "create", "tạo"),
    "target": ("repo", "repository", "path", "project", "dự án", "worktree", "branch"),
    "acceptance": ("acceptance", "done", "pass", "verify", "test", "build", "hoàn thành", "kiểm thử"),
    "scope": ("scope", "must", "should", "exclude", "không", "phạm vi", "ít nhất"),
    "review": ("review", "reviewer", "approve", "re-review", "duyệt"),
    "gates": ("deploy", "push", "merge", "production", "delete", "credential", "phê duyệt"),
}


def has_signal(text: str, words: tuple[str, ...]) -> bool:
    lowered = text.lower()
    return any(word in lowered for word in words)


def repeated_lines(lines: list[str]) -> list[str]:
    normalized: dict[str, int] = {}
    originals: dict[str, str] = {}
    for line in lines:
        key = re.sub(r"\W+", " ", line.lower()).strip()
        if len(key) < 18:
            continue
        normalized[key] = normalized.get(key, 0) + 1
        originals.setdefault(key, line.strip())
    return [originals[key] for key, count in normalized.items() if count > 1]


def analyze(text: str) -> dict[str, object]:
    lines = [line for line in text.splitlines() if line.strip()]
    signals = {name: has_signal(text, words) for name, words in CATEGORIES.items()}
    missing = [name for name in ("outcome", "target", "acceptance", "scope") if not signals[name]]
    conflicts = []
    lowered = text.lower()
    if "orca" in lowered and "hermes kanban" in lowered:
        conflicts.append("Multiple control planes mentioned; choose Orca Orchestration or Hermes Kanban as owner.")
    if "same worktree" in lowered and ("parallel" in lowered or "song song" in lowered):
        conflicts.append("Parallel writers in one worktree require explicit non-overlapping ownership or isolation.")
    excess = repeated_lines(lines)
    questions = []
    prompts = {
        "outcome": "Kết quả quan sát được nào phải tồn tại khi workflow hoàn tất?",
        "target": "Repository/path và base branch/commit chính xác là gì?",
        "acceptance": "Điều kiện kiểm chứng nào quyết định task đạt hay chưa đạt?",
        "scope": "Phần nào là bắt buộc, tùy chọn và bị loại trừ?",
    }
    for item in missing:
        questions.append(prompts[item])
    if not signals["review"] and ("orca" in lowered or "hermes" in lowered):
        questions.append("Những artifact nào cần reviewer độc lập và verdict nào chặn integration?")
    return {
        "signals": signals,
        "missing": missing,
        "conflicts": conflicts,
        "repeated_requirements": excess,
        "recommended_questions": questions[:3],
        "needs_clarification": bool(missing or conflicts),
        "word_count": len(text.split()),
        "line_count": len(lines),
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("brief", type=Path, help="Markdown or text brief")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    result = analyze(args.brief.read_text(encoding="utf-8"))
    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        for key, value in result.items():
            print(f"{key}: {value}")
    return 1 if result["needs_clarification"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
