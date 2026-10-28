import assert from "node:assert/strict"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { build } from "vite"

const root = fileURLToPath(new URL("../", import.meta.url))

for (const mode of ["production", "profile"]) {
  test(`${mode} build keeps JS chunks within budget and language grammars lazy`, async () => {
    const result = await build({ root, mode, logLevel: "silent", build: { write: false } })
    assert.ok(!Array.isArray(result) && "output" in result)
    const files = result.output
    const viewer = files.find((file) => file.fileName === "assets/semantic-viewer.js")
    assert.equal(viewer?.type, "chunk", "the embedded viewer needs its stable entry filename")

    const app = files.find((file) => file.type === "chunk" && file.isEntry && file.name === "index")
    assert.ok(app?.type === "chunk")
    assert.ok(app.imports.some((name) => name.includes("react-runtime-")))

    for (const file of files) {
      if (!file.fileName.endsWith(".js")) continue
      const source = file.type === "chunk" ? file.code : file.source
      const size = typeof source === "string" ? Buffer.byteLength(source) : source.byteLength
      // Vite's unchanged default warning limit is 500 KiB, including worker assets.
      assert.ok(size <= 500 * 1024, `${file.fileName} exceeds the default budget: ${size} bytes`)
    }

    const worker = files.find((file) => file.fileName.includes("semantic-highlight.worker-"))
    assert.ok(worker?.type === "asset" && typeof worker.source === "string")
    assert.ok(/import\(["'`]\.\/cpp-/.test(worker.source), "C++ grammar must load dynamically")
    assert.ok(/import\(["'`]\.\/go-/.test(worker.source), "Go grammar must load dynamically")
    // Shared C grammar must not pull the much larger C++ macro grammar into C.
    const cGrammar = files.find((file) => file.fileName.includes("cpp-support~c~"))
    const cppSupport = files.find((file) => /cpp-support~cpp~/.test(file.fileName))
    assert.ok(
      cGrammar && cppSupport,
      "entry-aware splitting must separate shared C from C++ support",
    )
    assert.ok(!app.imports.some((name) => name.includes("cpp-support")))
  })
}
