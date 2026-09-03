import { generateDiff, openApp, pause } from "./helpers.mjs"

const { browser, page } = await openApp()
try {
  await generateDiff(page)
  const firstFileIndex = await page.evaluate(() => document.querySelector("[data-file-index]")?.getAttribute("data-file-index"))
  if (!firstFileIndex) throw new Error("No file nodes appeared after generating the diff.")
  await page.click(`[data-file-index="${firstFileIndex}"]`)
  await pause(1800)
  const report = await page.evaluate(() => {
    const iframe = document.querySelector("iframe")
    const frameDocument = iframe?.contentDocument
    const body = frameDocument?.body
    const patch = frameDocument?.querySelector(".patch")
    return {
      hostBackground: getComputedStyle(document.body).backgroundColor,
      iframeLoaded: Boolean(frameDocument?.querySelector(".viewer")),
      semanticBackground: body ? getComputedStyle(body).backgroundColor : null,
      semanticForeground: body ? getComputedStyle(body).color : null,
      patchForeground: patch ? getComputedStyle(patch).color : null,
      visibleText: (patch?.textContent || "").trim().slice(0, 120),
      patchDisplay: patch ? getComputedStyle(patch).display : null,
      scripts: [...(frameDocument?.scripts ?? [])].map((script) => ({ src: script.src, type: script.type, text: script.textContent?.slice(0, 100) })),
      hasViewerState: Boolean(iframe?.contentWindow?.initialState),
    }
  })
  console.log(JSON.stringify(report, null, 2))
} finally {
  await browser.close()
}
