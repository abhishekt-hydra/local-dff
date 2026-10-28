import type { SemanticPatch } from "./semantic-highlight"

// Owned by semanticdiff_view in src/main.rs and injected before this module.
// Keep the complete initial contract: SetState replaces the upstream state.
type SemanticViewerState = {
  input: { original: string; modified: string }
  oldBreadcrumbs: string[]
  breadcrumbs: string[]
  title: string
  options: { contextLines: number; hideComments: boolean; compareMovedCode: boolean }
  threads: []
  viewerCanAddThread: boolean
  patch: SemanticPatch
  remoteIsGitHubSSH: boolean
  suggestGitHubApp: boolean
  minimapMode: "detailed"
  keepSelectionOnBlur: boolean
}
type HighlightInput = { old: string; new: string; oldPath: string; newPath: string }

declare global {
  interface Window {
    initialState?: SemanticViewerState
    initialHighlightInput?: HighlightInput
  }
}

const state = window.initialState
const input = window.initialHighlightInput

// Syntax coloring runs independently of the initial upstream render.
function startHighlighting() {
  if (!state?.patch || !input || !state.patch.blocks?.length) {
    document.documentElement.dataset.highlightStatus = "skipped"
    return
  }
  const origin = new URL(document.baseURI).origin
  document.documentElement.dataset.highlightStatus = "running"
  let worker: Worker
  try {
    worker = new Worker(new URL("./semantic-highlight.worker.ts", import.meta.url), {
      type: "module",
    })
  } catch (error) {
    document.documentElement.dataset.highlightError = String(error)
    document.documentElement.dataset.highlightStatus = "failed"
    return
  }
  let finished = false
  const finish = (status: "complete" | "failed") => {
    if (finished) return
    finished = true
    clearTimeout(timeout)
    worker.terminate()
    window.removeEventListener("message", onState)
    window.removeEventListener("pagehide", onHide)
    document.documentElement.dataset.highlightStatus = status
    window.parent.postMessage({ source: "local-diffe-semantic-highlight", status }, origin)
  }
  const onHide = () => finish("failed")
  // The upstream listener runs before this listener. Wait for two animation
  // frames after its parent-authorized state update before reporting completion.
  const onState = (event: MessageEvent) => {
    if (
      event.source !== window.parent ||
      event.origin !== origin ||
      event.data?.type !== "SetState"
    )
      return
    requestAnimationFrame(() => requestAnimationFrame(() => finish("complete")))
  }
  const timeout = window.setTimeout(() => finish("failed"), 20_000)
  window.addEventListener("message", onState)
  window.addEventListener("pagehide", onHide, { once: true })
  worker.onmessage = (
    event: MessageEvent<{ id: number; patch?: SemanticPatch; error?: string }>,
  ) => {
    if (finished || event.data.id !== 1) return
    worker.terminate()
    if (!event.data.patch || event.data.error) {
      finish("failed")
      return
    }
    // The viewer accepts SetState only from its parent; the React host checks
    // both origin and the currently mounted frame before forwarding it.
    // Spread the original object, retaining upstream-added fields such as
    // visibleHunks and scrollProgress as well as the backend-owned contract.
    window.parent.postMessage(
      {
        source: "semanticdiff-highlight",
        message: {
          type: "SetState",
          state: { ...state, patch: event.data.patch },
        },
      },
      origin,
    )
  }
  worker.onerror = (event) => {
    document.documentElement.dataset.highlightError =
      event.message || "Syntax worker failed to load"
    event.preventDefault()
    finish("failed")
  }
  worker.postMessage({ id: 1, patch: state.patch, input })
}

startHighlighting()
