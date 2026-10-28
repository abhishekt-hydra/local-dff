# Vendored anti-slop rules

- Upstream: https://github.com/dmmulroy/anti-slop
- Revision: `c44ef22ca116d0ba62a3ff663a0bd13a3f3fa40b`
- Copied from: `data-helix/frontend/tools/oxlint/anti-slop/` in the sibling workspace.
- Installed path: `web/tools/oxlint/anti-slop/`.
- Plugin source changes: none. This provenance document is local.
- `LICENSE` is the upstream MIT license retrieved at the pinned revision.
  The nested Stylistic license and provenance are also preserved.

This is a self-contained copy, not a dependency on another checkout. Keep Oxlint
and `@oxlint/plugins` pinned together; their JS plugin API is version-sensitive.
Review upstream changes before updating this directory, preserve licenses, and
run `just check-frontend` and `just test-browser` after an update. The vendored
source is excluded from application lint/format checks so local formatting does
not obscure upstream diffs. Effect rules are retained but not loaded: this app
does not use Effect.

## Local policy

`web/.oxlintrc.json` is the source of truth. Lint checks the entire owned frontend,
not only changed files; warnings and unused disable directives fail the check.

Enabled anti-slop rules guard against chained assertions, widening then asserting,
unsafe dictionary contracts, copying reduce accumulators, module mocking, reflective
access, opaque object parameters, unknown returns/type aliases, and unjustified
assertions. Oxlint's accumulating-spread check is also enforced. Prefer validating
I/O and using actual library contracts over adding `SAFETY:` comments to unsafe casts.

Deliberately not enabled:

- `no-runtime-typeof` and `no-unknown-parameters`: unknown input and runtime checks
  are appropriate at JSON, postMessage, storage, and error boundaries.
- `no-array-filter-map` and `no-conditional-empty-object-spread`: these are
  readability/performance tradeoffs, not blanket correctness failures.
- `no-shape-in-symbol-names`: naming preferences are not a correctness contract.
- `require-readable-spacing`: Oxfmt owns formatting.

The built-in correctness category, React hooks/dependency checks, explicit-any
ban, and accessibility checks are enabled. Style/suspicious/perf categories are
not enabled wholesale (e.g. browser scenarios intentionally await ordered steps).
`react/exhaustive-deps` is used instead of the stricter compiler dependency rule:
DOM focus and observer effects may intentionally depend on review identity.
Native-tag preference is disabled because accessible custom widgets use explicit
roles. `Input` is registered as a labelable component. Necessary external-system
synchronization and focusable scroll regions have narrowly scoped, explained
inline exceptions; unused exceptions are rejected.
