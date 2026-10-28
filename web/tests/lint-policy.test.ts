import assert from "node:assert/strict"
import { test } from "node:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("../", import.meta.url))
const executable = fileURLToPath(new URL("../node_modules/oxlint/bin/oxlint", import.meta.url))
const config = fileURLToPath(new URL("../.oxlintrc.json", import.meta.url))

function lint(path: string) {
  const result = spawnSync(
    process.execPath,
    [
      executable,
      "--config",
      config,
      "--format",
      "json",
      "--deny-warnings",
      "--report-unused-disable-directives",
      path,
    ],
    { cwd: root, encoding: "utf8" },
  )
  assert.ifError(result.error)
  assert.equal(result.signal, null, result.stderr)
  return result
}

test("real Oxlint invocation loads vendored anti-slop and React/type rules", async () => {
  const directory = await mkdtemp(join(tmpdir(), "local-diffe-lint-"))
  try {
    const invalid = join(directory, "invalid.tsx")
    await writeFile(
      invalid,
      `
import { useState } from "react"
export function invalidHook(condition: boolean) {
  if (condition) useState(0)
}
export const unsafe = (value: string) => value as unknown as number
export const copied = [1, 2].reduce((acc, item) => acc.concat(item), [])
export type Untyped = any
`,
    )
    const result = lint(invalid)
    assert.equal(result.status, 1, result.stdout + result.stderr)
    for (const rule of [
      "anti-slop(no-chained-type-assertions)",
      "anti-slop(no-reduce-accumulator-copy)",
      "anti-slop(require-safety-comment-for-type-assertion)",
      "react-hooks(rules-of-hooks)",
      "typescript(no-explicit-any)",
    ]) {
      assert.ok(result.stdout.includes(rule), `Missing ${rule}: ${result.stdout} ${result.stderr}`)
    }
    const valid = join(directory, "valid.ts")
    await writeFile(
      valid,
      `
export function readKey(value: unknown): string | null {
  return typeof value === "string" ? value : null
}
export const flags = (enabled: boolean) => ({ name: "fixture", ...(enabled ? { enabled } : {}) })
export const names = ["a", ""].filter(Boolean).map(name => name.toUpperCase())
export const defaults = { mode: "text" } as const
`,
    )
    const accepted = lint(valid)
    assert.equal(accepted.status, 0, accepted.stdout + accepted.stderr)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
