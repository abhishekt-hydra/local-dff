export type ReviewCoordinates = {
  scope: "pr" | "final" | "cumulative"
  tip: number | null
  diff?: "semantic" | "text"
  layout: "pr" | "files"
  path: string | null
  pathKind: "file" | "folder"
  symbol?: string
  folder?: string
}
export const DEFAULT_COORDINATES: ReviewCoordinates = {
  scope: "pr",
  tip: null,
  layout: "pr",
  path: null,
  pathKind: "file",
}
const COORDINATE_KEYS = [
  "scope",
  "tip",
  "diff",
  "layout",
  "path",
  "pathKind",
  "symbol",
  "folder",
] as const

// Shareable review identity is a GitHub URL, never an ephemeral backend session ID.
export type ReviewLocation =
  | { kind: "empty" }
  | { kind: "pr"; url: string; coordinates?: ReviewCoordinates }
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
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.hostname !== "github.com" ||
    url.port ||
    url.username ||
    url.password
  ) {
    throw new Error(INVALID_PR)
  }
  const match = /^\/([a-zA-Z0-9_.-]{1,100})\/([a-zA-Z0-9_.-]{1,100})\/pull\/(\d+)\/?$/.exec(
    url.pathname,
  )
  if (!match) throw new Error(INVALID_PR)
  const [, owner, repo, digits] = match
  const number = BigInt(digits)
  if (number < 1n || number > 18446744073709551615n)
    throw new Error(
      "The pull-request number must be a positive integer within GitHub's supported range.",
    )
  return `https://github.com/${owner}/${repo}/pull/${number}`
}

export function readReviewLocation(url: URL): ReviewLocation {
  const values = url.searchParams.getAll("pr")
  if (!values.length) return { kind: "empty" }
  const input = values[0]
  if (values.length !== 1)
    return { kind: "invalid", input, message: "Use one pr parameter per review URL." }
  try {
    const canonical = normalizePrUrl(input)
    const coordinates = readReviewCoordinates(url)
    return { kind: "pr", url: canonical, ...(coordinates ? { coordinates } : {}) }
  } catch (error) {
    return { kind: "invalid", input, message: error instanceof Error ? error.message : INVALID_PR }
  }
}

function readReviewCoordinates(url: URL): ReviewCoordinates | undefined {
  if (!COORDINATE_KEYS.some((key) => url.searchParams.has(key))) return undefined
  const params = url.searchParams
  for (const key of COORDINATE_KEYS)
    if (params.getAll(key).length > 1) throw new Error(`Use one ${key} parameter per review URL.`)
  const scope = params.get("scope") ?? "pr"
  const layout = params.get("layout") ?? "pr"
  const pathKind = params.get("pathKind") ?? "file"
  const diff = params.get("diff")
  if (
    !["pr", "final", "cumulative"].includes(scope) ||
    !["pr", "files"].includes(layout) ||
    !["file", "folder"].includes(pathKind) ||
    (diff !== null && !["semantic", "text"].includes(diff))
  )
    throw new Error("Invalid review scope, layout, path kind, or diff mode.")
  const tipValue = params.get("tip")
  const tip = tipValue === null ? null : Number(tipValue)
  if (tip !== null && (!/^\d+$/.test(tipValue ?? "") || !Number.isSafeInteger(tip) || tip <= 0))
    throw new Error("The stack tip must be a positive PR number.")
  const path = params.get("path")
  if (
    path !== null &&
    (!path.length ||
      path.length > 4096 ||
      path.includes("\0") ||
      path.startsWith("/") ||
      path.split("/").some((part) => part === ".." || part === "."))
  )
    throw new Error("Use a repository-relative file or folder path.")
  const folder = params.get("folder")
  if (
    folder !== null &&
    (!folder.length ||
      folder.length > 4096 ||
      folder.includes("\0") ||
      folder.startsWith("/") ||
      folder.split("/").some((part) => part === ".." || part === "."))
  )
    throw new Error("Use a repository-relative folder path.")
  const symbol = params.get("symbol")
  if (
    symbol !== null &&
    (!symbol.length ||
      symbol.length > 512 ||
      [...symbol].some((character) => character.charCodeAt(0) < 32))
  )
    throw new Error("Invalid symbol selection.")
  return {
    scope: scope === "final" ? "final" : scope === "cumulative" ? "cumulative" : "pr",
    layout: layout === "files" ? "files" : "pr",
    pathKind: pathKind === "folder" ? "folder" : "file",
    tip,
    path,
    ...(diff === "text" || diff === "semantic" ? { diff } : {}),
    ...(symbol ? { symbol } : {}),
    ...(folder ? { folder } : {}),
  }
}

// Preserve unrelated query parameters (such as profiling flags) and the hash.
export function withReviewPr(location: URL, pr: string | null): URL {
  const next = new URL(location)
  if (pr) next.searchParams.set("pr", normalizePrUrl(pr))
  else next.searchParams.delete("pr")
  return next
}

export function withReviewCoordinates(
  location: URL,
  pr: string | null,
  coordinates?: ReviewCoordinates,
): URL {
  const next = withReviewPr(location, pr)
  for (const key of COORDINATE_KEYS) next.searchParams.delete(key)
  if (!pr || !coordinates) return next
  if (coordinates.scope !== "pr") next.searchParams.set("scope", coordinates.scope)
  if (coordinates.tip !== null) next.searchParams.set("tip", String(coordinates.tip))
  if (coordinates.diff) next.searchParams.set("diff", coordinates.diff)
  if (coordinates.layout !== "pr") next.searchParams.set("layout", coordinates.layout)
  if (coordinates.path !== null) {
    next.searchParams.set("path", coordinates.path)
    if (coordinates.pathKind !== "file") next.searchParams.set("pathKind", coordinates.pathKind)
  }
  if (coordinates.symbol) next.searchParams.set("symbol", coordinates.symbol)
  if (coordinates.folder) next.searchParams.set("folder", coordinates.folder)
  return next
}
