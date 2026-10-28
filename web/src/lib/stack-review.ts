import type { Session } from "./review-api"

// Derive labels from the displayed session, not an in-flight selection. A commit
// view must never claim its diff is still against the parent PR or the trunk.
export function stackReviewContext(root: Session | null, active: Session | null) {
  const stack = root?.stack
  const member = stack?.members.find((member) => member.pull.number === stack.current)
  if (!stack || !member || !active) return null
  const comparison = active.comparison
  const range = comparison
    ? `${comparison.base.commit.slice(0, 7)} → ${comparison.target.commit.slice(0, 7)}`
    : null

  if (active.id !== root?.id && comparison) {
    return {
      title: `Reviewing #${stack.current} · commit ${comparison.target.revision}`,
      description: comparison.description,
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
