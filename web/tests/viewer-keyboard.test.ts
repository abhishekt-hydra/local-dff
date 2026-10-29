import assert from "node:assert/strict"
import { test } from "node:test"
import { readViewerKey } from "../src/lib/viewer-keyboard.ts"
import { readFileSync } from "node:fs"
import { runInNewContext } from "node:vm"

test("viewer readiness preserves a rendered fallback and reports errors without one", () => {
  const source = readFileSync(new URL("../../src/semantic-bridge.js", import.meta.url), "utf8")
  for (const fallback of [true, false]) {
    const messages: unknown[] = []
    runInNewContext(source, {
      window: {
        initialState: { patch: { fallback } },
        parent: { postMessage: (message: unknown) => messages.push(message) },
        addEventListener() {},
      },
      document: {
        baseURI: "http://localhost:3333/semanticdiff-assets/",
        body: {},
        getElementById: (id: string) => ({
          id,
          querySelector: () => ({ textContent: "YAML could not be parsed" }),
        }),
      },
      getComputedStyle: () => ({ display: "block" }),
      MutationObserver: class {
        observe() {}
        disconnect() {}
      },
      URL,
    })
    assert.deepEqual(JSON.parse(JSON.stringify(messages)), [
      fallback
        ? { source: "local-diffe-viewer", ready: true }
        : { source: "local-diffe-viewer", error: "YAML could not be parsed" },
    ])
  }
})

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
