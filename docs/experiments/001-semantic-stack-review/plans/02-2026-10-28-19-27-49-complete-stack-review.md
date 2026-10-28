---
title: "complete-stack-review"
type: plan
topic: "semantic-stack-review"
status: draft
created: "2026-10-28 19:27 UTC"
related: "experiments/001-semantic-stack-review"
---

## Authorization and sequencing

The user explicitly authorized finishing all five semantic stack-review slices,
with the condition that wolf-quito-0 finish and commit its Vite changes first.
That committed handoff is `eeedfdb`; only then did implementation resume. The
slice-one workspace was committed as `8ac3ec0`. Backend support is committed as
`1a6fd48`, with the stricter Go split/merge fallback in `100e8f8`.

Plan 01 remains the original immutable roadmap. This amendment records the
implemented boundaries and the separately authorized discovery prerequisite;
the plan-01 mutable tracker is the delivery checklist.

## Remaining slices

- **Final stack:** reuse cumulative comparison at an explicitly chosen descendant
  leaf; retain the pasted member as the workspace/URL anchor. Unique leaves can
  default automatically; siblings require a choice. Preserve This PR and Through
  here as distinct scopes. URL coordinates restore scope/tip/diff/layout/path/
  path kind/folder/symbol without a router or session IDs in links.
- **File/folder history:** poll typed per-member PR-local metadata with explicit
  pending/failed states. Show one ancestor-to-tip lane, never sibling chronology.
  Follow only supported one-to-one Git rename edges; copies and delete/recreate
  do not establish symbol identity. Add native accessible union-path tree,
  folder-component-boundary focus, file/PR skipping, and source-context links.
  Bound selectable path matches to 200 with an explicit refinement filter, and
  compute folder notices in one metadata pass rather than quadratic rescans.
- **Review evidence:** repository + scope + PR/tip + immutable base/target + paths
  identify an explicit local mark. Keep earlier evidence as outdated, not current
  approval. File and final-result reviews remain separate; symbol marks do not
  mark files. Preserve in-memory usability under storage denial. Legacy marks
  missing canonical identity are explained but not silently promoted. Retain at
  most 512 local records and approximately 1 MiB of serialized UTF-16 data.
- **Changes since review:** server-owned retained snapshot IDs select the reviewed
  target, never browser-supplied OIDs. Compare that target to the current target;
  disclose basis/topology changes and require returning to the full comparison
  before recording a fresh file review. The server keeps at most 128 metadata
  identities in memory, not pinned archival blobs. Restart/eviction/missing Git
  objects explicitly make the historical view unavailable.
- **Function-history pilot:** exact same-path qualified Go function/method keys,
  bounded lexical comments/string/braces handling, exact ranges and <=16 KiB
  declaration previews. FNV hashes are content cues, not persistent identities.
  Unsupported syntax, generics, unicode identifiers, bodyless/complex signatures,
  renamed/copied files, duplicate names, or mixed added/removed + edited
  declarations return a visible file-history fallback. The mixed-change rule
  fails closed on possible split/merge identity. Navigate only trusted declaration
  changes; explicit symbol-review marks never propagate to later revisions.

## Discovery prerequisite amendment

The user was informed that the small discovery limitation is being fixed so the
live #2480 example can reach the completed workflow. This is a separate backend
bugfix, not a new discovery product: complete cursor pagination, short-lived
versioned complete-topology cache rejecting old truncated arrays, refreshed
selected PR/head metadata, and explicit discovery failure instead of pretending
an unavailable stack is standalone. Verify live metadata without assuming
fixture success proves the remote stack or cloning a repository unnecessarily.

## Deferred requirement

A polished, keyboard-first review UI remains an explicit user requirement for a
separate design pass. Current implementation preserves existing overlay commands,
source/origin checks, native button/select/details keyboard behavior, predictable
focus and sticky navigation. It does not claim the dedicated interaction/visual
redesign is complete. General cross-language semantic symbol identity, GitHub
approvals/comments and cloud state remain outside these slices.

## Verification

Run `just check-frontend`, `just test-browser` (built + development StrictMode),
`just fmt-check`, `just test`, and `just package`. Preserve Rust 1.99.0, the
Justfile-only DYLD workaround, stable `assets/semantic-viewer.js`, lazy grammars,
and the unchanged default Vite chunk warning budget. Use local Git fixtures for
actual final/revert/rename/snapshot/symbol semantics; browser fixtures for complete
navigation, revision updates, failures, denied storage and focus-view behavior.
Record final counts and any live-validation limits in a new checkpoint.

