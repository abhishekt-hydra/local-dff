import path from "node:path"
import { appUrl, generateDiff, openApp, pause, screenshotDir } from "./helpers.mjs"

const { browser, page } = await openApp()
try {
  await page.screenshot({ path: path.join(screenshotDir, "01-landing.png"), fullPage: true })
  await generateDiff(page)
  await page.screenshot({ path: path.join(screenshotDir, "02-file-tree.png"), fullPage: true })

  const firstFileIndex = await page.evaluate(() => document.querySelector("[data-file-index]")?.getAttribute("data-file-index"))
  if (!firstFileIndex) throw new Error("No file nodes appeared after generating the diff.")
  await page.click(`[data-file-index="${firstFileIndex}"]`)
  await pause(1800)
  await page.screenshot({ path: path.join(screenshotDir, "03-semantic-view.png"), fullPage: true })
  console.log(JSON.stringify({ appUrl, firstFileIndex, screenshots: screenshotDir }, null, 2))
} finally {
  await browser.close()
}
