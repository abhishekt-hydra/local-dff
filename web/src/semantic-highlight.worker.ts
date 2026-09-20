import { decorateSemanticPatch, type SemanticPatch } from "./semantic-highlight"

type HighlightInput = { old: string; new: string; oldPath: string; newPath: string }
type HighlightRequest = { id: number; patch: SemanticPatch; input: HighlightInput }

self.onmessage = async (event: MessageEvent<HighlightRequest>) => {
  try {
    const { id, patch, input } = event.data
    await decorateSemanticPatch(patch, input)
    self.postMessage({ id, patch })
  } catch (error) {
    self.postMessage({ id: event.data?.id, error: error instanceof Error ? error.message : "Semantic highlighting failed." })
  }
}
