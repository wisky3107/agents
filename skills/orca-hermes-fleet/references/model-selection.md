# Hermes Model-Selection Gate

## Purpose

Turn a draft worker/profile topology into explicit, user-owned model decisions before an executable Orca plan is produced. This is a decision gate, not a recommendation after the fact.

## Version-matched inventory procedure

Do not guess a `hermes models list` command; the inspected Hermes CLI may not provide one.

1. Resolve the active Hermes executable and profile. Run `hermes profile show <profile>` and inspect that profile's config/defaults without exposing secrets.
2. Read the installed Hermes documentation/source for the current version and find its authenticated model-picker inventory. In the current installation this is `hermes_cli.inventory.load_picker_context()` plus `build_models_payload(...)`, the same substrate used by dashboard `/api/model/options` and the TUI picker. If names or signatures differ, follow the installed version rather than copying stale syntax.
3. Query it read-only from the resolved Hermes environment with the interpreter/environment that Hermes itself uses (not an arbitrary system `python3`; the example below is illustrative). First verify imports/dependencies. If `ModuleNotFoundError` or another environment error occurs, do not call the inventory live; proceed to the cache fallback and label the result `cached-candidate`.

   Example query:

   ```bash
   hermes_agent_dir="<resolved-installed-hermes-agent-dir>"
   PYTHONPATH="$hermes_agent_dir" "<hermes-runtime-python>" - <<'PY'
   import json
   from hermes_cli.inventory import build_models_payload, load_picker_context
   payload = build_models_payload(
       load_picker_context(),
       explicit_only=True,
       include_unconfigured=False,
       picker_hints=True,
       canonical_order=True,
   )
   print(json.dumps(payload, ensure_ascii=False))
   PY
   ```

   Never hard-code the example installation directory. A row is `confirmed-live` only when the payload identifies it as authenticated/configured and contains the exact model. Catalog-only or unconfigured rows are not eligible.
4. Cross-check provider health with `hermes status --all`; use `--deep` when the added probes are safe and relevant. Do not send an inference prompt merely to test availability unless the user has authorized the possible spend.
5. If the authenticated picker inventory cannot be queried, inspect Hermes's local provider/model cache. Record file modification time and embedded fetch time when present. Cache entries are only `cached-candidate`, even if they list the model.
6. If neither source is usable, stop before official planning. Never invent identifiers, substitute an unverified alias, or infer current support from general model knowledge.

## Eligibility

A model is eligible only when all required checks pass:

- The exact identifier appears under the selected provider.
- Provider authentication/configuration is confirmed; catalog presence alone is insufficient.
- The selected Hermes profile does not block the provider/model.
- Required tool use, vision, context, region and reasoning controls are compatible.
- The launch syntax can bind the exact provider, model and effort.

Treat `cached-candidate` as unconfirmed. It may be shown to the user with that label, but it cannot be the default for a write, migration, security-sensitive, irreversible or final-review Task. Confirm it live or choose a confirmed model first.

Deduplicate aliases that resolve to the same route. Prefer the exact identifier accepted by the selected provider. Never inspect or print credential values.

## Ranking rubric

Assess each candidate against the assigned task, not only its profile.

| Tier | Required properties | Typical use |
| --- | --- | --- |
| Rất phù hợp | Highest expected chance of meeting acceptance with the needed reasoning, coding/review quality, context and modality; favor reliability for security-sensitive, cross-cutting, migration, debugging or final-review work. | Complex implementation, architecture, high-risk fixes, independent review. |
| Tiết kiệm | Lowest verified price or latency among eligible choices that still has a credible path to acceptance. | Narrow edits, focused tests, documentation, mechanical analysis, low-risk research. |
| Tiết kiệm ước tính | No current price/latency data exists; ranking uses disclosed proxies such as an authenticated `auto/cheap` route, provider-published tier, smaller/fast model family, or lower reasoning effort. | Same low-risk work, with an explicit uncertainty label. |

Use task complexity, blast radius, reversibility, acceptance strictness, required tools/modality, context size, expected autonomy, provider reliability, latency and budget as evidence. “Tiết kiệm” must never be knowingly inadequate.

Do not claim “cheapest” or “fastest” without current comparable evidence. If no trustworthy price/latency is available, use **Tiết kiệm ước tính**, name the proxy and its source, and avoid fabricated numeric costs. If no credible proxy exists, offer only **Rất phù hợp** and explain why no economical recommendation can be supported.

Models whose identifiers encode an effort variant are distinct inventory choices. For models controlled through a separate reasoning setting, include the effort explicitly. `--reasoning` changes effort where supported; it does not implicitly change the model.

## Required user-facing output

Present this immediately after worker/profile decomposition and before the official plan:

| Worker / task | Hermes profile | Rất phù hợp | Tiết kiệm / ước tính | Availability | Default | Why |
| --- | --- | --- | --- | --- | --- | --- |
| API migration | backend-dev | `provider/model-a`, high | `provider/model-b`, medium | confirmed-live, checked at timestamp | Rất phù hợp | Migration risk needs deeper reasoning; economy ranking uses published tier. |

State the inventory provenance and check time. Use `confirmed-live` only for authenticated picker results; use `cached-candidate` otherwise.

Ask the user for one explicit response:

```text
Choose per worker: “Rất phù hợp”, “Tiết kiệm”, or an eligible exact model identifier.
Reply “accept defaults” to select all recommended defaults.
```

Do not produce the official plan, create Orca state or dispatch while any selection is pending. Persist exact provider/model, effort, availability evidence and user decision in the plan. If the user supplies an unsupported model, report the eligible choices and keep that row pending.

## Safe defaults

- Final independent review, security-sensitive or irreversible work: default **Rất phù hợp** and require `confirmed-live`.
- Routine scoped implementation with solid tests: **Tiết kiệm** or **Tiết kiệm ước tính** may be default only when acceptance evidence is straightforward and availability is confirmed.
- Mechanical documentation or focused read-only inventory: an explicitly labeled `cached-candidate` may be selectable, but it remains unconfirmed and should not be silently defaulted.

These are ranking heuristics. The current Hermes inventory, provider state and concrete Task control the final choices.
