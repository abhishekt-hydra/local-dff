import assert from "node:assert/strict"
import { test } from "node:test"
import { readApiResponse, sessionSchema, pullsSchema } from "../src/lib/review-api.ts"

const file = { old_path: null, new_path: "main.go", display_path: "main.go", renderable: true }
const session = { id: "review", files: [file] }

test("validates patch-only sessions without requiring comparison metadata", async () => {
  assert.deepEqual(await readApiResponse(Response.json(session), sessionSchema), session)
  assert.deepEqual(pullsSchema.parse([]), [])
})

test("rejects malformed sessions and nested data before it reaches React", () => {
  for (const body of [
    null,
    {},
    { files: [] },
    { ...session, files: null },
    { ...session, files: [{ ...file, renderable: "yes" }] },
    { ...session, commits: [{ sha: "abc" }] },
    { ...session, stack: { mode: "invalid" } },
  ]) {
    assert.equal(sessionSchema.safeParse(body).success, false)
  }
})

test("accepts serialized comparison, commit, and stack contracts", () => {
  const pull = {
    number: 1,
    title: "Review",
    url: "https://github.com/owner/repo/pull/1",
    state: "OPEN",
    baseRefName: "main",
    headRefName: "feature",
    isDraft: false,
    author: null,
    updatedAt: "2026-10-01",
  }
  const commit = {
    sha: "a",
    short: "a",
    parents: [],
    author: "A",
    date: "2026-10-01",
    subject: "Change",
    files_changed: 1,
  }
  const body = {
    ...session,
    comparison: {
      base: { revision: "main", commit: "a" },
      target: { revision: "HEAD", commit: "b" },
      changed_paths: 1,
      semantic_paths: 1,
      description: "Review",
      pull_request: pull,
    },
    commits: [commit],
    commits_truncated: false,
    stack: { trunk: "main", current: 1, mode: "pr", members: [{ pull, parent: null, depth: 0 }] },
  }
  assert.deepEqual(sessionSchema.parse(body), body)
  assert.deepEqual(pullsSchema.parse([pull]), [pull])
})

test("reports invalid successful JSON and non-JSON responses as actionable errors", async () => {
  await assert.rejects(readApiResponse(Response.json({ id: 1 }), sessionSchema), /invalid response/)
  await assert.rejects(readApiResponse(new Response("not JSON"), sessionSchema), /invalid response/)
})

test("preserves server errors and handles non-JSON HTTP failures", async () => {
  await assert.rejects(
    readApiResponse(Response.json({ error: "GitHub unavailable" }, { status: 502 }), sessionSchema),
    /GitHub unavailable/,
  )
  await assert.rejects(
    readApiResponse(new Response("upstream failed", { status: 502 }), sessionSchema),
    /Request failed \(502\)/,
  )
})
