import assert from "node:assert/strict"
import { mkdir } from "node:fs/promises"
import { chromium } from "rustwright"

const base = process.env.NATIVE_REVIEW_URL
if (!base) throw new Error("Set NATIVE_REVIEW_URL to an isolated Local Diffe server")
const pr = process.env.NATIVE_REVIEW_PR ?? "https://github.com/hydra-db/turbolay/pull/322"
const output = process.env.NATIVE_REVIEW_OUTPUT ?? "/tmp/local-diffe-native-review"
await mkdir(output, { recursive: true })
const browser = await chromium.launch({ headless: true, args: ["--window-size=1600,1000"] })
const page = await browser.newPage()
async function waitFor(selector) {
  await page.evaluate(
    (selector) =>
      new Promise((resolve, reject) => {
        const deadline = performance.now() + 30000
        const check = () => {
          if (document.querySelector(selector)) return resolve()
          if (performance.now() > deadline) return reject(new Error(`Missing ${selector}`))
          requestAnimationFrame(check)
        }
        check()
      }),
    selector,
  )
}
async function api(action, payload) {
  const response = await fetch(`${base}/api/comments/${action}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pr_url: pr, ...payload }),
  })
  assert.equal(response.status, 200)
  return response.json()
}
const body = `Native review UI check ${Date.now()}`
try {
  console.log("Opening review")
  await page.goto(`${base}/?pr=${encodeURIComponent(pr)}`)
  await waitFor("iframe")
  console.log("Waiting for semantic renderer")
  await page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const deadline = performance.now() + 30000
        const check = () => {
          if (
            document.querySelector("iframe")?.contentDocument?.querySelector("#patch > .line.added")
          )
            return resolve()
          if (performance.now() > deadline) return reject(new Error("No semantic line"))
          requestAnimationFrame(check)
        }
        check()
      }),
  )
  console.log("Checking minimal mode")
  await page.click('[data-testid="hide-chrome"]')
  assert.equal(
    await page.evaluate(
      () =>
        getComputedStyle(document.querySelector('[aria-label="Changed files sidebar"]')).display,
    ),
    "none",
  )
  await page.screenshot({ path: `${output}/minimal.png` })
  console.log("Selecting semantic line")
  const expected = await page.evaluate(() => {
    const doc = document.querySelector("iframe").contentDocument
    const gutter = doc.querySelector("#patch > .line.added")
    const rect = gutter.getBoundingClientRect()
    gutter.dispatchEvent(
      new doc.defaultView.MouseEvent("mouseup", {
        bubbles: true,
        clientX: rect.left + 8,
        clientY: rect.top + 8,
      }),
    )
    return Number(gutter.textContent)
  })
  await waitFor('[aria-label="Line comment"]')
  await page.click('[aria-label="Close comment"]')
  await page.evaluate(() => {
    const doc = document.querySelector("iframe").contentDocument
    const gutter = doc.querySelector("#patch > .line.added")
    let code = gutter.nextElementSibling
    while (code && !code.classList.contains("code-fg")) code = code.nextElementSibling
    if (!code) throw new Error("Missing code beside gutter")
    const rect = code.getBoundingClientRect()
    code.dispatchEvent(
      new doc.defaultView.MouseEvent("mouseup", {
        bubbles: true,
        clientX: rect.left + 8,
        clientY: rect.top + 8,
      }),
    )
  })
  await waitFor('[aria-label="Line comment"]')
  await page.fill('[aria-label="Line comment"]', body)
  await page.screenshot({ path: `${output}/composer.png` })
  await page.evaluate(() =>
    [...document.querySelectorAll('[aria-label="Comment on selected line"] button')]
      .find((button) => button.textContent === "Save comment")
      .click(),
  )
  await page.evaluate(
    () =>
      new Promise((resolve) => {
        const check = () =>
          document.querySelector('[aria-label="Line comment"]')
            ? requestAnimationFrame(check)
            : resolve()
        check()
      }),
  )
  console.log("Reading draft")
  const saved = (await api("list", {})).find((comment) => comment.body === body)
  assert.ok(saved)
  assert.equal(saved.target.kind, "line")
  assert.equal(saved.target.line, expected)
  assert.equal(saved.target.side, "RIGHT")
  assert.equal(saved.state, "draft")
  await page.click('[aria-label="Toggle review sidebar"]')
  await page.click('[data-testid="comments-panel"] summary')
  assert.ok((await page.textContent('[data-testid="comments-panel"]')).includes(body))
  await page.screenshot({ path: `${output}/sidebar.png` })
  await api("delete", { id: saved.id, version: saved.version })
  await page.click('[aria-label="Toggle review sidebar"]')
  await page.click('[data-testid="diff-mode-text"]')
  await waitFor("[data-comment-old]")
  await page.evaluate(() => {
    const row = document.querySelector("[data-comment-old]")
    const gutter = row.querySelector('[data-comment-side="LEFT"]')
    const rect = gutter.getBoundingClientRect()
    gutter.dispatchEvent(
      new MouseEvent("mouseup", { bubbles: true, clientX: rect.left + 5, clientY: rect.top + 5 }),
    )
  })
  await waitFor('[aria-label="Line comment"]')
  assert.ok(
    (await page.textContent('[aria-label="Comment on selected line"]')).includes("Old file"),
  )
  console.log(
    "Native review verified: semantic RIGHT exact-line SQLite draft, sidebar readback, delete cleanup, minimal layout, text LEFT composer. No publication.",
  )
} finally {
  await browser.close()
}
