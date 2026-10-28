# Diff viewing

The default viewer shows unified text hunks with fixed-height, virtualized rows.
Parsing runs in a worker; only visible rows and a small overscan buffer enter the
DOM. Semantic comparison is an explicit second view. It does not delay text
rendering, and failures leave the text view available.

## Backend boundaries

| Layer | Responsibility | Boundary |
| --- | --- | --- |
| Domain (`domain.rs`) | Immutable comparison input, diff modes, results, typed failures | `DiffKind`, `DiffArtifact`, `DiffError` |
| HTTP (`http.rs`) | Resolve a session selection, map results/status codes | Calls `DiffReader` |
| Application (`application.rs`) | Run the requested use case with deadlines and concurrency limits | Implements `DiffReader`; consumes output ports |
| Storage (`storage/`) | Cache admission, eviction, concurrent miss coalescing | Implements `DiffStore` using Foyer |
| Process adapters (`adapters/`) | Git reads and SemanticDiff execution | Implement `DiffSource` and `SemanticEngine` |
| Composition (`main.rs`) | Construct concrete adapters and inject them into the service | `Arc<dyn Trait>` wiring |

`ports.rs` defines the contracts without Axum, Foyer, or process types. Domain
failures remain typed through the storage adapter and are translated into HTTP
status codes only at the HTTP boundary. The existing repository/PR management
and embedded webview template remain in `main.rs`; this refactor covers the diff
loading path, not every existing feature.

## Storage and request lifecycle

Foyer provides an in-memory cache with a 500 MiB weighted capacity. Weights
conservatively estimate owned strings and parsed JSON allocations; this is a
cache budget, not a process-wide memory ceiling. Cached values are shared with
`Arc`. The cache is disposable and does not persist across process restarts.

Keys include repository, resolved base/target commits, file paths, and the
`Text`/`Semantic` mode. Comparisons resolve branches before listing or reading
files, so an existing session cannot silently drift when a branch moves.
Concurrent loads of the same key share Foyer's fetch operation. Failures are not
cached and can be retried. If rendering options become configurable, those
options must also enter the key.

Text generation has four execution slots; semantic analysis has two independent
slots. Background semantic warming additionally requires a single admission
permit **before** entering Foyer, so queued prefetches cannot block clicks on
their cache keys. At most one semantic slot is occupied by background work. Its
admission permit stays with the actual cache load, even if the original caller
is cancelled. Each admitted cache miss has a 20-second deadline, including
execution-slot queue time. Child processes are killed when their futures are
dropped; stdout and stderr are
drained concurrently with stdin writes. Output and retained diagnostics are
bounded. Foyer may finish an already-started load after its requesting browser
disconnects; concurrency and deadlines still apply, and the completed value can
serve another request.

## Background comparisons and stacked PRs

`warmup.rs` starts a replaceable task whenever a session opens. It warms
renderable files in list order; switching comparison cancels the old queue.
Errors are best-effort and do not stop subsequent files. Already-started Foyer
loads may complete and populate the shared cache.

Stack discovery still fetches all current heads and trunk metadata together,
keeping parent/merge-base calculations consistent. Only the selected PR needs
its changed blobs on the foreground path. In parallel with that PR's semantic
warming, the background task prepares the remaining members, nearest first, in
PR mode then cumulative mode. Git numstat hydrates changed blobs in the
persistent blobless clone, including binary/oversized content. This is not an
unfiltered clone of every file or historical revision.

Each resolved stack member has retryable `OnceCell` comparison data (file list
and commit rail). Foreground scope requests share these cells with background
preparation; identical PR/cumulative bases reuse one cell. Per-comparison
background preparation has a 120-second timeout. Dropping a preparation kills
its Git subprocesses. Prepared comparison metadata lives with the stack;
semantic artifacts use the shared, bounded Foyer cache.

## Stack review boundaries

The browser keeps the selected PR as a workspace anchor and resolves Final stack
through an explicit descendant leaf's cumulative comparison. Ancestor lanes
exclude sibling branches. URL coordinates represent the anchor, scope/tip,
rendering mode, layout, watched path/folder and symbol; no backend session UUID or
untrusted OID enters a shareable link. Failed/stale requests do not relabel the
displayed comparison. Snapshot-local metadata is read through
`POST /api/stack-history`; `stack_history.rs` returns ready/pending/failed members
without waiting for every Git operation. Its sequential worker shares the
existing OnceCells; failed members require explicit retry and cancelled workers
can restart. UI Ready here means metadata-ready, not that every semantic artifact
or browser renderer has finished.

`review-evidence.ts` isolates explicit local records by canonical repository,
scope/PR/tip, base/target commits and old/new/display paths. It retains at most
512 newest records within an estimated 1 MiB UTF-16 serialization budget.
Legacy marks missing identity are explained rather than promoted. File, final
result, commit and explicit symbol evidence remain separate; storage failures
fall back to memory. Earlier comparison records remain visible as outdated.

`POST /api/review-snapshot` retains a server-owned target/path/topology identity;
`POST /api/since-review` compares that reviewed target with the current target.
Browser-supplied revisions cannot choose arbitrary Git content. The server holds
at most 128 deduplicated FIFO identities in memory. It does not pin old blobs.
Eviction, restart or missing objects gives an explicit unavailable response.
Cross-repository/unrelated/copied path continuity is rejected; cross-path matches
require Git rename evidence. The response kind is `since-review`, not a full PR
or commit contribution. Base/topology changes are disclosed.

`POST /api/stack-symbols` is a bounded Go declaration pilot, not general symbol
identity. Same-path qualified declaration keys, lexical comments/strings/braces
and exact source ranges support a read-only preview. Unsupported syntax,
generics, unicode identifiers, bodyless/complex signatures, renamed/copied files,
duplicate declarations and possible split/merge edits fail closed. In particular,
mixed existing declaration edits with additions/removals are unsupported.
Limits: existing 1 MiB combined source cap, 100,000 tokens, 512 declarations and
16 KiB per declaration preview. FNV hashes are content cues, not stable IDs or a
security proof. Review evidence is never automatically propagated.

The file/folder UI uses the lane's PR-local metadata, supported rename aliases
and component-boundary folder filtering. Matching selectors/tree are bounded to
200 paths with an explicit filter; later-edit folder rollups are linear in
metadata size. Selecting a path never renders every diff eagerly.

## Browser limits and behavior

- Text patches: at most 16 MiB from Git; larger patches return an explicit error.
- Semantic input: at most 1 MiB across both versions; larger files remain usable
  in Text diff. Semantic output is capped at 16 MiB.
- Browser rendering: at most 200,000 rows, with a visible notice and a patch
  download for remaining rows. This also stays below browser scroll-height
  limits. Individual displayed lines are limited to 2,000 characters.
- A 32 MiB estimated browser cache keeps parsed text results across file changes.
  Large entries are not retained. File changes abort fetches and terminate parsers.
- A 45-second browser deadline covers request and renderer startup. Semantic
  readiness is reported by the embedded viewer, not inferred from iframe `load`.
- The semantic view uses the renderer's own tokens; full-file Shiki decoration
  is no longer on the startup path. Text rendering does not require highlighting.

Virtualized text is currently unified, not side-by-side. Native find and text
selection cover mounted rows; download the patch to search/copy the complete
file. Context is Git's three-line hunk context, without an expansion API yet.

## Verification

`just package` builds a stripped, optimized release executable with compressed
embedded parsers and rejects binaries at or above 50,000,000 bytes. `just run`
executes that packaged binary. Parser files are decompressed into the app cache
on first launch. The cache can be removed while the app is stopped; it is rebuilt
as needed. Removing it also removes locally cached PR metadata and cloned repos.

Rust 1.99.0 is pinned in `rust-toolchain.toml` and selected explicitly by the
`Justfile`. Its macOS LLVM loader workaround is local to Just build/test commands.
Run `just test` for service, storage, background cancellation/admission, blobless
stack hydration/offline reuse, branched final results, review retention and Go
symbol safety, and subprocess contract tests, and
`node --experimental-strip-types --test local-debug/diff.test.ts` for parsing and
virtual-window tests. Build with `npm run build` in `web/`.

With a freshly built server running, execute
`LOCAL_DIFFE_URL=http://127.0.0.1:3434 node check-large-diffs.mjs` in `local-debug/`.
It checks a synthetic 100,000-line diff in Chrome, bottom scrolling, file-cache
reuse, semantic failure recovery, and real Git/SemanticDiff rendering using this
repository's `HEAD~1..HEAD` comparison.
