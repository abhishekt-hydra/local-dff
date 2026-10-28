import { useCallback, useEffect, useMemo, useState } from "react"
import { api, reviewSnapshotSchema, type PatchFile } from "./review-api"
import {
  EVIDENCE_STORAGE_KEY,
  boundedEvidence,
  evidenceIdentity,
  parseEvidence,
  recordIdentity,
  type EvidenceContext,
  type ReviewEvidence,
} from "./review-evidence"

export function useReviewEvidence(context: EvidenceContext | null, files: PatchFile[]) {
  const [records, setRecords] = useState<ReviewEvidence[]>(() => {
    try {
      return parseEvidence(localStorage.getItem(EVIDENCE_STORAGE_KEY))
    } catch {
      return []
    }
  })
  const [warning, setWarning] = useState(() => {
    try {
      const legacy = Object.keys(localStorage).some((key) => key.startsWith("local-diffe:viewed:"))
      return legacy
        ? "Older viewed marks lack verified repository identity and are not carried over. Mark these revisions explicitly."
        : ""
    } catch {
      return "Local storage unavailable; review progress is kept in memory only."
    }
  })
  useEffect(() => {
    try {
      localStorage.setItem(EVIDENCE_STORAGE_KEY, JSON.stringify(records))
    } catch {
      // oxlint-disable-next-line react/set-state-in-effect -- Report external storage denial without blocking in-memory review.
      setWarning("Local storage unavailable or full; review progress is kept in memory only.")
    }
  }, [records])
  useEffect(() => {
    const receive = (event: StorageEvent) => {
      if (event.key === EVIDENCE_STORAGE_KEY) setRecords(parseEvidence(event.newValue))
    }
    window.addEventListener("storage", receive)
    return () => window.removeEventListener("storage", receive)
  }, [])
  const viewedFiles = useMemo(() => {
    if (!context) return new Set<number>()
    const marked = new Set(records.filter((record) => !record.symbol).map(recordIdentity))
    return new Set(
      files.flatMap((file, index) => (marked.has(evidenceIdentity(context, file)) ? [index] : [])),
    )
  }, [context, files, records])

  const toggle = useCallback(
    (file: PatchFile, sessionId: string, index: number, symbol?: { key: string; hash: string }) => {
      if (!context) return
      const identity = evidenceIdentity(context, file, symbol)
      const existing = records.some((record) => recordIdentity(record) === identity)
      if (existing) {
        setRecords((current) => current.filter((record) => recordIdentity(record) !== identity))
        return
      }
      const record: ReviewEvidence = {
        context,
        path: file.display_path,
        old_path: file.old_path,
        new_path: file.new_path,
        reviewed_at: Date.now(),
        ...(symbol ? { symbol } : {}),
      }
      setRecords((current) => boundedEvidence([...current, record]))
      if (symbol) return
      // Retention is separate from local evidence. A denied/evicted server snapshot
      // never deletes the review mark or prevents a fresh full review.
      void api("/api/review-snapshot", { id: sessionId, index }, reviewSnapshotSchema)
        .then(({ snapshot_id }) =>
          setRecords((current) =>
            current.map((entry) =>
              recordIdentity(entry) === identity ? { ...entry, snapshot_id } : entry,
            ),
          ),
        )
        .catch(() =>
          setWarning(
            "Review recorded locally; its historical snapshot could not be retained. Changes since review may be unavailable.",
          ),
        )
    },
    [context, records],
  )

  return { records, viewedFiles, warning, toggle }
}
