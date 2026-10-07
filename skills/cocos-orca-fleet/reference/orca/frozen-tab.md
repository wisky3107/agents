# Frozen Orca tab → Chrome headless fallback

From cc-love-train S08 (memory lesson `lt-s08-orca-tab-raf-hidden`) and cc-firefighter-kids S01
(three review rounds lost to it; the fourth, in Chrome headless, found two real blockers that the
Orca smoke had passed).

An Orca browser tab gets no `requestAnimationFrame` while it is not the selected tab of the visible
pane, and only one pane is visible at a time — a second project's preview in the same Orca window
starves the first. `cc.game` never starts, so run-smoke reports `page never became ready` (scene
null, frames 0), `document.hasFocus()` is false, and `orca eval` on the game tab may answer "The Orca
runtime closed the connection" while an about:blank tab answers at once. The build is fine.
`orca tab switch --page <id> --focus` only selects the tab inside Orca; it does not make the pane
visible.

1. **Run smoke with `--channel auto`** (the default command for writers, integrators and
   reviewers): `node .cursor/skills/smoke-test/scripts/run-smoke.mjs --port <PORT> --channel auto`.
   On an Orca infra error it reruns the same checks in Playwright + real Google Chrome headless on
   the GPU and reports `channel: "chrome"` with `fallback: { from: "orca", reason }`. A check FAIL on
   Orca is a real failure, never a reason to switch.
   A report with no `channel` field comes from a project whose run-smoke predates the fallback
   (it ignores the flag): run `/update-skills`, or run the same check files by hand in Chrome with the
   snippet from the template's smoke-test SKILL.md §Chrome headless fallback, and save the JSON.
2. **Probe by hand only to explain a failure:**
   ```
   orca eval --json --expression "new Promise((r) => { let n = 0; const t = setTimeout(() => r({ raf: n, timeout: true, vis: document.visibilityState, focus: document.hasFocus() }), 2000); const f = () => (++n >= 10 ? (clearTimeout(t), r({ raf: n, timeout: false })) : requestAnimationFrame(f)); requestAnimationFrame(f); })"
   ```
   `raf: 10` → the tab renders and the failure is real; below 10 with `timeout: true` → frozen.
3. **Runtime review beyond smoke** (feel rows, real pointer input, viewport matrix, fps) runs in the
   same Chrome when the Orca tab is frozen, with the launch config from
   `.cursor/skills/smoke-test/SKILL.md` §Chrome headless fallback: one page per V-row
   (`newPage({ viewport })`), real `page.mouse` / `page.touchscreen` input, the game's test hooks,
   screenshots per row. These rows are verified, not `manual_required`. Only device-only
   rows (real notch, finger feel, audio on a phone) stay manual.
4. **Record the channel**: `channel: chrome (Orca tab frozen, probe <result>)` in review.md, the
   `channel` field in runtime-state.json, and the run-smoke JSON as evidence.
5. **Playwright missing** (run-smoke exit 2 with the npm hint): install it once for every project —
   `npm i --prefix ~/.agents/tools/playwright playwright` — then rerun. Google Chrome itself is the
   system install; without it run-smoke uses Playwright's chromium and says fps/GPU numbers are not
   representative.

A frozen tab is never INFRA_BLOCKED and never a question for the director. INFRA_BLOCKED is still
right when the preview does not answer (the Step 0 curl), or when the boot fails in Chrome too.
