export type DiffRow = { kind: "meta" | "hunk" | "add" | "remove" | "context"; text: string; old?: number; next?: number }
export type ParsedDiff = { rows: DiffRow[]; width: number; truncated: boolean; limited: boolean }

// Bound DOM/text layout work even for minified or generated single-line files.
export const MAX_LINE_CHARS = 2000
export const MAX_ROWS = 200_000
export function parseDiff(patch: string): ParsedDiff {
  const rows: DiffRow[] = []
  let old = 0, next = 0, inHunk = false, width = 0, truncated = false
  let cursor = 0
  while (cursor < patch.length && rows.length < MAX_ROWS) {
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
    rows.push(row)
  }
  return { rows, width, truncated, limited: cursor < patch.length }
}

export const ROW_HEIGHT = 24
export function visibleRange(scrollTop: number, height: number, count: number) {
  const start = Math.max(0, Math.min(count, Math.floor(scrollTop / ROW_HEIGHT) - 12))
  return { start, end: Math.min(count, Math.ceil((scrollTop + height) / ROW_HEIGHT) + 12) }
}
