// Runs entirely against fixtures: never clones repositories or contacts GitHub.
import assert from "node:assert/strict"
import { createServer as createHttpServer } from "node:http"
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { extname, resolve, sep } from "node:path"
import { chromium } from "rustwright"
import { createServer as createViteServer } from "vite"

const github = (number) => `https://github.com/hydra-db/hydradb-application/pull/${number}`
const stackNumbers = [3006, 3007, 3008]
const file = (path, renderable = true) => ({
  old_path: path,
  new_path: path,
  display_path: path,
  renderable,
})
const pull = (number) => ({
  number,
  url: github(number),
  title: `Fixture PR ${number}`,
  state: "OPEN",
  baseRefName: number === 3007 ? "pr-3006" : number === 3008 ? "pr-3007" : "main",
  headRefName: `pr-${number}`,
  isDraft: false,
  updatedAt: "2026-10-01T00:00:00Z",
})
function session(number, mode = "pr") {
  if ([3100, 3101, 3102, 3200, 3201, 3202].includes(number)) return advancedSession(number, mode)
  const files =
    number === 3006
      ? [file("bottom.go"), file("shared.go")]
      : number === 3007
        ? [...(mode === "cumulative" ? [file("bottom.go")] : []), file("shared.go"), file("top.go")]
        : number === 3008
          ? [file("empty.txt", false)]
          : number === 3020
            ? [file("main.go")]
            : []
  return {
    id: `fixture-${number}-${mode}`,
    repository: "https://github.com/hydra-db/hydradb-application",
    files,
    commits: [3006, 3007, 3020].includes(number)
      ? [
          {
            sha: "c".repeat(40),
            short: "ccccccc",
            parents: ["a".repeat(40)],
            author: "Fixture",
            date: "2026-10-01",
            subject: "Fixture commit",
            files_changed: 1,
          },
        ]
      : [],
    commits_truncated: false,
    comparison: {
      base: { revision: "main", commit: "a".repeat(40) },
      target: { revision: `#${number}`, commit: "b".repeat(40) },
      changed_paths: files.length,
      semantic_paths: files.filter((file) => file.renderable).length,
      description: "Fixture comparison",
      pull_request: number ? pull(number) : null,
    },
    stack: stackNumbers.includes(number)
      ? {
          trunk: "main",
          current: number,
          mode,
          members: stackNumbers.map((number, index) => ({
            pull: pull(number),
            parent: index ? stackNumbers[index - 1] : null,
            depth: index,
          })),
        }
      : null,
  }
}

const oid = (number) => number.toString(16).padEnd(40, "0")
let pushed = false
let historyPendingOnce = false
let historyFailed = false
let ambiguousSymbols = false
let largeHistory = false
const snapshots = new Map()
let lastSincePair
function advancedSession(number, mode = "pr") {
  const branch = number < 3200
  const numbers = branch ? [3100, 3101, 3102] : [3200, 3201, 3202]
  const index = numbers.indexOf(number)
  const parent = index ? (branch ? numbers[0] : numbers[index - 1]) : null
  const ownFiles = branch
    ? number === 3100
      ? [file("src/store/value.go")]
      : number === 3101
        ? [file("branch-a.go")]
        : [file("sibling-b.go")]
    : number === 3200
      ? [file("src/store/value.go"), file("reverted.go")]
      : number === 3201
        ? [
            file("src/storehouse/noise.go"),
            ...(largeHistory
              ? Array.from({ length: 5000 }, (_, index) =>
                  file(`bulk/file-${String(index).padStart(5, "0")}.go`),
                )
              : []),
          ]
        : [
            file("src/store/value.go"),
            file("reverted.go"),
            { ...file("src/new.go"), old_path: "src/old.go", change_kind: "renamed" },
            { ...file("src/deleted.go"), new_path: null, change_kind: "deleted" },
            file("binary.dat", false),
          ]
  const files =
    mode === "cumulative" && index
      ? branch
        ? [file("src/store/value.go"), ...ownFiles]
        : number === 3202
          ? ownFiles
              .filter((entry) => entry.display_path !== "reverted.go")
              .concat(file("src/storehouse/noise.go"))
          : [file("src/store/value.go"), file("reverted.go"), ...ownFiles]
      : ownFiles
  const target = oid(number + (pushed && number === 3200 ? 10000 : 0))
  return {
    id: `fixture-${number}-${mode}-${pushed ? "v2" : "v1"}`,
    repository: "https://github.com/hydra-db/hydradb-application",
    files,
    commits: [],
    commits_truncated: false,
    comparison: {
      base: {
        revision: parent ? `#${parent}` : "main",
        commit: mode === "cumulative" || !parent ? "a".repeat(40) : oid(parent),
      },
      target: { revision: `#${number}`, commit: target },
      changed_paths: files.length,
      semantic_paths: files.filter((entry) => entry.renderable).length,
      description: "Immutable fixture contribution",
      pull_request: pull(number),
    },
    stack: {
      trunk: "main",
      current: number,
      mode,
      members: numbers.map((number, index) => ({
        pull: pull(number),
        parent: index ? (branch ? numbers[0] : numbers[index - 1]) : null,
        depth: branch && index ? 1 : index,
      })),
    },
  }
}

const dist = fileURLToPath(new URL("../dist/", import.meta.url))
const types = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
}
let opened = []
let failOnce = true
let failStackOnce = false
let delayCommit = false
let commitRequests = 0
const localComments = new Map()
let commentPosts = 0
const fixture = createHttpServer(async (request, response) => {
  try {
    const url = new URL(request.url, "http://fixture")
    if (url.pathname.startsWith("/api/")) {
      if (url.pathname.startsWith("/api/diff/")) {
        response.writeHead(200, { "content-type": "text/plain" })
        response.end("--- a/shared.go\n+++ b/shared.go\n@@ -1 +1 @@\n-old\n+new\n")
        return
      }
      let body = ""
      for await (const chunk of request) body += chunk
      const input = JSON.parse(body)
      let result
      if (url.pathname.startsWith("/api/comments/")) {
        const rows = localComments.get(input.pr_url) ?? []
        const comment = rows.find((item) => item.id === input.id)
        if (url.pathname.endsWith("/save")) {
          if (comment) {
            comment.body = input.body
            comment.version += 1
          } else
            rows.push({
              id: `comment-${rows.length + 1}`,
              body: input.body,
              version: 1,
              state: "draft",
              remote_url: null,
              target: { kind: "general" },
            })
        } else if (url.pathname.endsWith("/publish")) {
          assert.ok(comment)
          commentPosts += 1
          comment.state = "posted"
          comment.remote_url = `${input.pr_url}#issuecomment-1`
        }
        localComments.set(input.pr_url, rows)
        result = rows
      } else if (url.pathname === "/api/github/open-url") {
        opened.push(input.url)
        const number = Number(input.url.split("/").at(-1))
        assert.ok(number > 0, `Non-canonical API request: ${input.url}`)
        if (number === 3010) await new Promise((resolve) => setTimeout(resolve, 500))
        if (number === 3011 && failOnce) {
          failOnce = false
          response.writeHead(500, { "content-type": "application/json" })
          response.end(JSON.stringify({ error: "Fixture GitHub failure; retry opening the PR." }))
          return
        }
        result = number === 3012 ? { id: "malformed", files: "not an array" } : session(number)
      } else if (url.pathname === "/api/stack-scope") {
        if (failStackOnce) {
          failStackOnce = false
          response.writeHead(502, { "content-type": "application/json" })
          response.end(JSON.stringify({ error: "Fixture stack unavailable; retry." }))
          return
        }
        result = session(input.number, input.mode)
      } else if (url.pathname === "/api/commit-scope") {
        commitRequests += 1
        if (delayCommit) {
          delayCommit = false
          await new Promise((resolve) => setTimeout(resolve, 500))
        }
        const number = Number(input.id.split("-")[1])
        const root = session(number)
        result = {
          ...root,
          id: `fixture-commit-${number}-${input.mode}`,
          files: [file("shared.go")],
          commits: [],
          stack: null,
          comparison: {
            ...root.comparison,
            base: { revision: "ccccccc^", commit: "d".repeat(40) },
            target: { revision: "ccccccc", commit: "c".repeat(40) },
            changed_paths: 1,
            semantic_paths: 1,
            description: "Commit 1 of 1, compared with its parent.",
          },
        }
      } else if (url.pathname === "/api/stack-history") {
        const root = session(Number(input.id.split("-")[1]))
        if (input.retry) historyFailed = false
        result = {
          repository: root.repository,
          members: root.stack.members.map((entry, index) => {
            const data = session(entry.pull.number)
            const state =
              index === root.stack.members.length - 1 && historyFailed
                ? "failed"
                : index === root.stack.members.length - 1 && historyPendingOnce
                  ? "pending"
                  : "ready"
            return {
              number: entry.pull.number,
              parent: entry.parent,
              depth: entry.depth,
              base: data.comparison.base.commit,
              target: data.comparison.target.commit,
              state,
              files: state === "ready" ? data.files : [],
              ...(state === "failed" ? { error: "Fixture member unavailable" } : {}),
            }
          }),
        }
        historyPendingOnce = false
      } else if (url.pathname === "/api/review-snapshot") {
        const data = session(Number(input.id.split("-")[1]))
        const snapshot_id = `snapshot-${snapshots.size}`
        snapshots.set(snapshot_id, {
          target: data.comparison.target.commit,
          file: data.files[input.index],
        })
        result = { snapshot_id, retention_limit: 128 }
      } else if (url.pathname === "/api/since-review") {
        const old = snapshots.get(input.snapshot_id)
        if (!old) {
          response.writeHead(410, { "content-type": "application/json" })
          response.end(
            JSON.stringify({
              error:
                "Reviewed snapshot unavailable after restart or eviction. Perform a fresh review.",
            }),
          )
          return
        }
        const data = session(Number(input.id.split("-")[1]))
        lastSincePair = [old.target, data.comparison.target.commit]
        result = {
          ...data,
          id: `fixture-since-${data.id}`,
          files: [data.files[input.index]],
          stack: null,
          comparison: {
            ...data.comparison,
            kind: "since-review",
            base: { revision: "reviewed target", commit: old.target },
            description:
              "Changes since my review: retained reviewed target to current target; not the full PR contribution.",
          },
        }
      } else if (url.pathname === "/api/stack-symbols") {
        const value = input.path.endsWith("value.go") || input.path === "shared.go"
        const ambiguous = value && ambiguousSymbols && input.number === 3202
        result = {
          state: !input.path.endsWith(".go") ? "unsupported" : ambiguous ? "ambiguous" : "ready",
          policy:
            "Exact same-file Go qualified names; no inferred rename/move identity or review carryover.",
          ...(ambiguous
            ? { message: "Duplicate declaration names are ambiguous; use file history." }
            : {}),
          symbols: value
            ? [
                {
                  key: "func:Value",
                  name: "Value",
                  status: ambiguous ? "ambiguous" : "changed",
                  ...(ambiguous
                    ? {}
                    : {
                        old_start: 3,
                        old_end: 5,
                        new_start: 3,
                        new_end: 5,
                        old_hash: "old-body",
                        new_hash: `body-${input.number}`,
                        old_source: "func Value() int { return 1 }",
                        new_source: `func Value() int { return ${input.number} }`,
                      }),
                },
              ]
            : [],
        }
      } else if (url.pathname === "/api/github/open-prs") result = stackNumbers.map(pull)
      else if (url.pathname === "/api/git-diff") result = session(null)
      else throw new Error(`Unexpected API call: ${url.pathname}`)
      if (!response.destroyed) {
        response.writeHead(200, { "content-type": "application/json" })
        response.end(JSON.stringify(result))
      }
      return
    }
    if (url.pathname.startsWith("/semanticdiff-view/fixture-")) {
      response.writeHead(200, { "content-type": "text/html" })
      response.end(`<!doctype html><html><body data-fixture-viewer>
        <script>
          const origin = new URL(document.baseURI).origin;
          parent.postMessage({ source: "local-diffe-viewer", ready: true }, origin);
          addEventListener("message", (event) => {
            if (event.source === parent && event.data?.testKey) {
              parent.postMessage({ source: "local-diffe-keyboard", key: event.data.testKey, ctrlKey: Boolean(event.data.testCtrl), metaKey: Boolean(event.data.testMeta) }, origin);
            }
          });
        </script>
      </body></html>`)
      return
    }
    const path = resolve(
      dist,
      `.${url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname)}`,
    )
    if (!path.startsWith(dist.endsWith(sep) ? dist : `${dist}${sep}`))
      throw new Error("Invalid asset path")
    const content = await readFile(path)
    response.writeHead(200, { "content-type": types[extname(path)] || "application/octet-stream" })
    response.end(content)
  } catch (error) {
    response.writeHead(500)
    response.end(String(error))
  }
})
await new Promise((resolve) => fixture.listen(0, "127.0.0.1", resolve))
const fixtureUrl = `http://127.0.0.1:${fixture.address().port}`
const browser = await chromium.launch({
  headless: true,
  ...(process.env.RUSTWRIGHT_CHROMIUM ? { executablePath: process.env.RUSTWRIGHT_CHROMIUM } : {}),
  args: ["--window-size=1600,1100"],
})
let vite
try {
  vite = await createViteServer({
    server: {
      host: "127.0.0.1",
      port: 0,
      proxy: { "/api": { target: fixtureUrl }, "/semanticdiff-view": { target: fixtureUrl } },
    },
  })
  await vite.listen()
  const devUrl = vite.resolvedUrls.local[0].replace(/\/$/, "")
  for (const [mode, app] of [
    ["built", fixtureUrl],
    ["development StrictMode", devUrl],
  ]) {
    opened = []
    failOnce = true
    failStackOnce = false
    delayCommit = false
    commitRequests = 0
    pushed = false
    historyPendingOnce = false
    historyFailed = false
    ambiguousSymbols = false
    largeHistory = false
    snapshots.clear()
    localComments.clear()
    commentPosts = 0
    lastSincePair = undefined
    const page = await browser.newPage()
    async function waitText(selector, fragment) {
      await page.evaluate(
        ({ selector, fragment }) =>
          new Promise((resolve, reject) => {
            const deadline = performance.now() + 10_000
            const check = () => {
              const status = document.querySelector(selector)?.textContent ?? ""
              if (status.includes(String(fragment))) return resolve()
              if (performance.now() > deadline)
                return reject(new Error(`Expected status ${fragment}; got ${status}`))
              requestAnimationFrame(check)
            }
            check()
          }),
        { selector, fragment },
      )
    }
    const waitStatus = (fragment) => waitText('[data-testid="status"]', fragment)
    async function waitViewer() {
      // A PR's status/context updates before its iframe has finished mounting.
      // Wait for the fixture renderer before Rustwright resolves host controls;
      // its cross-frame locator search cannot tolerate a detaching old iframe.
      await page.evaluate(
        () =>
          new Promise((resolve, reject) => {
            const deadline = performance.now() + 10_000
            const check = () => {
              const diff = document.querySelector("[data-diff-complete]")
              const semantic =
                document
                  .querySelector('[data-testid="diff-mode-semantic"]')
                  ?.getAttribute("aria-checked") === "true"
              if (!diff) return resolve()
              if (!semantic && diff.getAttribute("data-diff-complete") === "true") return resolve()
              if (
                semantic &&
                diff
                  .querySelector("iframe")
                  ?.contentDocument?.querySelector("[data-fixture-viewer]")
              )
                return requestAnimationFrame(() => resolve())
              if (performance.now() > deadline)
                return reject(new Error("Fixture renderer did not settle"))
              requestAnimationFrame(check)
            }
            check()
          }),
      )
    }
    const waitContext = async (fragment) => {
      await waitText('[data-testid="stack-review-context"]', fragment)
      await waitViewer()
    }
    const review = async (number) => {
      await waitStatus(`PR #${number} ·`)
      await waitViewer()
    }
    const location = () => page.evaluate(() => window.location.href)
    const currentPr = async () => new URL(await location()).searchParams.get("pr")
    const count = (number) => opened.filter((url) => url === github(number)).length
    async function checkPicker(selector) {
      await page.click(selector)
      const relationships = await page.evaluate(
        (selector) =>
          new Promise((resolve, reject) => {
            const deadline = performance.now() + 10_000
            const check = () => {
              const trigger = document.querySelector(selector)
              const popup = document.getElementById(trigger.getAttribute("aria-controls"))
              const input = popup?.querySelector("[cmdk-input]")
              const list = input && document.getElementById(input.getAttribute("aria-controls"))
              if (popup && input && list)
                return resolve({
                  triggerTag: trigger.tagName,
                  triggerRole: trigger.getAttribute("role"),
                  popupRole: popup.getAttribute("role"),
                  popupNamed: Boolean(popup.getAttribute("aria-label")),
                  inputNamed: Boolean(
                    document
                      .getElementById(input.getAttribute("aria-labelledby"))
                      ?.textContent.trim(),
                  ),
                  inputRole: input.getAttribute("role"),
                  listRole: list.getAttribute("role"),
                  listInsidePopup: popup.contains(list),
                })
              if (performance.now() > deadline)
                return reject(new Error(`Broken picker ARIA relationships: ${selector}`))
              requestAnimationFrame(check)
            }
            check()
          }),
        selector,
      )
      assert.deepEqual(relationships, {
        triggerTag: "BUTTON",
        triggerRole: null,
        popupRole: "dialog",
        popupNamed: true,
        inputNamed: true,
        inputRole: "combobox",
        listRole: "listbox",
        listInsidePopup: true,
      })
      await page.click(selector)
    }
    const navigate = (url) =>
      page.evaluate((url) => {
        history.pushState(null, "", String(url))
        window.dispatchEvent(new PopStateEvent("popstate"))
      }, url)
    try {
      // First load, trailing slash normalization, reload, no StrictMode double POST.
      await page.goto(`${app}/?perf=1&pr=${github(3006)}/`)
      await review(3006)
      assert.equal(count(3006), 1)
      assert.equal(await currentPr(), github(3006))
      assert.equal(new URL(await location()).searchParams.get("perf"), "1")
      await page.goto(await location())
      await review(3006)
      assert.equal(count(3006), 2)

      // Manual form, native history, and stack rail keep the URL in sync.
      await page.fill('[data-testid="pr-url"]', `${github(3007)}/`)
      await page.click('[data-testid="open-pr-url"]')
      await review(3007)
      assert.equal(await currentPr(), github(3007))
      assert.equal(count(3007), 1)
      await page.evaluate(() => history.back())
      await review(3006)
      await page.evaluate(() => history.forward())
      await review(3007)
      await page.click('[data-testid="stack-pr-3006"]')
      await review(3006)
      assert.equal(await currentPr(), github(3006))
      await page.evaluate(() => history.back())
      await review(3007)

      // A non-PR review removes the previous PR identity from the URL.
      await page.click('[data-testid="source-branches"]')
      await page.click('[data-testid="generate-diff"]')
      await waitStatus("changed paths")
      assert.equal(await currentPr(), null)

      // Invalid links never reach the API. A failed open stays retryable.
      const beforeInvalid = opened.length
      await page.goto(`${app}/?pr=${encodeURIComponent("https://evil.test/owner/repo/pull/1")}`)
      await waitStatus("Enter a GitHub pull-request URL")
      assert.equal(opened.length, beforeInvalid)
      await page.goto(`${app}/?pr=${encodeURIComponent(github(3011))}`)
      await waitStatus("Fixture GitHub failure")
      await page.click('[data-testid="open-pr-url"]')
      await review(3011)
      assert.equal(count(3011), 2)

      // Abort and stale-result guards: a slow old PR must not win a race.
      await navigate(`/?pr=${encodeURIComponent(github(3010))}`)
      await navigate(`/?pr=${encodeURIComponent(github(3007))}`)
      await review(3007)
      await new Promise((resolve) => setTimeout(resolve, 600))
      await review(3007)
      assert.equal(await currentPr(), github(3007))
      await navigate(`/?pr=${encodeURIComponent(github(3010))}`)
      await navigate("/")
      await waitStatus("Ready to compare")
      await new Promise((resolve) => setTimeout(resolve, 600))
      await waitStatus("Ready to compare")
      assert.equal(await currentPr(), null)

      // Returning from a manually opened PR to the landing entry clears review.
      await page.fill('[data-testid="pr-url"]', github(3006))
      await page.click('[data-testid="open-pr-url"]')
      await review(3006)
      await page.evaluate(() => history.back())
      await waitStatus("Ready to compare")
      assert.equal(await currentPr(), null)
      // A 200 response is not a type contract: malformed data remains retryable.
      await page.goto(`${app}/?pr=${encodeURIComponent(github(3012))}`)
      await waitStatus("The server returned an invalid response")
      assert.equal(
        await page.evaluate(() => document.querySelector('[data-testid="stack-rail"]') !== null),
        false,
      )

      // Slice 1: a pasted member opens a semantic stack workspace, not a
      // standalone diff. A saved Text preference must not override that default.
      await page.evaluate(() => localStorage.setItem("local-diffe:diff-mode", "text"))
      await page.goto(`${app}/?pr=${encodeURIComponent(github(3007))}`)
      await review(3007)
      await waitContext("Reviewing #3007 against #3006")
      const checked = (id) =>
        page.evaluate(
          (id) => document.querySelector(`[data-testid="${id}"]`)?.getAttribute("aria-checked"),
          id,
        )
      async function waitFile(path) {
        await page.evaluate(
          (path) =>
            new Promise((resolve, reject) => {
              const deadline = performance.now() + 10_000
              const check = () => {
                const frame = document.querySelector(
                  'iframe[title="Semantic diff for ' + path + '"]',
                )
                if (frame?.contentDocument?.querySelector("[data-fixture-viewer]")) return resolve()
                if (performance.now() > deadline) return reject(new Error(`Expected file ${path}`))
                requestAnimationFrame(check)
              }
              check()
            }),
          path,
        )
      }
      const key = (key) =>
        page.evaluate(
          (key) => window.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true })),
          key,
        )
      assert.equal(await checked("diff-mode-semantic"), "true")
      await waitFile("shared.go")
      assert.equal(
        await page.evaluate(() => document.querySelectorAll('[data-testid^="stack-pr-"]').length),
        3,
      )
      await page.screenshot({ path: `/tmp/local-diffe-stack-slice1-${mode.split(" ")[0]}.png` })

      // Shared files stay selected across PRs; viewed marks stay with each PR.
      await page.click('[data-testid="mark-as-viewed"]')
      await page.click('[data-testid="previous-stack-pr"]')
      await review(3006)
      await waitContext("Reviewing #3006 against main")
      await waitFile("shared.go")
      assert.equal(
        await page.evaluate(() => document.querySelector('[data-testid="mark-as-viewed"]').checked),
        false,
      )
      await page.click('[data-testid="mark-as-viewed"]')
      await page.click('[data-testid="diff-mode-text"]')
      assert.equal(await checked("diff-mode-text"), "true")
      await page.click('[data-testid="next-stack-pr"]')
      await review(3007)
      await waitFile("shared.go")
      assert.equal(await checked("diff-mode-semantic"), "true")
      assert.equal(
        await page.evaluate(() => document.querySelector('[data-testid="mark-as-viewed"]').checked),
        true,
      )
      assert.equal(
        await page.evaluate(() => document.activeElement?.getAttribute("data-testid")),
        "next-stack-pr",
        "PR navigation must not steal focus from its control",
      )

      // Commit scopes keep the rail, but label the actual commit comparison.
      // Clicking the current PR returns to its full comparison.
      await page.click('[data-testid="next-commit"]')
      await waitContext("Reviewing #3007 · commit ccccccc")
      assert.ok(await page.textContent('[data-testid="stack-rail"]'))
      await page.click('[data-testid="hide-chrome"]')
      await waitContext("Reviewing #3007 · commit ccccccc")
      assert.ok(await page.textContent('[data-testid="stack-rail"]'))
      assert.deepEqual(
        await page.evaluate(() => {
          const header = document.querySelector('[data-testid="minimal-header"]')
          const panel = document.querySelector('[aria-label="Diff panel"]')
          const frame = panel.querySelector("iframe")
          return {
            title: header.querySelector("a").textContent.trim(),
            path: header.querySelector('[aria-label^="Copy file path:"]').textContent.trim(),
            toolbarHidden: !panel.querySelector('[data-testid="next-file"]'),
            headerHeight: Math.round(header.getBoundingClientRect().height),
            frameTop: Math.round(frame.getBoundingClientRect().top),
            pageFits: document.documentElement.scrollHeight <= window.innerHeight,
          }
        }),
        {
          title: "#3007Fixture PR 3007",
          path: "shared.go",
          toolbarHidden: true,
          headerHeight: 44,
          frameTop: 44,
          pageFits: true,
        },
      )
      await page.click('[aria-label="Copy file path: shared.go"]')
      await waitText('[data-testid="minimal-header"] [role="status"]', "File path copied")
      await page.evaluate(() =>
        document.querySelector('[aria-label="Toggle review sidebar"]').focus(),
      )
      await page.evaluate(
        () =>
          new Promise((resolve, reject) => {
            const deadline = performance.now() + 2000
            const check = () => {
              const trigger = document.querySelector('[aria-label="Toggle review sidebar"]')
              const tooltip = document.getElementById(trigger.getAttribute("aria-describedby"))
              if (
                getComputedStyle(tooltip).opacity === "1" &&
                tooltip.querySelector("kbd")?.textContent === "E"
              )
                return resolve()
              if (performance.now() > deadline)
                return reject(new Error("Sidebar hint did not show E on focus"))
              requestAnimationFrame(check)
            }
            check()
          }),
      )
      await page.screenshot({ path: `/tmp/local-diffe-minimal-${mode.split(" ")[0]}.png` })
      const sidebarDisplay = () =>
        page.evaluate(
          () =>
            getComputedStyle(document.querySelector('[aria-label="Changed files sidebar"]'))
              .display,
        )
      // Single-letter shortcuts are live by default (persisted mode, no gate).
      // The header toggle is hidden in focus view, so read the persisted mode.
      const keyboardModeOn = () =>
        page.evaluate(() => localStorage.getItem("local-diffe:keyboard-mode") !== "off")
      if (!(await keyboardModeOn())) await key("-")
      assert.equal(await sidebarDisplay(), "none")
      await key("e")
      assert.notEqual(await sidebarDisplay(), "none")
      await key("E")
      assert.equal(await sidebarDisplay(), "none")
      await key("-")
      assert.equal(await keyboardModeOn(), false, "- turns keyboard shortcuts off")
      assert.equal(
        await page.evaluate(
          () => document.querySelector('[data-testid="minimal-header"] kbd') === null,
        ),
        true,
        "Disabled keyboard mode hides inactive key hints",
      )
      await key("e")
      assert.equal(await sidebarDisplay(), "none", "Sidebar shortcut requires keyboard mode on")
      await key("-")
      assert.equal(await keyboardModeOn(), true, "- turns keyboard shortcuts back on")
      await key("v")
      assert.equal(
        await page.evaluate(
          () => document.querySelector('[data-testid="minimal-header"]') === null,
        ),
        true,
        "V restores the overview",
      )
      await key("v")
      await page.click('[data-testid="show-chrome"]')
      await page.click('[data-testid="stack-pr-3007"]')
      await waitContext("Reviewing #3007 against #3006")
      await page.click('[data-testid="stack-scope-cumulative"]')
      await waitContext("Reviewing through #3007 against main")
      await page.click('[data-testid="diff-mode-text"]')
      await page.click('[data-testid="review-from-bottom"]')
      await review(3006)
      await waitContext("Reviewing #3006 against main")
      assert.equal(await checked("stack-scope-pr"), "true")
      assert.equal(await checked("diff-mode-semantic"), "true")
      await waitFile("shared.go")
      assert.equal(
        await page.evaluate(() => document.querySelector('[data-testid="mark-as-viewed"]').checked),
        true,
        "Review from bottom must not erase viewed marks",
      )
      // Starting from a commit on the bottom PR must also restore all changes.
      await page.click('[data-testid="next-commit"]')
      await waitContext("commit ccccccc")
      await page.click('[data-testid="review-from-bottom"]')
      await waitContext("Reviewing #3006 against main")

      // A file missing from the next member falls back to its first reviewable
      // file. An empty/metadata-only member leaves stack navigation usable.
      await page.click('[data-file-index="0"]')
      await waitFile("bottom.go")
      await page.click('[data-testid="next-stack-pr"]')
      await review(3007)
      await waitFile("shared.go")
      await page.click('[data-testid="stack-scope-cumulative"]')
      await waitContext("Reviewing through #3007 against main")
      failStackOnce = true
      await page.click('[data-testid="next-stack-pr"]')
      await waitStatus("Fixture stack unavailable")
      await waitContext("Reviewing through #3007 against main")
      assert.equal(await currentPr(), github(3007))
      await page.click('[data-testid="next-stack-pr"]')
      await review(3008)
      await waitContext("Reviewing through #3008 against main")
      assert.equal(await page.evaluate(() => Boolean(document.querySelector("iframe"))), false)
      assert.equal(
        await page.evaluate(() => document.querySelector('[data-testid="next-stack-pr"]').disabled),
        true,
      )
      await page.click('[data-testid="review-from-bottom"]')
      await review(3006)

      // Late commit work from an old PR must not replace a newer PR's scope.
      delayCommit = true
      const previousCommitRequests = commitRequests
      await page.click('[data-testid="next-commit"]')
      const requestDeadline = Date.now() + 10_000
      while (commitRequests === previousCommitRequests) {
        assert.ok(Date.now() < requestDeadline, "Commit scope request did not start")
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      await page.click('[data-testid="next-stack-pr"]')
      await review(3007)
      await new Promise((resolve) => setTimeout(resolve, 600))
      await waitContext("Reviewing #3007 against #3006")
      await waitFile("shared.go")
      // Stack shortcuts work without opening any overlay (mode is on above).
      await key("}")
      await review(3008)
      await key("{")
      await review(3007)
      await page.evaluate(() => localStorage.removeItem("local-diffe:diff-mode"))

      // Final-stack scope keeps the selected member as the URL anchor and
      // requires an explicit lane when there are sibling leaves.
      const choose = (selector, value) =>
        page.evaluate(
          ({ selector, value }) => {
            const select = document.querySelector(selector)
            select.value = value
            select.dispatchEvent(new Event("change", { bubbles: true }))
          },
          { selector, value },
        )
      await page.goto(`${app}/?pr=${github(3100)}`)
      await review(3100)
      assert.equal(
        await page.evaluate(() => document.querySelector('[data-testid="stack-tip"]').value),
        "",
      )
      await page.click('[data-testid="stack-scope-final"]')
      await waitStatus("Choose a descendant tip")
      await waitContext("Reviewing #3100 against main")
      await choose('[data-testid="stack-tip"]', "3101")
      await page.click('[data-testid="stack-scope-final"]')
      await waitContext("Final stack through #3101 against main")
      assert.equal(await currentPr(), github(3100))
      assert.equal(new URL(await location()).searchParams.get("scope"), "final")
      assert.equal(new URL(await location()).searchParams.get("tip"), "3101")
      await choose('[data-testid="stack-tip"]', "3102")
      await waitContext("Final stack through #3102 against main")
      assert.equal(
        await page.evaluate(() =>
          [...document.querySelectorAll("[data-file-index]")].some((entry) =>
            entry.textContent.includes("branch-a.go"),
          ),
        ),
        false,
      )
      await choose('[data-testid="stack-tip"]', "3101")
      await waitContext("Final stack through #3101 against main")
      assert.equal(
        await page.evaluate(() =>
          [...document.querySelectorAll("[data-file-index]")].some((entry) =>
            entry.textContent.includes("sibling-b.go"),
          ),
        ),
        false,
      )
      await page.click('[data-testid="diff-mode-text"]')
      await page.goto(await location())
      await waitContext("Final stack through #3101 against main")
      assert.equal(await checked("diff-mode-text"), "true")
      await page.click('[data-testid="stack-scope-pr"]')
      await waitContext("Reviewing #3100 against main")
      await page.evaluate(() => history.back())
      await waitContext("Final stack through #3101 against main")
      await page.evaluate(() => history.forward())
      await waitContext("Reviewing #3100 against main")
      failStackOnce = true
      await page.click('[data-testid="stack-scope-final"]')
      await waitStatus("Fixture stack unavailable")
      await waitContext("Reviewing #3100 against main")
      assert.equal(await checked("stack-scope-pr"), "true")
      await page.click('[data-testid="stack-scope-final"]')
      await waitContext("Final stack through #3101 against main")

      await page.click('[data-testid="review-from-bottom"]')
      await waitContext("Reviewing #3100 against main")
      assert.equal(
        await checked("diff-mode-semantic"),
        "true",
        "Starting on the same anchor must still restore Semantic",
      )
      await page.goto(`${app}/?pr=${github(3101)}&scope=final&tip=3102`)
      await waitStatus("not a descendant")
      await waitContext("Reviewing #3101 against #3100")
      assert.notEqual(new URL(await location()).searchParams.get("scope"), "final")

      // File history contains actual A/C modifications, not inherited appearances
      // in untouched B. Metadata can be partial, failed, and explicitly retried.
      await page.evaluate(() => localStorage.removeItem("local-diffe:review-evidence:v1"))
      historyPendingOnce = true
      await page.goto(
        `${app}/?pr=${github(3200)}&layout=files&path=src%2Fstore%2Fvalue.go&tip=3202`,
      )
      await review(3200)
      await waitText('[data-testid="stack-history"]', "Preparing stack metadata")
      await waitText('[data-testid="history-pr-3202"]', "3202")
      assert.equal(
        await page.evaluate(() =>
          Boolean(document.querySelector('[data-testid="history-pr-3201"]')),
        ),
        false,
      )
      await waitText('[data-testid="symbol-source-preview"]', "return 3200")
      await page.click('[data-testid="mark-as-viewed"]')
      await page.click('[data-testid="mark-symbol-reviewed"]')
      await waitText('[data-testid="later-change-notice"]', "3202")
      await waitText('[data-testid="symbol-later-notice"]', "changes later")
      await page.screenshot({ path: `/tmp/local-diffe-all-slices-${mode.split(" ")[0]}.png` })
      await page.click('[data-testid="next-file-change"]')
      await review(3202)
      await waitFile("src/store/value.go")
      assert.equal(
        await page.evaluate(() => document.querySelector('[data-testid="mark-as-viewed"]').checked),
        false,
      )
      await page.click('[data-testid="previous-file-change"]')
      await review(3200)
      await waitText('[data-testid="symbol-source-preview"]', "return 3200")
      await page.click('[data-testid="next-symbol-change"]')
      await review(3202)
      await waitText('[data-testid="symbol-source-preview"]', "return 3202")
      await choose('[data-testid="history-folder"]', "src/store")
      assert.equal(new URL(await location()).searchParams.get("pathKind"), "folder")
      assert.deepEqual(
        await page.evaluate(() =>
          [...document.querySelector('[data-testid="history-file"]').options]
            .map((option) => option.value)
            .filter(Boolean),
        ),
        ["src/store/value.go"],
      )
      await choose('[data-testid="history-file"]', "src/store/value.go")
      await page.goto(await location())
      await review(3202)
      await waitText('[data-testid="history-pr-3200"]', "3200")
      assert.equal(new URL(await location()).searchParams.get("folder"), "src/store")
      assert.ok(await page.textContent('[data-testid="stack-path-tree"]'))
      await page.click('[data-testid="previous-folder-pr"]')
      await review(3200)
      await page.click('[data-testid="next-folder-pr"]')
      await review(3202)
      await choose('[data-testid="history-folder"]', "")
      await choose('[data-testid="history-file"]', "binary.dat")
      await waitText('[data-testid="stack-history"]', "Go-only pilot")
      assert.equal(await checked("diff-mode-text"), "true")
      historyFailed = true
      await page.goto(await location())
      await review(3202)
      await waitText('[data-testid="stack-history"]', "Fixture member unavailable")
      await page.click('[data-testid="retry-stack-history"]')
      await waitText('[data-testid="history-pr-3202"]', "3202")
      await choose('[data-testid="history-file"]', "src/new.go")
      await waitText('[data-testid="history-pr-3202"]', "Renamed (Git)")
      await choose('[data-testid="history-file"]', "src/store/value.go")
      ambiguousSymbols = true
      await page.goto(await location())
      await review(3202)
      await waitText('[data-testid="symbol-history"]', "Duplicate declaration names")
      assert.equal(
        await page.evaluate(
          () => document.querySelector('[data-testid="next-symbol-change"]').disabled,
        ),
        true,
      )
      assert.equal(
        await page.evaluate(
          () => document.querySelector('[data-testid="previous-symbol-change"]').disabled,
        ),
        true,
      )
      ambiguousSymbols = false

      // A many-file lane stays navigable without mounting every path or diff.
      largeHistory = true
      await page.goto(`${app}/?pr=${github(3200)}&layout=files&tip=3202`)
      await review(3200)
      await waitText('[data-testid="stack-history"]', "Showing 200 of")
      assert.ok(
        await page.evaluate(
          () => document.querySelector('[data-testid="history-file"]').options.length <= 202,
        ),
      )
      await page.fill('[data-testid="history-path-filter"]', "bulk/file-04999.go")
      await waitText('[data-testid="history-file"]', "file-04999.go")
      assert.ok(
        await page.evaluate(
          () => document.querySelector('[data-testid="history-file"]').options.length <= 3,
        ),
      )
      largeHistory = false

      // Final-result review evidence is separate from reviewing each contribution;
      // the reverted intermediate path is absent from the final comparison.
      await page.goto(`${app}/?pr=${github(3200)}&scope=final&tip=3202`)
      await waitContext("Final stack through #3202 against main")
      assert.equal(
        await page.evaluate(() =>
          [...document.querySelectorAll("[data-file-index]")].some((entry) =>
            entry.textContent.includes("reverted.go"),
          ),
        ),
        false,
      )
      assert.equal(
        await page.evaluate(() => document.querySelector('[data-testid="mark-as-viewed"]').checked),
        false,
      )
      await page.click('[data-testid="mark-as-viewed"]')
      await page.click('[data-testid="stack-scope-pr"]')
      await waitContext("Reviewing #3200 against main")
      assert.equal(
        await page.evaluate(() => document.querySelector('[data-testid="mark-as-viewed"]').checked),
        true,
      )

      await page.goto(`${app}/?pr=${github(3200)}&scope=cumulative&diff=text`)
      await waitContext("Reviewing through #3200 against main")
      assert.equal(await checked("stack-scope-cumulative"), "true")
      assert.equal(await checked("diff-mode-text"), "true")
      await page.click('[data-testid="stack-scope-pr"]')
      await waitContext("Reviewing #3200 against main")

      // Pushes expose previous evidence as outdated, with an explicit retained
      // target-to-target delta. Missing snapshots never substitute another base.
      pushed = true
      await page.goto(`${app}/?pr=${github(3200)}`)
      await review(3200)
      await waitText('[data-testid="outdated-review"]', "Outdated review")
      assert.equal(
        await page.evaluate(() => document.querySelector('[data-testid="mark-as-viewed"]').checked),
        false,
      )
      await page.click('[data-testid="changes-since-review"]')
      await waitContext("Changes since my review")
      assert.deepEqual(lastSincePair, [oid(3200), oid(13200)])
      assert.equal(
        await page.evaluate(
          () => document.querySelector('[data-testid="mark-as-viewed"]').disabled,
        ),
        true,
      )
      await page.click('[data-testid="return-current-review"]')
      await waitContext("Reviewing #3200 against main")
      snapshots.clear()
      await page.click('[data-testid="hide-chrome"]')
      await page.click('[data-testid="changes-since-review"]')
      await waitText('[data-testid="review-error"]', "Reviewed snapshot unavailable")
      await waitContext("Reviewing #3200 against main")
      await page.click('[data-testid="show-chrome"]')
      await page.click('[data-testid="mark-as-viewed"]')
      await page.goto(await location())
      await review(3200)
      assert.equal(
        await page.evaluate(() => document.querySelector('[data-testid="mark-as-viewed"]').checked),
        true,
      )
      await page.evaluate(() => {
        const original = Storage.prototype.setItem
        window.restoreFixtureStorage = () => {
          Storage.prototype.setItem = original
        }
        Storage.prototype.setItem = () => {
          throw new DOMException("Denied", "QuotaExceededError")
        }
      })
      await page.click('[data-testid="mark-as-viewed"]')
      await page.click('[data-testid="mark-as-viewed"]')
      await waitText('[data-testid="evidence-warning"]', "kept in memory")
      assert.equal(
        await page.evaluate(() => document.querySelector('[data-testid="mark-as-viewed"]').checked),
        true,
      )
      await page.evaluate(() => window.restoreFixtureStorage())

      // Only the current same-origin viewer may send keyboard commands.
      await page.goto(`${app}/?pr=${encodeURIComponent(github(3020))}`)
      await review(3020)
      await checkPicker('[data-testid="commit-select"]')
      await page.click('[data-testid="list-prs"]')
      await waitStatus("open pull requests found")
      await checkPicker('[data-testid="pr-select"]')
      await page.evaluate(
        () =>
          new Promise((resolve, reject) => {
            const deadline = performance.now() + 10_000
            const check = () => {
              const frame = document.querySelector("iframe")
              if (frame?.contentDocument?.querySelector("[data-fixture-viewer]")) return resolve()
              if (performance.now() > deadline)
                return reject(new Error("Fixture viewer did not load"))
              requestAnimationFrame(check)
            }
            check()
          }),
      )
      const overlay = () =>
        page.evaluate(() => document.querySelector('[data-testid="keyboard-overlay"]') !== null)
      const keyboardPressed = () =>
        page.evaluate(() =>
          document
            .querySelector('[data-testid="keyboard-overlay-toggle"]')
            ?.getAttribute("aria-pressed"),
        )
      assert.equal(await overlay(), false)
      const before = await keyboardPressed()
      await page.evaluate(
        () =>
          new Promise((resolve) => {
            window.addEventListener(
              "message",
              () => requestAnimationFrame(() => requestAnimationFrame(resolve)),
              { once: true },
            )
            window.postMessage({ source: "local-diffe-keyboard", key: "-" }, location.origin)
          }),
      )
      assert.equal(await overlay(), false)
      assert.equal(
        await keyboardPressed(),
        before,
        "same-origin messages from the host must not act as viewer commands",
      )
      await page.evaluate(() => {
        const source = document.querySelector("iframe").contentWindow
        window.dispatchEvent(
          new MessageEvent("message", {
            source,
            origin: "https://evil.test",
            data: { source: "local-diffe-keyboard", key: "-" },
          }),
        )
        window.dispatchEvent(
          new MessageEvent("message", {
            source,
            origin: location.origin,
            data: { source: "local-diffe-keyboard", key: 123 },
          }),
        )
      })
      assert.equal(await overlay(), false)
      assert.equal(
        await keyboardPressed(),
        before,
        "foreign-origin and malformed viewer messages must be ignored",
      )
      await page.evaluate(
        (beforePressed) =>
          new Promise((resolve, reject) => {
            document
              .querySelector("iframe")
              .contentWindow.postMessage({ testKey: "-" }, location.origin)
            const deadline = performance.now() + 10_000
            const check = () => {
              const pressed = document
                .querySelector('[data-testid="keyboard-overlay-toggle"]')
                ?.getAttribute("aria-pressed")
              if (pressed !== null && pressed !== undefined && pressed !== beforePressed)
                return resolve()
              if (performance.now() > deadline)
                return reject(new Error("Trusted viewer command did not toggle keyboard mode"))
              requestAnimationFrame(check)
            }
            check()
          }),
        before,
      )
      assert.equal(await keyboardPressed(), before === "true" ? "false" : "true")
      assert.equal(await overlay(), false)
      // Restore keyboard mode, then exercise the new always-on keys.
      await key("-")
      assert.equal(await keyboardPressed(), "true")
      await page.evaluate(() =>
        window.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "k",
            ctrlKey: true,
            bubbles: true,
            cancelable: true,
          }),
        ),
      )
      assert.equal(
        await page.evaluate(() =>
          Boolean(document.querySelector('[data-testid="command-palette"]')),
        ),
        true,
        "Ctrl+K opens the command palette",
      )
      await key("Escape")
      assert.equal(
        await page.evaluate(() =>
          Boolean(document.querySelector('[data-testid="command-palette"]')),
        ),
        false,
        "Escape closes the command palette",
      )
      // Ctrl+K pressed inside the focused diff iframe must open the palette
      // (the bridge forwards the chord with modifiers, not a bare "k").
      await page.evaluate(
        () =>
          new Promise((resolve, reject) => {
            document
              .querySelector("iframe")
              .contentWindow.postMessage({ testKey: "k", testCtrl: true }, location.origin)
            const deadline = performance.now() + 10_000
            const check = () => {
              if (document.querySelector('[data-testid="command-palette"]')) return resolve()
              if (performance.now() > deadline)
                return reject(new Error("Ctrl+K inside the diff did not open the palette"))
              requestAnimationFrame(check)
            }
            check()
          }),
      )
      await key("Escape")
      assert.equal(
        await page.evaluate(() =>
          Boolean(document.querySelector('[data-testid="command-palette"]')),
        ),
        false,
        "Escape closes the palette opened from inside the diff",
      )
      await key("/")
      await page.evaluate(
        () =>
          new Promise((resolve, reject) => {
            const deadline = performance.now() + 10_000
            const check = () => {
              if (document.activeElement?.getAttribute("data-testid") === "file-filter")
                return resolve()
              if (performance.now() > deadline)
                return reject(new Error("/ did not focus the file filter"))
              requestAnimationFrame(check)
            }
            check()
          }),
      )
      await page.evaluate(() => document.activeElement?.blur())
      const modeBefore = await checked("diff-mode-semantic")
      await key("t")
      assert.notEqual(await checked("diff-mode-semantic"), modeBefore, "t toggles the diff mode")
      // Saving and editing are local. Publication requires its own user action.
      await page.goto(`${app}/?pr=${github(3006)}`)
      await review(3006)
      const panel = '[data-testid="comments-panel"]'
      const clickComment = (text) =>
        page.evaluate(
          (text) =>
            new Promise((resolve, reject) => {
              const deadline = performance.now() + 10000
              const check = () => {
                const button = [
                  ...document.querySelectorAll('[data-testid="comments-panel"] button'),
                ].find((node) => node.textContent.trim() === text)
                if (button && !button.disabled) {
                  button.click()
                  return resolve()
                }
                if (performance.now() > deadline)
                  return reject(new Error(`Comment button unavailable: ${text}`))
                requestAnimationFrame(check)
              }
              check()
            }),
          text,
        )
      await page.click(`${panel} summary`)
      await page.fill(`${panel} textarea`, "Draft from the review")
      await clickComment("Save locally")
      await waitText(`${panel} li`, "Draft from the review")
      assert.equal(commentPosts, 0)
      await page.goto(await location())
      await review(3006)
      await page.click(`${panel} summary`)
      await waitText(`${panel} li`, "Draft from the review")
      await clickComment("Edit")
      await page.fill(`${panel} textarea`, "Edited draft from the review")
      await clickComment("Save locally")
      await waitText(`${panel} li`, "Edited draft from the review")
      await clickComment("Post to GitHub")
      assert.equal(commentPosts, 0)
      await clickComment("Confirm post")
      await waitText(`${panel} li`, "View on GitHub")
      assert.equal(commentPosts, 1)
      await page.goto(`${app}/?pr=${github(3007)}`)
      await review(3007)
      await waitText(`${panel} summary`, "0 local")
      assert.equal(
        await page.evaluate(
          (selector) => document.querySelector(selector).textContent.includes("Edited draft"),
          panel,
        ),
        false,
      )
      console.log(
        `Review browser checks passed (${mode}): URL/scope restoration, explicit final lanes, file/folder history, review evidence and updates, retained deltas, conservative Go function navigation, keyboard/focus, retries/races, API contracts and viewer boundaries.`,
      )
    } finally {
      await page.close()
    }
  }
} finally {
  await browser.close()
  await vite?.close()
  await new Promise((resolve) => fixture.close(resolve))
}
