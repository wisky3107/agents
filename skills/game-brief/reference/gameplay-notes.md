# Director gameplay notes

Optional input for `store`, `media`, and `idea`. No notes → keep the existing flow;
do not ask for notes or create empty notes/coverage artifacts. Notes supplement the source
mode; adding them to a store pack does not switch the mode to `idea`.

## Capture (caller)

Save supplied chat text or file contents verbatim under **Source text** in
`reference/<slug>-brief/GAMEPLAY_NOTES.md`. Record the source filename or chat origin and
date. Reuse `brief.gameplay_notes_path` when an existing project configured another path.
For a new store clone before bootstrap, stage it in
`/Users/wikz/orca-global/<slug>-brief/GAMEPLAY_NOTES.md`; Step 3 copies it into the project.
Once a project exists, its copy is authoritative; do not overwrite later amendments with
the staged copy. Preserve supplied attachments beside the notes and link their paths.

Under **Requirement index**, assign stable `GP-01`, `GP-02`, … IDs to distinct claims or
requirements, pointing to exact source passages. Keep quoted text separate from the
agent's interpretation. Reuse existing IDs on reruns without duplicating input; append new amendments with dates and
new IDs, linking any superseded IDs instead of deleting or renumbering the old source.

Classify each entry from the user's wording:

- **Reported behavior** — what the user experienced in the original game.
- **Requested change** — behavior the user explicitly wants in the clone.
- **Uncertain** — tentative recollection, question, or an ambiguity that changes the rule.

Do not require the user to reformat their notes. If a supplied file cannot be read, report
the exact path/error and resolve that input before claiming it was incorporated.

## Evidence and decisions (brief author)

Read the entire source text and verify the index covers it. Cite statements as
`GIVEN (GAMEPLAY_NOTES GP-01)` in every source mode. Reported behavior is user testimony,
not `OBSERVED`; use `OBSERVED (<path>)` only for evidence actually inspected. A tentative
claim remains uncertain even though its source is GIVEN; any provisional design is ASSUMPTION.

Explicit requested changes determine the clone's intended behavior over store/rip inference
and previous assumptions. Record intentional differences in EXPECT's accepted-deviation
table. Reported behavior can fill mechanics missing from screenshots; when it conflicts
with inspected evidence, record both sources in HOW_TO rather than silently choosing one.
Ask only when the conflict/ambiguity materially changes implementation and current user
instructions do not resolve it. Put unresolved decisions in affected slices' `risks` with
`needs_director_ok: true`; independent decisions can proceed. Honor decisions already given.

Describing original-game meta features does not automatically include them in v1. Explicit
requests for them must receive a scope decision; do not silently exclude an explicit
must-have to fit the default slice budget. Unspecified numbers/timing remain ASSUMPTION.

## Coverage (brief author and gate)

Add **Gameplay notes coverage** to `HOW_TO.md`, with one row per GP ID:

| GP ID | Kind / source passage | Decision / reason | Contract section | Slice | Acceptance / playtest |
|-------|-----------------------|-------------------|------------------|-------|-----------------------|

Use decisions `included`, `deferred`, `excluded`, `unresolved`, or `superseded`.
Every included behavior needs a concrete rule in the relevant contract, an owning slice,
and a checkable scenario in that slice's acceptance/playtest, citing the GP ID (initial
state → action → expected result). Mirror relevant scenarios in PLAYTEST.md and update
EXPECT, ASSET_MANIFEST, SCOPE, ARCHITECTURE, MILESTONES, and RELEASE_CHECKLIST only where
the decision affects them. Use existing slice-schema fields; no new parser keys are needed.

Deferred/excluded rows need a scope reason and a FOLLOWUPS or NOT-in-v1 pointer; deferral
within the release also names its owning slice. Unresolved rows point to the affected
slice's risk/gate. Superseded rows point to the replacement ID. An explicit requirement
whose deferral/exclusion is not authorized remains unresolved, not silently dropped.

The gate checks source text against the index, every ID's disposition, and that referenced
rules, slices, and scenarios exist and agree. A coverage table alone is not sufficient.
Report counts by decision and outstanding conflicts. These checks establish contract
coverage, never runtime verification. Missing coverage → nudge the brief author with IDs.

## Notes arriving after contracts exist (caller and brief author)

Route amendments to `game-brief` in the existing project; do not bootstrap/crawl again.
Preserve prior sources/IDs, append new notes, and identify affected contracts, slices,
assets, and review scenarios before authoring. Read current contracts and release state.
If a producer/lane is active, the caller coordinates a hold on affected work and confirms
that the current owner has stopped using those contracts before they are revised;
independent work may continue. Report a pending handoff if that coordination is unavailable.

Re-run/nudge the resolved brief author with the amendment and affected paths. Use the
normal prompt's evidence/quality rules, but revise only affected contracts and dependencies;
do not regenerate all slices, renumber existing slices, or force the initial slice count.
Preserve completed slice contracts as history: changes to merged gameplay need follow-up
slices and updated milestone/checklist coverage, not a rewrite claiming the old review
proved the new behavior. Keep the milestone DAG and final release-polish checks consistent
with follow-up work, including fresh final checks if the previous release is already complete.
Producer owns release status; the brief author does not reset it.

Re-run the coverage and contract-consistency gates. Return changed GP IDs, changed files,
affected slice IDs, and scenarios requiring fresh review to the caller/current coordinator.
Before affected implementation/review resumes, that owner must confirm the revised files
are present in its checkout and writer/reviewer have re-read them. The caller handles this
handoff; the docs-only brief author does not dispatch workers or edit gameplay.
