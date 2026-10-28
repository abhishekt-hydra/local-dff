import assert from "node:assert/strict"
import { test } from "node:test"
import type { Session } from "../src/lib/review-api.ts"
import { stackReviewContext } from "../src/lib/stack-review.ts"

function review(current = 2, mode: "pr" | "cumulative" = "pr"): Session {
  return {
    id: `pr-${current}-${mode}`,
    files: [],
    comparison: {
      base: { revision: "base", commit: "a".repeat(40) },
      target: { revision: `#${current}`, commit: "b".repeat(40) },
      changed_paths: 0,
      semantic_paths: 0,
      description: "PR comparison",
    },
    stack: {
      current,
      mode,
      trunk: "staging",
      members: [1, 2].map((number, index) => ({
        parent: index ? 1 : null,
        depth: index,
        pull: {
          number,
          url: `https://github.com/owner/repo/pull/${number}`,
          title: `PR ${number}`,
          state: "OPEN",
          baseRefName: index ? "pr-1" : "staging",
          headRefName: `pr-${number}`,
          isDraft: false,
          updatedAt: "2026-10-28",
        },
      })),
    },
  }
}

test("labels PR-only comparisons against the parent or trunk", () => {
  const child = review()
  assert.deepEqual(stackReviewContext(child, child), {
    title: "Reviewing #2 against #1",
    description: "Only this PR's changes, compared with the merge-base of #1's current head.",
    range: "aaaaaaa → bbbbbbb",
  })
  const bottom = review(1)
  assert.equal(stackReviewContext(bottom, bottom)?.title, "Reviewing #1 against staging")
})

test("labels cumulative comparisons without claiming to be PR-only", () => {
  const root = review(2, "cumulative")
  assert.equal(stackReviewContext(root, root)?.title, "Reviewing through #2 against staging")
  assert.match(stackReviewContext(root, root)?.description ?? "", /Cumulative changes/)
})

test("commit views retain PR identity but describe the displayed commit's actual scope", () => {
  const root = review()
  const commit: Session = {
    id: "commit",
    files: [],
    comparison: {
      base: { revision: "ccccccc^", commit: "d".repeat(40) },
      target: { revision: "ccccccc", commit: "c".repeat(40) },
      changed_paths: 0,
      semantic_paths: 0,
      description: "Commit 1 of 2, compared with its parent.",
    },
  }
  assert.deepEqual(stackReviewContext(root, commit), {
    title: "Reviewing #2 · commit ccccccc",
    description: "Commit 1 of 2, compared with its parent.",
    range: "ddddddd → ccccccc",
  })
  // Selection can change before its response arrives. Keep the displayed scope
  // truthful until the actual session changes.
  assert.equal(stackReviewContext(root, root)?.title, "Reviewing #2 against #1")
})

test("does not show stack context for standalone, absent, or inconsistent sessions", () => {
  const standalone: Session = { id: "standalone", files: [] }
  assert.equal(stackReviewContext(null, null), null)
  assert.equal(stackReviewContext(standalone, standalone), null)
  const invalid = review(999)
  assert.equal(stackReviewContext(invalid, invalid), null)
  assert.equal(stackReviewContext(review(), null), null)
})
