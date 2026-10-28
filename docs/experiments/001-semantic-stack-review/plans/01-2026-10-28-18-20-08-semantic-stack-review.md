---
title: "semantic stack review"
type: plan
topic: "semantic-stack-review"
status: planning
created: "2026-10-28 18:20 UTC"
related: "experiments/001-semantic-stack-review"
---

## Problem Statement

Reviewing a long GitHub PR stack in PR order hides the evolution of individual
files. Reviewers repeatedly read inherited changes, lose their position, and
cannot tell whether a file they reviewed earlier changes again later. The goal
is to understand what ships and how each PR contributes without silently treating
an earlier review as approval of a later revision.

This plan is a proposed implementation breakdown of the five user-selected
slices. No application implementation is authorized or completed by this document.

## Solution

One stack workspace with two complementary navigation layouts:

- **PR by PR:** choose a member and review its own contribution with SemanticDiff.
- **File/folder across stack:** choose a path and follow the PRs that modify it.

Both layouts share the same selected PR, explicit comparison scope, file
selection, URL, and review evidence. SemanticDiff displays changes; Git metadata
establishes which versions are being compared and where a file changes.

### Existing foundation — reuse, do not rebuild

- Opening a pasted PR already discovers a stack, selects that PR, and resolves
  immutable trunk/member Git commits for the session.
- Parent relationships, a stack rail, previous/next member controls, per-member
  commit lists, Semantic/Text views, and viewed marks already exist.
- **This PR** and **Through here** already provide parent-relative and cumulative
  comparisons; neither is a new diff engine to implement.
- The PR query parameter already follows successful stack switches and supports
  reload and Back/Forward. Other review coordinates are not yet encoded.
- Background comparison preparation, bounded diff caching, and foreground
  priority already exist. Extend these boundaries rather than adding a second
  unbounded cache or task scheduler.
- Existing viewed marks include comparison commits, but do not expose stale
  review evidence or a cross-stack file history. Audit identity/isolation before
  migrating them; do not assume a complete progress redesign is necessary.

### Delivery slices

| User slice | Demoable implementation tasks | Outcome |
| --- | --- | --- |
| 1. Stack review workspace | T1 | Persistent stack context and reliable member navigation |
| 2. Final-stack view | T2 | This PR versus final result on an explicitly selected stack branch |
| 3. File history across the stack | T3, T4 | File timeline, then folder-focused review across members |
| 4. Review progress and updates | T5, T6, T7 | Revision-specific evidence, later-change notices, changes since review |
| 5. Function-level history | T8, T9 | Conservative symbol correspondence, then symbol navigation |

**Build T1 first.** It is a narrow extension of the current workflow, not a rewrite.
Then T2 and T3 can proceed independently; prioritize T3 to reach the file/folder
workflow quickly. Do not finish every progress feature before validating file
history with a real reviewer.

## User Stories

1. As a reviewer, I want a pasted PR to stay selected while I see its stack context.
2. As a reviewer, I want the stack navigator to remain reachable while reading a long diff.
3. As a reviewer, I want the actual parent, base, and target of a comparison to be explicit.
4. As a reviewer, I want to start from the bottom and step through PRs with mouse or keyboard.
5. As a reviewer, I want SemanticDiff by default for stack review and an immediate Text fallback.
6. As a reviewer, I want the final result on a chosen stack branch, not an arbitrary last row.
7. As a reviewer, I want to switch PR and cumulative scopes without misleading labels after errors.
8. As a reviewer, I want a shareable URL to restore my layout, scope, PR, and selected path.
9. As a reviewer, I want to see every PR that modifies a selected file, skipping untouched members.
10. As a reviewer, I want to select a folder and review only changes under that path across the stack.
11. As a reviewer, I want to return from file history to the corresponding PR without losing the file.
12. As a reviewer, I want renames, deletions, unsupported files, and incomplete history to be explicit.
13. As a reviewer, I want reviewed marks to describe exact revisions, not moving branch names.
14. As a reviewer, I want a warning when previously reviewed code changes later in the stack.
15. As a reviewer, I want to distinguish reviewing each PR contribution from reviewing the final result.
16. As a reviewer, I want new pushes to make affected review evidence outdated, not silently green.
17. As a reviewer, I want to compare with my previous reviewed snapshot when it remains available.
18. As a reviewer, I want a missing snapshot to produce an explanation rather than a false comparison.
19. As a reviewer, I want failed preparation to be retryable without blocking the active diff.
20. As a reviewer, I want eventual function history to disclose uncertainty rather than invent identity.

## Implementation Decisions

### Comparison and navigation model

- Retain one active resolved stack snapshot with canonical repository identity,
  parent links, and immutable comparison commits. A member switch within that
  workspace must not silently mix newly fetched heads with the old snapshot.
- **This PR** compares the selected member's parent-relative merge-base to its
  head. Do not describe it as a direct parent-tip diff when the merge-base differs.
- **Final stack** compares trunk merge-base to an explicitly chosen tip's head.
  Default to the unique descendant leaf when unambiguous. If there are several
  descendant leaves, require a choice; never use the last depth-first row as tip.
  Label the selected tip and keep the original PR context separate.
- The existing cumulative **Through here** comparison is reusable for the chosen
  tip. Do not silently relabel the selected member's cumulative diff as the final
  result of the whole stack.
- Final-stack and file-history views follow one ancestor-to-tip lane. Show sibling
  branches as alternatives, not successive versions. The existing PR navigator
  may continue to show the entire dependency tree.
- Stage requested navigation separately from displayed comparison metadata. Commit
  scope, target, selected file, and URL coherently after successful resolution;
  stale/failed requests cannot relabel an old diff as a new one.
- Continue using URLSearchParams and the existing parser/history boundary.
  Introduce coordinates as their features land: `pr` (selected member),
  `scope=pr|final`, `tip` (explicit PR number), `diff=semantic|text`,
  `layout=pr|files`, `path`, and `pathKind=file|folder`. Defaults keep existing
  PR-only links working; unrelated parameters survive. Commit deep links are
  deferred. URLs select the latest available review snapshot, not archival OIDs.
- No new router or global state library is required. Extract only the component
  or state boundary needed for each task; no prerequisite whole-app refactor.

### Stack-wide path index and timeline

- Build timeline entries from each member's **own PR comparison**, not cumulative
  file lists that repeatedly count inherited changes. Reuse prepared comparison
  metadata, expose a typed read boundary, and validate responses at the frontend.
- Record member/parent, resolved base/target, old/new paths, change kind, and
  renderability. Group by exact paths first. Follow rename continuity only when
  Git reports a supported rename relationship; do not invent identities for
  copies, delete/recreate pairs, or ambiguous mappings.
- Enumerate the entire snapshot's candidate metadata, but present branch-aware
  timelines on the selected lane. Report pending/failed members explicitly;
  unavailable history is not an empty history. Partial results remain usable.
- A file timeline entry opens that member's parent-relative semantic/text diff.
  It does not diff against the preceding timeline entry's head, which may have
  diverged. Keep navigation context when the selected member does not touch a path.
- Folder selection uses path-component boundaries, not raw string prefixes:
  selecting `src/store` must not include `src/storehouse`. Renames into/out of a
  folder and deleted files remain discoverable with truthful path labels.
- Folder focus filters files and member counts; it does not precompute semantic
  artifacts for every file in the folder before showing anything.

### Revision-aware review evidence

- Store explicit local review evidence by canonical repository, PR or final scope,
  resolved comparison base/target, and file paths. Session UUIDs and PR number
  alone are insufficient. Preserve earlier evidence for an outdated badge.
- Keep **reviewed this contribution**, **reviewed earlier**, **changed later**,
  and **reviewed final result at tip X** distinct. Viewing a diff is not marking
  it reviewed. Reviewing a cumulative view never automatically checks each PR.
- Compute notices from changed-file metadata initially: "Reviewed in #2481;
  modified again in #2669." Until semantic correspondence exists, say
  "file changed," not "same function changed."
- Do not carry reviewed marks onto later PRs or different comparison revisions.
  New snapshots may conservatively mark evidence outdated; automatic carryover
  for provably identical comparisons can be considered separately.
- Changes since review compare the retained reviewed file version with the
  current version, visibly separate from the original PR contribution. Disclose
  base/topology changes. Retention is bounded; unavailable old objects must be
  reported and must never fall back silently to an unrelated base.
- Progress is local review tracking, not a GitHub approval or a merge guarantee.
  Storage denial/quota failure must not break the viewer.

### Semantic rendering, preparation, and later symbol history

- Preserve existing rendering limits, bounded caching, foreground admission, and
  cancellation. Active file comes first; stack metadata and adjacent comparisons
  must not make a click wait for all members. Use measured job/result state for
  Preparing/Ready/Failed labels, not "cached" guesses.
- Provide Text fallback for unsupported semantic input. Keep known semantic
  suppression behavior explicit; do not promise counts or move classifications
  that the renderer cannot expose.
- Function/block history is a gated later phase. Investigate parser-provided
  source ranges and Git rename information before selecting a matching strategy.
  SemanticDiff output does not imply persistent symbol IDs.
- T8 delivers a narrowly supported, read-only correspondence view with positive,
  negative, and ambiguous cases. T9 expands navigation only after that evidence
  is trustworthy. Neither transfers reviewed status automatically.

## Testing Decisions

- Prefer the existing browser fixture seam for complete user-visible flows and
  local Git repository fixtures for comparison correctness. Do not depend on live
  GitHub topology or the pasted example's current number of open PRs.
- Use a deterministic chain with a file changed early, untouched in the middle,
  changed later, and another change reverted before the tip. Add a branched stack,
  rename, deletion/recreation, binary file, failed member, and head/base update.
- Each task includes its own API-contract, state-transition, and browser tests
  where applicable. Test actual comparison identity and displayed content, not
  just spinner visibility or status strings.
- Exercise reload and native Back/Forward in both built and development
  StrictMode versions. Slow old requests must lose to newer navigation.
- Assert that cumulative final results exclude reverted changes, file timelines
  include only actual PR-local modifications, and sibling PRs are not a false
  chronological chain.
- Assert reviewed evidence never crosses repository, revision, scope, or path
  identities; denied storage, missing history, and timeout states stay usable.
- Preserve keyboard accessibility, existing URL behavior, viewer message source
  checks, virtualization, and foreground responsiveness on a synthetic long stack.
- Proposed acceptance seam is the existing browser fixtures plus local Git tests;
  confirm this seam and task granularity with the user before implementation.

## Out of Scope

- Fixing PR discovery pagination/cache expiry as the product feature. Record it
  separately as a known prerequisite for any live example whose topology is
  incomplete; deterministic fixtures allow this workflow to be developed without it.
- GitHub comment submission, approvals, merge queues, stack rebasing/submission,
  Graphite integration, CI/review-status synchronization, and generated summaries.
- Multi-user/cloud review-state sync, arbitrary source-code symbol identity,
  cross-branch automatic review carryover, and unbounded historical retention.
- A new diff engine, broad frontend rewrite, or new global state framework.

## Further Notes

The prioritized differentiator is watching a file or folder evolve across the
stack, alongside PR-by-PR review. The workspace and final view are supporting
slices, not reasons to delay that workflow with a large redesign. A plan and
one mutable task tracker capture the roadmap; implementation boxes start unchecked.
