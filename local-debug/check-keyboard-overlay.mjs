import { openApp, pause } from "./helpers.mjs"

async function press(page, key) {
  // rustwright intentionally exposes a compact API and does not provide a
  // Playwright-style keyboard object. Dispatching on window exercises the same
  // application keydown listener that real key presses reach.
  await page.evaluate((pressedKey) => window.dispatchEvent(new KeyboardEvent("keydown", {
    key: pressedKey,
    bubbles: true,
    cancelable: true,
  })), key)
  await pause(75)
}

const { browser, page } = await openApp()
try {
  await press(page, "-")
  const shown = await page.evaluate(() => ({
    overlay: Boolean(document.querySelector('[data-testid="keyboard-overlay"]')),
    destinations: document.querySelector('[data-testid="keyboard-overlay"]')?.textContent,
  }))
  if (!shown.overlay || !shown.destinations?.includes("Files") || !shown.destinations.includes("Diff panel") || !shown.destinations.includes("Focus view")) {
    throw new Error("Keyboard overlay did not expose the three one-key destinations.")
  }

  await press(page, "f")
  const sidebarFocused = await page.evaluate(() => document.activeElement?.getAttribute("aria-label") === "Changed files sidebar")
  if (!sidebarFocused) throw new Error("F did not focus the changed-files sidebar.")

  await press(page, "d")
  const diffFocused = await page.evaluate(() => document.activeElement?.getAttribute("aria-label") === "Semantic diff panel")
  if (!diffFocused) throw new Error("D did not focus the diff panel.")

  await press(page, "v")
  const focusView = await page.evaluate(() => Boolean(document.querySelector('[data-testid="show-chrome"]')))
  if (!focusView) throw new Error("V did not enter Focus view.")

  await press(page, "Escape")
  const hidden = await page.evaluate(() => !document.querySelector('[data-testid="keyboard-overlay"]'))
  if (!hidden) throw new Error("Escape did not hide the keyboard overlay.")

  console.log("keyboard overlay check passed")
} finally {
  await browser.close()
}
