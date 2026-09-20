import type { SemanticPatch } from "./semantic-highlight"

type SemanticViewerState = { patch: SemanticPatch; [key: string]: unknown }
type HighlightInput = { old: string; new: string; oldPath: string; newPath: string }
type HighlightWindow = Window & {
  initialState?: SemanticViewerState
  initialHighlightInput?: HighlightInput
}

const viewerWindow = window as HighlightWindow
const state = viewerWindow.initialState
const input = viewerWindow.initialHighlightInput

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
    worker = new Worker(new URL("./semantic-highlight.worker.ts", import.meta.url), { type: "module" })
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
    if (event.source !== window.parent || event.origin !== origin || event.data?.type !== "SetState") return
    requestAnimationFrame(() => requestAnimationFrame(() => finish("complete")))
  }
  const timeout = window.setTimeout(() => finish("failed"), 20_000)
  window.addEventListener("message", onState)
  window.addEventListener("pagehide", onHide, { once: true })
  worker.onmessage = (event: MessageEvent<{ id: number; patch?: SemanticPatch; error?: string }>) => {
    if (finished || event.data.id !== 1) return
    worker.terminate()
    if (!event.data.patch || event.data.error) { finish("failed"); return }
    // The viewer accepts SetState only from its parent; the React host checks
    // both origin and the currently mounted frame before forwarding it.
    window.parent.postMessage({ source: "semanticdiff-highlight", message: {
      type: "SetState", state: { ...state, patch: event.data.patch },
    } }, origin)
  }
  worker.onerror = event => {
    document.documentElement.dataset.highlightError = event.message || "Syntax worker failed to load"
    event.preventDefault(); finish("failed")
  }
  worker.postMessage({ id: 1, patch: state.patch, input })
}

startHighlighting()
