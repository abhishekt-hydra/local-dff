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

Foyer provides an in-memory cache with a 64 MiB weighted capacity. Weights
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
slots. Each cache miss has a 20-second deadline, including queue time. Child
processes are killed when their futures are dropped; stdout and stderr are
drained concurrently with stdin writes. Output and retained diagnostics are
bounded. Foyer may finish an already-started load after its requesting browser
disconnects; concurrency and deadlines still apply, and the completed value can
serve another request.

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

Run `cargo test --release --target-dir .build` for service, storage, and subprocess contract tests, and
`node --experimental-strip-types --test local-debug/diff.test.ts` for parsing and
virtual-window tests. Build with `npm run build` in `web/`.

With a freshly built server running, execute
`LOCAL_DIFFE_URL=http://127.0.0.1:3434 node check-large-diffs.mjs` in `local-debug/`.
It checks a synthetic 100,000-line diff in Chrome, bottom scrolling, file-cache
reuse, semantic failure recovery, and real Git/SemanticDiff rendering using this
repository's `HEAD~1..HEAD` comparison.
