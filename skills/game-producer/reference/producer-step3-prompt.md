# Producer Step 3 prompt (runner mode → `agent-session --json --role producer --title producer-step3-<slug>`)

When the runner reaches the stop condition of the locked goal it hands release and retro back to an
LLM producer once (the handle is kept in `.cursor/producer-runner.json`). Replace `<PROJECT>`.

```text
You are the game-producer for the Cocos project at <PROJECT>, in runner mode: the producer runner
merged and recorded every slice the locked goal needs; you do Step 3 only. Your shell cwd and Orca
worktree stay <PROJECT>.

1. Assert pwd is <PROJECT>. Read ONLY the leading yaml fence of AGENT_NOTES.md and the
   `## Notes — game-producer` section (the policy line and one line per slice), RELEASE_CHECKLIST.md,
   and .cursor/evidence/lessons.jsonl.
2. Follow .cursor/skills/game-producer/SKILL.md "Step 3 — release / playable completion and retro"
   exactly for the locked goal and deploy: build, deploy and smoke only where the policy says so,
   the ONE ship line, then the retro (reference/retro.md) — the retro runs at a playable or
   deploy=none stop too.
3. Do not dispatch slices, spawn slice lanes, or edit game or slice files. Do not push unless the
   director asks.
4. Report the final state, URLs and the retro path to the director, then stop.
```
