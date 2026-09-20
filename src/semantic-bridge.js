// A loaded iframe is not necessarily a rendered diff. Report actual readiness
// and renderer failures to the parent, which validates source and origin.
(() => {
  let finished = false
  const report = (message) => {
    if (finished) return
    finished = true
    observer.disconnect()
    // srcdoc has an about: URL; its location.origin is not the inherited origin.
    window.parent.postMessage({ source: "local-diffe-viewer", ...message }, new URL(document.baseURI).origin)
  }
  const check = () => {
    const error = document.getElementById("errorNotification")
    if (error && getComputedStyle(error).display !== "none") {
      report({ error: error.querySelector(".text")?.textContent || "Semantic rendering failed. Use Text diff." })
      return
    }
    const patch = document.getElementById("patch")
    if (patch && getComputedStyle(patch).display !== "none") report({ ready: true })
  }
  const observer = new MutationObserver(check)
  observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["style", "class"] })
  window.addEventListener("error", () => report({ error: "The semantic viewer failed to load. Use Text diff or retry." }), true)
  window.addEventListener("unhandledrejection", () => report({ error: "The semantic viewer failed. Use Text diff or retry." }))
  check()
})()
