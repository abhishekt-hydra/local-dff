import type { PatchFile, Session, StackHistory } from "./review-api"

export type Stack = NonNullable<Session["stack"]>
export type HistoryMember = StackHistory["members"][number]

export function ancestorLane(stack: Stack, tip: number): number[] {
  const byNumber = new Map(stack.members.map((member) => [member.pull.number, member]))
  const lane: number[] = []
  const seen = new Set<number>()
  let current: number | null = tip
  while (current !== null) {
    if (seen.has(current)) return []
    seen.add(current)
    const member = byNumber.get(current)
    if (!member) return []
    lane.unshift(current)
    current = member.parent
  }
  return lane
}

export function descendantTips(stack: Stack, selected: number): number[] {
  const parents = new Set(stack.members.map((member) => member.parent))
  return stack.members
    .filter((member) => !parents.has(member.pull.number))
    .map((member) => member.pull.number)
    .filter((tip) => ancestorLane(stack, tip).includes(selected))
}

export function inFolder(path: string, folder: string): boolean {
  return !folder || path === folder || path.startsWith(`${folder}/`)
}

export function touchesPath(file: PatchFile, path: string, kind: "file" | "folder"): boolean {
  const paths =
    file.change_kind === "copied"
      ? [file.new_path, file.display_path]
      : [file.old_path, file.new_path, file.display_path]
  return paths.some(
    (candidate) =>
      candidate !== null && (kind === "folder" ? inFolder(candidate, path) : candidate === path),
  )
}

export function historyPaths(members: HistoryMember[]): string[] {
  const paths = new Set<string>()
  for (const member of members) {
    for (const file of member.files) {
      paths.add(file.display_path)
      if (file.old_path && file.change_kind !== "copied") paths.add(file.old_path)
      if (file.new_path) paths.add(file.new_path)
    }
  }
  return [...paths].sort()
}

export function historyFolders(paths: string[]): string[] {
  const folders = new Set<string>()
  for (const path of paths) {
    const parts = path.split("/")
    parts.pop()
    while (parts.length) {
      folders.add(parts.join("/"))
      parts.pop()
    }
  }
  return [...folders].sort()
}

// Only Git-reported, one-to-one renames add aliases. Deletion/recreation at the
// same path remains a sequence of file events, not a claimed symbol identity.
export function pathAliases(members: HistoryMember[], selected: string): Set<string> {
  const aliases = new Set([selected])
  const renames = members.flatMap((member) =>
    member.files.filter(
      (file) =>
        file.change_kind === "renamed" ||
        file.change_kind === "rename" ||
        file.change_kind?.startsWith("R"),
    ),
  )
  for (let pass = 0; pass < renames.length; pass++) {
    for (const file of renames) {
      const old = file.old_path
      const next = file.new_path
      if (!old || !next || ![old, next].some((path) => aliases.has(path))) continue
      if (
        renames.filter((entry) => entry.old_path === old).length !== 1 ||
        renames.filter((entry) => entry.new_path === next).length !== 1
      )
        continue
      aliases.add(old)
      aliases.add(next)
    }
  }
  return aliases
}

export function fileTimeline(members: HistoryMember[], selected: string) {
  const aliases = pathAliases(members, selected)
  return members.flatMap((member) =>
    member.files
      .filter((file) => [...aliases].some((path) => touchesPath(file, path, "file")))
      .map((file) => ({ member, file })),
  )
}

export function changeLabel(file: PatchFile): string {
  if (!file.old_path) return "Added"
  if (!file.new_path) return "Deleted"
  if (file.old_path !== file.new_path)
    return file.change_kind === "copied" || file.change_kind?.startsWith("C")
      ? "Copied (identity not linked)"
      : file.change_kind === "renamed" || file.change_kind?.startsWith("R")
        ? "Renamed (Git)"
        : "Path changed (identity unknown)"
  return file.renderable ? "Modified" : "Binary, empty or metadata-only"
}
