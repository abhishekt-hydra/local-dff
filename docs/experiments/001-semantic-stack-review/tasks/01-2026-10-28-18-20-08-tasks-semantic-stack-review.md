---
title: "tasks for spec 01"
type: tasks
topic: "semantic-stack-review"
status: complete
created: "2026-10-28 18:20 UTC"
related: "experiments/001-semantic-stack-review/plans/01-2026-10-28-18-20-08-semantic-stack-review.md"
spec: "01"
---

## Tasks

The user authorized all five slices after wolf-quito-0 committed its Vite
handoff (`eeedfdb`). All T1–T9 functional deliveries are now implemented and
verified; T8/T9 are explicitly the conservative Go-only pilot, not general symbol
identity. Plan02 records the amended implementation/safety boundaries.
Checkboxes certify the described delivery, not GitHub approval or review of every
line in the live repository.

### Slice 1 — Stack review workspace

- [x] **T1. Persistent PR-by-PR workspace** — fixture and live HTTP topology/rendering acceptance verified.

  **Verification handoff:** `deer-seoul-1` reports `just check-frontend` passing
  22 tests, `just test` passing 19 backend tests, `just test-browser` passing built
  and development StrictMode flows, and `just package` producing a signed 18.87 MB
  binary with Rust 1.99.0 and no LLVM warning. This tracker records the peer's
  results; they were not independently rerun here. Includes selected-file
  continuity/fallback, empty members, viewed-mark preservation, focus-view context,
  leaving commit scope via current-PR selection, and stale commit/PR guards.

  **Live prerequisite resolved:** complete cursor pagination, a60s versioned
  complete-topology cache, fresh selected metadata/heads and the authoritative
  default-branch boundary replace the earlier100-PR limitation. An open staging
  release PR does not absorb all feature stacks. The isolated packaged HTTP smoke
  opened #2480 with trunkstaging and exact12 members,95 changed paths in3.17s;
  real Go SemanticDiff, retained delta and final2939 comparison also passed.
  Browser workflows are fixture-based; no live browser walkthrough of all12 is claimed.

  **What to build:** Extend the existing pasted-PR workflow with a persistent
  stack navigator, clear selected PR and comparison basis, and a "Review from
  bottom" action. Keep member controls reachable in focus view and on small
  screens. Reuse existing PR-local comparison, Semantic/Text viewer, caching,
  member switching, and PR URL updates; make only narrow boundary extractions.

  **Acceptance criteria:**
  - Pasting a middle member selects it, shows its dependency context, and renders
    its own semantic diff. Base/target descriptions match resolved comparison data.
  - "Review from bottom," member clicks, previous/next, and existing keyboard
    commands show the correct member, preserve a matching selected file where
    possible, and update the PR URL after success.
  - Long-file scrolling/focus view does not strand stack navigation; unsupported
    semantic content still has a Text fallback.
  - Slow/failed switches cannot display old content under a new PR label or URL.
    Built and StrictMode browser fixtures cover these transitions with real files.

### Slice 2 — Final-stack view

- [x] **T2. Final result on an explicit stack lane** (delivered; dependencies satisfied).

  **What to build:** Offer This PR / Final stack, reusing the existing cumulative
  comparison at a chosen descendant tip. Show trunk, tip, and comparison basis.
  Add shareable scope/tip/diff coordinates without breaking old PR-only links.

  **Acceptance criteria:**
  - In a linear stack, final view defaults to the unique descendant leaf; This PR
    returns to the selected member's own contribution, not the tip's PR-local diff.
  - A branched stack asks which descendant tip to inspect; depth-first row order
    never chooses a tip implicitly. Sibling changes do not leak into the result.
  - An early edit reverted at the tip is absent from Final stack but visible in
    the relevant individual PRs. Labels and resolved Git pairs agree.
  - Reload and Back/Forward restore member, scope, tip, and diff mode; failed scope
    requests leave the displayed scope and comparison coherent and retryable.

### Slice 3 — File history across the stack

- [x] **T3. One file's change timeline** (delivered; dependencies satisfied).

  **What to build:** Expose typed stack-wide changed-file metadata from existing
  per-member PR comparisons. In the viewer, show the selected file's modifying
  PRs on its ancestor-to-tip lane; click or step to open each PR's semantic diff.
  Include "Open in PR context" and URL-restorable file/history selection.

  **Acceptance criteria:**
  - A file changed in PRs A and C but untouched in B lists only A and C. Each
    entry uses that PR's own resolved comparison, not a cumulative diff.
  - Previous/next change skips untouched members; returning to PR layout retains
    the selected member/file. Branch alternatives never appear as later versions.
  - Deleted, added, and binary/oversized files have truthful states. Git-supported
    rename links are explicit; ambiguous copy/delete-recreate cases are not guessed.
  - Metadata arrives without waiting for every semantic artifact. Pending/failed
    member history is visible and retryable, never mislabeled "no changes."
  - Local Git fixtures verify comparison/path metadata; typed API and browser
    fixtures verify selection, URLs, partial results, retries, and stale requests.

- [x] **T4. Folder-focused stack review** (delivered; dependencies satisfied).

  **What to build:** Add a stack-wide file tree and file/folder selection to the
  history layout. Filter member counts and file changes to the chosen folder,
  with next changed file/member actions and quick switching back to PR layout.
  "Watch" means retaining this navigation focus, not background notifications.

  **Acceptance criteria:**
  - Selecting `src/storage` includes descendants but not `src/storage-extra`.
    Display the union of relevant files, not just files changed in the active PR.
  - Rename-in, rename-out, and deletion entries remain discoverable with old/new
    paths; file timelines and PR navigation retain folder focus.
  - Reload/Back/Forward restore layout and path-kind/folder selection. Empty and
    incomplete folders are distinguishable; navigation is keyboard accessible.
  - A long-stack/many-file fixture remains interactive before all metadata is
    ready; changing the folder does not eagerly render every semantic diff.

### Slice 4 — Review progress and updates

- [x] **T5. Revision-specific review evidence** (delivered; dependencies satisfied).

  **What to build:** Audit and extend existing viewed marks into explicit local
  evidence for repository, member/scope, comparison commits, and file paths.
  Retain earlier evidence to show Outdated after updates. Roll up counts without
  equating file marks with GitHub approvals. Apply the same contract to final view
  when T2 is available; T6 is the integration gate across the layouts.

  **Acceptance criteria:**
  - Mark/unmark and next-unreviewed survive reload for exactly the same comparison.
    Identical PR numbers/paths in different repositories cannot share marks.
  - A changed base or target exposes earlier evidence as outdated; it does not
    appear as current approval. Scope/file changes cannot persist another scope's set.
  - Loading or viewing a diff does not mark it reviewed. Final-view evidence cannot
    silently mark individual PR contributions reviewed, or vice versa.
  - Migrate existing marks only where identity is sufficient; otherwise explain
    reset/unverified state. Denied/full local storage leaves in-memory review usable.
  - Unit/browser tests cover identity collisions, updates, persistence errors,
    failed scope transitions, and no automatic carryover.

- [x] **T6. Repeated-change and final-form notices** (delivered; dependencies satisfied).

  **What to build:** Connect history and review evidence. Show "Reviewed in A;
  file changes again in C," links to earlier/later changes, and folder counts of
  files with later unreviewed modifications. Show separately whether the final
  result at the chosen tip has been explicitly reviewed.

  **Acceptance criteria:**
  - Reviewing a file in A leaves its later modification in C unreviewed; the
    timeline, PR layout, and folder layout communicate that consistently.
  - Notices count actual modifications on the selected lane, not inherited
    cumulative appearances or sibling changes. Incomplete metadata is disclosed.
  - "Reviewed all contributions" and "Reviewed final result at tip X" remain
    distinct; each records a specific comparison rather than moving branch names.
  - Browser tests cover the early-review/later-edit scenario, multiple paths,
    changed snapshots, and a final-view review without per-PR auto-checking.

- [x] **T7. Changes since my review** (delivered; dependencies satisfied).

  **What to build:** Retain enough bounded snapshot evidence to compare a previously
  reviewed file version with its current version. Offer this explicitly labeled
  comparison through the existing semantic/text rendering path; disclose topology
  or base changes and offer a fresh full review when old objects are unavailable.

  **Acceptance criteria:**
  - After a simulated push, old-reviewed-target to current-target is the comparison
    shown; it is not mislabeled as the whole PR's contribution.
  - Rename/deletion and base changes are visible. Missing/expired objects produce
    an unavailable explanation, not a silent substitute diff.
  - Snapshot retention has a documented capacity/eviction policy. Eviction does
    not delete review evidence or make the current PR view fail.
  - Local Git and browser tests exercise updates, old-object unavailability,
    semantic fallback, and the requirement to explicitly mark a new review.

### Slice 5 — Function-level history

- [x] **T8. Conservative symbol correspondence pilot** (delivered within conservative Go pilot).

  **What to build:** Inspect available parser/source-range data, choose one
  supported language, and ship a narrow read-only symbol-history preview for
  unambiguous matches. Provide a visible unmatched/ambiguous result with file
  history fallback. Record evidence for continuing or limiting the feature.

  **Acceptance criteria:**
  - A small fixture corpus covers unchanged, edited, renamed, moved, deleted,
    split/merged, duplicate-name, and overloaded symbols where applicable.
  - Document the supported matching rules and false matches found. Unsupported
    cases do not produce fabricated persistent symbol identities.
  - A reviewer can inspect one supported symbol across PRs from the file timeline;
    uncertain matches are disclosed and no reviewed marks are propagated.
  - Gate T9 on a reviewed matching policy and trustworthy positive/negative tests,
    not on an assumption that SemanticDiff supplies stable IDs.

- [x] **T9. Function-focused navigation and later-edit notices** (delivered within conservative Go pilot).

  **What to build:** Extend the validated symbol preview into previous/next symbol
  change navigation, PR-context links, and conservative "this reviewed function
  changes later" notices. Keep file history as the reliable default/fallback.

  **Acceptance criteria:**
  - Supported matches navigate to the actual source change in the chosen lane;
    ambiguous, split, merged, and unsupported symbols return to file-level history.
  - Previously reviewed symbol changes never auto-mark later revisions reviewed.
  - Browser tests cover navigation, unsupported cases, and a new push that makes
    the prior correspondence stale. Expand language support only with fixtures.

## Delivery status

All five functional slices are delivered. Final integrated checks:
`just check-frontend`41 passing tests, `just test`48 passing tests/1 explicitly
ignored live test, Rust formatting, signed package below50 MB, and production +
development StrictMode browser suites. The browser suite includes a5,000-path
lane with bounded selectors and filtering; unit rollups cover15,000 file events.
The live metadata contract was separately run by wolf-quito-0; a packaged live
HTTP smoke independently verified #2480's exact12-member stack and real rendering.
See checkpoint03 for logs, limits and source commits.

T8's exact-key Go policy and positive/negative corpus were reviewed before T9:
mixed edits with additions/removals fail closed on possible splits/merges.
T9 navigates exact ranges/source previews alongside the corresponding PR-local
semantic file diff; it does not promise an isolated function-only diff or stable
semantic identities. General language expansion and the dedicated polished
keyboard-first UI remain deferred.

## Verification for every delivery

Run applicable existing project recipes: `just check-frontend`,
`just test-browser`, `just fmt-check`, and `just test` for Rust changes. Reuse
browser fixtures for user flows and temporary Git repositories for actual
comparison correctness; include each task's tests in the same delivery. Use real
SemanticDiff integration where installed, with deterministic contract fixtures in
CI. Do not rely solely on empty-file browser sessions or live GitHub state.

## Deferred (not this spec)

- **Polished, keyboard-first review UI:** explicit user requirement for a later
  design pass, not dropped scope. Cover deliberate visual hierarchy, discoverable
  commands, predictable focus, accessible keyboard navigation across stack/file/
  folder/timeline views, and pointer parity. Preserve existing shortcuts and
  accessibility in current slices; defer the cohesive interaction/visual redesign.
  Coordinate with experiment 002, where `deer-seoul-1` reports recording this
  follow-up; do not create a competing UI implementation under experiment 001.
- The separately reported discovery prerequisite was fixed and live HTTP-verified
  as part of integration, not shipped as a separate discovery product. Preserve
  complete pagination, short-lived complete cache and the default-branch boundary.
- GitHub comment/review submission, CI/status synchronization, stack authoring,
  rebasing, merging, and Graphite service integration.
- Commit-level URL restoration, archival snapshot links, cloud/multi-user progress,
  automatic review carryover, background watch notifications, and generated summaries.
- General cross-language symbol identity. T8/T9 are complete only within the
  explicitly supported conservative Go pilot; uncertain cases use file history.
