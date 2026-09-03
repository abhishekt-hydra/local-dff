import path from "node:path"
import { generateDiff, openApp, pause, screenshotDir } from "./helpers.mjs"

const { browser, page } = await openApp()
try {
  await generateDiff(page)
  const supportedFile = await page.evaluate(() => {
    return [...document.querySelectorAll("[data-file-index]")]
      .find((element) => /\.(go|rs|ts|tsx|js|jsx|py|json)$/i.test(element.textContent || ""))
      ?.getAttribute("data-file-index")
  })
  if (!supportedFile) throw new Error("No SemanticDiff-supported source file was rendered in the tree.")
  await page.click(`[data-file-index="${supportedFile}"]`)
  await pause(1800)
  await page.screenshot({ path: path.join(screenshotDir, "04-desktop-semantic.png"), fullPage: true })
  console.log(`Captured desktop view for file ${supportedFile}`)
} finally {
  await browser.close()
}
