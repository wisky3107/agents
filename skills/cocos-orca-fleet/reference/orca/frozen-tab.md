# Frozen Orca tab: run-smoke says "page never became ready"

From cc-love-train S08 (memory lesson `lt-s08-orca-tab-raf-hidden`). In S09 the reviewer followed it
and finished the review without asking. The same symptom sent two infra questions to the director in
cc-firefighter-kids S01, whose packs did not carry the lesson.

An Orca browser tab gets no `requestAnimationFrame` while it is not the selected tab of the visible
pane. `cc.game` never starts, so run-smoke reports `page never became ready` (scene null, frames 0)
even though the build is fine. `orca tab switch --page <id> --focus` does not select the tab, and
neither does bringing Orca to the front.

1. **Probe it before you call it a boot error.** It takes seconds:
   ```
   orca eval --json --expression "new Promise((r) => { let n = 0; const t = setTimeout(() => r({ raf: n, timeout: true, vis: document.visibilityState }), 2000); const f = () => (++n >= 10 ? (clearTimeout(t), r({ raf: n, timeout: false })) : requestAnimationFrame(f)); requestAnimationFrame(f); })"
   ```
   - `raf: 10`: the tab renders, so the failure is real. Debug the boot.
   - `raf` below 10 with `timeout: true`: the tab is frozen.
2. **Frozen, and you can select the tab:** click it in its pane with `orca computer click`, at the
   tab's window coordinate (`orca computer list-windows` / `get-app-state`). Then rerun run-smoke.
3. **Frozen, and the director's Orca view is on another workspace,** so you cannot select the tab:
   - Run the same `scripts/smoke/checks/*.check.js` files on headless Chrome over CDP, against the
     same preview URL. Evaluate them the way `run-smoke.mjs` does (read it): wait for
     `cc.director.getScene()`, then run each check.
   - Save the JSON as evidence: `smoke-cdp-headless.json` from the writer, `review-smoke-cdp.json`
     from the reviewer.
   - Record the deviation: `smoke channel: headless Chrome CDP (Orca tab frozen, probe <result>)`.
   - Feel rows you cannot watch there are `manual_required`.

A frozen tab is never on its own INFRA_BLOCKED, and never a question for the director.
INFRA_BLOCKED is still right when the preview does not answer (the Step 0 curl), or when the boot
fails while frames are running.
