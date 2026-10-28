// postMessage is an I/O boundary: a matching source tag alone is not a type contract.
export function readViewerKey(data: unknown): string | null {
  if (
    typeof data !== "object" ||
    data === null ||
    !("source" in data) ||
    data.source !== "local-diffe-keyboard" ||
    !("key" in data) ||
    typeof data.key !== "string"
  )
    return null
  return data.key
}
