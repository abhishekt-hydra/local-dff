import assert from "node:assert/strict"
import { test } from "node:test"
import type { PatchFile, Session } from "../src/lib/review-api.ts"
import {
  EVIDENCE_LIMIT,
  EVIDENCE_BYTE_LIMIT,
  laterUnreviewedCount,
  boundedEvidence,
  canonicalReviewRepository,
  evidenceFor,
  evidenceIdentity,
  parseEvidence,
  reviewEvidenceContext,
  type EvidenceContext,
  type ReviewEvidence,
} from "../src/lib/review-evidence.ts"

const file: PatchFile = {
  old_path: "a.go",
  new_path: "a.go",
  display_path: "a.go",
  renderable: true,
}
const context: EvidenceContext = {
  repository: "https://github.com/o/r",
  pr: 1,
  scope: "pr",
  tip: null,
  base: "base",
  target: "target",
}
const record: ReviewEvidence = {
  context,
  old_path: file.old_path,
  new_path: file.new_path,
  path: file.display_path,
  reviewed_at: 1,
  snapshot_id: "retained",
}

test("review evidence isolates repositories, comparison commits, scopes, tips and paths", () => {
  assert.ok(evidenceFor(context, file, [record]).current)
  for (const change of [
    { repository: "https://github.com/other/r" },
    { pr: 2 },
    { base: "updated" },
    { target: "updated" },
    { scope: "final" as const, tip: 3 },
  ]) {
    assert.equal(evidenceFor({ ...context, ...change }, file, [record]).current, undefined)
    assert.notEqual(
      evidenceIdentity({ ...context, ...change }, file),
      evidenceIdentity(context, file),
    )
  }
  assert.equal(
    evidenceFor(
      context,
      { ...file, display_path: "other.go", old_path: "other.go", new_path: "other.go" },
      [record],
    ).current,
    undefined,
  )
})

test("base/target updates expose outdated evidence without marking current or unrelated versions reviewed", () => {
  const updated = { ...context, target: "new-head" }
  const status = evidenceFor(updated, file, [record])
  assert.equal(status.current, undefined)
  assert.equal(status.outdated?.snapshot_id, "retained")
  assert.equal(
    evidenceFor({ ...updated, repository: "another-repo" }, file, [record]).outdated,
    undefined,
  )
  assert.equal(
    evidenceFor({ ...updated, scope: "final", tip: 3 }, file, [record]).outdated,
    undefined,
  )
})

test("symbol reviews do not automatically review the file, or transfer to a changed function", () => {
  const symbol = { ...record, symbol: { key: "func:Value", hash: "old-body" } }
  assert.equal(evidenceFor(context, file, [symbol]).current, undefined)
  assert.notEqual(
    evidenceIdentity(context, file, symbol.symbol),
    evidenceIdentity(context, file, { ...symbol.symbol, hash: "new-body" }),
  )
})

test("review retention is bounded, newest wins, corrupt/legacy values do not migrate as verified evidence", () => {
  const many = Array.from({ length: EVIDENCE_LIMIT + 5 }, (_, i) => ({
    ...record,
    path: `${i}.go`,
    reviewed_at: i,
  }))
  assert.equal(boundedEvidence(many).length, EVIDENCE_LIMIT)
  assert.equal(boundedEvidence(many)[0].path, "5.go")
  assert.equal(boundedEvidence([record, { ...record, reviewed_at: 100 }])[0].reviewed_at, 100)
  assert.deepEqual(parseEvidence(JSON.stringify([record])), [record])
  for (const bad of [
    "not-json",
    '["a.go"]',
    '{"paths":[]}',
    JSON.stringify([{ ...record, context: {} }]),
  ])
    assert.deepEqual(parseEvidence(bad), [])
})

test("canonical identity comes from the backend or normalized GitHub repository, not a PR number alone", () => {
  const root: Session = {
    id: "root",
    files: [file],
    comparison: {
      base: { revision: "main", commit: "base" },
      target: { revision: "#1", commit: "target" },
      description: "",
      changed_paths: 1,
      semantic_paths: 1,
      pull_request: {
        number: 1,
        title: "",
        url: "https://github.com/Owner/Repo/pull/1",
        state: "OPEN",
        baseRefName: "main",
        headRefName: "a",
        isDraft: false,
        updatedAt: "",
      },
    },
  }
  assert.equal(canonicalReviewRepository(root), "https://github.com/owner/repo")
  assert.equal(
    canonicalReviewRepository({ ...root, repository: "/canonical/local/repo" }),
    "/canonical/local/repo",
  )
  assert.equal(reviewEvidenceContext(root, root, 3)?.scope, "final")
  assert.equal(reviewEvidenceContext(root, { ...root, id: "commit" }, null)?.scope, "commit")
  const patch: Session = { id: "patch", files: [] }
  assert.match(reviewEvidenceContext(patch, patch, null)?.repository ?? "", /^unverified-session:/)
})

test("folder later-edit rollups remain linear and do not include sibling prefixes or final evidence", () => {
  const files = Array.from({ length: 500 }, (_, i) => ({
    old_path: `src/${i % 2 ? "storehouse" : "store"}/${i}.go`,
    new_path: `src/${i % 2 ? "storehouse" : "store"}/${i}.go`,
    display_path: `src/${i % 2 ? "storehouse" : "store"}/${i}.go`,
    renderable: true,
  }))
  const members = Array.from({ length: 30 }, (_, i) => ({
    number: i + 1,
    parent: i ? i : null,
    depth: i,
    base: i ? `base-${i}` : "base",
    target: i ? `target-${i}` : "target",
    state: "ready" as const,
    files,
  }))
  const marked = files.map((file) => ({
    ...record,
    path: file.display_path,
    old_path: file.old_path,
    new_path: file.new_path,
  }))
  assert.equal(laterUnreviewedCount(context.repository, members, marked, "src/store"), 250)
  assert.equal(laterUnreviewedCount(context.repository, members, marked, "src/storehouse"), 250)
  assert.equal(
    laterUnreviewedCount(
      context.repository,
      members,
      marked.map((entry) => ({ ...entry, context: { ...entry.context, scope: "final", tip: 30 } })),
      "src/store",
    ),
    0,
  )
})

test("copies never import a source file's review and local evidence has a byte bound", () => {
  const copied = { ...file, new_path: "copy.go", display_path: "copy.go", change_kind: "copied" }
  assert.equal(
    evidenceFor({ ...context, target: "new-target" }, copied, [record]).outdated,
    undefined,
  )
  const huge = Array.from({ length: 100 }, (_, i) => ({
    ...record,
    path: `${i}-${"x".repeat(10000)}`,
  }))
  const retained = boundedEvidence(huge)
  assert.ok(JSON.stringify(retained).length * 2 <= EVIDENCE_BYTE_LIMIT + 1024)
})
