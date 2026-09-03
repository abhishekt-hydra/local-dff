import { chromium } from "rustwright"
import { mkdir } from "node:fs/promises"
import path from "node:path"

export const appUrl = process.env.LOCAL_DIFFE_URL || "http://127.0.0.1:4317"
export const screenshotDir = path.resolve("screenshots")

export async function openApp() {
  process.env.RUSTWRIGHT_CHROMIUM ||= "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  await mkdir(screenshotDir, { recursive: true })
  const browser = await chromium.launch({
    headless: true,
    args: ["--window-size=1600,1100", "--force-device-scale-factor=1"],
  })
  const page = await browser.newPage()
  await page.goto(appUrl)
  return { browser, page }
}

export const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))

export async function generateDiff(page) {
  await page.click('[data-testid="generate-diff"]')
  // Rustwright's Node binding intentionally exposes a compact Playwright subset.
  // The app's Git + SemanticDiff flow is local and normally completes within this window.
  await pause(1800)
}
