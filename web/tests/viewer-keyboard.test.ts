import assert from "node:assert/strict"
import { test } from "node:test"
import { readViewerKey } from "../src/lib/viewer-keyboard.ts"

test("reads keyboard commands only from correctly typed bridge payloads", () => {
  assert.equal(readViewerKey({ source: "local-diffe-keyboard", key: "Escape" }), "Escape")
  for (const data of [
    null,
    undefined,
    true,
    "-",
    [],
    {},
    { source: "other", key: "-" },
    { source: "local-diffe-keyboard" },
    { source: "local-diffe-keyboard", key: 1 },
    { source: "local-diffe-keyboard", key: {} },
  ]) {
    assert.equal(readViewerKey(data), null)
  }
})
