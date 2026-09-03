# Local Diffe

A personal Git comparison viewer with a React + Vite + Tailwind frontend. It
uses the installed SemanticDiff executable and its installed VS Code webview to
render one changed source file at a time.

## Run

```bash
cd /Users/abhishek/hydradb/2026-07/local-diffe
cd web && npm install && npm run build && cd ..
cargo run
```

Open <http://localhost:4317>. To compare the checked-out branch with staging,
leave the repository as `hydradb-application`, retain `staging` / `HEAD`, and
click **Generate Git diff**. `HEAD` means the repository's currently checked-out
commit; the fields also accept other branches, tags, or commit IDs.

You can still choose `staging-vs-current.diff` and use **Load .diff file** when
you already have a patch artifact.

For frontend iteration, run `cargo run` in one terminal and `npm run dev` from
`web/` in another. Vite proxies the API and SemanticDiff routes to the Rust
server.

The binary path defaults to the currently installed macOS ARM Cursor extension.
Override it on another machine with either:

```bash
cargo run -- --semanticdiff-bin /absolute/path/to/semanticdiff
SEMANTICDIFF_BIN=/absolute/path/to/semanticdiff cargo run
```

## How it works

The patch is only an index of changed files. A unified diff lacks sufficient
unchanged source context for language-aware parsing, so the server reads full
source versions from Git with `git show <revision>:<path>`. It then writes the
two file contents as JSON to `semanticdiff --diff-stdin` and renders its
structured `blocks` result in the browser.

## UI and SemanticDiff display engine

The frontend lives in `web/` and uses React, Vite, Tailwind v4, and shadcn-style
source components (`Button`, `Input`, and `Card`). The changed-file sidebar uses
`react-arborist`: it is a virtualized, keyboard-friendly tree that handles a
large diff more cleanly than a generic shadcn component. The official shadcn
registry has no first-party tree component.

For supported languages, the selected-file panel is an iframe running the
installed SemanticDiff `out/webview` assets unchanged. Rust supplies the state
that VS Code normally supplies and a tiny `acquireVsCodeApi` host shim; it does
not copy or bundle the extension's renderer. This is intentionally a local,
version-pinned integration: SemanticDiff extension upgrades can change the
private webview contract.

The server binds to `0.0.0.0:4317` by default, so machines on your network can
reach it. It can read any local repository path supplied by its user, so only
use it on a trusted network (or bind to `127.0.0.1:4317` explicitly). The
SemanticDiff executable is not bundled or redistributed; the app calls a
separately installed local copy.
