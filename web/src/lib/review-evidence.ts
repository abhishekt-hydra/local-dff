import * as z from "zod/mini"
import type { PatchFile, Session, StackHistory } from "./review-api"

export const EVIDENCE_STORAGE_KEY = "local-diffe:review-evidence:v1"
export const EVIDENCE_LIMIT = 512
export const EVIDENCE_BYTE_LIMIT = 1024 * 1024
const contextSchema = z.object({
  repository: z.string(),
  pr: z.nullable(z.number()),
  scope: z.enum(["pr", "cumulative", "final", "commit", "patch"]),
  tip: z.nullable(z.number()),
  base: z.string(),
  target: z.string(),
})
const evidenceSchema = z.object({
  context: contextSchema,
  path: z.string(),
  old_path: z.nullable(z.string()),
  new_path: z.nullable(z.string()),
  reviewed_at: z.number(),
  snapshot_id: z.optional(z.string()),
  symbol: z.optional(z.object({ key: z.string(), hash: z.string() })),
})
export type EvidenceContext = z.infer<typeof contextSchema>
export type ReviewEvidence = z.infer<typeof evidenceSchema>

export function canonicalReviewRepository(root: Session | null): string | null {
  if (root?.repository) return root.repository
  const url = root?.comparison?.pull_request?.url
  if (!url) return null
  try {
    const parsed = new URL(url)
    const [owner, repo] = parsed.pathname.split("/").filter(Boolean)
    return owner && repo ? `https://github.com/${owner}/${repo}`.toLowerCase() : null
  } catch {
    return null
  }
}

export function reviewEvidenceContext(
  root: Session | null,
  active: Session | null,
  finalTip: number | null,
): EvidenceContext | null {
  if (!root || !active) return null
  const repository = canonicalReviewRepository(root)
  // Unknown local identity is deliberately session-local, not a cross-repository
  // persistent mark based on the browser's uncanonicalized repository field.
  const identity = repository ?? `unverified-session:${root.id}`
  const comparison = active.comparison
  return {
    repository: identity,
    pr: finalTip ?? root.comparison?.pull_request?.number ?? null,
    scope:
      active.id !== root.id
        ? "commit"
        : finalTip !== null
          ? "final"
          : root.stack?.mode === "cumulative"
            ? "cumulative"
            : comparison
              ? "pr"
              : "patch",
    tip: finalTip,
    base: comparison?.base.commit ?? `session:${active.id}`,
    target: comparison?.target.commit ?? `session:${active.id}`,
  }
}

export function evidenceIdentity(
  context: EvidenceContext,
  file: PatchFile,
  symbol?: { key: string; hash: string },
): string {
  return JSON.stringify([
    context.repository,
    context.pr,
    context.scope,
    context.tip,
    context.base,
    context.target,
    file.old_path,
    file.new_path,
    file.display_path,
    symbol?.key ?? null,
    symbol?.hash ?? null,
  ])
}

export function recordIdentity(record: ReviewEvidence): string {
  return evidenceIdentity(
    record.context,
    {
      old_path: record.old_path,
      new_path: record.new_path,
      display_path: record.path,
      renderable: true,
    },
    record.symbol,
  )
}

export function parseEvidence(value: string | null): ReviewEvidence[] {
  if (!value || value.length > 2 * 1024 * 1024) return []
  try {
    const parsed = z.array(evidenceSchema).safeParse(JSON.parse(value))
    return parsed.success ? boundedEvidence(parsed.data) : []
  } catch {
    return []
  }
}

export function boundedEvidence(records: ReviewEvidence[]): ReviewEvidence[] {
  const unique = new Map<string, ReviewEvidence>()
  for (const record of [...records].sort((a, b) => a.reviewed_at - b.reviewed_at))
    unique.set(recordIdentity(record), record)
  const kept: ReviewEvidence[] = []
  let bytes = 0
  for (const record of [...unique.values()].reverse()) {
    const size = JSON.stringify(record).length * 2
    if (kept.length === EVIDENCE_LIMIT || bytes + size > EVIDENCE_BYTE_LIMIT) break
    kept.unshift(record)
    bytes += size
  }
  return kept
}

export function evidenceFor(
  context: EvidenceContext | null,
  file: PatchFile | null | undefined,
  records: ReviewEvidence[],
) {
  if (!context || !file) return { current: undefined, outdated: undefined }
  const exact = evidenceIdentity(context, file)
  const current = records.find((record) => !record.symbol && recordIdentity(record) === exact)
  const paths = new Set(
    [
      file.change_kind === "renamed" ? file.old_path : null,
      file.new_path,
      file.display_path,
    ].filter(Boolean),
  )
  const outdated = records
    .filter(
      (record) =>
        !record.symbol &&
        record.context.repository === context.repository &&
        record.context.pr === context.pr &&
        record.context.scope === context.scope &&
        record.context.tip === context.tip &&
        (paths.has(record.path) || paths.has(record.new_path)) &&
        (record.context.base !== context.base || record.context.target !== context.target),
    )
    .sort((a, b) => b.reviewed_at - a.reviewed_at)[0]
  return { current, outdated }
}

// Linear in metadata size: folder notices must not rescan every file's entire
// timeline (or every stored review) on each render of a large stack.
export function laterUnreviewedCount(
  repository: string,
  members: StackHistory["members"],
  records: ReviewEvidence[],
  folder = "",
): number {
  const marked = new Set(records.filter((record) => !record.symbol).map(recordIdentity))
  const renames = members.flatMap((member) =>
    member.files.filter((file) => file.change_kind === "renamed"),
  )
  const oldCounts = new Map<string, number>()
  const newCounts = new Map<string, number>()
  for (const file of renames) {
    if (file.old_path) oldCounts.set(file.old_path, (oldCounts.get(file.old_path) ?? 0) + 1)
    if (file.new_path) newCounts.set(file.new_path, (newCounts.get(file.new_path) ?? 0) + 1)
  }
  const aliases = new Map<string, string>()
  const find = (path: string): string => {
    let root = path
    while (aliases.has(root)) root = aliases.get(root)!
    let current = path
    while (aliases.has(current)) {
      const next = aliases.get(current)!
      aliases.set(current, root)
      current = next
    }
    return root
  }
  for (const file of renames) {
    if (
      !file.old_path ||
      !file.new_path ||
      oldCounts.get(file.old_path) !== 1 ||
      newCounts.get(file.new_path) !== 1
    )
      continue
    const old = find(file.old_path)
    const next = find(file.new_path)
    if (old !== next) aliases.set(old, next)
  }
  const status = new Map<string, { reviewed: boolean; later: boolean; focused: boolean }>()
  for (const member of members) {
    const context: EvidenceContext = {
      repository,
      pr: member.number,
      scope: "pr",
      tip: null,
      base: member.base,
      target: member.target,
    }
    for (const file of member.files) {
      const paths = [
        file.change_kind === "copied" ? null : file.old_path,
        file.new_path,
        file.display_path,
      ].filter((path): path is string => path !== null)
      const reviewed = marked.has(evidenceIdentity(context, file))
      for (const root of new Set(paths.map(find))) {
        const previous = status.get(root) ?? { reviewed: false, later: false, focused: false }
        status.set(root, {
          reviewed: previous.reviewed || reviewed,
          later: previous.later || (previous.reviewed && !reviewed),
          focused:
            previous.focused ||
            paths.some((path) => !folder || path === folder || path.startsWith(`${folder}/`)),
        })
      }
    }
  }
  return [...status.values()].filter((value) => value.focused && value.later).length
}
