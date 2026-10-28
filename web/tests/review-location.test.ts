import assert from "node:assert/strict"
import { test } from "node:test"
import { withReviewCoordinates } from "../src/lib/review-location.ts"
import { normalizePrUrl, readReviewLocation, withReviewPr } from "../src/lib/review-location.ts"

const pr = "https://github.com/hydra-db/hydradb-application/pull/3006"

test("normalizes GitHub PR links, trailing slashes, and GitHub query/hash fragments", () => {
  for (const input of [
    pr,
    `${pr}/`,
    ` ${pr}/ `,
    `${pr}/?diff=split#discussion`,
    pr.replace("https://", ""),
    pr.replace("https:", "http:"),
    pr.replace("3006", "003006"),
  ]) {
    assert.equal(normalizePrUrl(input), pr)
  }
})

test("rejects malformed, non-GitHub, credential-bearing, and non-PR URLs", () => {
  for (const input of [
    "",
    "not a url",
    "/owner/repo/pull/1",
    "javascript:alert(1)",
    pr.replace("github.com", "github.com.evil.test"),
    pr.replace("github.com", "evil.test"),
    pr.replace("https://", "https://user:password@"),
    pr.replace("github.com", "github.com:444"),
    pr.replace("/pull/", "/issues/"),
    `${pr}/files`,
    pr.replace("3006", "0"),
    pr.replace("3006", "-1"),
    pr.replace("3006", "1.5"),
    pr.replace("3006", "18446744073709551616"),
    pr.replace("hydra-db", "bad%2Fowner"),
  ]) {
    assert.throws(() => normalizePrUrl(input), Error, input)
  }
  assert.equal(
    normalizePrUrl(pr.replace("3006", "18446744073709551615")),
    pr.replace("3006", "18446744073709551615"),
  )
})

test("reads both encoded and readable redirect URLs without requiring a repository field", () => {
  for (const value of [pr, `${pr}/`, encodeURIComponent(`${pr}/`)]) {
    assert.deepEqual(readReviewLocation(new URL(`http://localhost:3333/?pr=${value}`)), {
      kind: "pr",
      url: pr,
    })
  }
  assert.deepEqual(readReviewLocation(new URL("http://localhost:3333/?perf=1")), { kind: "empty" })
})

test("invalid and ambiguous deep links become explicit errors, not exceptions", () => {
  for (const search of ["?pr=", "?pr=garbage", "?pr=%E0%A4%A", `?pr=${pr}&pr=${pr}`]) {
    const location = readReviewLocation(new URL(`http://localhost:3333/${search}`))
    assert.equal(location.kind, "invalid", search)
    if (location.kind === "invalid") assert.ok(location.message.length > 0)
  }
})

test("builds shareable URLs without mutating the current URL or dropping other parameters", () => {
  const current = new URL("https://review.example/?perf=1&label=a%26b#review")
  const next = withReviewPr(current, `${pr}/?diff=split#discussion`)
  assert.equal(next.origin, current.origin)
  assert.equal(next.pathname, "/")
  assert.equal(next.searchParams.get("pr"), pr)
  assert.equal(next.searchParams.get("perf"), "1")
  assert.equal(next.searchParams.get("label"), "a&b")
  assert.equal(next.hash, "#review")
  assert.equal(current.searchParams.has("pr"), false)
  assert.deepEqual(readReviewLocation(next), { kind: "pr", url: pr })
  const cleared = withReviewPr(next, null)
  assert.equal(cleared.searchParams.has("pr"), false)
  assert.equal(cleared.searchParams.get("label"), "a&b")
  assert.equal(cleared.hash, "#review")
})

test("restores explicit lane, final scope, layout, folder, file and diff coordinates", () => {
  const coordinates = {
    scope: "final" as const,
    tip: 42,
    diff: "text" as const,
    layout: "files" as const,
    path: "src/store/has space.go",
    pathKind: "file" as const,
    folder: "src/store",
    symbol: "Value",
  }
  const next = withReviewCoordinates(new URL("http://localhost/?perf=1#position"), pr, coordinates)
  assert.deepEqual(readReviewLocation(next), { kind: "pr", url: pr, coordinates })
  assert.equal(next.searchParams.get("perf"), "1")
  assert.equal(next.hash, "#position")
  const manual = withReviewCoordinates(next, pr)
  assert.deepEqual(readReviewLocation(manual), { kind: "pr", url: pr })
  const cleared = withReviewCoordinates(next, null)
  assert.equal(cleared.searchParams.has("path"), false)
  assert.equal(cleared.searchParams.has("tip"), false)
})

test("rejects invalid or duplicated review coordinates before making API calls", () => {
  for (const search of [
    "scope=other",
    "tip=-1",
    "tip=1.5",
    "tip=9007199254740992",
    "layout=other",
    "diff=other",
    "pathKind=other",
    "path=../secret",
    "path=/absolute",
    "folder=../secret",
    "scope=pr&scope=final",
    "symbol=%00bad",
  ]) {
    assert.equal(
      readReviewLocation(new URL(`http://localhost/?pr=${pr}&${search}`)).kind,
      "invalid",
      search,
    )
  }
})
