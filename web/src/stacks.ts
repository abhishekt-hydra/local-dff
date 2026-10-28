// Group open PRs into stacks for the PR picker. A PR is stacked on another when
// its base branch is that PR's head branch; this mirrors the server's
// `stacks::stack_members`, which decides what a review actually opens.

export type PullRequest = {
  number: number
  title: string
  url: string
  state: string
  baseRefName: string
  headRefName: string
  isDraft: boolean
  isCrossRepository?: boolean
  isStackTrunkBase?: boolean
  author?: { login: string } | null
  updatedAt: string
}

export type PullRow = { pull: PullRequest; depth: number }
export type PullGroups = { stacks: PullRow[][]; standalone: PullRequest[] }

export function groupPulls(pulls: PullRequest[]): PullGroups {
  const local = pulls.filter((pull) => !pull.isCrossRepository)
  const byHead = new Map<string, PullRequest[]>()
  for (const pull of local)
    byHead.set(pull.headRefName, [...(byHead.get(pull.headRefName) ?? []), pull])
  // An ambiguous head branch (several open PRs from it) links nothing.
  const parentOf = (pull: PullRequest) => {
    // The repository default branch is an authoritative integration boundary,
    // even when an open release PR happens to use that branch as its head.
    if (pull.isStackTrunkBase) return undefined
    const parents = byHead.get(pull.baseRefName)
    return parents?.length === 1 && parents[0].number !== pull.number ? parents[0] : undefined
  }
  const children = new Map<number, PullRequest[]>()
  for (const pull of local) {
    const parent = parentOf(pull)
    if (parent) children.set(parent.number, [...(children.get(parent.number) ?? []), pull])
  }
  for (const list of children.values()) list.sort((left, right) => left.number - right.number)

  const seen = new Set<number>()
  const stacks: PullRow[][] = []
  const walk = (pull: PullRequest, depth: number, rows: PullRow[]) => {
    if (seen.has(pull.number)) return
    seen.add(pull.number)
    rows.push({ pull, depth })
    for (const child of children.get(pull.number) ?? []) walk(child, depth + 1, rows)
  }
  for (const pull of [...local].sort((left, right) => left.number - right.number)) {
    if (parentOf(pull) || !children.has(pull.number)) continue
    const rows: PullRow[] = []
    walk(pull, 0, rows)
    stacks.push(rows)
  }
  return { stacks, standalone: pulls.filter((pull) => !seen.has(pull.number)) }
}
