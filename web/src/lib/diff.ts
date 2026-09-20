export type DiffRow = { kind: "meta" | "hunk" | "add" | "remove" | "context"; text: string; old?: number; next?: number }
export type ParsedDiff = { rows: DiffRow[]; width: number; truncated: boolean; limited: boolean }
export type DiffBatch = { rows: DiffRow[]; width: number; truncated: boolean }

// Bound DOM/text layout work even for minified or generated single-line files.
export const MAX_LINE_CHARS = 2000
export const MAX_ROWS = 200_000
export const DIFF_BATCH_SIZE = 1024

/**
 * Parse a patch. When a callback is supplied, rows are emitted in bounded
 * batches and are not retained by the parser. This is used by the worker so
 * parsing a 200k-row patch does not create a second full row array before the
 * first rows can be displayed.
 */
function parseDiffInternal(patch: string, onBatch?: (batch: DiffBatch) => void): ParsedDiff {
  const rows: DiffRow[] | undefined = onBatch ? undefined : []
  let batch: DiffRow[] = []
  let old = 0, next = 0, inHunk = false, width = 0, truncated = false
  let cursor = 0, rowCount = 0

  const push = (row: DiffRow) => {
    if (onBatch) {
      batch.push(row)
      if (batch.length >= DIFF_BATCH_SIZE) {
        onBatch({ rows: batch, width, truncated })
        batch = []
      }
    } else {
      rows!.push(row)
    }
    rowCount++
  }

  while (cursor < patch.length && rowCount < MAX_ROWS) {
    const end = patch.indexOf("\n", cursor)
    const line = patch.slice(cursor, end < 0 ? patch.length : end)
    cursor = end < 0 ? patch.length : end + 1
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
    let row: DiffRow
    if (hunk) {
      old = Number(hunk[1]); next = Number(hunk[2]); inHunk = true
      row = { kind: "hunk", text: line }
    } else if (inHunk && line.startsWith("+")) {
      row = { kind: "add", text: line.slice(1), next: next++ }
    } else if (inHunk && line.startsWith("-")) {
      row = { kind: "remove", text: line.slice(1), old: old++ }
    } else if (inHunk && line.startsWith(" ")) {
      row = { kind: "context", text: line.slice(1), old: old++, next: next++ }
    } else {
      if (line.startsWith("diff --git ")) inHunk = false
      if (!line) continue
      row = { kind: "meta", text: line }
    }
    if (row.text.length > MAX_LINE_CHARS) {
      row.text = row.text.slice(0, MAX_LINE_CHARS) + " … [line truncated]"
      truncated = true
    }
    width = Math.max(width, row.text.replace(/\t/g, "    ").length)
    push(row)
  }
  if (onBatch && batch.length) onBatch({ rows: batch, width, truncated })
  return { rows: rows ?? [], width, truncated, limited: cursor < patch.length }
}

export function parseDiff(patch: string): ParsedDiff {
  return parseDiffInternal(patch)
}

export function parseDiffBatches(patch: string, onBatch: (batch: DiffBatch) => void): ParsedDiff {
  return parseDiffInternal(patch, onBatch)
}

export const ROW_HEIGHT = 24
export function visibleRange(scrollTop: number, height: number, count: number) {
  const start = Math.max(0, Math.min(count, Math.floor(scrollTop / ROW_HEIGHT) - 12))
  return { start, end: Math.min(count, Math.ceil((scrollTop + height) / ROW_HEIGHT) + 12) }
}
