# Fleet task specs: char-concept → char-mesh → char-anim

Use one chain per character; chains for different characters run in parallel. Fill in `<ID>`,
`<ART_PATHS>` (the PLAN's `art_paths`, or `dest` outside a fleet), `<EVIDENCE_ROOT>`
(default `evidence`), `<CAG>` (`.cursor/skills/cocos-asset-gen/scripts` in a Cocos project,
else `~/.agents/skills/cocos-asset-gen/scripts`), `<CHAR_ANIM_HOME>`, `<CLIPS>`, `<EXPORT>`,
`<HEIGHT_M>`, `<PROJECT_SLUG>`, and the next handle in the chain.

Launch rules follow the host fleet skill:
- In `cocos-orca-fleet`, each art gen role uses **recipe C**, meaning no AGENTS.md boot and
  this spec as the first turn. Concept is always Antigravity (`agy --dangerously-skip-permissions`).
- In `orca-agent-fleet`, use the plain worker start with this spec.
- Outside any fleet (one coordinator session, for example Claude Code without image tools), use
  the solo launch below.
- Close terminals after `worker_done`.
- Solo (no next agent in the chain): drop the `send --type status --to <…_HANDLE>` step; the
  coordinator picks up `worker_done` itself.

| Task | Agent | Owns (disjoint) | Done when |
|---|---|---|---|
| `char-concept-<ID>` | antigravity (own image tools) | `<ART_PATHS>/concepts/<ID>/**`, `<EVIDENCE_ROOT>/art/<ID>/concept-check.md` | `CONCEPT: PASS`; `status` sent to the mesh handle |
| `char-mesh-<ID>` | any agent with shell + Blender | `<ART_PATHS>/gen3d/<ID>/**`, `<EVIDENCE_ROOT>/art/<ID>/{gen3d-report.json,review/**,model/**,model-check.md}` | `VERDICT: PASS`; `status` sent to the anim handle |
| `char-anim-<ID>` | any agent with shell + Blender on the machine that has `<CHAR_ANIM_HOME>` | `<CHAR_ANIM_HOME>/{characters,jobs,out,build/<ID>-*}/<ID>*`, `<ART_PATHS>/characters/<ID>/**`, `<EVIDENCE_ROOT>/art/<ID>/anim-check.md` | `ANIM: PASS`; deliverables copied |

---

## char-concept-<ID>

```text
ROLE: writer (assets) — rig-ready concept for an animated character. Antigravity image tools only.
Owns ONLY: <ART_PATHS>/concepts/<ID>/** and <EVIDENCE_ROOT>/art/<ID>/concept-check.md.
Brief: <NAME> — <design text from the user / GAME_BRIEF>.

Do:
1. Read ~/.agents/skills/char-anim/reference/concept-prompt.md. Build the prompt from its template
   (A-pose, one figure per image, no props / cape / long skirt, plain background).
2. Generate concept-front.png first, then concept-threequarter.png and concept-back.png with the
   front as the reference. Only the VIEW line changes between them.
   Do NOT call orca-gpt-image-gen / ChatGPT, and never make a multi-view sheet.
3. Open every PNG and write concept-check.md with the checklist in concept-prompt.md.
   Its last line is CONCEPT: PASS | CONCEPT: FAIL — <reason>.
4. FAIL → regenerate, at most 2 rounds. Still no PASS → worker_done --outcome failed.
5. PASS → orca orchestration send --type status --to <MESH_HANDLE> --subject "concept ready"
   --body "<ART_PATHS>/concepts/<ID>", then worker_done listing the PNGs.

Never: write .glb files; touch other characters' files; open Creator; create .meta.
```

## char-mesh-<ID>

```text
ROLE: writer (assets) — one character mesh via 3D Gen Studio. Depends on CONCEPT: PASS.
Owns ONLY: <ART_PATHS>/gen3d/<ID>/** and <EVIDENCE_ROOT>/art/<ID>/{gen3d-report.json,review/**,model/**,model-check.md}.

Do:
1. Confirm concept-check.md ends CONCEPT: PASS and open concept-front.png. If it is missing →
   ask, never invent a concept.
2. python3 <CAG>/gen3d_studio.py --check. Exit 2 → escalate "studio unavailable"; a primitive
   Blender figure cannot be rigged.
3. python3 <CAG>/gen3d_studio.py --image <ART_PATHS>/concepts/<ID>/concept-front.png --stem <ID> \
     --out-dir <ART_PATHS>/gen3d/<ID> --evidence-dir <EVIDENCE_ROOT>/art/<ID> \
     --project "<PROJECT_SLUG>" --target-tris 30000 --lod-ratios 0.5 --collision none
   Read gen3d-report.json: game.triangles ≤ 40000, bake coverage ≥ 0.95, seam_limited false.
   Finishing issues → rerun with --source-glb <ART_PATHS>/gen3d/<ID>/<ID>_high.glb (no credits),
   at most 2 times.
4. <CHAR_ANIM_HOME>/anim normalize <ART_PATHS>/gen3d/<ID>/<ID>.glb \
     --out <EVIDENCE_ROOT>/art/<ID>/review/<ID>-front.glb --face=-Y
   "$BLENDER" --background --python <CAG>/render_model_iso.py -- \
     --input <EVIDENCE_ROOT>/art/<ID>/review/<ID>-front.glb \
     --out <EVIDENCE_ROOT>/art/<ID>/model[/round-<n>] --concepts <ART_PATHS>/concepts/<ID>
5. Open contact-sheet.png and compare-sheet.png, then write model-check.md:
     ## <ID>.glb — round <n>
     source: gen3d-report.json (high <n> tris → game <n>, coverage <c>, ~<n> credits)
     concept match: PASS|FAIL — front / threequarter / back rows
     single humanoid, arms clear of torso, two separate legs to the feet, hands present: PASS|FAIL
     no fused props / base / second figure: PASS|FAIL
     tri budget: PASS|FAIL — <n> ≤ 40000
     VERDICT: PASS | VERDICT: FAIL — <reason>
   FAIL → fix and re-render into round-<n+1>, at most 3 rounds. If the silhouette itself is
   wrong, escalate for a new concept round instead of regenerating blind.
6. PASS → send status to <ANIM_HANDLE> --subject "mesh ready" --body "<ART_PATHS>/gen3d/<ID>/<ID>.glb",
   then worker_done listing the files.

Never: edit the concepts; create .meta; open Creator.
```

## char-anim-<ID>

```text
ROLE: writer (assets) — rig + animate one character with char-anim-pipeline. Depends on VERDICT: PASS.
Owns ONLY: the <ID> files in <CHAR_ANIM_HOME> (characters/<ID>/, jobs/<ID>-*.json, out/<ID>-*/,
build/<ID>-*/, build/rig/<ID>*), <ART_PATHS>/characters/<ID>/** and
<EVIDENCE_ROOT>/art/<ID>/anim-check.md.
Clips: <CLIPS> (authored: idle, walk, run, jump, attack; others = mocap files <MOCAP_FILES>). Export: <EXPORT>.

Do:
1. Read <CHAR_ANIM_HOME>/CLAUDE.md, which maps the prompt to commands and says how to check results.
2. From the project dir (the mesh path resolves from cwd):
   <CHAR_ANIM_HOME>/anim character <ART_PATHS>/gen3d/<ID>/<ID>.glb --id <ID> \
     --height <HEIGHT_M> --clips <authored clips> --export <EXPORT> [--pixel <PX_PER_M>] --run
   (--pixel only when the brief asks for pixel art; later tweaks: edit the job's "pixel" block,
   then ./anim run jobs/<ID>-core.json --repack)
   RIG_REPORT must show pose "A", normalize.scale sane, empty_bone_groups [] and unweighted_vertices 0.
   A rig failure or pose T/other means a concept problem → escalate with the RIG_REPORT line
   (the coordinator reopens char-concept). Don't hand-edit the mesh.
3. Mocap clips: copy the take into <CHAR_ANIM_HOME>/mocap/, then run ./anim inspect <file>. Add a clip
   with a "source" block (mocap/README.md §4) to jobs/<ID>-core.json, then run
   ./anim run jobs/<ID>-core.json --clips <clip> (from <CHAR_ANIM_HOME>: job paths are relative to it). Don't use `anim mocap`: it writes jobs/<clip>.json,
   which is shared across characters.
4. Check out/<job>/qa.json (verdict pass) and open every evidence/<clip>-contact-sheet.png.
   Write anim-check.md with one line per clip plus a final ANIM: PASS | ANIM: FAIL — <clip>: <reason>.
   Pose or timing fixes go in jobs/<ID>-core.json → ./anim run jobs/<ID>-core.json --clips <clip>,
   at most 2 rounds per clip.
5. Copy out/<job>/{fbx,fbf,player.html,manifest.json,qa.json} to <ART_PATHS>/characters/<ID>/.
   No .meta files.
6. worker_done listing the deliverables plus the key manifest facts (takes, seconds, events:
   FBX events have time_s; fbf events have `frame`, a 0-based index).

Never: edit airi or another character's files; change pipeline code (report pipeline bugs
through an escalation); open Creator.
```

---

## Solo launch (no fleet)

This is recipe C without a fleet. The steps below are the ones that worked on 2026-09-23
(goldie test). Run them from any Orca worktree. `--worktree current` is fine even when `<ART_PATHS>`
lives outside that worktree: the terminal `cd`s there itself.

```bash
RUN=$(orca orchestration run-create --objective "char-concept <ID>" --json | python3 -c "import sys,json; r=json.loads(sys.stdin.read(),strict=False)['result']; print(r.get('run',r)['id'])")
orca orchestration task-create --run "$RUN" --task-title "char-concept-<ID>" --display-name "char-concept-<ID>" \
  --spec "$(cat <EVIDENCE_ROOT>/art/<ID>/concept-task.txt)" --json >/dev/null
orca orchestration task-list --run "$RUN" --json      # take the task id from here
H=$(orca terminal create --worktree current --title "char-concept-<ID>" \
  --command "cd <PROJECT_DIR> && agy --dangerously-skip-permissions" --json \
  | python3 -c "import sys,json; r=json.loads(sys.stdin.read(),strict=False)['result']; print(r.get('handle') or r['terminal']['handle'])")
orca terminal wait --terminal "$H" --for tui-idle --timeout-ms 90000 --json
orca orchestration worker-start --task <TASK_ID> --terminal "$H" --worktree current --json
```

Known traps:
- `--json` output can contain control characters that make `jq` fail. Parse it with
  `json.loads(..., strict=False)`.
- `agy --dangerously-skip-permissions` needs the user's OK when the session runs in auto mode.
- On the first launch in a new folder, Antigravity asks to trust it. After you answer, Orca keeps
  `blockedReason: codex-trust-workspace` and `worker-start` fails every time. Close that
  terminal and create a new one: the folder is trusted now, so the new terminal starts cleanly.
- Wait for the worker with `orca orchestration check --run "$RUN" --wait ...`. Without `--run`,
  check does not see the run's messages, and `--types` does not filter out heartbeats.
  If `worker_done` never arrives, `orca orchestration worker-show --dispatch <ctx_…>` shows
  `state: succeeded` when the worker has finished.
- Review the PNGs yourself: append a coordinator review to concept-check.md that ends in its own
  `CONCEPT:` line.

