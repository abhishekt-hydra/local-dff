# Local Diffe

A personal Git comparison viewer with a React + Vite + Tailwind frontend. It
uses SemanticDiff's CLI and VS Code webview to render one changed source file
at a time.

## Run

```bash
cd /Users/abhishek/hydradb/2026-07/local-diffe
just run
```

Rust **1.99.0** is pinned by `rust-toolchain.toml`; `just build` and `just test`
select it explicitly. The macOS LLVM library-path workaround is scoped to those
`Justfile` commands, not your shell configuration.

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

### Share or redirect to a review

Pass the GitHub PR URL in the `pr` query parameter to open it automatically,
without entering a local repository path:

```text
http://localhost:3333/?pr=https://github.com/hydra-db/hydradb-application/pull/3006/
```

Trailing slashes are accepted. For a redirect integration, let `URLSearchParams`
encode the GitHub link, especially when it contains query parameters or a hash:

```js
const review = new URL("http://localhost:3333/")
review.searchParams.set("pr", githubPrUrl)
// Redirect to review.href.
```

The address bar updates after manual PR opens and stack navigation. Reload and
Back/Forward reopen the linked PR; returning to the bare app URL clears the
review. Links identify the PR, not a transient session or selected commit/file.
Invalid links stay in the form with an error and never trigger a download.
GitHub CLI authentication and a running Local Diffe server are still required.

URL parsing tests: `just test-frontend`. Browser flows: `just test-browser`
(requires Chrome/Chromium; set `RUSTWRIGHT_CHROMIUM` if needed). The browser suite
uses local API fixtures in both the production build and development StrictMode;
it does not contact GitHub or clone repositories. It also covers semantic stack
navigation, file/commit continuity, review-from-bottom, empty members, viewed-mark
isolation, stack keyboard commands, and late-response/error handling.

## Review stacked pull requests

A PR is part of a stack when its base branch is another open PR's head branch
within the same repository. The repository's authoritative default branch is
an integration boundary: an open release PR whose head is that branch does not
pull every feature PR into one enormous stack. The PR picker groups each stack
under one heading, with stacked PRs indented under the PR they build on.
Tool-specific body/footer relationships are not inferred when branches do not
express the dependency chain.

Opening any PR in a stack (including a pasted URL) fetches every member's
current head, together with the trunk, in a single metadata-only `git fetch`
into the blobless cache clone. Only the opened PR's file content is needed to
show the review; the remaining stack downloads in the background. File lists,
commit rails, and semantic diffs are warmed for both **This PR** and **Through
here**, with nearby members prepared first. Changed file contents stay in the
local Git cache across restarts, including binary and oversized files; this is
not a full checkout of every file or historical blob.

The **Stack review** panel above the file list stays available while navigating
files, commits, and focus view. It shows the whole detected stack, bottom first;
click a PR, or step with ⌃ ⌄ (or `{` / `}` with the keyboard overlay on). The
context above the diff explicitly identifies the selected PR and comparison base,
e.g. **Reviewing #2481 against #2480**. In a commit view it instead identifies the
actual commit scope. Clicking the current PR returns to its full comparison.

**Review from bottom** opens the first PR's own changes in Semantic view, leaving
commit scopes and cumulative mode without clearing viewed marks. Switching PRs
keeps the selected file when that member also changes it; otherwise the first
reviewable file opens. Empty members keep the stack controls available.

Three comparison scopes are available:

- **This PR** compares the PR with the merge-base of its parent PR's *current*
  head. You see only that PR's own changes, even after its parent has been
  pushed again.
- **Through here** compares the PR with its merge-base on the trunk. This shows
  everything that lands once the stack is merged up to and including this PR.
- **Final stack** compares the trunk merge-base with a chosen descendant tip.
  A linear stack defaults to its unique leaf. Branched stacks require choosing
  a **Stack lane tip**; sibling PRs are alternatives, not successive versions.
  The pasted PR stays the workspace/URL anchor. **This PR** returns to that
  member, rather than accidentally showing the tip's own contribution.

A stack always opens in **Semantic** diff. Switching to Text applies until you
move to another PR in the stack, and does not change the mode saved for other
reviews. Each stacked PR has its own commit rail and its own viewed marks.
Fork PRs are never linked into a stack, because branch names are not unique
across forks. If a parent PR was merged and its child retargeted to the trunk
without a rebase, the child is reviewed as a standalone PR.

### Files and folders across the stack

Choose **Files across stack** to inspect the union of changed paths on the
selected lane. Use the folder selector or native expandable **Stack path tree**;
`src/store` does not include `src/storehouse`. Filter paths to find any file
(the selector/tree shows at most 200 matches at once). File and folder controls
skip untouched PRs; opening a timeline entry uses that PR's own comparison,
not a diff against an unrelated preceding timeline entry.

The timeline discloses preparing/failed members and supports retry. Only
Git-reported one-to-one renames connect path aliases. Copies, delete/recreate,
binary and metadata-only changes are labeled; they do not invent symbol identity.
Watched paths can remain selected when the current comparison does not modify
them. **Open in PR context** returns to PR-by-PR layout.

Links restore `scope=pr|cumulative|final`, `tip`, `diff=semantic|text`,
`layout=pr|files`, `path`, `pathKind=file|folder`, optional `folder`, and
optional `symbol`. Reload and Back/Forward restore those coordinates against
the latest resolved stack snapshot. Commit and retained-snapshot views are not
archival deep links.

### Local review evidence and updates

**Viewed** is an explicit local mark, not a GitHub approval. Evidence is isolated
by canonical repository, PR/scope/tip, immutable comparison commits and file
paths. Reviewing a final result does not mark its individual contributions.
Later modifications remain unreviewed, with links/notices in file history.
New base/target revisions expose earlier evidence as **Outdated** rather than
silently transferring a green mark.

Use **Changes since my review** to compare the retained reviewed target to the
current target. This is visibly separate from the full PR contribution; return
to the current comparison before explicitly marking the new review. Missing
snapshots never substitute an unrelated base. Local evidence keeps the newest
512 records within an approximately 1 MiB budget. Server snapshot IDs retain
at most 128 version identities in memory, not pinned archival blobs: restart,
eviction or missing Git objects makes that historical comparison unavailable.
Storage denial/quota failure leaves review tracking usable in memory. Older
viewed marks without verified repository identity are not automatically migrated.

### Go function-history preview

A conservative Go-only pilot provides declaration ranges/source previews,
previous/next function-change navigation and explicit function-review marks.
Matching is restricted to exact qualified names in the same file. It does not
infer persistent semantic IDs, cross-file moves or renames. Ambiguous duplicates,
generics/unsupported syntax and possible splits/merges fall back to file history.
Mixed edited declarations plus additions/removals fail closed as possible
split/merge cases. Source previews are limited to 16 KiB per declaration.
Function marks do not mark the file or any later revision reviewed.

The polished, keyboard-first interaction/visual redesign remains a dedicated
follow-up. Current controls preserve existing shortcuts and native Tab/Enter/
select/details keyboard behavior; no new keyboard framework is introduced.

## Review faster

Every comparison starts best-effort semantic precomputation in file-list order.
The backend keeps up to **500 MiB** of weighted text/semantic results in memory;
clicks reuse warmed results or join an already-running computation. Background
analysis occupies at most one of two semantic slots, leaving capacity for file
clicks. Switching comparisons cancels the obsolete queue; bounded loads already
started by the cache may finish. Semantic failures do not stop warming other
files or block Text diff. Rendering/highlighting still happens in the browser.

Press `-` to turn on the keyboard overlay. Then `J` / `K` moves between files,
`N` jumps to the next file you have not marked as viewed, and `M` toggles
**Viewed**. The review header shows how many files have been viewed. When you
open a review, or move to another PR or commit, its first file opens
automatically.

## Review commit by commit

Any Git or PR comparison lists its commits above the file filter, oldest first.
Pick one from the commit menu, or step with the ‹ › buttons (or `[` / `]` with
the keyboard overlay on); `[` from the first commit returns to **All changes**.
**This commit** shows the commit against its parent, as GitHub's Commits tab
does; **Up to commit** shows everything from the comparison base through it.
The list follows the first-parent chain, so a PR that merged its base branch
back in lists that merge once — diffed against its first parent — instead of
every commit it brought along. A root commit is compared with the empty tree.
Viewed marks are kept separately for each commit.

## Local PR comments

Open a PR and select a code line or its line number in either Semantic or Text
view. A small comment composer opens beside that line, with the old/new side and
line number already selected. **Save comment** stores the draft locally in
SQLite. Cmd/Ctrl+Enter saves; Escape closes the composer. Unsaved text remains
available when you reopen that same line during the current comparison.

The left sidebar holds **Comments**, including saved drafts, editing, deletion,
and a general PR comment form. **Minimal** gives the diff the full window;
**Sidebar** opens or hides the floating files/comments sidebar, and **Full view**
restores the setup controls. Line commenting remains available in minimal mode.
Line attachments are available in the PR's own comparison, outside cumulative
and since-review views. Saving an edited draft preserves its original attachment.

**Post to GitHub**, followed by **Confirm post**, sends that saved draft using
your authenticated `gh` account. General comments go to the PR conversation;
line comments use GitHub's
[review comment API](https://docs.github.com/en/rest/pulls/comments#create-a-review-comment-for-a-pull-request).
The backend checks the current PR head before sending a line comment. If it
changed, reopen the PR and update the draft's attachment. GitHub also requires
the line to belong to its PR diff, which can differ from a local stack comparison.

Each posted comment retains its GitHub URL locally. Duplicate publish requests
reuse that receipt. After an interrupted or failed send, **Check GitHub** searches
for an invisible draft marker and records the receipt without sending again.
If no receipt is found, the draft stays uncertain; inspect GitHub before creating
another draft. Published comments cannot be edited or deleted through this panel.

Drafts live separately from disposable caches, in the OS application data
directory as `comments.sqlite3`. On macOS the default is
`~/Library/Application Support/com.hydradb.local-diffe/comments.sqlite3`.
Set `--data-dir /path/to/data` or `LOCAL_DIFFE_DATA_DIR` to choose another
directory. One server may use a data directory at a time. To back it up, stop
the server and copy that directory, or use SQLite's online backup operation.
The comments API also supports agents via JSON POST requests to
`/api/comments/list`, `/save`, `/delete`, and `/publish`. Every request names
`pr_url`; mutations of an existing draft include its `id` and `version` from
the list response. Only `/publish` contacts GitHub.

For example, save a PR-level draft with this JSON body at `/api/comments/save`:

```json
{"pr_url":"https://github.com/owner/repo/pull/123","body":"My review comment","location":{"kind":"general"}}
```

The response includes the draft's `id` and `version`. To publish that exact
saved version when requested, send these fields to `/api/comments/publish`:

```json
{"pr_url":"https://github.com/owner/repo/pull/123","id":"<draft-id>","version":1}
```

Run `just test-comments` to check the packaged API against real SQLite and a
fixture `gh` command. This check makes no GitHub requests.

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

Open-PR discovery uses complete cursor pagination, not a 100-PR subset. The
versioned complete-list cache expires after roughly 60 seconds; old bare arrays
and incomplete/stale cache data are refetched. Pasted PR metadata and actual heads
are refreshed when opening a review. Discovery errors remain explicit and
retryable instead of silently presenting an unavailable stack as standalone.
Choose a portable or
project-specific location with either `--cache-dir` or `LOCAL_DIFFE_CACHE_DIR`:

```bash
cargo run -- --cache-dir /path/to/local-diffe-cache
# or
LOCAL_DIFFE_CACHE_DIR=/path/to/local-diffe-cache just run
```

For frontend iteration, run `cargo run` in one terminal and `bun run dev` from
`web/` in another. Vite proxies the API and SemanticDiff routes to the Rust
server.

### Frontend quality checks

Use Bun (the version is recorded in `web/package.json`) and the single
`web/bun.lock`; install with `cd web && bun ci`. Node 22.18+ is also required
for the TypeScript unit tests and vendored TypeScript lint plugin.

```bash
just lint-frontend   # Oxlint: correctness, React hooks, accessibility, anti-slop
just fmt-frontend    # Oxfmt: format owned frontend files
just check-frontend  # Lint, format check, app/test/plugin types, unit tests
just test-browser   # Build and run Chrome production + StrictMode regressions
```

Oxlint and its plugin adapter are pinned together. The generic anti-slop rules
are vendored in `web/tools/oxlint/anti-slop/`, with upstream revision and licenses;
no sibling checkout is needed. See [local lint policy](web/tools/oxlint/anti-slop/UPSTREAM.md)
for enabled rules and deliberate exceptions. Lint runs over the full owned
frontend and rejects warnings and unused suppressions. Oxfmt excludes the
unchanged vendored sources and generated `dist/` and `dist-profile/` outputs.

Tests exercise the actual lint CLI against accepted/rejected fixtures so a
broken plugin load or accidentally disabled core guardrail fails the check.
API JSON is validated before it enters review state, and iframe keyboard
messages require the current viewer frame, matching origin, and a typed payload.

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
bun run build:profile
bun run preview:profile -- --host 127.0.0.1 --port 4173
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

YAML files (`.yaml` and `.yml`, case-insensitive) use a local Tree-sitter YAML
parser in the same viewer. Values are matched by document, mapping key, and
sequence position, so mapping key reordering, indentation, and equivalent string
quoting do not produce changes. Sequence order, scalar types, comments, anchors,
and tags remain significant. The viewer retains original source and line numbers
with YAML syntax highlighting. Invalid YAML, duplicate keys, and structures that
cannot be matched safely fall back to an explicitly labeled line diff.

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
