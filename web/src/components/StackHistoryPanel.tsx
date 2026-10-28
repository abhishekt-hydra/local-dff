import { useMemo, useState } from "react"
import { Button } from "@/components/ui/button"
import type { PatchFile, Session, StackHistory } from "../lib/review-api"
import type { ReviewCoordinates } from "../lib/review-location"
import {
  ancestorLane,
  changeLabel,
  fileTimeline,
  historyFolders,
  historyPaths,
  inFolder,
  touchesPath,
} from "../lib/stack-history"
import { evidenceFor, laterUnreviewedCount, type ReviewEvidence } from "../lib/review-evidence"
import { SymbolHistoryPanel } from "./SymbolHistoryPanel"
import { StackPathTree } from "./StackPathTree"

type Props = {
  root: Session
  coordinates: ReviewCoordinates
  tip: number | null
  history: StackHistory | null
  error: string
  records: ReviewEvidence[]
  onRetry: () => void
  onCoordinates: (coordinates: ReviewCoordinates) => void
  onOpen: (number: number, file: PatchFile) => void
  onPrLayout: () => void
  onSymbolReview: (file: PatchFile, key: string, hash: string) => void
  canReviewSymbols: boolean
}

export function StackHistoryPanel({
  root,
  coordinates,
  tip,
  history,
  error,
  records,
  onRetry,
  onCoordinates,
  onOpen,
  onPrLayout,
  onSymbolReview,
  canReviewSymbols,
}: Props) {
  const stack = root.stack
  const [pathFilter, setPathFilter] = useState("")
  const lane = useMemo(() => (stack && tip ? ancestorLane(stack, tip) : []), [stack, tip])
  const members = useMemo(
    () =>
      lane.flatMap((number) => history?.members.find((member) => member.number === number) ?? []),
    [history, lane],
  )
  const paths = useMemo(() => historyPaths(members), [members])
  const folders = useMemo(() => historyFolders(paths), [paths])
  const folder =
    coordinates.folder ?? (coordinates.pathKind === "folder" ? coordinates.path : null) ?? ""
  const visiblePaths = paths.filter((path) => inFolder(path, folder))
  const matchingPaths = visiblePaths.filter((path) =>
    path.toLowerCase().includes(pathFilter.toLowerCase()),
  )
  const displayedPaths = matchingPaths.slice(0, 200)
  const path = coordinates.pathKind === "file" ? coordinates.path : null
  const timeline = useMemo(() => (path ? fileTimeline(members, path) : []), [members, path])
  const incomplete =
    !history || members.length !== lane.length || members.some((member) => member.state !== "ready")
  const currentPosition = lane.indexOf(stack?.current ?? -1)
  const previousEntry = [...timeline]
    .reverse()
    .find((entry) => lane.indexOf(entry.member.number) < currentPosition)
  const nextEntry = timeline.find((entry) => lane.indexOf(entry.member.number) > currentPosition)
  const pathIndex = path ? visiblePaths.indexOf(path) : -1
  const openStackFile = (direction: 1 | -1) => {
    if (!visiblePaths.length) return
    const index =
      direction === 1
        ? Math.min(visiblePaths.length - 1, pathIndex + 1)
        : Math.max(0, pathIndex - 1)
    const events = fileTimeline(members, visiblePaths[index])
    const entry =
      events.find((event) => lane.indexOf(event.member.number) >= currentPosition) ?? events[0]
    if (entry) onOpen(entry.member.number, entry.file)
  }
  const folderMembers = folder
    ? members.filter(
        (member) =>
          member.state === "ready" &&
          member.files.some((file) => touchesPath(file, folder, "folder")),
      )
    : []
  const previousFolderMember = [...folderMembers]
    .reverse()
    .find((member) => lane.indexOf(member.number) < currentPosition)
  const nextFolderMember = folderMembers.find(
    (member) => lane.indexOf(member.number) > currentPosition,
  )
  const openFolderMember = (member: typeof previousFolderMember) => {
    const file =
      member?.files.find((file) => file.renderable && touchesPath(file, folder, "folder")) ??
      member?.files.find((file) => touchesPath(file, folder, "folder"))
    if (member && file) onOpen(member.number, file)
  }
  const reviewed = timeline.filter(
    ({ member, file }) =>
      evidenceFor(
        {
          repository: history?.repository ?? "",
          pr: member.number,
          scope: "pr",
          tip: null,
          base: member.base,
          target: member.target,
        },
        file,
        records,
      ).current,
  )
  const later = reviewed.flatMap((entry) =>
    timeline
      .filter((next) => lane.indexOf(next.member.number) > lane.indexOf(entry.member.number))
      .filter((next) => !reviewed.includes(next))
      .map((next) => ({ earlier: entry, next })),
  )[0]
  const laterUnreviewedFiles = useMemo(
    () => laterUnreviewedCount(history?.repository ?? "", members, records, folder),
    [history?.repository, members, records, folder],
  )

  return (
    <section
      data-testid="stack-history"
      aria-label="File and folder history"
      className="grid min-w-0 max-h-[65vh] gap-2 overflow-auto border-t pt-3"
    >
      <h3 className="text-xs font-semibold">Files across stack</h3>
      {!tip && (
        <p className="text-xs text-muted-foreground">
          Choose a descendant tip to inspect one branch. Sibling PRs are not consecutive versions.
        </p>
      )}
      {error && (
        <p role="alert" className="text-xs">
          {error}
        </p>
      )}
      {(error || members.some((member) => member.state === "failed")) && (
        <Button data-testid="retry-stack-history" size="sm" variant="outline" onClick={onRetry}>
          Retry history
        </Button>
      )}
      {incomplete && tip && (
        <p role="status" className="text-xs text-muted-foreground">
          Preparing stack metadata; unavailable members are not assumed unchanged.
        </p>
      )}
      <label className="grid gap-1 text-xs">
        Folder focus
        <select
          data-testid="history-folder"
          value={folder}
          className="min-w-0 w-full rounded border bg-background p-1.5"
          onChange={(event) =>
            onCoordinates({
              ...coordinates,
              folder: event.target.value || undefined,
              path: event.target.value || null,
              pathKind: "folder",
            })
          }
        >
          <option value="">All folders</option>
          {folders.map((folder) => (
            <option key={folder} value={folder}>
              {folder}
            </option>
          ))}
        </select>
      </label>
      <label className="grid gap-1 text-xs">
        Filter stack paths
        <input
          data-testid="history-path-filter"
          className="min-w-0 w-full rounded border bg-background p-1.5"
          value={pathFilter}
          onChange={(event) => setPathFilter(event.target.value)}
          placeholder="Find a file across this lane"
        />
      </label>
      <label className="grid gap-1 text-xs">
        File across stack
        <select
          data-testid="history-file"
          value={path ?? ""}
          className="min-w-0 w-full rounded border bg-background p-1.5"
          onChange={(event) =>
            onCoordinates({
              ...coordinates,
              path: event.target.value || null,
              pathKind: "file",
              symbol: undefined,
            })
          }
        >
          <option value="">Choose a file ({visiblePaths.length})</option>
          {path && !displayedPaths.includes(path) && (
            <option value={path}>{path} (selected; outside filter)</option>
          )}
          {displayedPaths.map((path) => (
            <option key={path} value={path}>
              {path}
            </option>
          ))}
        </select>
      </label>
      <StackPathTree
        paths={displayedPaths}
        selected={path}
        onFile={(path) =>
          onCoordinates({ ...coordinates, path, pathKind: "file", symbol: undefined })
        }
        onFolder={(folder) =>
          onCoordinates({
            ...coordinates,
            folder,
            path: folder,
            pathKind: "folder",
            symbol: undefined,
          })
        }
      />
      {matchingPaths.length > 200 && (
        <p className="text-[11px] text-muted-foreground">
          Showing 200 of {matchingPaths.length} matching paths. Refine the filter to select any
          other path.
        </p>
      )}
      <div className="flex flex-wrap gap-1">
        <Button
          data-testid="previous-stack-file"
          size="sm"
          variant="outline"
          disabled={pathIndex <= 0}
          onClick={() => openStackFile(-1)}
        >
          Previous stack file
        </Button>
        <Button
          data-testid="next-stack-file"
          size="sm"
          variant="outline"
          disabled={!visiblePaths.length || pathIndex === visiblePaths.length - 1}
          onClick={() => openStackFile(1)}
        >
          Next stack file
        </Button>
      </div>
      {folder && (
        <div className="flex flex-wrap gap-1">
          <Button
            data-testid="previous-folder-pr"
            size="sm"
            variant="outline"
            disabled={!previousFolderMember}
            onClick={() => openFolderMember(previousFolderMember)}
          >
            Previous folder PR
          </Button>
          <Button
            data-testid="next-folder-pr"
            size="sm"
            variant="outline"
            disabled={!nextFolderMember}
            onClick={() => openFolderMember(nextFolderMember)}
          >
            Next folder PR
          </Button>
        </div>
      )}
      {folder && (
        <p className="text-[11px] text-muted-foreground">
          {laterUnreviewedFiles} known files with later unreviewed edits in this folder.{" "}
          {incomplete ? "Counts are incomplete." : ""}
        </p>
      )}
      {!path && coordinates.pathKind === "folder" && (
        <ul className="grid max-h-36 gap-1 overflow-auto">
          {members.map((member) => {
            const count = member.files.filter((file) => touchesPath(file, folder, "folder")).length
            return (
              <li key={member.number} className="text-xs">
                #{member.number}:{" "}
                {member.state === "ready" ? `${count} changed paths` : member.state}
              </li>
            )
          })}
        </ul>
      )}
      {path && (
        <>
          {later && (
            <p
              data-testid="later-change-notice"
              className="rounded border border-amber-500/30 bg-amber-500/5 p-2 text-xs"
            >
              Reviewed in #{later.earlier.member.number}; file changes again in #
              {later.next.member.number}. Later changes are not marked reviewed.
            </p>
          )}
          {timeline.length > 0 && reviewed.length === timeline.length && !incomplete && (
            <p className="text-xs">
              All contributions for this file reviewed. The final result is a separate review.
            </p>
          )}
          <div className="flex flex-wrap gap-1">
            <Button
              data-testid="previous-file-change"
              size="sm"
              variant="outline"
              disabled={!previousEntry}
              onClick={() => {
                if (previousEntry) onOpen(previousEntry.member.number, previousEntry.file)
              }}
            >
              Previous change
            </Button>
            <Button
              data-testid="next-file-change"
              size="sm"
              variant="outline"
              disabled={!nextEntry}
              onClick={() => {
                if (nextEntry) onOpen(nextEntry.member.number, nextEntry.file)
              }}
            >
              Next change
            </Button>
          </div>
          <ol className="grid max-h-48 gap-1 overflow-auto" aria-label="File change timeline">
            {members.map((member) => {
              const events = timeline.filter((entry) => entry.member.number === member.number)
              if (member.state !== "ready")
                return (
                  <li key={member.number} className="text-xs">
                    #{member.number}: {member.state}
                    {member.error ? ` — ${member.error}` : ""}
                  </li>
                )
              return events.map(({ file }) => {
                const evidence = evidenceFor(
                  {
                    repository: history?.repository ?? "",
                    pr: member.number,
                    scope: "pr",
                    tip: null,
                    base: member.base,
                    target: member.target,
                  },
                  file,
                  records,
                )
                return (
                  <li key={`${member.number}:${file.display_path}`}>
                    <button
                      type="button"
                      data-testid={`history-pr-${member.number}`}
                      aria-current={member.number === stack?.current ? "step" : undefined}
                      className="w-full rounded border px-2 py-1.5 text-left text-xs hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
                      onClick={() => onOpen(member.number, file)}
                    >
                      <span className="font-semibold">#{member.number}</span> · {changeLabel(file)}
                      {evidence.current
                        ? " · Reviewed"
                        : evidence.outdated
                          ? " · Outdated"
                          : " · Unreviewed"}
                      {file.old_path !== file.new_path && (
                        <span className="block break-all text-muted-foreground">
                          {file.old_path ?? "∅"} → {file.new_path ?? "∅"}
                        </span>
                      )}
                    </button>
                  </li>
                )
              })
            })}
          </ol>
          {!timeline.length && !incomplete && (
            <p className="text-xs">No changes to this path on the selected lane.</p>
          )}
          <p className="text-[11px] text-muted-foreground">
            Delete/recreate and copies do not establish persistent identity. Only Git-reported
            one-to-one renames link path aliases.
          </p>
          <SymbolHistoryPanel
            root={root}
            timeline={timeline}
            path={path}
            symbol={coordinates.symbol}
            records={records}
            onSymbol={(symbol) => onCoordinates({ ...coordinates, symbol })}
            onOpen={onOpen}
            onReview={onSymbolReview}
            canReview={canReviewSymbols}
          />
        </>
      )}
      <Button size="sm" variant="ghost" onClick={onPrLayout}>
        Open in PR context
      </Button>
    </section>
  )
}
