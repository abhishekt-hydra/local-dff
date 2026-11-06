import assert from "node:assert/strict"

// Rustwright exposes its browser endpoint; use CDP for real phone viewport and
// touch emulation rather than changing CSS or spoofing window.innerWidth.
async function phoneSession(browser, page) {
  const targetUrl = `about:blank#mobile-review-${crypto.randomUUID()}`
  await page.goto(targetUrl)
  const socket = new WebSocket(browser.wsEndpoint())
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true })
    socket.addEventListener("error", reject, { once: true })
  })
  let nextId = 0
  const pending = new Map()
  socket.addEventListener("message", ({ data }) => {
    const message = JSON.parse(data)
    const request = pending.get(message.id)
    if (!request) return
    pending.delete(message.id)
    clearTimeout(request.timeout)
    if (message.error) request.reject(new Error(message.error.message))
    else request.resolve(message.result)
  })
  function send(method, params = {}, sessionId) {
    return new Promise((resolve, reject) => {
      const id = ++nextId
      const timeout = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`Phone emulation timed out: ${method}`))
      }, 10000)
      pending.set(id, { resolve, reject, timeout })
      socket.send(JSON.stringify({ id, method, params, sessionId }))
    })
  }
  const { targetInfos } = await send("Target.getTargets")
  const target = targetInfos.find((target) => target.type === "page" && target.url === targetUrl)
  assert.ok(target, "A new page is available for phone emulation")
  const { sessionId } = await send("Target.attachToTarget", {
    targetId: target.targetId,
    flatten: true,
  })
  return {
    send: (method, params) => send(method, params, sessionId),
    close: () => socket.close(),
  }
}

export async function verifyMobileReview(browser, app, mode) {
  const page = await browser.newPage()
  const phone = await phoneSession(browser, page)
  const output = `/tmp/local-diffe-mobile-${mode.split(" ")[0]}`
  async function waitFor(expression) {
    await page.evaluate(
      (expression) =>
        new Promise((resolve, reject) => {
          const deadline = performance.now() + 10000
          function check() {
            if (Function(`return (${expression})`)()) return resolve()
            if (performance.now() > deadline)
              return reject(new Error(`Mobile check timed out: ${expression}`))
            requestAnimationFrame(check)
          }
          check()
        }),
      expression,
    )
  }
  async function resize(width, height) {
    await phone.send("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: true,
    })
    await phone.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 })
    await waitFor(`innerWidth === ${width} && innerHeight === ${height}`)
  }
  async function tap(selector) {
    const point = await page.evaluate((selector) => {
      const node = document.querySelector(selector)
      if (!node) throw new Error(`Tap target missing: ${selector}`)
      node.scrollIntoView({ block: "nearest", inline: "nearest" })
      const bounds = node.getBoundingClientRect()
      return { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 }
    }, selector)
    await phone.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point] })
    await phone.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] })
  }
  const ready = () =>
    waitFor(
      `document.querySelector('[data-diff-complete="true"] [data-testid="diff-scroll"]') && document.querySelector('[data-testid="mobile-review-footer"]')`,
    )
  const currentFile = (name) =>
    waitFor(
      `document.querySelector('[data-testid="mobile-review-header"]').textContent.includes(${JSON.stringify(name)})`,
    )
  try {
    await page.goto(app)
    await resize(390, 844)
    await page.evaluate(() => localStorage.clear())
    await page.fill(
      '[data-testid="pr-url"]',
      "https://github.com/hydra-db/hydradb-application/pull/3030",
    )
    assert.ok(
      await page.evaluate(() => document.querySelector('[data-testid="source-card"]')),
      "Typing a PR URL keeps setup open",
    )
    await tap('[data-testid="open-pr-url"]')
    await ready()
    await currentFile("ReviewPaneWithLongName.tsx")

    for (const [width, height] of [
      [320, 568],
      [360, 740],
      [390, 844],
      [430, 932],
      [844, 390],
    ]) {
      await resize(width, height)
      const bounds = await page.evaluate(() => {
        const diff = document.querySelector('[data-testid="diff-scroll"]').getBoundingClientRect()
        const header = document
          .querySelector('[data-testid="mobile-review-header"]')
          .getBoundingClientRect()
        const footer = document
          .querySelector('[data-testid="mobile-review-footer"]')
          .getBoundingClientRect()
        return {
          width: innerWidth,
          height: innerHeight,
          pageWidth: document.documentElement.scrollWidth,
          pageHeight: document.documentElement.scrollHeight,
          diff: {
            x: diff.x,
            width: diff.width,
            height: diff.height,
            top: diff.top,
            bottom: diff.bottom,
          },
          headerBottom: header.bottom,
          footerTop: footer.top,
          footerBottom: footer.bottom,
          touchTargets: [
            ...document.querySelectorAll(
              '[data-testid="mobile-review-header"] button, [data-testid="mobile-review-footer"] button',
            ),
          ].every((button) => button.getBoundingClientRect().height >= 44),
        }
      })
      assert.equal(bounds.pageWidth, width, "The page never scrolls sideways")
      assert.equal(bounds.pageHeight, height, "The review fits the phone height")
      assert.equal(bounds.diff.width, width, "The diff uses the full width")
      assert.equal(bounds.diff.x, 0)
      assert.ok(bounds.diff.height >= height - 120, "Only compact controls take space from code")
      assert.ok(bounds.diff.top >= bounds.headerBottom)
      assert.ok(bounds.diff.bottom <= bounds.footerTop)
      assert.equal(bounds.footerBottom, height)
      assert.ok(bounds.touchTargets, "Primary touch targets are at least 44px tall")
      await page.screenshot({ path: `${output}-${width}x${height}.png` })
    }

    await resize(390, 844)
    // Pan long code inside the diff; the page and its controls stay in place.
    assert.ok(
      await page.evaluate(() => {
        const viewport = document.querySelector('[data-testid="diff-scroll"]')
        viewport.scrollLeft = 120
        viewport.scrollTop = 240
        return (
          viewport.scrollLeft > 0 &&
          viewport.scrollTop > 0 &&
          window.scrollX === 0 &&
          window.scrollY === 0
        )
      }),
    )
    await page.evaluate(() => {
      const viewport = document.querySelector('[data-testid="diff-scroll"]')
      viewport.scrollTo(0, 0)
    })

    await tap('[data-testid="viewed-and-next"]')
    await currentFile("review-navigation.ts")
    await ready()
    assert.equal(
      await page.evaluate(() =>
        document.querySelector('[aria-label="Files viewed"]').getAttribute("aria-valuenow"),
      ),
      "1",
    )
    await tap('[data-testid="mobile-review-footer"] [aria-label="Previous file"]')
    await currentFile("ReviewPaneWithLongName.tsx")
    await waitFor(
      `document.querySelector('[data-testid="viewed-and-next"]').textContent.includes('Next unviewed')`,
    )

    await tap('[data-testid="mobile-files"]')
    await waitFor(`document.querySelector('dialog[aria-label="Review navigation"]').open`)
    await waitFor(
      `document.querySelector('[role="tree"]').getBoundingClientRect().height >= document.querySelector('[data-testid="file-tree-container"]').clientHeight - 20`,
    )
    await waitFor(
      `document.querySelector('[data-file-index="2"]')?.getBoundingClientRect().bottom < document.querySelector('dialog[aria-label="Review navigation"]').getBoundingClientRect().bottom`,
    )
    assert.ok(
      await page.evaluate(() =>
        document
          .querySelector('dialog[aria-label="Review navigation"]')
          .contains(document.activeElement),
      ),
    )
    await page.screenshot({ path: `${output}-files.png` })
    await tap('[data-file-index="2"]')
    await currentFile("review.md")
    await waitFor(`!document.querySelector('dialog[aria-label="Review navigation"]').open`)
    assert.equal(
      await page.evaluate(() => document.activeElement?.getAttribute("data-testid")),
      "mobile-files",
      "Closing navigation returns focus to its trigger",
    )

    // A real tap opens a line draft, and typing keeps focus in the sheet.
    await ready()
    await tap('[data-comment-new="1"] [data-comment-side="RIGHT"]')
    await waitFor(`document.querySelector('dialog[aria-label="Comment on selected line"]')?.open`)
    await page.fill('[aria-label="Line comment"]', "Mobile review draft")
    const sheet = await page.evaluate(() => {
      const dialog = document.querySelector('dialog[aria-label="Comment on selected line"]')
      const bounds = dialog.getBoundingClientRect()
      return {
        left: bounds.left,
        right: bounds.right,
        bottom: bounds.bottom,
        height: bounds.height,
        focused: document.activeElement?.getAttribute("aria-label"),
      }
    })
    assert.equal(sheet.left, 0)
    assert.equal(sheet.right, 390)
    assert.equal(sheet.bottom, 844)
    assert.equal(sheet.focused, "Line comment")
    await page.screenshot({ path: `${output}-comment.png` })
    await resize(390, 460)
    assert.ok(
      await page.evaluate(() => {
        const sheet = document
          .querySelector('dialog[aria-label="Comment on selected line"]')
          .getBoundingClientRect()
        return sheet.top >= 0 && sheet.bottom <= window.visualViewport.height
      }),
      "Comment sheet fits when the keyboard reduces the available height",
    )
    await resize(390, 844)
    await tap('[aria-label="Close comment"]')
    await tap('[data-comment-new="1"] [data-comment-side="RIGHT"]')
    await waitFor(
      `document.querySelector('[aria-label="Line comment"]')?.value === 'Mobile review draft'`,
    )
    await page.evaluate(() =>
      [...document.querySelectorAll('dialog[aria-label="Comment on selected line"] button')]
        .find((button) => button.textContent.includes("Save comment"))
        .click(),
    )
    await waitFor(`!document.querySelector('dialog[aria-label="Comment on selected line"]')`)
    await tap('[data-testid="mobile-files"]')
    await tap('[data-testid="comments-panel"] summary')
    await waitFor(
      `document.querySelector('[data-testid="comments-panel"]').textContent.includes('Mobile review draft')`,
    )
    await tap('[aria-label="Close changed files"]')

    await tap('[data-testid="viewed-and-next"]')
    await currentFile("review-navigation.ts")
    await tap('[data-testid="viewed-and-next"]')
    await waitFor(
      `document.querySelector('[data-testid="viewed-and-next"]').textContent.includes('All files viewed')`,
    )
    assert.equal(
      await page.evaluate(() =>
        document.querySelector('[aria-label="Files viewed"]').getAttribute("aria-valuenow"),
      ),
      "3",
    )
    await page.goto(await page.evaluate(() => location.href))
    await ready()
    await waitFor(
      `document.querySelector('[data-testid="viewed-and-next"]').textContent.includes('All files viewed')`,
    )

    await tap('[aria-label="Review options"]')
    await waitFor(`document.querySelector('[aria-label="Diff view"]')`)
    await page.evaluate(() =>
      [...document.querySelectorAll(".mobile-review-options button")]
        .find((button) => button.textContent.includes("Mark as unviewed"))
        .click(),
    )
    await waitFor(
      `document.querySelector('[aria-label="Files viewed"]').getAttribute('aria-valuenow') === '2'`,
    )
    await tap('[aria-label="Review options"]')
    await page.evaluate(() =>
      [...document.querySelectorAll(".mobile-review-options button")]
        .find((button) => button.textContent.includes("Overview & setup"))
        .click(),
    )
    await waitFor(`document.querySelector('[data-testid="source-card"]')`)
    await page.click('[data-testid="hide-chrome"]')
    await ready()

    // Stack PRs also default to unified text, while explicit Semantic links work.
    await page.goto(`${app}/?pr=https://github.com/hydra-db/hydradb-application/pull/3006`)
    await ready()
    assert.equal(await page.evaluate(() => document.querySelector("iframe") === null), true)
    await page.goto(
      `${app}/?pr=https://github.com/hydra-db/hydradb-application/pull/3006&diff=semantic`,
    )
    await waitFor(`document.querySelector('iframe')`)
    console.log(
      `Mobile review checks passed (${mode}): five phone viewports, real touch navigation, retained progress, file drawer, line drafts, reduced viewport, completion and explicit diff modes. Screenshots: ${output}-*.png`,
    )
  } catch (error) {
    await page.screenshot({ path: `${output}-failure.png` })
    throw error
  } finally {
    phone.close()
    await page.close()
  }
}
