import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import {
  api,
  stackSymbolsSchema,
  type PatchFile,
  type Session,
  type StackSymbols,
} from "../lib/review-api"
import type { fileTimeline } from "../lib/stack-history"
import {
  canonicalReviewRepository,
  evidenceIdentity,
  recordIdentity,
  type ReviewEvidence,
} from "../lib/review-evidence"

type Entry = ReturnType<typeof fileTimeline>[number]
type Observation = { entry: Entry; result?: StackSymbols; error?: string }
type Props = {
  root: Session
  timeline: Entry[]
  path: string
  symbol?: string
  records: ReviewEvidence[]
  onSymbol: (key: string) => void
  onOpen: (number: number, file: PatchFile) => void
  onReview: (file: PatchFile, key: string, hash: string) => void
  canReview: boolean
}

export function SymbolHistoryPanel({
  root,
  timeline,
  path,
  symbol,
  records,
  onSymbol,
  onOpen,
  onReview,
  canReview,
}: Props) {
  const [observations, setObservations] = useState<{
    id: string
    path: string
    values: Observation[]
  } | null>(null)
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    if (!path.endsWith(".go")) return
    const controller = new AbortController()
    const load = async () => {
      const values: Observation[] = []
      for (const entry of timeline) {
        try {
          const result = await api(
            "/api/stack-symbols",
            { id: root.id, number: entry.member.number, path: entry.file.display_path },
            stackSymbolsSchema,
            controller.signal,
          )
          if (controller.signal.aborted) return
          values.push({ entry, result })
        } catch (error) {
          if (controller.signal.aborted) return
          values.push({
            entry,
            error: error instanceof Error ? error.message : "Symbol preview unavailable.",
          })
        }
        setObservations({ id: root.id, path, values: [...values] })
      }
    }
    void load()
    return () => controller.abort()
  }, [root.id, timeline, path, retry])
  if (!path.endsWith(".go"))
    return (
      <p className="text-[11px] text-muted-foreground">
        Function preview currently supports a conservative Go-only pilot. File history remains
        available for other languages.
      </p>
    )
  const current =
    observations?.id === root.id && observations.path === path ? observations.values : []
  const keys = [
    ...new Set(
      current.flatMap(
        (observation) => observation.result?.symbols.map((symbol) => symbol.key) ?? [],
      ),
    ),
  ]
  const selected = symbol ?? keys[0]
  const matches = current.flatMap(
    (observation) =>
      observation.result?.symbols
        .filter((symbol) => symbol.key === selected && symbol.status !== "ambiguous")
        .map((symbol) => ({ ...observation, symbol })) ?? [],
  )
  const changes = matches.filter((match) => match.symbol.status !== "unchanged")
  const ordered = root.stack?.members.map((member) => member.pull.number) ?? []
  const position = ordered.indexOf(root.stack?.current ?? -1)
  const previousChange = [...changes]
    .reverse()
    .find((match) => ordered.indexOf(match.entry.member.number) < position)
  const nextChange = changes.find((match) => ordered.indexOf(match.entry.member.number) > position)
  const uncertain = current.some(
    (item) =>
      item.error ||
      item.result?.state !== "ready" ||
      item.result.symbols.some(
        (candidate) => candidate.key === selected && candidate.status === "ambiguous",
      ),
  )
  const preview =
    matches.find((match) => match.entry.member.number === root.stack?.current) ?? matches[0]
  const repository = canonicalReviewRepository(root) ?? ""
  const identity = (match: (typeof matches)[number]) =>
    evidenceIdentity(
      {
        repository,
        pr: match.entry.member.number,
        scope: "pr",
        tip: null,
        base: match.entry.member.base,
        target: match.entry.member.target,
      },
      match.entry.file,
      { key: match.symbol.key, hash: match.symbol.new_hash ?? "" },
    )
  const marked = (match: (typeof matches)[number]) =>
    records.some((record) => Boolean(record.symbol) && recordIdentity(record) === identity(match))
  const changedAfterReview = matches.some(
    (match, i) =>
      marked(match) &&
      matches
        .slice(i + 1)
        .some(
          (next) =>
            next.symbol.status === "removed" ||
            (next.symbol.new_hash && next.symbol.new_hash !== match.symbol.new_hash),
        ),
  )
  let deleted = false
  let broken = false
  for (const entry of timeline) {
    if (deleted && !entry.file.old_path) broken = true
    if (!entry.file.new_path) deleted = true
  }
  return (
    <section
      data-testid="symbol-history"
      aria-label="Go function history preview"
      className="grid min-w-0 gap-2 break-words border-t pt-2"
    >
      <h4 className="text-xs font-semibold">Go function history · conservative preview</h4>
      <p className="text-[11px] text-muted-foreground">
        Exact qualified names in the same file only. Renames, moves, overload-like duplicates and
        split/merge identity are not inferred. No automatic review carryover.
      </p>
      {current.length < timeline.length && (
        <p role="status" className="text-xs">
          Preparing function ranges…
        </p>
      )}
      {current.some((item) => item.error) && (
        <Button size="sm" variant="outline" onClick={() => setRetry((value) => value + 1)}>
          Retry function preview
        </Button>
      )}
      {current
        .filter((item) => item.error || item.result?.state !== "ready")
        .map((item) => (
          <p key={item.entry.member.number} className="text-xs">
            #{item.entry.member.number}: {item.error ?? item.result?.message ?? item.result?.state}{" "}
            — use file history.
          </p>
        ))}
      {broken && (
        <p className="text-xs">
          File deleted and recreated: function identity is not linked across that gap. Use the file
          timeline.
        </p>
      )}
      <label className="grid gap-1 text-xs">
        Function
        <select
          data-testid="history-symbol"
          className="min-w-0 w-full rounded border bg-background p-1.5"
          value={selected ?? ""}
          onChange={(event) => onSymbol(event.target.value)}
        >
          {!keys.length && <option value="">No unambiguous declarations</option>}
          {symbol && !keys.includes(symbol) && <option value={symbol}>Unmatched: {symbol}</option>}
          {keys.map((key) => (
            <option key={key} value={key}>
              {key}
            </option>
          ))}
        </select>
      </label>
      {changedAfterReview && !broken && !uncertain && (
        <p data-testid="symbol-later-notice" className="text-xs text-amber-600">
          This explicitly reviewed declaration changes later on this lane. Later versions remain
          unreviewed.
        </p>
      )}
      <div className="flex flex-wrap gap-1">
        <Button
          data-testid="previous-symbol-change"
          size="sm"
          variant="outline"
          disabled={broken || uncertain || !previousChange}
          onClick={() => {
            if (previousChange)
              onOpen(previousChange.entry.member.number, previousChange.entry.file)
          }}
        >
          Previous function change
        </Button>
        <Button
          data-testid="next-symbol-change"
          size="sm"
          variant="outline"
          disabled={broken || uncertain || !nextChange}
          onClick={() => {
            if (nextChange) onOpen(nextChange.entry.member.number, nextChange.entry.file)
          }}
        >
          Next function change
        </Button>
      </div>
      {preview && (
        <details open data-testid="symbol-source-preview" className="min-w-0 text-xs">
          <summary>
            #{preview.entry.member.number} · {preview.symbol.name} · {preview.symbol.status}
          </summary>
          <p className="my-1 text-muted-foreground">
            Exact source ranges from the labeled PR. Open its contribution to inspect the semantic
            file diff.
          </p>
          <Button
            data-testid="open-symbol-pr"
            size="sm"
            variant="outline"
            onClick={() => onOpen(preview.entry.member.number, preview.entry.file)}
          >
            Open function in PR context
          </Button>
          {preview.symbol.old_source && (
            <>
              <p>
                Before · lines {preview.symbol.old_start}–{preview.symbol.old_end}
              </p>
              <pre className="max-h-40 overflow-auto rounded bg-muted p-2">
                {preview.symbol.old_source}
              </pre>
            </>
          )}
          {preview.symbol.new_source && (
            <>
              <p>
                After · lines {preview.symbol.new_start}–{preview.symbol.new_end}
              </p>
              <pre className="max-h-40 overflow-auto rounded bg-muted p-2">
                {preview.symbol.new_source}
              </pre>
            </>
          )}
          {canReview &&
            preview.symbol.new_hash &&
            preview.entry.member.number === root.stack?.current &&
            !broken &&
            !uncertain && (
              <Button
                data-testid="mark-symbol-reviewed"
                size="sm"
                variant="outline"
                onClick={() =>
                  onReview(preview.entry.file, preview.symbol.key, preview.symbol.new_hash ?? "")
                }
              >
                {marked(preview) ? "Unmark function review" : "Mark function reviewed"}
              </Button>
            )}
          <p className="mt-1 text-[11px] text-muted-foreground">{preview.result?.policy}</p>
        </details>
      )}
    </section>
  )
}
