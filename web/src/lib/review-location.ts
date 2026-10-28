// Shareable review identity is a GitHub URL, never an ephemeral backend session ID.
export type ReviewLocation =
  | { kind: "empty" }
  | { kind: "pr"; url: string }
  | { kind: "invalid"; input: string; message: string }

const INVALID_PR = "Enter a GitHub pull-request URL such as https://github.com/owner/repo/pull/123."

export function normalizePrUrl(input: string): string {
  const trimmed = input.trim()
  let url: URL
  try {
    url = new URL(trimmed.startsWith("github.com/") ? `https://${trimmed}` : trimmed)
  } catch {
    throw new Error(INVALID_PR)
  }
  if (!["https:", "http:"].includes(url.protocol) || url.hostname !== "github.com" || url.port || url.username || url.password) {
    throw new Error(INVALID_PR)
  }
  const match = /^\/([a-zA-Z0-9_.-]{1,100})\/([a-zA-Z0-9_.-]{1,100})\/pull\/(\d+)\/?$/.exec(url.pathname)
  if (!match) throw new Error(INVALID_PR)
  const [, owner, repo, digits] = match
  const number = BigInt(digits)
  if (number < 1n || number > 18446744073709551615n) throw new Error("The pull-request number must be a positive integer within GitHub's supported range.")
  return `https://github.com/${owner}/${repo}/pull/${number}`
}

export function readReviewLocation(url: URL): ReviewLocation {
  const values = url.searchParams.getAll("pr")
  if (!values.length) return { kind: "empty" }
  const input = values[0]
  if (values.length !== 1) return { kind: "invalid", input, message: "Use one pr parameter per review URL." }
  try {
    return { kind: "pr", url: normalizePrUrl(input) }
  } catch (error) {
    return { kind: "invalid", input, message: error instanceof Error ? error.message : INVALID_PR }
  }
}

// Preserve unrelated query parameters (such as profiling flags) and the hash.
export function withReviewPr(location: URL, pr: string | null): URL {
  const next = new URL(location)
  if (pr) next.searchParams.set("pr", normalizePrUrl(pr))
  else next.searchParams.delete("pr")
  return next
}
