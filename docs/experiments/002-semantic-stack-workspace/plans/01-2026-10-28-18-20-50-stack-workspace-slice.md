---
title: "stack-workspace-slice"
type: plan
topic: "semantic-stack-workspace"
status: draft
created: "2026-10-28 18:20 UTC"
related: "experiments/002-semantic-stack-workspace"
---

## Slice 1: cohesive semantic stack workspace

Reuse the existing stack API, PR/commit scopes, renderer, caches, and keyboard
commands. Pasting a member selects that PR, with the whole detected stack visible.

- Extract the stack rail from App; add Review from bottom (PR-only scope,
  Semantic view, all changes rather than a selected commit).
- Show explicit review context next to the diff: selected PR versus parent/trunk,
  or the actual commit scope. Keep it visible in focus view too.
- Preserve a selected file across PR changes when it remains reviewable; otherwise
  choose the first reviewable file, including after an empty PR.
- Keep rail/PR context while reviewing a commit; clicking the current PR returns
  to its full comparison. Invalidate pending commit work when switching PRs.
- Verify direct/pasted opens, PR and commit navigation, shared-file preservation,
  fallback, empty members, semantic defaults, Text escape hatch, keyboard entry,
  errors and stale responses in built and development StrictMode browser tests.

## Deferred product requirements

**The user requires a polished UI that is keyboard-first.** Plan and implement a
dedicated UI/keyboard design later: focus model, discoverable commands, shortcuts,
stack navigation, layout, and visual polish. This slice keeps accessible native
controls and existing keyboard behavior; it does not attempt that redesign.

Later functional slices: final-stack view, file-across-stack history,
revision-aware review progress, and function-level correspondence. No discovery
redesign, new review-progress model, generated summaries, or new state/router
framework in this slice. The known 100-open-PR discovery cap remains a separate
backend limitation for live PR #2480; fixture coverage must not claim it is fixed.

