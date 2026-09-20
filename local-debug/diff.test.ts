import assert from "node:assert/strict"
import { test } from "node:test"
import { parseDiff, visibleRange, MAX_ROWS, MAX_LINE_CHARS } from "../web/src/lib/diff.ts"

test("hunks preserve old/new numbers, header-like content, and missing newline markers", () => {
  const { rows } = parseDiff("diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -9,2 +20,2 @@\n context\n---removed\n+++added\n\\ No newline at end of file\n@@ -30,0 +40 @@\n+last\n")
  assert.deepEqual(rows.filter(r => r.kind === "remove"), [{ kind: "remove", text: "--removed", old: 10 }])
  assert.deepEqual(rows.filter(r => r.kind === "add"), [{ kind: "add", text: "++added", next: 21 }, { kind: "add", text: "last", next: 40 }])
  assert.equal(rows.at(-2)?.kind, "hunk")
})

test("new-file and deleted-file hunks use the correct side", () => {
  const { rows } = parseDiff("@@ -0,0 +1,2 @@\n+one\n+two\ndiff --git a/y b/y\n--- a/y\n+++ /dev/null\n@@ -1 +0,0 @@\n-gone\n")
  assert.equal(rows.find(r => r.text === "two")?.next, 2)
  assert.equal(rows.find(r => r.text === "gone")?.old, 1)
  assert.equal(rows.find(r => r.text === "--- a/y")?.kind, "meta")
})

test("100,000 rows keep a bounded viewport and the last line is reachable", () => {
  const { rows } = parseDiff("@@ -0,0 +1,100000 @@\n" + "+hello\n".repeat(100000))
  assert.equal(rows.length, 100001)
  const range = visibleRange(rows.length * 24 - 600, 600, rows.length)
  assert.equal(range.end, rows.length)
  assert.ok(range.end - range.start <= 50)
  assert.equal(rows.at(-1)?.next, 100000)
})

test("pathological line and row counts are explicitly limited", () => {
  const long = parseDiff("@@ -0,0 +1 @@\n+" + "x".repeat(100000))
  assert.equal(long.truncated, true)
  assert.ok(long.rows[1].text.length < MAX_LINE_CHARS + 30)
  const many = parseDiff("+x\n".repeat(MAX_ROWS + 1))
  assert.equal(many.rows.length, MAX_ROWS)
  assert.equal(many.limited, true)
})
