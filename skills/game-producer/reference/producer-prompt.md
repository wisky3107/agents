# Producer spawn prompt (from `new-cocos-game` Step 8 / `store-game-clone` Step 6)

Spawn **inside the project** with the locked orchestrator agent; never run the producer from the
bootstrap chat.

**Pick the mode from AGENT_NOTES `release.producer_mode`** (missing → `llm`):
- `llm` — the prompt below: one model runs the whole skill.
- `runner` — same command, but `--title "producer-step01-<slug>"` and the prompt from
  [producer-step01-prompt.md](producer-step01-prompt.md) (`<RUNNER>` =
  `~/.agents/skills/game-producer/scripts/producer-runner.mjs`): the model does Step 0–1, then
  launches the runner for the slice loop (SKILL § Runner mode).

```bash
node ~/.agents/skills/new-cocos-game/scripts/bootstrap.mjs agent-session --json \
  --path "<PROJECT>" \
  --agent "<fleet.orchestrator_agent>" \
  --role producer \
  --title "producer-<slug>" \
  --prompt "$(cat <<'EOF'
You are the game-producer for the Cocos project at <PROJECT>. Your shell cwd and Orca worktree
MUST stay this project (or a child worktree you create from it).

1. Assert pwd is <PROJECT>. Uncommitted contract files from game-brief / setup-project are
   expected; snapshot anything else into forbidden_changes.
2. Read ONLY the leading yaml fence of AGENT_NOTES.md plus the `policy` line under
   `## Notes — game-producer`. Do not load the rest of that file (Notes history is not input).
   yaml release: is your policy; yaml fleet: are the lane agents. Lock both at start;
   precedence: this prompt > file > defaults. Pass resolved locks into every lane prompt —
   lanes must not open AGENT_NOTES.md.
3. Read MILESTONES.md, RELEASE_CHECKLIST.md, every slices/S*.md, and the root contracts.
   Forward optional recipe_refs to lanes; collect learning-candidates.json and reviewed reuse
   results before cleanup. Run the recipe-aware retro even at a playable/deploy=none stop.
4. Read and follow .cursor/skills/game-producer/SKILL.md in this project. If the skill folder is
   missing, copy it from /Users/wikz/Works/games/template/cc-game-template/.cursor/skills/game-producer
   and say so before starting.
5. Confirm orca.yaml + scripts/setup-orca-worktree.sh exist (cocos-orca-worktree); copy from the
   template if missing and say so.

Overrides (only lines the director asked for; otherwise delete this block):
goal: <end_to_end|playable> · deploy: <none|preview|prod> · max_parallel: <1|2> · auto_commit: <bool>

Run the director gate first, then the slice loop until the stop condition for the locked goal.
You are coordinator only: never edit game files or slice files, never hold the editor lock; spawn
fleet orchestrators / single agents as terminals in this project. Do not push unless I ask.
EOF
)"
```

Report the terminal handle to the director and stop monitoring from the bootstrap chat.
