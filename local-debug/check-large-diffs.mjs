import assert from "node:assert/strict"
import { fileURLToPath } from "node:url"
import { appUrl, openApp, pause } from "./helpers.mjs"

const { browser, page } = await openApp()
async function click(selector) {
  // The tree recycles its row elements; select the current node at dispatch time.
  await page.evaluate(selector => document.querySelector(selector).click(), selector)
}
async function until(check, message) {
  for (let i = 0; i < 200; i++) {
    if (await page.evaluate(check)) return
    await pause(50)
  }
  throw new Error(message)
}
try {
  await page.evaluate(() => {
    const original = window.fetch.bind(window)
    window.diffRequests = 0
    window.fetch = async (url, options) => {
      if (url === "/api/git-diff") return Response.json({ id: "large-fixture", files: ["large.ts", "other.ts"].map(path => ({ old_path: path, new_path: path, display_path: path, renderable: true })) })
      if (String(url).startsWith("/api/diff/large-fixture/")) {
        window.diffRequests++
        const patch = String(url).endsWith("/0") ? "@@ -0,0 +1,100000 @@\n" + Array.from({ length: 100000 }, (_, i) => `+line ${i + 1}\n`).join("") : "@@ -1 +1 @@\n-before\n+after\n"
        return new Response(patch)
      }
      if (String(url).startsWith("/semanticdiff-view/large-fixture/")) return Response.json({ error: "Simulated semantic timeout" }, { status: 504 })
      return original(url, options)
    }
  })
  const start = performance.now()
  await click('[data-testid="generate-diff"]')
  await until(() => Boolean(document.querySelector('[data-file-index="0"]')), "File tree did not load")
  await click('[data-file-index="0"]')
  await until(() => Boolean(document.querySelector("[data-diff-row]")), "Large diff did not render")
  const firstPaint = performance.now() - start
  const first = await page.evaluate(() => ({ rows: document.querySelectorAll("[data-diff-row]").length, iframe: Boolean(document.querySelector("iframe")) }))
  assert.ok(first.rows < 100, `Too many DOM rows: ${first.rows}`)
  assert.equal(first.iframe, false)
  await page.evaluate(() => { const view = document.querySelector('[data-testid="diff-scroll"]'); view.scrollTop = view.scrollHeight })
  await until(() => document.querySelector('[data-testid="diff-scroll"]')?.textContent.includes("line 100000"), "Last line was not reachable")
  await click('[data-file-index="1"]')
  await until(() => document.querySelector('[data-testid="diff-scroll"]')?.textContent.includes("after"), "Second file did not render")
  await click('[data-file-index="0"]')
  await until(() => document.querySelector('[data-testid="diff-scroll"]')?.textContent.includes("line 1"), "Cached file did not render")
  assert.equal(await page.evaluate(() => window.diffRequests), 2)
  await page.evaluate(() => [...document.querySelectorAll("button")].find(b => b.textContent === "Semantic diff").click())
  await until(() => document.querySelector('[role="alert"]')?.textContent.includes("Simulated semantic timeout"), "Semantic failure was hidden")
  await page.evaluate(() => [...document.querySelectorAll("button")].find(b => b.textContent === "Text diff").click())
  await until(() => Boolean(document.querySelector("[data-diff-row]")), "Text fallback did not recover")

  // Exercise real Git, HTTP, Foyer, and the embedded semantic renderer as well.
  const response = await fetch(`${appUrl}/api/git-diff`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ repo: fileURLToPath(new URL("..", import.meta.url)), base: "HEAD~1", target: "HEAD" }) })
  assert.equal(response.ok, true)
  const session = await response.json()
  const index = session.files.findIndex(file => file.renderable && /\.(tsx?|rs|js)$/.test(file.display_path))
  assert.ok(index >= 0, "No source file in HEAD~1..HEAD for integration check")
  const patch = await fetch(`${appUrl}/api/diff/${session.id}/${index}`)
  assert.equal(patch.ok, true)
  assert.match(await patch.text(), /@@ /)
  await page.goto(appUrl)
  await page.evaluate((session) => {
    const original = window.fetch.bind(window)
    window.fetch = (url, options) => url === "/api/git-diff" ? Promise.resolve(Response.json(session)) : original(url, options)
  }, session)
  await click('[data-testid="generate-diff"]')
  await until(() => Boolean(document.querySelector("[data-file-index]")), "Real file tree did not load")
  await click(`[data-file-index="${index}"]`)
  await until(() => Boolean(document.querySelector("[data-diff-row]")), "Real text diff did not load")
  await page.evaluate(() => [...document.querySelectorAll("button")].find(b => b.textContent === "Semantic diff").click())
  await until(() => {
    const frame = document.querySelector("iframe")
    return Boolean(frame?.contentDocument?.querySelector("#patch")?.style.display !== "none" && frame && !document.querySelector('[role="status"]'))
  }, "Real semantic renderer did not report readiness")
  assert.equal(await page.evaluate(() => Boolean(document.querySelector('[role="alert"]'))), false)
  console.log(JSON.stringify({ firstPaintMs: Math.round(firstPaint), mountedRows: first.rows, checks: "100k rows, bottom scroll, file cache, semantic error recovery, real Git and semantic rendering" }))
} catch (error) {
  console.error(await page.evaluate(() => ({
    alert: document.querySelector('[role="alert"]')?.textContent,
    status: document.querySelector('[role="status"]')?.textContent,
    frame: document.querySelector("iframe")?.contentDocument?.body?.innerText.slice(0, 1500),
    patchStyle: document.querySelector("iframe")?.contentDocument?.querySelector("#patch")?.getAttribute("style"),
  })))
  throw error
} finally {
  await browser.close()
}
