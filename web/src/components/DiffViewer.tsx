import { memo, Profiler, useEffect, useRef, useState, type RefObject, type UIEvent } from "react"
import { LoaderCircle } from "lucide-react"
import { Button } from "./ui/button"
import { ROW_HEIGHT, visibleRange, type DiffRow, type ParsedDiff } from "../lib/diff"
import type { DiffWorkerMessage } from "../diff.worker"
import { PERFORMANCE_BUILD_ENABLED, mark, measure, onRender, recordPerformance } from "../lib/performance"

type DiffMode = "text" | "semantic"
const MODE_STORAGE_KEY = "local-diffe:diff-mode"

function preferredMode(): DiffMode {
  try {
    return localStorage.getItem(MODE_STORAGE_KEY) === "text" ? "text" : "semantic"
  } catch {
    return "semantic"
  }
}

// LRU shared across file switches, with a conservative allocation estimate.
type RenderDiff = Omit<ParsedDiff, "rows"> & { rows: { length: number; slice(start: number, end: number): DiffRow[] } }

// Each published snapshot owns an immutable list of row chunks. Appending a
// batch copies only the small chunk-reference list, never all prior rows.
class DiffRowStore {
  readonly length: number
  readonly estimatedBytes: number
  constructor(private readonly chunks: readonly DiffRow[][] = [], length = 0, estimatedBytes = 64) {
    this.length = length
    this.estimatedBytes = estimatedBytes
  }
  append(chunk: DiffRow[]) {
    let bytes = 0
    for (const row of chunk) bytes += 112 + row.text.length * 2
    return new DiffRowStore([...this.chunks, chunk], this.length + chunk.length, this.estimatedBytes + bytes)
  }
  slice(start: number, end: number) {
    const rows: DiffRow[] = []
    let offset = 0
    for (const chunk of this.chunks) {
      const chunkEnd = offset + chunk.length
      if (chunkEnd > start && offset < end) {
        rows.push(...chunk.slice(Math.max(0, start - offset), Math.min(chunk.length, end - offset)))
      }
      if (chunkEnd >= end) break
      offset = chunkEnd
    }
    return rows
  }
}

const cache = new Map<string, { result: RenderDiff; bytes: number }>()
const CACHE_LIMIT = 32 * 1024 * 1024
let cacheBytes = 0
let profileRun = 0
function remember(key: string, result: RenderDiff, estimatedBytes: number) {
  // The source patch is not retained by the cache. The row estimate includes
  // object/array overhead plus UTF-16 text. This bounds estimated cache usage,
  // not the browser's heap (which also includes the active diff and worker).
  const bytes = estimatedBytes
  if (bytes > CACHE_LIMIT) return
  const previous = cache.get(key)
  if (previous) { cacheBytes -= previous.bytes; cache.delete(key) }
  while (cacheBytes + bytes > CACHE_LIMIT && cache.size) {
    const oldest = cache.keys().next().value!
    cacheBytes -= cache.get(oldest)!.bytes
    cache.delete(oldest)
  }
  cache.set(key, { result, bytes }); cacheBytes += bytes
}

function cachedResult(key: string) {
  const hit = cache.get(key)
  if (!hit) return null
  cache.delete(key); cache.set(key, hit)
  return hit.result
}

// SemanticDiff returns a complete HTML document. Keep a smaller, independent
// LRU for it so revisiting a file avoids the network and serialization cost
// without allowing large rendered documents to retain the text-diff cache.
const SEMANTIC_CACHE_LIMIT = 8 * 1024 * 1024
const semanticCache = new Map<string, { html: string; bytes: number }>()
let semanticCacheBytes = 0

function rememberSemanticHtml(key: string, html: string) {
  const bytes = html.length * 2
  if (bytes > SEMANTIC_CACHE_LIMIT) return
  const previous = semanticCache.get(key)
  if (previous) {
    semanticCacheBytes -= previous.bytes
    semanticCache.delete(key)
  }
  while (semanticCacheBytes + bytes > SEMANTIC_CACHE_LIMIT && semanticCache.size) {
    const oldest = semanticCache.keys().next().value!
    semanticCacheBytes -= semanticCache.get(oldest)!.bytes
    semanticCache.delete(oldest)
  }
  semanticCache.set(key, { html, bytes })
  semanticCacheBytes += bytes
}

function cachedSemanticHtml(key: string) {
  const hit = semanticCache.get(key)
  if (!hit) return null
  semanticCache.delete(key)
  semanticCache.set(key, hit)
  return hit.html
}

function forgetSemanticHtml(key: string) {
  const hit = semanticCache.get(key)
  if (!hit) return
  semanticCacheBytes -= hit.bytes
  semanticCache.delete(key)
}

async function fetchText(url: string, signal: AbortSignal, profileKey?: string) {
  const fetchMark = profileKey ? `${profileKey}:fetch` : undefined
  if (PERFORMANCE_BUILD_ENABLED && fetchMark) mark(fetchMark)
  const response = await fetch(url, { signal })
  if (PERFORMANCE_BUILD_ENABLED && fetchMark) {
    measure(`${profileKey}:headers`, fetchMark, { status: response.status })
    mark(`${profileKey}:body`)
  }
  if (!response.ok) {
    const body = await response.json().catch(() => null)
    throw new Error(body?.error || `Unable to load diff (${response.status}).`)
  }
  const text = await response.text()
  if (PERFORMANCE_BUILD_ENABLED && profileKey) measure(`${profileKey}:body`, `${profileKey}:body`, { characters: text.length })
  return text
}

const TextDiff = memo(function TextDiff({ result, path }: { result: RenderDiff; path: string }) {
  const [height, setHeight] = useState(600)
  const scrollTop = useRef(0)
  const viewport = useRef<HTMLDivElement>(null)
  const [range, setRange] = useState(() => visibleRange(0, 600, result.rows.length))

  useEffect(() => {
    const element = viewport.current
    if (!element) return
    const measure = () => setHeight(element.clientHeight)
    const observer = new ResizeObserver(measure)
    observer.observe(element); measure()
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const next = visibleRange(scrollTop.current, height, result.rows.length)
    setRange((current) => current.start === next.start && current.end === next.end ? current : next)
  }, [height, result.rows.length])

  const rows = result.rows.slice(range.start, range.end)
  const onScroll = (event: UIEvent<HTMLDivElement>) => {
    const top = event.currentTarget.scrollTop
    scrollTop.current = top
    const next = visibleRange(top, height, result.rows.length)
    setRange((current) => current.start === next.start && current.end === next.end ? current : next)
  }
  return <div ref={viewport} data-testid="diff-scroll" tabIndex={0} role="region" aria-label={`Text diff for ${path}`} onScroll={onScroll} className="h-full overflow-auto font-mono text-xs outline-none" style={{ contain: "strict", tabSize: 4 }}>
    {result.rows.length ? <div style={{ height: result.rows.length * ROW_HEIGHT, minWidth: "100%", width: `${result.width + 22}ch`, position: "relative" }}>
      {rows.map((row, offset) => <DiffRowView key={range.start + offset} row={row} index={range.start + offset} />)}
    </div> : <p className="p-4">No text changes in this file.</p>}
  </div>
})

const DiffRowView = memo(function DiffRowView({ row, index }: { row: DiffRow; index: number }) {
  return <div data-diff-row={index} className={row.kind === "add" ? "bg-emerald-500/10" : row.kind === "remove" ? "bg-red-500/10" : row.kind === "hunk" ? "bg-primary/10 text-primary" : ""} style={{ position: "absolute", top: index * ROW_HEIGHT, height: ROW_HEIGHT, lineHeight: `${ROW_HEIGHT}px`, width: "100%", display: "flex", whiteSpace: "pre" }}>
    <span className="sticky left-0 flex shrink-0 select-none bg-card text-muted-foreground" aria-hidden="true"><span className="w-[8ch] pr-2 text-right">{row.old ?? ""}</span><span className="w-[8ch] pr-2 text-right">{row.next ?? ""}</span><span className="w-[3ch] text-center">{row.kind === "add" ? "+" : row.kind === "remove" ? "−" : " "}</span></span>
    <span>{row.text}</span>
  </div>
})

function DiffViewerContent({ sessionId, index, path, frameRef }: {
  sessionId: string; index: number; path: string; frameRef: RefObject<HTMLIFrameElement | null>
}) {
  const [mode, setMode] = useState<DiffMode>(preferredMode)
  const [attempt, setAttempt] = useState(0)
  const url = `/api/diff/${sessionId}/${index}`
  const semanticUrl = `/semanticdiff-view/${sessionId}/${index}`
  const initialResult = mode === "text" ? cache.get(url)?.result ?? null : null
  const [result, setResult] = useState<RenderDiff | null>(initialResult)
  const [html, setHtml] = useState<string | null>(null)
  const [loading, setLoading] = useState(() => !initialResult)
  const [complete, setComplete] = useState(() => Boolean(initialResult))
  const [error, setError] = useState("")

  useEffect(() => {
    try {
      localStorage.setItem(MODE_STORAGE_KEY, mode)
    } catch {
      // The viewer remains usable when browser storage is unavailable.
    }
  }, [mode])

  useEffect(() => {
    const controller = new AbortController()
    let worker: Worker | undefined
    let active = true
    let frame = 0
    let pendingBatches: Extract<DiffWorkerMessage, { type: "batch" }>[] = []
    const profileKey = PERFORMANCE_BUILD_ENABLED ? `diff:${++profileRun}` : undefined
    setError(""); setLoading(true); setHtml(null)
    const hit = mode === "text" ? cachedResult(url) : null
    if (mode === "text") setResult(hit)
    else setResult(null)
    setComplete(mode === "text" && Boolean(hit))
    if (hit) setLoading(false)
    const timer = window.setTimeout(() => {
      if (!active) return
      fail(new Error("The viewer timed out. Retry or switch to Text diff."))
    }, 45_000)
    const fail = (reason: unknown) => {
      if (!active) return
      if (mode === "semantic") forgetSemanticHtml(semanticUrl)
      active = false
      clearTimeout(timer)
      controller.abort(); worker?.terminate()
      if (frame) window.cancelAnimationFrame(frame)
      pendingBatches = []
      setError(reason instanceof Error ? reason.message : "Unable to render this diff.")
      setLoading(false)
    }
    const ready = (parsed: RenderDiff) => {
      if (!active) return
      clearTimeout(timer); setResult(parsed); setComplete(true); setLoading(false)
    }
    const onMessage = (event: MessageEvent) => {
      if (!active || event.origin !== window.location.origin || event.source !== frameRef.current?.contentWindow) return
      // The upstream viewer accepts state updates only from its parent. Relay
      // the worker's decorated state solely to the currently mounted frame.
      if (event.data?.source === "semanticdiff-highlight" && event.data.message?.type === "SetState" && event.data.message.state?.patch) {
        frameRef.current?.contentWindow?.postMessage(event.data.message, window.location.origin)
        return
      }
      if (event.data?.source !== "local-diffe-viewer") return
      if (event.data.error) fail(new Error(String(event.data.error)))
      else if (event.data.ready) { clearTimeout(timer); setLoading(false) }
    }
    window.addEventListener("message", onMessage)
    if (mode === "text") {
      const hit = cache.get(url)
      if (hit) {
        ready(hit.result)
      } else {
        setResult(null)
        void fetchText(url, controller.signal, profileKey).then((patch) => {
          if (!active) return
          worker = new Worker(new URL("../diff.worker.ts", import.meta.url), { type: "module" })
          if (profileKey) {
            mark(`${profileKey}:worker`)
            mark(`${profileKey}:worker-total`)
          }
          let rowStore = new DiffRowStore()
          let pendingWidth = 0
          let pendingTruncated = false
          const publish = () => {
            frame = 0
            if (!active || !pendingBatches.length) return
            for (const pending of pendingBatches) rowStore = rowStore.append(pending.rows)
            pendingBatches = []
            setResult({ rows: rowStore, width: pendingWidth, truncated: pendingTruncated, limited: false })
            setLoading(false)
          }
          const schedulePublish = () => {
            if (!frame) frame = window.requestAnimationFrame(publish)
          }
          worker.onmessage = (event: MessageEvent<DiffWorkerMessage>) => {
            if (!active) return
            if (event.data.type === "error") { worker?.terminate(); fail(new Error(event.data.error)); return }
            if (event.data.type === "batch") {
              // Publish a new chunk-reference snapshot. A rows.slice/spread
              // per batch would make a 200k-row diff quadratic before it
              // could finish parsing.
              pendingWidth = event.data.width
              pendingTruncated = event.data.truncated
              if (!rowStore.length) {
                rowStore = rowStore.append(event.data.rows)
                setResult({ rows: rowStore, width: pendingWidth, truncated: pendingTruncated, limited: false })
                setLoading(false)
                if (profileKey) measure(`${profileKey}:first-batch`, `${profileKey}:worker`, { rows: rowStore.length })
              } else {
                pendingBatches.push(event.data)
                schedulePublish()
              }
            } else if (event.data.type === "done") {
              if (frame) { window.cancelAnimationFrame(frame); frame = 0 }
              publish()
              worker?.terminate()
              const parsed = { rows: rowStore, width: event.data.width, truncated: event.data.truncated, limited: event.data.limited }
              remember(url, parsed, rowStore.estimatedBytes)
              if (profileKey) {
                measure(`${profileKey}:complete`, `${profileKey}:worker-total`, { rows: rowStore.length })
                if (event.data.profile) {
                  const startTimeMs = event.data.profile.startedAt - performance.timeOrigin
                  recordPerformance({ name: `${profileKey}:worker-parse`, durationMs: event.data.profile.parseDurationMs, startTimeMs, endTimeMs: startTimeMs + event.data.profile.parseDurationMs, detail: { rows: rowStore.length, firstBatchMs: event.data.profile.firstBatchDurationMs } })
                }
              }
              ready(parsed)
            }
          }
          worker.onerror = () => { worker?.terminate(); fail(new Error("The diff parser could not start. Retry loading this file.")) }
          worker.postMessage({ patch })
        }).catch(fail)
      }
    } else {
      const hit = cachedSemanticHtml(semanticUrl)
      if (hit !== null) {
        setHtml(hit)
      } else {
        void fetchText(semanticUrl, controller.signal, profileKey)
          .then((source) => {
            if (!active) return
            rememberSemanticHtml(semanticUrl, source)
            setHtml(source)
          }).catch(fail)
      }
    }
    return () => {
      active = false; clearTimeout(timer); controller.abort(); worker?.terminate()
      if (frame) window.cancelAnimationFrame(frame)
      window.removeEventListener("message", onMessage)
    }
  }, [url, semanticUrl, sessionId, index, mode, attempt, frameRef])

  const textDiff = result && (PERFORMANCE_BUILD_ENABLED
    ? <Profiler id="DiffViewer.TextDiff" onRender={onRender}><TextDiff result={result} path={path} /></Profiler>
    : <TextDiff result={result} path={path} />)
  return <div className="flex h-full min-h-0 flex-col" data-diff-complete={mode === "text" ? complete : true} data-diff-row-count={mode === "text" ? result?.rows.length ?? 0 : 0}>
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-b px-3 py-2">
      <Button size="sm" variant={mode === "text" ? "secondary" : "ghost"} aria-pressed={mode === "text"} onClick={() => setMode("text")}>Text diff</Button>
      <Button size="sm" variant={mode === "semantic" ? "secondary" : "ghost"} aria-pressed={mode === "semantic"} onClick={() => setMode("semantic")}>Semantic diff</Button>
    </div>
    {result?.truncated && mode === "text" && <p className="shrink-0 px-3 py-1 text-xs text-muted-foreground">Long lines are shortened to 2,000 characters.</p>}
    {result?.limited && mode === "text" && <p className="shrink-0 px-3 py-1 text-xs text-muted-foreground">Showing the first 200,000 diff rows of this file.</p>}
    <div className="relative min-h-0 flex-1">
      {error ? <div role="alert" className="grid h-full place-content-center gap-3 p-6 text-sm"><p>{error}</p><Button variant="outline" onClick={() => setAttempt((n) => n + 1)}>Retry</Button></div>
        : mode === "semantic" ? html && <iframe ref={frameRef} title={`Semantic diff for ${path}`} srcDoc={html} className="h-full w-full border-0 bg-card" sandbox="allow-scripts allow-same-origin" />
        : textDiff}
      {loading && !error && <div className="absolute inset-0 grid place-items-center bg-card/90" role="status"><span className="flex items-center gap-2 text-sm"><LoaderCircle className="size-4 animate-spin" />{mode === "text" ? "Loading diff…" : "Computing semantic diff…"}</span></div>}
    </div>
  </div>
}

export const DiffViewer = memo(function DiffViewer(props: { sessionId: string; index: number; path: string; frameRef: RefObject<HTMLIFrameElement | null> }) {
  const content = <DiffViewerContent {...props} />
  return PERFORMANCE_BUILD_ENABLED ? <Profiler id="DiffViewer" onRender={onRender}>{content}</Profiler> : content
})
