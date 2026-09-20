import { useEffect, useRef, useState, type RefObject } from "react"
import { LoaderCircle } from "lucide-react"
import { Button } from "./ui/button"
import { ROW_HEIGHT, visibleRange, type ParsedDiff } from "../lib/diff"

// LRU shared across file switches, with a conservative allocation estimate.
const cache = new Map<string, { result: ParsedDiff; bytes: number }>()
const CACHE_LIMIT = 32 * 1024 * 1024
let cacheBytes = 0
function remember(key: string, result: ParsedDiff, sourceLength: number) {
  const bytes = sourceLength * 2 + result.rows.length * 160
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

async function fetchText(url: string, signal: AbortSignal) {
  const response = await fetch(url, { signal })
  if (!response.ok) {
    const body = await response.json().catch(() => null)
    throw new Error(body?.error || `Unable to load diff (${response.status}).`)
  }
  return response.text()
}

export function DiffViewer({ sessionId, index, path, frameRef }: {
  sessionId: string; index: number; path: string; frameRef: RefObject<HTMLIFrameElement | null>
}) {
  const [mode, setMode] = useState<"text" | "semantic">("text")
  const [attempt, setAttempt] = useState(0)
  const [result, setResult] = useState<ParsedDiff | null>(null)
  const [html, setHtml] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [scrollTop, setScrollTop] = useState(0)
  const [height, setHeight] = useState(600)
  const viewport = useRef<HTMLDivElement>(null)
  const url = `/api/diff/${sessionId}/${index}`

  useEffect(() => {
    const controller = new AbortController()
    let worker: Worker | undefined
    let active = true
    setError(""); setLoading(true); setHtml(null); setScrollTop(0)
    if (viewport.current) viewport.current.scrollTop = 0
    const timer = window.setTimeout(() => {
      if (!active) return
      active = false
      controller.abort(); worker?.terminate()
      setError("The viewer timed out. Retry or switch to Text diff."); setLoading(false)
    }, 45_000)
    const fail = (reason: unknown) => {
      if (!active) return
      clearTimeout(timer)
      setError(reason instanceof Error ? reason.message : "Unable to render this diff.")
      setLoading(false)
    }
    const ready = (parsed: ParsedDiff) => {
      if (!active) return
      clearTimeout(timer); setResult(parsed); setLoading(false)
    }
    const onMessage = (event: MessageEvent) => {
      if (!active || event.origin !== window.location.origin || event.source !== frameRef.current?.contentWindow || event.data?.source !== "local-diffe-viewer") return
      if (event.data.error) fail(new Error(String(event.data.error)))
      else if (event.data.ready) { clearTimeout(timer); setLoading(false) }
    }
    window.addEventListener("message", onMessage)
    if (mode === "text") {
      const hit = cache.get(url)
      if (hit) {
        cache.delete(url); cache.set(url, hit); ready(hit.result)
      } else {
        setResult(null)
        void fetchText(url, controller.signal).then((patch) => {
          if (!active) return
          worker = new Worker(new URL("../diff.worker.ts", import.meta.url), { type: "module" })
          worker.onmessage = (event: MessageEvent<{ result?: ParsedDiff; error?: string }>) => {
            worker?.terminate()
            if (!active) return
            if (event.data.error || !event.data.result) { fail(new Error(event.data.error || "Empty parser response.")); return }
            remember(url, event.data.result, patch.length)
            ready(event.data.result)
          }
          worker.onerror = () => { worker?.terminate(); fail(new Error("The diff parser could not start. Retry loading this file.")) }
          worker.postMessage(patch)
        }).catch(fail)
      }
    } else {
      void fetchText(`/semanticdiff-view/${sessionId}/${index}`, controller.signal)
        .then((source) => { if (active) setHtml(source) }).catch(fail)
    }
    return () => {
      active = false; clearTimeout(timer); controller.abort(); worker?.terminate()
      window.removeEventListener("message", onMessage)
    }
  }, [url, sessionId, index, mode, attempt, frameRef])

  useEffect(() => {
    const element = viewport.current
    if (!element) return
    const measure = () => setHeight(element.clientHeight)
    const observer = new ResizeObserver(measure)
    observer.observe(element); measure()
    return () => observer.disconnect()
  }, [mode, result, loading, error])

  const { start, end } = visibleRange(scrollTop, height, result?.rows.length ?? 0)
  return <div className="flex h-full min-h-0 flex-col">
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-b px-3 py-2">
      <Button size="sm" variant={mode === "text" ? "secondary" : "ghost"} aria-pressed={mode === "text"} onClick={() => setMode("text")}>Text diff</Button>
      <Button size="sm" variant={mode === "semantic" ? "secondary" : "ghost"} aria-pressed={mode === "semantic"} onClick={() => setMode("semantic")}>Semantic diff</Button>
      <a className="ml-auto text-xs text-muted-foreground underline" href={url} download={`${path.split("/").at(-1)}.diff`}>Download patch</a>
    </div>
    {result?.truncated && mode === "text" && <p className="shrink-0 px-3 py-1 text-xs text-muted-foreground">Long lines are shortened to 2,000 characters. Download the patch for complete text.</p>}
    {result?.limited && mode === "text" && <p className="shrink-0 px-3 py-1 text-xs text-muted-foreground">Showing the first 200,000 diff rows. Download the patch for the remaining changes.</p>}
    <div className="relative min-h-0 flex-1">
      {error ? <div role="alert" className="grid h-full place-content-center gap-3 p-6 text-sm"><p>{error}</p><Button variant="outline" onClick={() => setAttempt((n) => n + 1)}>Retry</Button></div>
        : mode === "semantic" ? html && <iframe ref={frameRef} title={`Semantic diff for ${path}`} srcDoc={html} className="h-full w-full border-0 bg-card" sandbox="allow-scripts allow-same-origin" />
        : result && <div ref={viewport} data-testid="diff-scroll" tabIndex={0} role="region" aria-label={`Text diff for ${path}`} onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)} className="h-full overflow-auto font-mono text-xs outline-none" style={{ contain: "strict", tabSize: 4 }}>
          {result.rows.length ? <div style={{ height: result.rows.length * ROW_HEIGHT, minWidth: "100%", width: `${result.width + 22}ch`, position: "relative" }}>
            {result.rows.slice(start, end).map((row, offset) => <div key={start + offset} data-diff-row={start + offset} className={row.kind === "add" ? "bg-emerald-500/10" : row.kind === "remove" ? "bg-red-500/10" : row.kind === "hunk" ? "bg-primary/10 text-primary" : ""} style={{ position: "absolute", top: (start + offset) * ROW_HEIGHT, height: ROW_HEIGHT, lineHeight: `${ROW_HEIGHT}px`, width: "100%", display: "flex", whiteSpace: "pre" }}>
              <span className="sticky left-0 flex shrink-0 select-none bg-card text-muted-foreground" aria-hidden="true"><span className="w-[8ch] pr-2 text-right">{row.old ?? ""}</span><span className="w-[8ch] pr-2 text-right">{row.next ?? ""}</span><span className="w-[3ch] text-center">{row.kind === "add" ? "+" : row.kind === "remove" ? "−" : " "}</span></span>
              <span>{row.text}</span>
            </div>)}
          </div> : <p className="p-4">No text changes in this file.</p>}
        </div>}
      {loading && !error && <div className="absolute inset-0 grid place-items-center bg-card/90" role="status"><span className="flex items-center gap-2 text-sm"><LoaderCircle className="size-4 animate-spin" />{mode === "text" ? "Loading diff…" : "Computing semantic diff…"}</span></div>}
    </div>
  </div>
}
