// postMessage is an I/O boundary: a matching source tag alone is not a type contract.
export type ViewerKey = {
  key: string
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
}

// The bridge inside the SemanticDiff iframe forwards keys the parent window
// cannot see. Modifier state must travel with the key: without it, Ctrl/Cmd+K
// inside the diff arrives as a bare "k" and is misread as scroll-up instead
// of the command-palette chord. Modifiers are optional for plain keys but
// must be booleans when present.
export function readViewerKey(data: unknown): ViewerKey | null {
  if (
    typeof data !== "object" ||
    data === null ||
    !("source" in data) ||
    data.source !== "local-diffe-keyboard" ||
    !("key" in data) ||
    typeof data.key !== "string"
  )
    return null
  let ctrlKey = false
  if ("ctrlKey" in data) {
    if (typeof data.ctrlKey !== "boolean") return null
    ctrlKey = data.ctrlKey
  }
  let metaKey = false
  if ("metaKey" in data) {
    if (typeof data.metaKey !== "boolean") return null
    metaKey = data.metaKey
  }
  let altKey = false
  if ("altKey" in data) {
    if (typeof data.altKey !== "boolean") return null
    altKey = data.altKey
  }
  return { key: data.key, ctrlKey, metaKey, altKey }
}
