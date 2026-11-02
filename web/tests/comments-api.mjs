// Tests the packaged server and real SQLite. PATH contains a fixture gh command;
// publication cannot reach GitHub or use the developer's GitHub credentials.
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { resolve, join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { setTimeout as delay } from "node:timers/promises"

const binary = resolve(import.meta.dirname, "../../dist/local-diffe-darwin-arm64")
const root = await mkdtemp(join(tmpdir(), "local-diffe-comments-"))
const data = join(root, "data")
const bin = join(root, "bin")
const receipt = join(root, "receipt.json")
const prUrl = "https://github.com/fixture/local-diffe/pull/7"
let child
let base
let diagnostics = ""
async function start() {
  const reservation = createServer()
  reservation.listen(0, "127.0.0.1")
  await once(reservation, "listening")
  const port = reservation.address().port
  await new Promise((resolve) => reservation.close(resolve))
  base = `http://127.0.0.1:${port}`
  child = spawn(
    binary,
    ["--listen", `127.0.0.1:${port}`, "--data-dir", data, "--cache-dir", join(root, "cache")],
    {
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        LOCAL_DIFFE_TEST_RECEIPT: receipt,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  )
  child.stdout.on("data", (chunk) => {
    diagnostics += chunk
  })
  child.stderr.on("data", (chunk) => {
    diagnostics += chunk
  })
  for (let attempt = 0; attempt < 250; attempt++) {
    if (child.exitCode !== null) throw new Error(diagnostics)
    if (
      await fetch(base)
        .then((response) => response.ok)
        .catch(() => false)
    )
      return
    await delay(20)
  }
  throw new Error(`Server did not start: ${diagnostics}`)
}
async function stop() {
  if (child && child.exitCode === null) {
    const exit = once(child, "exit")
    child.kill("SIGTERM")
    await exit
  }
  child = undefined
}
async function api(action, payload, expected = 200) {
  const response = await fetch(`${base}/api/comments/${action}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pr_url: prUrl, ...payload }),
  })
  const result = await response.json()
  assert.equal(response.status, expected, JSON.stringify(result))
  return result
}
try {
  await mkdir(bin)
  await writeFile(
    join(bin, "gh"),
    `#!/usr/bin/env node
const fs = require("node:fs");
if (process.argv[2] !== "api" || !process.argv.includes("POST")) process.exit(2);
const body = JSON.parse(fs.readFileSync(0, "utf8"));
fs.writeFileSync(process.env.LOCAL_DIFFE_TEST_RECEIPT, JSON.stringify({args:process.argv.slice(2),body}));
process.stdout.write(JSON.stringify({html_url:"${prUrl}#issuecomment-1"}));
`,
    { mode: 0o700 },
  )
  await start()
  assert.deepEqual(await api("list", {}), [])
  let [draft] = await api("save", {
    body: "Stored locally\n**Markdown**",
    location: { kind: "general" },
  })
  assert.equal(draft.state, "draft")
  assert.equal(
    await readFile(receipt)
      .then(() => true)
      .catch(() => false),
    false,
  )
  await stop()
  const db = new DatabaseSync(join(data, "comments.sqlite3"), { readOnly: true })
  assert.deepEqual(
    { ...db.prepare("SELECT pr_url, body, state FROM comments").get() },
    { pr_url: prUrl, body: "Stored locally\n**Markdown**", state: "draft" },
  )
  db.close()
  await start()
  assert.equal((await api("list", {}))[0].id, draft.id)
  assert.deepEqual(
    await api("list", { pr_url: "https://github.com/fixture/local-diffe/pull/8" }),
    [],
  )
  ;[draft] = await api("save", {
    id: draft.id,
    version: draft.version,
    body: "Edited draft",
    location: { kind: "keep" },
  })
  await api("publish", { id: draft.id, version: 1 }, 409)
  const [posted] = await api("publish", { id: draft.id, version: draft.version })
  assert.equal(posted.remote_url, `${prUrl}#issuecomment-1`)
  const sent = JSON.parse(await readFile(receipt, "utf8"))
  assert.deepEqual(sent.args, [
    "api",
    "--hostname",
    "github.com",
    "repos/fixture/local-diffe/issues/7/comments",
    "--method",
    "POST",
    "--input",
    "-",
  ])
  assert.equal(sent.body.body, `Edited draft\n\n<!-- local-diffe:${draft.id} -->`)
  await api("publish", { id: draft.id, version: draft.version })
  await stop()
  await start()
  assert.equal((await api("list", {}))[0].remote_url, posted.remote_url)
  console.log(
    "Packaged comments API passed: real SQLite readback, restart retention, PR isolation, version conflicts, explicit gh payload and durable receipt. No GitHub requests.",
  )
} finally {
  await stop()
  await rm(root, { recursive: true, force: true })
}
