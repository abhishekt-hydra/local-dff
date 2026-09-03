# Local Diffe

A personal Git comparison viewer with a React + Vite + Tailwind frontend. It
uses SemanticDiff's CLI and VS Code webview to render one changed source file
at a time.

## Run

```bash
cd /Users/abhishek/hydradb/2026-07/local-diffe
just run
```

Open <http://localhost:4317>. To compare the checked-out branch with staging,
leave the repository as `hydradb-application`, retain `origin/staging` / `HEAD`, and
click **Generate Git diff**. `HEAD` means the repository's currently checked-out
commit; the fields also accept other branches, tags, or commit IDs.

You can still choose `staging-vs-current.diff` and use **Load .diff file** when
you already have a patch artifact.

## Review a GitHub pull request

Local Diffe uses the authenticated [GitHub CLI](https://cli.github.com/) rather
than a separate GitHub token or integration. First authenticate once:

```bash
gh auth login
```

Then either paste `https://github.com/owner/repo/pull/123` in **GitHub
pull-request URL** and click **Open PR**, or enter a local repository path,
click **List**, select an open PR, and click **Review**. Each review runs
`git fetch --prune origin`, fetches GitHub's `refs/pull/<number>/head`, and
compares that head with its Git merge-base. This produces the PR-only diff,
not a misleading whole-branch snapshot. Pasted links work for open, closed,
and merged PRs; if the selected repository is different, Local Diffe clones a
private cache copy under its application cache directory and reuses it later.

For frontend iteration, run `cargo run` in one terminal and `npm run dev` from
`web/` in another. Vite proxies the API and SemanticDiff routes to the Rust
server.

## Release a single executable

On the build machine only, install the macOS ARM SemanticDiff Cursor extension,
then create a distributable with:

```bash
just package
```

This writes one executable to `dist/local-diffe-darwin-arm64`. It embeds the
React/Shiki build, SemanticDiff's webview assets, and SemanticDiff's CLI. At
runtime it extracts only the embedded CLI into the current user's cache because
macOS cannot execute a Mach-O binary from memory; no Cursor extension, Node,
or Cargo is needed on the machine running the release binary. The package task
also applies an ad-hoc macOS signature after copying the executable, so the
local executable-trust cache accepts the standalone `dist/` file.

Set `SEMANTICDIFF_EXTENSION_DIR` if the build machine has the extension in a
different location:

```bash
SEMANTICDIFF_EXTENSION_DIR=/path/to/semanticdiff.semanticdiff-0.10.0-darwin-arm64 just package
```

`just version` prints the Git-stamped release version in
`<short-sha>+<YYYY.MM.DD>` form. The date is the `HEAD` commit date, making
rebuilds of the same commit deterministic.

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
SemanticDiff `out/webview` assets unchanged. Rust supplies the state
that VS Code normally supplies and a tiny `acquireVsCodeApi` host shim; it does
not modify the extension's renderer. This is intentionally a local,
version-pinned integration: SemanticDiff extension upgrades can change the
private webview contract. The release build embeds those pinned extension assets
into the executable; check SemanticDiff/Cursor licensing before redistributing
the embedded helper outside internal use.

The server binds to `0.0.0.0:4317` by default, so machines on your network can
reach it. It can read any local repository path supplied by its user, so only
use it on a trusted network (or bind to `127.0.0.1:4317` explicitly).
