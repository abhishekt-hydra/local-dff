// Runs entirely against fixtures: never clones repositories or contacts GitHub.
import assert from "node:assert/strict"
import { createServer as createHttpServer } from "node:http"
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { extname, resolve, sep } from "node:path"
import { chromium } from "rustwright"
import { createServer as createViteServer } from "vite"

const github = (number) => `https://github.com/hydra-db/hydradb-application/pull/${number}`
const pull = (number) => ({
  number,
  url: github(number),
  title: `Fixture PR ${number}`,
  state: "OPEN",
  baseRefName: number === 3007 ? "pr-3006" : "main",
  headRefName: `pr-${number}`,
  isDraft: false,
  updatedAt: "2026-10-01T00:00:00Z",
})
function session(number, mode = "pr") {
  return {
    id: `fixture-${number}-${mode}`,
    files:
      number === 3020
        ? [{ old_path: "main.go", new_path: "main.go", display_path: "main.go", renderable: true }]
        : [],
    commits:
      number === 3020
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
      changed_paths: number === 3020 ? 1 : 0,
      semantic_paths: number === 3020 ? 1 : 0,
      description: "Fixture comparison",
      pull_request: number ? pull(number) : null,
    },
    stack: [3006, 3007].includes(number)
      ? {
          trunk: "main",
          current: number,
          mode,
          members: [3006, 3007].map((number, index) => ({
            pull: pull(number),
            parent: index ? 3006 : null,
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
const fixture = createHttpServer(async (request, response) => {
  try {
    const url = new URL(request.url, "http://fixture")
    if (url.pathname.startsWith("/api/")) {
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
      } else if (url.pathname === "/api/stack-scope") result = session(input.number, input.mode)
      else if (url.pathname === "/api/github/open-prs") result = [pull(3006), pull(3007)]
      else if (url.pathname === "/api/git-diff") result = session(null)
      else throw new Error(`Unexpected API call: ${url.pathname}`)
      if (!response.destroyed) {
        response.writeHead(200, { "content-type": "application/json" })
        response.end(JSON.stringify(result))
      }
      return
    }
    if (url.pathname === "/semanticdiff-view/fixture-3020-pr/0") {
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
    const page = await browser.newPage()
    async function waitStatus(fragment) {
      await page.evaluate(
        (fragment) =>
          new Promise((resolve, reject) => {
            const deadline = performance.now() + 10_000
            const check = () => {
              const status = document.querySelector('[data-testid="status"]')?.textContent ?? ""
              if (status.includes(String(fragment))) return resolve()
              if (performance.now() > deadline)
                return reject(new Error(`Expected status ${fragment}; got ${status}`))
              requestAnimationFrame(check)
            }
            check()
          }),
        fragment,
      )
    }
    const review = (number) => waitStatus(`PR #${number} ·`)
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
        `Review browser checks passed (${mode}): URL navigation, validation, retry, races, API contract, picker accessibility, viewer message boundaries.`,
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
