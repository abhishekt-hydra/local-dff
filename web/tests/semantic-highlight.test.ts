import assert from "node:assert/strict"
import { test } from "node:test"
import {
  decorateSemanticPatch,
  type SemanticLine,
  type SemanticPatch,
  type SemanticToken,
} from "../src/semantic-highlight.ts"

test("lazy TypeScript grammar preserves native tokens and maps emoji to Unicode scalar offsets", async () => {
  const content = 'const emoji = "😀" // note'
  const native: SemanticToken = { start: 100, end: 101, foreground: "#native", priority: 7 }
  const line: SemanticLine = { line: 1, content, tokens: [native] }
  const patch: SemanticPatch = { type: "code", blocks: [{ new_column: [line] }] }

  await decorateSemanticPatch(patch, {
    old: "",
    new: content,
    oldPath: "empty.ts",
    newPath: "emoji.ts",
  })

  assert.equal(line.tokens?.[0], native)
  assert.ok(
    line.tokens.some(
      (token) => token.foreground === "#A5D6FF" && token.start === 14 && token.end === 17,
    ),
  )
  assert.ok(
    line.tokens.some(
      (token) => token.foreground === "#8B949E" && token.start === 18 && token.end === 25,
    ),
  )
  assert.ok(line.tokens.slice(1).every((token) => token.background === undefined))
})

test("lazy Go grammar decorates the correct source lines in both columns", async () => {
  const old: SemanticLine = { line: 2, content: "func old() { // note" }
  const added: SemanticLine = { line: 2, content: "func new() { // 😀 note" }
  const patch: SemanticPatch = {
    type: "code",
    blocks: [{ old_column: [old], new_column: [added] }],
  }

  await decorateSemanticPatch(patch, {
    old: `package main\n${old.content}`,
    new: `package main\n${added.content}`,
    oldPath: "old.go",
    newPath: "new.go",
  })

  for (const line of [old, added]) {
    assert.ok(
      line.tokens?.some(
        (token) => token.foreground === "#FF7B72" && token.start === 0 && token.end === 4,
      ),
    )
  }
  assert.ok(
    added.tokens?.some(
      (token) => token.foreground === "#8B949E" && token.start === 13 && token.end === 22,
    ),
  )
})

test("concurrent old/new lazy TSX grammar loading includes embedded language registrations", async () => {
  const content = "const view = <div>{42}</div>"
  const old: SemanticLine = { line: 1, content }
  const added: SemanticLine = { line: 1, content }
  const patch: SemanticPatch = {
    type: "code",
    blocks: [{ old_column: [old], new_column: [added] }],
  }

  await decorateSemanticPatch(patch, {
    old: content,
    new: content,
    oldPath: "old.tsx",
    newPath: "new.tsx",
  })

  assert.ok(old.tokens?.length)
  assert.deepEqual(old.tokens, added.tokens)
})

test("unsupported extensions and non-code patches retain native change tokens unchanged", async () => {
  const native = { start: 0, end: 4, background: "#native", priority: 7 }
  for (const [type, path] of [
    ["code", "file.unsupported"],
    ["error", "file.ts"],
  ]) {
    const line: SemanticLine = { line: 1, content: "text", tokens: [native] }
    const patch: SemanticPatch = { type, blocks: [{ new_column: [line] }] }
    const before = structuredClone(patch)
    await decorateSemanticPatch(patch, { old: "", new: "text", oldPath: path, newPath: path })
    assert.deepEqual(patch, before)
    assert.equal(line.tokens?.[0], native)
  }
})

test("empty source and missing columns remain renderable", async () => {
  const patch: SemanticPatch = {
    type: "code",
    blocks: [{}, { new_column: [{ line: 1, content: "" }] }],
  }
  const before = structuredClone(patch)
  await decorateSemanticPatch(patch, { old: "", new: "", oldPath: "old.ts", newPath: "new.ts" })
  assert.deepEqual(patch, before)
})

test("highlight worker relay retains the complete initial state and upstream-added view state", async () => {
  const patch: SemanticPatch = {
    type: "code",
    blocks: [{ new_column: [{ line: 1, content: "const n = 1" }] }],
  }
  const state = {
    input: { original: "file:///old.ts", modified: "file:///new.ts" },
    oldBreadcrumbs: ["old.ts"],
    breadcrumbs: ["new.ts"],
    title: "new.ts",
    options: { contextLines: 3, hideComments: false, compareMovedCode: true },
    threads: [],
    viewerCanAddThread: false,
    patch,
    remoteIsGitHubSSH: false,
    suggestGitHubApp: false,
    minimapMode: "detailed",
    keepSelectionOnBlur: true,
    // The upstream renderer adds view state before the highlighting module runs.
    visibleHunks: [{ block: 0 }],
    scrollProgress: 0.25,
    showErrorTokens: true,
  }
  const input = { old: "", new: "const n = 1", oldPath: "old.ts", newPath: "new.ts" }
  type HighlightRequest = { id: number; patch: SemanticPatch; input: typeof input }
  type WorkerMessage = { data: { id: number; patch?: SemanticPatch; error?: string } }
  type WorkerError = { message: string; preventDefault: () => void }
  type ParentMessage =
    | { source: "semanticdiff-highlight"; message: { type: "SetState"; state: typeof state } }
    | { source: "local-diffe-semantic-highlight"; status: "complete" | "failed" }
  type MockParent = { postMessage(message: ParentMessage, origin: string): void }
  type ParentStateEvent = { source: MockParent | null; origin: string; data: { type: "SetState" } }
  type HighlightDataset = {
    highlightStatus?: "skipped" | "running" | "complete" | "failed"
    highlightError?: string
  }
  const requests: HighlightRequest[] = []
  const forwarded: { message: ParentMessage; origin: string }[] = []
  const listeners = new Map<string, (event: ParentStateEvent) => void>()
  const dataset: HighlightDataset = {}
  const workers: MockWorker[] = []
  let timeout: ReturnType<typeof setTimeout> | undefined
  class MockWorker {
    onmessage?: (event: WorkerMessage) => void
    onerror?: (event: WorkerError) => void
    terminated = false
    constructor() {
      workers.push(this)
    }
    postMessage(message: HighlightRequest) {
      requests.push(message)
    }
    terminate() {
      this.terminated = true
    }
  }
  const parent: MockParent = {
    postMessage(message, origin) {
      forwarded.push({ message, origin })
    },
  }
  const globals = {
    window: {
      initialState: state,
      initialHighlightInput: input,
      parent,
      addEventListener(type: string, callback: (event: ParentStateEvent) => void) {
        listeners.set(type, callback)
      },
      removeEventListener(type: string) {
        listeners.delete(type)
      },
      setTimeout(callback: () => void, delay: number) {
        timeout = setTimeout(callback, delay)
        return timeout
      },
    },
    document: {
      baseURI: "http://localhost:3333/semanticdiff-assets/",
      documentElement: { dataset },
    },
    Worker: MockWorker,
    requestAnimationFrame(callback: () => void) {
      callback()
      return 1
    },
  }
  const descriptors = Object.keys(globals).map(
    (name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const,
  )
  try {
    for (const [name, value] of Object.entries(globals))
      Object.defineProperty(globalThis, name, { configurable: true, value })
    await import("../src/semantic-viewer.ts")
    assert.equal(dataset.highlightStatus, "running")
    assert.deepEqual(requests, [{ id: 1, patch, input }])
    const worker = workers[0]
    assert.ok(worker)
    worker.onmessage?.({ data: { id: 2, patch } })
    assert.equal(forwarded.length, 0)
    const highlighted: SemanticPatch = {
      ...patch,
      blocks: [
        {
          new_column: [
            {
              line: 1,
              content: "const n = 1",
              tokens: [{ start: 0, end: 5, foreground: "#FF7B72" }],
            },
          ],
        },
      ],
    }
    worker.onmessage?.({ data: { id: 1, patch: highlighted } })
    assert.deepEqual(forwarded, [
      {
        message: {
          source: "semanticdiff-highlight",
          message: { type: "SetState", state: { ...state, patch: highlighted } },
        },
        origin: "http://localhost:3333",
      },
    ])
    assert.equal(state.patch, patch)
    const onState = listeners.get("message")
    assert.ok(onState)
    onState({ source: null, origin: "http://localhost:3333", data: { type: "SetState" } })
    onState({ source: parent, origin: "https://evil.example", data: { type: "SetState" } })
    assert.equal(dataset.highlightStatus, "running")
    onState({ source: parent, origin: "http://localhost:3333", data: { type: "SetState" } })
    assert.equal(dataset.highlightStatus, "complete")
    assert.equal(worker.terminated, true)
    assert.equal(listeners.size, 0)
  } finally {
    if (timeout) clearTimeout(timeout)
    for (const [name, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor)
      else Reflect.deleteProperty(globalThis, name)
    }
  }
})
