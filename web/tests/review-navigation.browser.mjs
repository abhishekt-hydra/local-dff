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
      if (url.pathname === "/api/github/open-url") {
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
              parent.postMessage({ source: "local-diffe-keyboard", key: event.data.testKey }, origin);
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
      // Keep the existing keyboard overlay's stack shortcuts working.
      await key("-")
      await key("}")
      await review(3008)
      await key("{")
      await review(3007)
      await key("-")
      await page.evaluate(() => localStorage.removeItem("local-diffe:diff-mode"))

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
      assert.equal(await overlay(), false)
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
      assert.equal(
        await overlay(),
        false,
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
      assert.equal(
        await overlay(),
        false,
        "foreign-origin and malformed viewer messages must be ignored",
      )
      await page.evaluate(
        () =>
          new Promise((resolve, reject) => {
            document
              .querySelector("iframe")
              .contentWindow.postMessage({ testKey: "-" }, location.origin)
            const deadline = performance.now() + 10_000
            const check = () => {
              if (document.querySelector('[data-testid="keyboard-overlay"]')) return resolve()
              if (performance.now() > deadline)
                return reject(
                  new Error("Trusted viewer command did not toggle the keyboard overlay"),
                )
              requestAnimationFrame(check)
            }
            check()
          }),
      )
      assert.equal(await overlay(), true)
      console.log(
        `Review browser checks passed (${mode}): URL navigation, semantic stack workspace, file/commit continuity, review-from-bottom, keyboard stack navigation, retry/races, API contract, picker accessibility, viewer message boundaries.`,
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
