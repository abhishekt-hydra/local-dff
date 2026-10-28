import { useMemo } from "react"
import { makeTree, type TreeItem } from "../sidebarTree"

type Props = {
  paths: string[]
  selected: string | null
  onFile: (path: string) => void
  onFolder: (path: string) => void
}

// Native details/buttons preserve Tab/Enter behavior without inventing an ARIA
// tree keyboard model ahead of the dedicated keyboard-first design pass. The
// parent bounds matches to 200 paths and supplies an explicit refinement filter.
export function StackPathTree({ paths, selected, onFile, onFolder }: Props) {
  const tree = useMemo(
    () => makeTree(paths.map((display_path) => ({ display_path, renderable: true }))),
    [paths],
  )
  const item = (node: TreeItem) => (
    <li key={node.id} className="min-w-0">
      {node.children?.length ? (
        <details open>
          <summary className="cursor-pointer truncate py-0.5 font-medium" title={node.id}>
            {node.name}/
          </summary>
          <button
            type="button"
            className="rounded px-1 py-0.5 text-primary focus-visible:ring-2 focus-visible:ring-ring"
            aria-label={`Focus folder ${node.id}`}
            onClick={() => onFolder(node.id)}
          >
            Focus this folder
          </button>
          {node.fileIndex !== undefined && (
            <button
              type="button"
              className="block rounded px-1 py-0.5 focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() => onFile(node.id)}
            >
              File at {node.id}
            </button>
          )}
          <ul className="ml-2 grid gap-0.5 border-l pl-2">{node.children.map(item)}</ul>
        </details>
      ) : (
        <button
          type="button"
          title={node.id}
          aria-label={`Watch file ${node.id}`}
          aria-current={selected === node.id ? "true" : undefined}
          className="w-full truncate rounded px-1 py-0.5 text-left hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => onFile(node.id)}
        >
          {node.name}
        </button>
      )}
    </li>
  )
  return (
    <details data-testid="stack-path-tree" className="min-w-0 rounded border p-2 text-xs">
      <summary className="cursor-pointer font-semibold">Stack path tree (filtered union)</summary>
      <ul className="mt-2 grid gap-1">{tree.map(item)}</ul>
    </details>
  )
}
