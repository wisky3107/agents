# Verify-main prompt (producer runner, after a fleet merge → `agent-session --json --role worker --slice <Sxx> --title verify-<slug>-<Sxx>`)

Step 2d.3 asks for "the primary-checkout integration/runtime verification before marking the slice
merged". The runner spawns this short integrator lane on the main checkout once the primary Editor
is back (`wait-mcp` passed) and waits on `verify-main.json`. Replace `<PROJECT>`, `<Sxx>`,
`<EVIDENCE_DIR>`, `<BRANCH>`, `<SHA>`. cc4 checkouts and projects without Funplay never get this
prompt: the runner records `manual_required` and asks the director.

```text
You are the integrator verifying the main checkout <PROJECT> right after slice <Sxx> (branch <BRANCH>,
commit <SHA>) was merged into it. You verify and report; you do not change game files, scenes,
settings, slices or the PLAN, and you do not commit. AGENTS.md and .cursor/rules are already loaded;
do not open .cursor/skills/** unless a step names the file.

1. Funplay: `node .cursor/skills/vibe-game-director/scripts/probe.mjs --only funplay` from <PROJECT>
   → parity true (the producer already waited for it once). Not true → status failed.
2. Refresh assets once, open the main scene, and confirm the Editor reports no MissingScript and no
   missing-asset errors.
3. Feature Cropping: if the merge changed engine modules (physics, 2D physics, spine, …), every
   active config's includeModules lists both the parent feature and its selected backend (for
   example physics + physics-ammo).
4. Preview: reuse the healthy browser preview or run run_project_preview({mode:"browser"}) once,
   then `node .cursor/skills/smoke-test/scripts/run-smoke.mjs --port <port of that preview> --channel chrome`, plus the
   flags in scripts/smoke/run-args.json when it exists, must be green. Chrome like the gate: an Orca tab right after
   the Editor reopened, or behind another preview, reads false reds (pilot 24 S39 verify: 19 on orca, the 7 known on
   chrome). The run-args flags are the ones the gate, the writer and the reviewer ran with (`--settle` waits for the
   first scene, `--viewport` pins the size): without them a start-up or viewport-pinned check reads red (pilot 24 S41
   verify: S01-02-layout-baseline red without --settle, green with it). Do not replay feel rows; the slice review
   already did. A big suite takes minutes: run it with a Bash timeout of 600000 (or in the background) and stdout to
   a file, e.g. `> <EVIDENCE_DIR>/verify-smoke.json`, then read that file. When run-args.json has no `--viewport`
   and `grep -q -- '--viewport' .cursor/skills/smoke-test/scripts/run-smoke.mjs` succeeds, also pass
   `--viewport <the portrait V1 size in EXPECT_GAMEPLAY_VISUAL.md, else the design resolution>` (a landscape page
   stalled cc-lego-stack S11's verify on 2026-10-05).
5. Write <EVIDENCE_DIR>/verify-main.json:
   {"status":"verified|manual_required|failed","checks":{"funplay":"…","missing_script":"…","include_modules":"…","smoke":"…"},"detail":"<one line>","updatedAt":"<ISO>"}
   manual_required only with the real reason (the preview cannot start, a device is needed). Then stop.
```
