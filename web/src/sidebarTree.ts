export type SidebarFile = {
  display_path: string
  renderable: boolean
}

export type TreeItem = {
  id: string
  name: string
  children?: TreeItem[]
  fileIndex?: number
  renderable?: boolean
}

export type FileNavigation = {
  indices: number[]
  positions: Map<number, number>
}

/** Build the arborist tree in O(files * path depth) using a sibling index. */
export function makeTree(files: ReadonlyArray<SidebarFile>): TreeItem[] {
  const roots: TreeItem[] = []
  const rootIndex = new Map<string, TreeItem>()
  const childIndexes = new WeakMap<TreeItem, Map<string, TreeItem>>()

  for (const [fileIndex, file] of files.entries()) {
    const parts = file.display_path.split("/").filter(Boolean)
    let level = roots
    let index = rootIndex
    let id = ""

    for (const [partIndex, name] of parts.entries()) {
      id = id ? `${id}/${name}` : name
      let node = index.get(name)
      if (!node) {
        node = { id, name, children: partIndex === parts.length - 1 ? undefined : [] }
        index.set(name, node)
        level.push(node)
      }

      if (partIndex === parts.length - 1) {
        node.fileIndex = fileIndex
        node.renderable = file.renderable
      } else {
        level = node.children ?? (node.children = [])
        // A node's children are indexed once and reused for every descendant.
        index = childIndexes.get(node) ?? new Map<string, TreeItem>()
        childIndexes.set(node, index)
      }
    }
  }

  return roots
}

export function buildFileNavigation(files: ReadonlyArray<SidebarFile>): FileNavigation {
  const indices: number[] = []
  const positions = new Map<number, number>()
  for (const [index, file] of files.entries()) {
    if (!file.renderable) continue
    positions.set(index, indices.length)
    indices.push(index)
  }
  return { indices, positions }
}
