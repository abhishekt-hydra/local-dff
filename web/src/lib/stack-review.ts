import type { Session, PatchFile } from "./review-api"

export function reviewFileSelection(
  files: PatchFile[],
  requestedPath: string | null,
  strictPath = false,
  includeMetadata = false,
): number | null {
  const kept = requestedPath
    ? files.findIndex(
        (file) => file.display_path === requestedPath && (includeMetadata || file.renderable),
      )
    : -1
  if (kept >= 0) return kept
  if (strictPath && requestedPath) return null
  const first = files.findIndex((file) => file.renderable)
  return first >= 0 ? first : null
}

// Derive labels from the displayed session, not an in-flight selection. A commit
// view must never claim its diff is still against the parent PR or the trunk.
export function stackReviewContext(
  root: Session | null,
  active: Session | null,
  finalTip: number | null = null,
) {
  const stack = root?.stack
  const member = stack?.members.find((member) => member.pull.number === stack.current)
  if (!stack || !member || !active) return null
  const comparison = active.comparison
  const range = comparison
    ? `${comparison.base.commit.slice(0, 7)} → ${comparison.target.commit.slice(0, 7)}`
    : null

  if (comparison?.kind === "since-review") {
    return {
      title: `Changes since my review · #${stack.current}`,
      description: comparison.description,
      range,
    }
  }
  if (active.id !== root?.id && comparison) {
    return {
      title: `${finalTip ? `Final stack through #${finalTip}` : `Reviewing #${stack.current}`} · commit ${comparison.target.revision}`,
      description: comparison.description,
      range,
    }
  }
  if (finalTip !== null) {
    return {
      title: `Final stack through #${finalTip} against ${stack.trunk}`,
      description:
        "The final result on this explicit ancestor-to-tip lane. Reviewing it does not mark individual PR contributions reviewed.",
      range,
    }
  }
  if (stack.mode === "cumulative") {
    return {
      title: `Reviewing through #${stack.current} against ${stack.trunk}`,
      description: "Cumulative changes from the trunk through this PR, using their merge-base.",
      range,
    }
  }
  const parent = member.parent === null ? stack.trunk : `#${member.parent}`
  return {
    title: `Reviewing #${stack.current} against ${parent}`,
    description: `Only this PR's changes, compared with the merge-base of ${parent}'s current head.`,
    range,
  }
}
