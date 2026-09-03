import path from "node:path"
import { appUrl, openApp, pause, screenshotDir } from "./helpers.mjs"

const prUrl = process.env.LOCAL_DIFFE_PR_URL || "https://github.com/hydra-db/hydradb-application/pull/1102"
const { browser, page } = await openApp()
try {
  await page.fill('[data-testid="pr-url"]', prUrl)
  await page.click('[data-testid="open-pr-url"]')
  await pause(12_000)
  const fileIndex = await page.evaluate(() => {
    const files = [...document.querySelectorAll("[data-file-index]")]
    const goFile = files.find((element) => element.textContent?.trim().endsWith(".go"))
    return (goFile ?? files[0])?.getAttribute("data-file-index")
  })
  if (!fileIndex) throw new Error("No file nodes appeared after opening the PR.")
  await page.click(`[data-file-index="${fileIndex}"]`)
  await pause(1_800)
  await page.screenshot({ path: path.join(screenshotDir, "05-github-pr.png"), fullPage: true })
  await page.click('[data-testid="hide-chrome"]')
  await pause(300)
  await page.screenshot({ path: path.join(screenshotDir, "06-focus-view.png"), fullPage: true })
  console.log(JSON.stringify({ appUrl, prUrl, fileIndex, screenshots: [path.join(screenshotDir, "05-github-pr.png"), path.join(screenshotDir, "06-focus-view.png")] }, null, 2))
} finally {
  await browser.close()
}
