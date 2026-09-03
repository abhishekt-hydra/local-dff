import path from "node:path"
import { generateDiff, openApp, pause, screenshotDir } from "./helpers.mjs"

const fileIndex = process.env.FILE_INDEX || "0"
const { browser, page } = await openApp()
try {
  await generateDiff(page)
  await page.click(`[data-file-index="${fileIndex}"]`)
  await pause(1800)
  await page.screenshot({ path: path.join(screenshotDir, `semantic-file-${fileIndex}.png`), fullPage: true })
  console.log(`Captured semantic file ${fileIndex}`)
} finally {
  await browser.close()
}
