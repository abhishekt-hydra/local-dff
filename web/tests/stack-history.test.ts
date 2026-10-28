import assert from "node:assert/strict"
import { test } from "node:test"
import { groupPulls } from "../src/stacks.ts"
import {
  ancestorLane,
  descendantTips,
  fileTimeline,
  historyFolders,
  historyPaths,
  inFolder,
  touchesPath,
} from "../src/lib/stack-history.ts"
import {
  stackHistorySchema,
  type PatchFile,
  type Session,
  type StackHistory,
} from "../src/lib/review-api.ts"

const file = (path: string): PatchFile => ({
  old_path: path,
  new_path: path,
  display_path: path,
  renderable: true,
})
const stack: NonNullable<Session["stack"]> = {
  trunk: "main",
  current: 1,
  mode: "pr",
  members: [1, 2, 3, 4].map((number) => ({
    parent: number === 1 ? null : number === 4 ? 1 : number - 1,
    depth: number === 4 ? 1 : number - 1,
    pull: {
      number,
      title: String(number),
      url: `https://github.com/o/r/pull/${number}`,
      state: "OPEN",
      baseRefName: "main",
      headRefName: String(number),
      isDraft: false,
      updatedAt: "",
    },
  })),
}
const member = (number: number, files: PatchFile[]): StackHistory["members"][number] => ({
  number,
  parent: number === 1 ? null : number - 1,
  depth: number - 1,
  base: `base-${number}`,
  target: `head-${number}`,
  state: "ready",
  files,
})

test("the picker respects an authoritative default-branch boundary, not a release PR's head", () => {
  const template = stack.members[0].pull
  const pulls = [
    { ...template, number: 99, baseRefName: "byoc-staging", headRefName: "staging" },
    {
      ...template,
      number: 1,
      baseRefName: "staging",
      headRefName: "feature",
      isStackTrunkBase: true,
    },
    {
      ...template,
      number: 2,
      baseRefName: "feature",
      headRefName: "child",
      isStackTrunkBase: false,
    },
    {
      ...template,
      number: 3,
      baseRefName: "staging",
      headRefName: "other",
      isStackTrunkBase: true,
    },
  ]
  const grouped = groupPulls(pulls)
  assert.deepEqual(
    grouped.stacks.map((rows) => rows.map((row) => row.pull.number)),
    [[1, 2]],
  )
  assert.deepEqual(
    grouped.standalone.map((pull) => pull.number),
    [99, 3],
  )
  const unknown = groupPulls(pulls.map((pull) => ({ ...pull, isStackTrunkBase: undefined })))
  assert.equal(
    unknown.stacks[0].length,
    4,
    "no magic branch-name heuristic without authoritative metadata",
  )
})

test("final tips are descendant leaves; sibling branches never become chronological versions", () => {
  assert.deepEqual(descendantTips(stack, 1), [3, 4])
  assert.deepEqual(descendantTips(stack, 2), [3])
  assert.deepEqual(ancestorLane(stack, 3), [1, 2, 3])
  assert.deepEqual(ancestorLane(stack, 4), [1, 4])
  assert.deepEqual(ancestorLane(stack, 999), [])
  const cycle = {
    ...stack,
    members: stack.members.map((entry) =>
      entry.pull.number === 1 ? { ...entry, parent: 3 } : entry,
    ),
  }
  assert.deepEqual(ancestorLane(cycle, 3), [])
})

test("file timelines use PR-local modifications, skipping untouched members", () => {
  const members = [
    member(1, [file("src/query.go")]),
    member(2, [file("src/other.go")]),
    member(3, [file("src/query.go")]),
  ]
  assert.deepEqual(
    fileTimeline(members, "src/query.go").map((entry) => entry.member.number),
    [1, 3],
  )
  assert.deepEqual(historyPaths(members), ["src/other.go", "src/query.go"])
  assert.deepEqual(historyFolders(["src/store/a.go", "src/b.go", "root.go"]), ["src", "src/store"])
})

test("folder boundaries include rename-in/out and deletion, not sibling prefixes", () => {
  assert.equal(inFolder("src/store/a.go", "src/store"), true)
  assert.equal(inFolder("src/storehouse/a.go", "src/store"), false)
  assert.equal(
    touchesPath(
      { ...file("new/a.go"), old_path: "src/store/a.go", change_kind: "renamed" },
      "src/store",
      "folder",
    ),
    true,
  )
  assert.equal(
    touchesPath({ ...file("src/store/a.go"), new_path: null }, "src/store", "folder"),
    true,
  )
})

test("only supported one-to-one Git renames connect old/new file aliases", () => {
  const renamed = { ...file("new.go"), old_path: "old.go", change_kind: "renamed" }
  const history = [member(1, [file("old.go")]), member(2, [renamed]), member(3, [file("new.go")])]
  assert.deepEqual(
    fileTimeline(history, "new.go").map((entry) => entry.member.number),
    [1, 2, 3],
  )
  assert.deepEqual(
    fileTimeline(
      [member(1, [file("old.go")]), member(2, [{ ...renamed, change_kind: "copied" }])],
      "new.go",
    ).map((entry) => entry.member.number),
    [2],
  )
  assert.equal(
    fileTimeline(
      [member(1, [file("old.go")]), member(2, [{ ...renamed, change_kind: "copied" }])],
      "old.go",
    ).length,
    1,
  )
  const ambiguous = [
    ...history,
    member(4, [{ ...file("other.go"), old_path: "old.go", change_kind: "renamed" }]),
  ]
  assert.equal(
    fileTimeline(ambiguous, "new.go").some((entry) => entry.member.number === 1),
    false,
  )
})

test("pending and failed metadata remain explicit validated states, not empty ready histories", () => {
  const pending = { ...member(1, []), state: "pending" }
  const failed = { ...member(2, []), state: "failed", error: "Git unavailable" }
  const response = stackHistorySchema.parse({
    repository: "https://github.com/o/r",
    members: [pending, failed],
  })
  assert.deepEqual(
    response.members.map((entry) => entry.state),
    ["pending", "failed"],
  )
  assert.equal(
    stackHistorySchema.safeParse({ ...response, members: [{ ...pending, state: "unknown" }] })
      .success,
    false,
  )
})
