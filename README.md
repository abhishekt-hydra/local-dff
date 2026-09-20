# Local Diffe

A personal Git comparison viewer with a React + Vite + Tailwind frontend. It
uses SemanticDiff's CLI and VS Code webview to render one changed source file
at a time.

## Run

```bash
cd /Users/abhishek/hydradb/2026-07/local-diffe
just run
```

The port is configured in the root `.env` file: `LOCAL_DIFFE_PORT=3333`.
Change that one value and restart the server and Vite to use a different port;
the frontend proxy and local debug scripts read the same setting. The server
loads `.env` from the working directory or its parents. `--port` overrides the
setting, and `--listen` overrides the full bind address.

Open <http://localhost:3333>. To compare the checked-out branch with staging,
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

## Cache directory

By default, Local Diffe stores its data in the operating system's application
cache directory. It keeps embedded SemanticDiff runtime files, cloned
repositories, and GitHub PR JSON separately:

```
<cache-dir>/semanticdiff/
<cache-dir>/github-repos/<owner>--<repo>/
<cache-dir>/github-prs/<owner>--<repo>/open.json
<cache-dir>/github-prs/<owner>--<repo>/<number>.json
```

The first request stores the open-PR list and each fetched PR; later requests
reuse those files (invalid cache JSON is refetched). Choose a portable or
project-specific location with either `--cache-dir` or `LOCAL_DIFFE_CACHE_DIR`:

```bash
cargo run -- --cache-dir /path/to/local-diffe-cache
# or
LOCAL_DIFFE_CACHE_DIR=/path/to/local-diffe-cache just run
```

For frontend iteration, run `cargo run` in one terminal and `npm run dev` from
`web/` in another. Vite proxies the API and SemanticDiff routes to the Rust
server.

## Browser performance profiling

Performance telemetry is opt-in. In a profiling build, add `?perf=1` to the
frontend URL, or set `LOCAL_DIFFE_PERF=1` when building. Samples stay in memory, are
capped at 200 entries, and are exposed through the local
`window.__LOCAL_DIFFE_PERF__` handle; they are never sent to a network service.
The normal production build removes the telemetry and React profiling renderer;
adding a query parameter cannot activate them in that build.

Build the profiling renderer explicitly, then serve the separate `dist-profile/`:

```bash
cd web
npm run build:profile
npm run preview:profile -- --host 127.0.0.1 --port 4173
```

The reproducible Rustwright benchmark prepares source-shaped 10,000, 100,000,
and 200,000-row fixtures with a 5,000-file sidebar. It reports repeated cold file
loads, warm cache loads, rapid scrolling p50/p95 timings, and delayed-response
cancellation:

```bash
cd local-debug
PROFILE_REQUIRE_REACT=1 PROFILE_LABEL=profile LOCAL_DIFFE_URL=http://127.0.0.1:4173 npm run profile
```

Run against a preserved baseline and an optimized normal-build preview without
`PROFILE_REQUIRE_REACT` to compare end-user timings without profiler overhead.
The benchmark's DOM-ready and two
`requestAnimationFrame` measurements describe browser scheduling; they do not
claim that a frame was painted. Set `PROFILE_SIZE=10000` or
`PROFILE_REPEATS=5` to narrow or repeat a run. The runner is TypeScript (tested
with Node 26); application instrumentation and workers are TypeScript bundled
and minified by Vite. See [profiling details](local-debug/README.md).

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

## Set up another machine

The release executable is self-contained, so the machine that runs it needs
only Git. GitHub pull-request features additionally need an authenticated
GitHub CLI; Rust is needed only when building from source. On a new macOS
machine, run:

```bash
./scripts/bootstrap-macos.sh
```

It installs Homebrew (when needed), Git, GitHub CLI, and Rust, then starts the
browser-based GitHub CLI login. Choose SSH during the login flow and let GitHub
CLI use or create an SSH key. This configures both API access for PR data and
SSH access for private repositories; no token needs to be copied manually.

On Linux, run the equivalent script instead:

```bash
./scripts/bootstrap-linux.sh
```

It supports Debian/Ubuntu (`apt`), Fedora/RHEL (`dnf`), Arch (`pacman`), and
openSUSE/SUSE (`zypper`). The current `local-diffe-darwin-arm64` release is a
macOS ARM executable and cannot run on Linux. A Linux release requires a
separate build with a compatible Linux SemanticDiff extension/runtime.

For a machine that will not use GitHub PR features, skip the interactive login:

```bash
./scripts/bootstrap-macos.sh --skip-gh-auth
# or on Linux
./scripts/bootstrap-linux.sh --skip-gh-auth
```

Later, enable PR features with `gh auth login --web --git-protocol ssh`, then
verify the setup with `gh auth status`.

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
SemanticDiff 0.10.0 `out/webview` assets, copied unchanged into
`vendor/semanticdiff/webview` with checksums and original license notices. Rust supplies the state
that VS Code normally supplies and a tiny `acquireVsCodeApi` host shim; it does
not modify the extension's renderer. This is intentionally a local,
version-pinned integration: SemanticDiff extension upgrades can change the
private webview contract. The release build embeds those pinned extension assets
into the executable; check SemanticDiff/Cursor licensing before redistributing
the embedded helper outside internal use.

Semantic diff is the default. The mode buttons persist the selected mode in
`localStorage` under `local-diffe:diff-mode`. An 8 MiB estimated LRU cache retains
semantic HTML for file revisits; a failed render evicts its entry before retry.

The CLI produces change tokens but does not run VS Code's syntax-highlighting
host. Our `semantic-viewer.ts` adapter fills that gap using a Shiki worker, with
language grammars loaded on demand. The diff renders first; syntax colors arrive
through the viewer's native state-update protocol. The worker is terminated on
completion, navigation, failure, or timeout. The upstream viewer files remain
unchanged. React profiling covers the surrounding application; the PR profiling
script measures iframe readiness and highlighting completion separately.

The server binds to `0.0.0.0:3333` by default, so machines on your network can
reach it. It can read any local repository path supplied by its user, so only
use it on a trusted network (or bind to `127.0.0.1:3333` explicitly).
