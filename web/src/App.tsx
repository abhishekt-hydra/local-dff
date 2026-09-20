import { createContext, memo, Profiler, useCallback, useContext, useDeferredValue, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react"
import { Tree, type NodeRendererProps } from "react-arborist"
import {
  ChevronRight,
  ChevronDown,
  ChevronUp,
  ChevronsUpDown,
  Check,
  FileCode2,
  FileDiff,
  Folder,
  FolderOpen,
  GitBranch,
  GitPullRequest,
  GripVertical,
  Keyboard,
  Link,
  LoaderCircle,
  Minus,
  Plus,
  Search,
  Sparkles,
  Upload,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { cn } from "@/lib/utils"
import { DiffViewer } from "@/components/DiffViewer"
import { buildFileNavigation, makeTree, type TreeItem } from "./sidebarTree"
import { PERFORMANCE_BUILD_ENABLED, onRender } from "./lib/performance"

type PatchFile = { old_path: string | null; new_path: string | null; display_path: string; renderable: boolean }
type Revision = { revision: string; commit: string }
type PullRequest = { number: number; title: string; url: string; state: string; baseRefName: string; headRefName: string; isDraft: boolean; author?: { login: string } | null; updatedAt: string }
type Comparison = { base: Revision; target: Revision; changed_paths: number; semantic_paths: number; description: string; pull_request?: PullRequest | null }
type Session = { id: string; files: PatchFile[]; comparison?: Comparison | null }
const EMPTY_FILES: PatchFile[] = []

type ReviewRegion = "sidebar" | "diff"

function isEditableTarget(target: EventTarget | null) {
  return target instanceof HTMLElement && Boolean(target.closest('input, textarea, select, [contenteditable="true"], [role="textbox"]'))
}

const initialRepo = "/Users/abhishek/hydradb/hydradb-application"

// Session ids are fresh UUIDs per comparison, so viewed state is keyed by the
// revisions under review and stored as display paths: both survive a reload and
// a re-generated session whose file order changed.
function viewedStorageKey(session: Session | null) {
  if (!session) return null
  const comparison = session.comparison
  if (comparison) {
    const scope = comparison.pull_request ? `pr-${comparison.pull_request.number}` : `${comparison.base.revision}..${comparison.target.revision}`
    return `local-diffe:viewed:${scope}:${comparison.base.commit}:${comparison.target.commit}`
  }
  return `local-diffe:viewed:patch:${session.files.length}:${session.files[0]?.display_path ?? ""}`
}

function readViewedPaths(key: string) {
  try {
    const stored = JSON.parse(window.localStorage.getItem(key) ?? "[]")
    return new Set<string>(Array.isArray(stored) ? stored.filter((entry): entry is string => typeof entry === "string") : [])
  } catch {
    return new Set<string>()
  }
}

type TreeRowProps = NodeRendererProps<TreeItem> & {
  active: boolean
  viewed: boolean
  sidebarScale: number
  sidebarFontSize: number
  sidebarRowHeight: number
  sidebarIconSize: number
  sidebarGap: number
  sidebarPadding: number
  onSelectFile: (fileIndex: number) => void
}

const TreeRow = memo(function TreeRow({
  node,
  style,
  dragHandle,
  active,
  viewed,
  sidebarScale,
  sidebarFontSize,
  sidebarRowHeight,
  sidebarIconSize,
  sidebarGap,
  sidebarPadding,
  onSelectFile,
}: TreeRowProps) {
  const item = node.data
  const isFile = item.fileIndex !== undefined
  const canRender = !isFile || item.renderable !== false
  return (
    <div style={{ ...style, paddingRight: Math.max(1, Math.round(4 * sidebarScale)) }} ref={dragHandle}>
      <button
        type="button"
        data-file-index={isFile ? item.fileIndex : undefined}
        onClick={() => isFile ? canRender && onSelectFile(item.fileIndex!) : node.toggle()}
        title={isFile && !canRender ? "Empty or metadata-only Git change — no semantic text diff" : undefined}
        style={{ fontSize: sidebarFontSize, height: sidebarRowHeight, gap: sidebarGap, paddingInline: sidebarPadding }}
        className={cn("flex w-full items-center rounded text-left hover:bg-accent", active && "bg-accent text-accent-foreground", !canRender && "cursor-default opacity-45 hover:bg-transparent")}
      >
        {isFile ? <span className="shrink-0" style={{ width: sidebarIconSize }} /> : <ChevronRight style={{ width: sidebarIconSize, height: sidebarIconSize }} className={cn("shrink-0 transition-transform", node.isOpen && "rotate-90")} />}
        {isFile ? <FileCode2 style={{ width: sidebarIconSize, height: sidebarIconSize }} className={cn("shrink-0", canRender ? "text-sky-600" : "text-muted-foreground")} /> : node.isOpen ? <FolderOpen style={{ width: sidebarIconSize, height: sidebarIconSize }} className="shrink-0 text-amber-500" /> : <Folder style={{ width: sidebarIconSize, height: sidebarIconSize }} className="shrink-0 text-amber-500" />}
        <span className="truncate">{item.name}</span>
        {isFile && viewed && <span className="ml-auto shrink-0 text-emerald-600" title="Viewed"><Check aria-hidden="true" style={{ width: sidebarIconSize, height: sidebarIconSize }} /><span className="sr-only">Viewed</span></span>}
      </button>
    </div>
  )
})

type SidebarTreeContextValue = Omit<TreeRowProps, "node" | "style" | "dragHandle" | "tree" | "active" | "viewed"> & {
  selected: number | null
  viewedFiles: ReadonlySet<number>
}
const SidebarTreeContext = createContext<SidebarTreeContextValue | null>(null)

const SidebarTreeRow = (props: NodeRendererProps<TreeItem>) => {
  const context = useContext(SidebarTreeContext)
  if (!context) return null
  const fileIndex = props.node.data.fileIndex
  const { selected, viewedFiles, ...rowProps } = context
  return <TreeRow {...props} {...rowProps} active={fileIndex !== undefined && fileIndex === selected} viewed={fileIndex !== undefined && viewedFiles.has(fileIndex)} />
}

function SidebarProfilerBoundary({ children }: { children: ReactNode }) {
  return PERFORMANCE_BUILD_ENABLED ? <Profiler id="Sidebar" onRender={onRender}>{children}</Profiler> : <>{children}</>
}

const SidebarTree = memo(function SidebarTree({
  tree,
  treeHeight,
  rowHeight,
  indent,
  searchTerm,
  selected,
  viewedFiles,
  sidebarScale,
  sidebarFontSize,
  sidebarIconSize,
  sidebarGap,
  sidebarPadding,
  onSelectFile,
}: {
  tree: TreeItem[]
  treeHeight: number
  rowHeight: number
  indent: number
  searchTerm: string
  selected: number | null
  viewedFiles: ReadonlySet<number>
  sidebarScale: number
  sidebarFontSize: number
  sidebarIconSize: number
  sidebarGap: number
  sidebarPadding: number
  onSelectFile: (fileIndex: number) => void
}) {
  const context = useMemo(() => ({ selected, viewedFiles, sidebarScale, sidebarFontSize, sidebarRowHeight: rowHeight, sidebarIconSize, sidebarGap, sidebarPadding, onSelectFile }), [onSelectFile, rowHeight, selected, sidebarFontSize, sidebarGap, sidebarIconSize, sidebarPadding, sidebarScale, viewedFiles])
  return <SidebarTreeContext.Provider value={context}><Tree<TreeItem> data={tree} width="100%" height={treeHeight} rowHeight={rowHeight} indent={indent} openByDefault disableDrag disableDrop searchTerm={searchTerm}>{SidebarTreeRow}</Tree></SidebarTreeContext.Provider>
})

async function api<T>(path: string, payload: unknown): Promise<T> {
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  })
  const body = await response.json()
  if (!response.ok) throw new Error(body.error || "Request failed")
  return body as T
}

export default function App() {
  const [repo, setRepo] = useState(initialRepo)
  const [base, setBase] = useState("origin/staging")
  const [target, setTarget] = useState("HEAD")
  const [prUrl, setPrUrl] = useState("")
  const [pulls, setPulls] = useState<PullRequest[]>([])
  const [prNumber, setPrNumber] = useState("")
  const [prPickerOpen, setPrPickerOpen] = useState(false)
  const [chromeHidden, setChromeHidden] = useState(false)
  const [keyboardOverlay, setKeyboardOverlay] = useState(false)
  const [keyboardOverlayExpanded, setKeyboardOverlayExpanded] = useState(false)
  const [activeRegion, setActiveRegion] = useState<ReviewRegion>("sidebar")
  const [sidebarWidth, setSidebarWidth] = useState(320)
  const [sidebarFontSize, setSidebarFontSize] = useState(12)
  const [resizingSidebar, setResizingSidebar] = useState(false)
  const [session, setSession] = useState<Session | null>(null)
  const [selected, setSelected] = useState<number | null>(null)
  const [viewedFiles, setViewedFiles] = useState<Set<number>>(() => new Set())
  const [search, setSearch] = useState("")
  const [status, setStatus] = useState("Ready to compare origin/staging with the checked-out branch.")
  const [loading, setLoading] = useState(false)
  const reviewGrid = useRef<HTMLDivElement>(null)
  const sidebarRef = useRef<HTMLDivElement>(null)
  const sidebarContentRef = useRef<HTMLDivElement>(null)
  const diffPanelRef = useRef<HTMLDivElement>(null)
  const diffFrameRef = useRef<HTMLIFrameElement>(null)
  const resizeOriginLeftRef = useRef(0)
  const resizePendingWidthRef = useRef<number | null>(null)
  const resizeFrameRef = useRef<number | null>(null)
  const hydratedViewedKeyRef = useRef<string | null>(null)
  const textViewportCacheRef = useRef<HTMLElement | null | undefined>(undefined)
  const semanticScrollCacheRef = useRef<{ document: Document; target: HTMLElement | null } | undefined>(undefined)
  const [treeHeight, setTreeHeight] = useState(480)
  const files = session?.files ?? EMPTY_FILES
  const tree = useMemo(() => makeTree(files), [files])
  const fileNavigation = useMemo(() => buildFileNavigation(files), [files])
  const deferredSearch = useDeferredValue(search)
  const selectedPull = useMemo(() => pulls.find((pull) => String(pull.number) === prNumber), [pulls, prNumber])
  const viewedKey = useMemo(() => viewedStorageKey(session), [session])
  const sidebarScale = sidebarFontSize / 12
  const sidebarRowHeight = Math.max(20, Math.round(28 * sidebarScale))
  const sidebarIconSize = Math.max(11, Math.round(14 * sidebarScale))
  const sidebarGap = Math.max(2, Math.round(6 * sidebarScale))
  const sidebarPadding = Math.max(2, Math.round(6 * sidebarScale))

  const startSidebarResize = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    event.preventDefault()
    // Capture the stable grid origin once at drag start. Pointer moves only
    // update the pending width and are committed at most once per frame.
    resizeOriginLeftRef.current = reviewGrid.current?.getBoundingClientRect().left ?? 0
    resizePendingWidthRef.current = null
    setResizingSidebar(true)
  }, [])

  useEffect(() => {
    if (!resizingSidebar) return
    const resize = (event: globalThis.PointerEvent) => {
      resizePendingWidthRef.current = Math.max(220, Math.min(760, event.clientX - resizeOriginLeftRef.current))
      if (resizeFrameRef.current !== null) return
      resizeFrameRef.current = requestAnimationFrame(() => {
        resizeFrameRef.current = null
        const nextWidth = resizePendingWidthRef.current
        if (nextWidth !== null) setSidebarWidth((current) => current === nextWidth ? current : nextWidth)
      })
    }
    const stop = () => {
      if (resizeFrameRef.current !== null) cancelAnimationFrame(resizeFrameRef.current)
      resizeFrameRef.current = null
      const nextWidth = resizePendingWidthRef.current
      resizePendingWidthRef.current = null
      if (nextWidth !== null) setSidebarWidth((current) => current === nextWidth ? current : nextWidth)
      setResizingSidebar(false)
    }
    window.addEventListener("pointermove", resize)
    window.addEventListener("pointerup", stop, { once: true })
    return () => {
      window.removeEventListener("pointermove", resize)
      window.removeEventListener("pointerup", stop)
      if (resizeFrameRef.current !== null) cancelAnimationFrame(resizeFrameRef.current)
      resizeFrameRef.current = null
    }
  }, [resizingSidebar])

  useEffect(() => {
    const element = sidebarContentRef.current
    if (!element) return
    const updateHeight = (entry: ResizeObserverEntry) => {
      // The tree is a flex child inside the sidebar card. Reading its own
      // height while assigning the tree height creates a positive feedback
      // loop through the grid's intrinsic row size. `contain:size` on the
      // body removes that intrinsic contribution; contentRect is the body's
      // content box and tracks the fixed grid/diff-panel height.
      const nextHeight = Math.max(160, Math.floor(entry.contentRect.height))
      setTreeHeight((current) => current === nextHeight ? current : nextHeight)
    }
    const observer = new ResizeObserver(([entry]) => updateHeight(entry))
    observer.observe(element)
    return () => observer.disconnect()
  }, [session, chromeHidden])

  useEffect(() => {
    if (!viewedKey) {
      hydratedViewedKeyRef.current = null
      return
    }
    const paths = readViewedPaths(viewedKey)
    const restored = new Set<number>()
    files.forEach((file, index) => { if (paths.has(file.display_path)) restored.add(index) })
    hydratedViewedKeyRef.current = viewedKey
    setViewedFiles(restored)
  }, [files, viewedKey])

  useEffect(() => {
    // Only write once this key's stored state has been read back, so the empty
    // set a fresh session starts with never erases what was saved for it.
    if (!viewedKey || hydratedViewedKeyRef.current !== viewedKey) return
    const paths = [...viewedFiles].map((index) => files[index]?.display_path).filter((path): path is string => Boolean(path))
    try {
      if (paths.length) window.localStorage.setItem(viewedKey, JSON.stringify(paths))
      else window.localStorage.removeItem(viewedKey)
    } catch {
      // Private browsing or a full quota: viewed state stays in-memory only.
    }
  }, [files, viewedFiles, viewedKey])

  useEffect(() => {
    // DiffViewer replaces both viewports when the selected file changes.
    // Keyboard scrolling validates connected cached nodes and retries when a
    // renderer has not mounted yet, so no subtree observer is needed here.
    textViewportCacheRef.current = undefined
    semanticScrollCacheRef.current = undefined
  }, [selected, session?.id])

  const loadSession = async (endpoint: string, payload: unknown, progress: string) => {
    setLoading(true)
    setStatus(progress)
    try {
      const next = await api<Session>(endpoint, payload)
      setSession(next)
      setSelected(null)
      setViewedFiles(new Set())
      if (next.comparison) {
        const { base: resolvedBase, target: resolvedTarget, changed_paths, semantic_paths, pull_request } = next.comparison
        const revisions = `${resolvedBase.commit.slice(0, 7)} → ${resolvedTarget.commit.slice(0, 7)}`
        setStatus(pull_request ? `PR #${pull_request.number} · ${changed_paths} changed paths · ${semantic_paths} content diffs · ${revisions}` : `${changed_paths} changed paths · ${semantic_paths} content diffs · ${resolvedBase.revision}@${resolvedBase.commit.slice(0, 7)} → ${resolvedTarget.revision}@${resolvedTarget.commit.slice(0, 7)}`)
      } else {
        setStatus(`${next.files.length} text patches loaded · select one to inspect its semantic diff`)
      }
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Unable to create comparison")
    } finally {
      setLoading(false)
    }
  }

  const generate = () => loadSession("/api/git-diff", { repo, base, target }, `Generating ${base} → ${target}…`)
  const upload = async (file?: File) => {
    if (!file) return
    await loadSession("/api/patch", { repo, base, target, patch: await file.text() }, `Reading ${file.name}…`)
  }
  const listPulls = async (refresh = false) => {
    setLoading(true)
    setStatus(refresh ? "Refreshing open pull requests from GitHub…" : "Checking GitHub for open pull requests…")
    try {
      const next = await api<PullRequest[]>("/api/github/open-prs", { repo, refresh })
      setPulls(next)
      setPrNumber(next[0] ? String(next[0].number) : "")
      setStatus(next.length ? `${next.length} open pull requests found; downloading them into the PR cache in the background.` : "No open pull requests found for this repository.")
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Unable to list pull requests")
    } finally {
      setLoading(false)
    }
  }
  const openPull = () => {
    if (!prNumber) {
      setStatus("Choose an open pull request first.")
      return
    }
    void loadSession("/api/github/compare", { repo, number: Number(prNumber) }, `Fetching PR #${prNumber} and generating its merge-base diff…`)
  }
  const openPrUrl = () => {
    if (!prUrl.trim()) {
      setStatus("Paste a GitHub pull-request URL first.")
      return
    }
    void loadSession("/api/github/open-url", { url: prUrl }, "Downloading the GitHub pull request if needed and generating its merge-base diff…")
  }

  const focusSidebar = useCallback(() => {
    setActiveRegion("sidebar")
    requestAnimationFrame(() => sidebarRef.current?.focus())
  }, [])

  const focusDiff = useCallback(() => {
    const firstRenderable = fileNavigation.indices[0]
    if (selected === null && firstRenderable !== undefined) setSelected(firstRenderable)
    setActiveRegion("diff")
  }, [fileNavigation, selected])

  const moveFile = useCallback((direction: 1 | -1) => {
    const { indices, positions } = fileNavigation
    if (!indices.length) return
    const current = selected === null ? -1 : (positions.get(selected) ?? -1)
    const next = current === -1
      ? (direction === 1 ? 0 : indices.length - 1)
      : (current + direction + indices.length) % indices.length
    setSelected(indices[next])
  }, [fileNavigation, selected])

  const scrollDiff = useCallback((direction: 1 | -1) => {
    const panel = diffPanelRef.current
    let textViewport = textViewportCacheRef.current
    if (!textViewport || !textViewport.isConnected || !panel?.contains(textViewport)) {
      textViewport = panel?.querySelector<HTMLElement>('[data-testid="diff-scroll"]') ?? null
      textViewportCacheRef.current = textViewport
    }
    if (textViewport) {
      textViewport.scrollBy({ top: Math.max(160, textViewport.clientHeight * 0.72) * direction })
      return
    }
    const frame = diffFrameRef.current
    const document = frame?.contentDocument
    const viewport = frame?.contentWindow
    if (!document || !viewport) return
    let scrollTarget = semanticScrollCacheRef.current?.document === document
      ? semanticScrollCacheRef.current.target
      : null
    if (!scrollTarget || !scrollTarget.isConnected || scrollTarget.ownerDocument !== document || scrollTarget.scrollHeight <= scrollTarget.clientHeight + 1) {
      scrollTarget = [document.scrollingElement, ...document.querySelectorAll<HTMLElement>("*")]
        .filter((element): element is HTMLElement => Boolean(element && element.scrollHeight > element.clientHeight + 1))
        .sort((left, right) => (right.scrollHeight - right.clientHeight) - (left.scrollHeight - left.clientHeight))[0] ?? null
      semanticScrollCacheRef.current = scrollTarget ? { document, target: scrollTarget } : undefined
    }
    const distance = Math.max(160, Math.round(viewport.innerHeight * 0.72)) * direction
    if (scrollTarget) {
      const nextTop = Math.max(0, Math.min(scrollTarget.scrollHeight - scrollTarget.clientHeight, scrollTarget.scrollTop + distance))
      scrollTarget.scrollTop = nextTop
    }
    else viewport.scrollBy({ top: distance, behavior: "smooth" })
  }, [])

  const toggleKeyboardOverlay = useCallback(() => {
    setKeyboardOverlay((open) => {
      const next = !open
      setKeyboardOverlayExpanded(next)
      return next
    })
  }, [])

  const showKeyboardHelp = useCallback(() => {
    setKeyboardOverlay(true)
    setKeyboardOverlayExpanded(true)
  }, [])

  const runOverlayCommand = useCallback((key: string) => {
    switch (key.toLowerCase()) {
      case "f":
        focusSidebar()
        break
      case "d":
        focusDiff()
        break
      case "v":
        setChromeHidden(true)
        focusDiff()
        break
      case "j":
        if (activeRegion === "diff") scrollDiff(1)
        else moveFile(1)
        break
      case "k":
        if (activeRegion === "diff") scrollDiff(-1)
        else moveFile(-1)
        break
    }
  }, [activeRegion, focusDiff, focusSidebar, moveFile, scrollDiff])

  useEffect(() => {
    if (activeRegion !== "diff") return
    const frame = requestAnimationFrame(() => (diffFrameRef.current ?? diffPanelRef.current)?.focus())
    return () => cancelAnimationFrame(frame)
  }, [activeRegion, selected, session?.id])

  useEffect(() => {
    if (!keyboardOverlay || !keyboardOverlayExpanded) return
    const timer = window.setTimeout(() => setKeyboardOverlayExpanded(false), 20_000)
    return () => window.clearTimeout(timer)
  }, [keyboardOverlay, keyboardOverlayExpanded])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (isEditableTarget(event.target)) return
      if (event.key === "-") {
        event.preventDefault()
        toggleKeyboardOverlay()
        return
      }
      if (event.key === "?") {
        event.preventDefault()
        showKeyboardHelp()
        return
      }
      if (event.key === "Escape" && keyboardOverlay) {
        event.preventDefault()
        setKeyboardOverlay(false)
        return
      }
      if (!keyboardOverlay) return
      const key = event.key.toLowerCase()
      if (["f", "d", "v", "j", "k"].includes(key)) {
        event.preventDefault()
        runOverlayCommand(key)
      }
    }
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { source?: string; key?: string } | null
      if (data?.source !== "local-diffe-keyboard" || !data.key) return
      if (data.key === "-") {
        toggleKeyboardOverlay()
      } else if (data.key === "?") {
        showKeyboardHelp()
      } else if (data.key === "Escape" && keyboardOverlay) {
        setKeyboardOverlay(false)
      } else if (keyboardOverlay && ["f", "d", "v", "j", "k"].includes(data.key.toLowerCase())) {
        runOverlayCommand(data.key)
      }
    }
    window.addEventListener("keydown", onKeyDown)
    window.addEventListener("message", onMessage)
    return () => {
      window.removeEventListener("keydown", onKeyDown)
      window.removeEventListener("message", onMessage)
    }
  }, [keyboardOverlay, runOverlayCommand, showKeyboardHelp, toggleKeyboardOverlay])

  const selectFile = useCallback((fileIndex: number) => setSelected(fileIndex), [])

  const selectedFile = selected === null ? null : session?.files[selected]
  const selectedViewed = selected !== null && viewedFiles.has(selected)
  const toggleViewed = () => {
    if (selected === null || !selectedFile) return
    setViewedFiles((current) => {
      const next = new Set(current)
      if (next.has(selected)) next.delete(selected)
      else next.add(selected)
      return next
    })
  }
  return (
    <div className="min-h-screen bg-muted/40">
      {loading && <div className="fixed inset-x-0 top-0 z-[60] h-1 overflow-hidden bg-primary/10" role="progressbar" aria-label="Loading comparison"><div className="loading-sheen h-full w-1/3 bg-primary" /></div>}
      {!chromeHidden && <header className="border-b bg-background">
        <div className="flex h-14 w-full items-center gap-3 px-4">
          <div className="flex items-center gap-2 font-semibold"><FileDiff className="size-5 text-primary" /> Local Diffe</div>
          <span className="hidden text-sm text-muted-foreground md:inline">GitHub-style review, SemanticDiff display engine</span>
          <div className="ml-auto flex items-center gap-2"><div className="flex items-center gap-1.5 text-xs text-muted-foreground"><Sparkles className="size-3.5" /> local only</div><Button data-testid="keyboard-overlay-toggle" size="sm" variant={keyboardOverlay ? "secondary" : "outline"} onClick={toggleKeyboardOverlay} aria-pressed={keyboardOverlay} title="Toggle keyboard overlay (-)"><Keyboard className="size-4" /> Keys</Button><Button data-testid="hide-chrome" size="sm" variant="outline" onClick={() => setChromeHidden(true)}><ChevronUp className="size-4" /> Focus view</Button></div>
        </div>
      </header>}

      <main className="flex w-full flex-col gap-4 p-4">
        {loading && <div className="flex items-center gap-3 rounded-2xl bg-primary/[.07] px-4 py-3 text-sm text-foreground shadow-[0_12px_32px_-28px_rgba(0,113,227,0.8)]" role="status" aria-live="polite">
          <LoaderCircle className="size-4 shrink-0 animate-spin text-primary" />
          <span className="min-w-0 truncate">{status}</span>
          <span className="loading-dots shrink-0 text-primary" aria-hidden="true">•••</span>
        </div>}
        {chromeHidden && <Button data-testid="show-chrome" size="sm" variant="outline" className="fixed right-4 top-4 z-20 shadow-md" onClick={() => setChromeHidden(false)}><ChevronDown className="size-4" /> Show controls</Button>}
        {!chromeHidden && <><Card>
          <CardContent className="grid gap-3 p-4 lg:grid-cols-[minmax(340px,1fr)_150px_150px_auto_auto] lg:items-end">
            <label className="grid gap-1.5 text-xs font-medium text-muted-foreground">Repository
              <Input data-testid="repo" value={repo} onChange={(event) => setRepo(event.target.value)} />
            </label>
            <label className="grid gap-1.5 text-xs font-medium text-muted-foreground">Base
              <Input data-testid="base" value={base} onChange={(event) => setBase(event.target.value)} />
            </label>
            <label className="grid gap-1.5 text-xs font-medium text-muted-foreground">Compare
              <Input data-testid="target" value={target} onChange={(event) => setTarget(event.target.value)} />
            </label>
            <Button data-testid="generate-diff" onClick={generate} disabled={loading}>{loading ? <LoaderCircle className="size-4 animate-spin" /> : <GitBranch className="size-4" />} {loading ? "Generating…" : "Generate diff"}</Button>
            <Button asChild variant="outline" disabled={loading}><label className="cursor-pointer">{loading ? <LoaderCircle className="size-4 animate-spin" /> : <Upload className="size-4" />} {loading ? "Loading…" : "Upload patch"}<input className="hidden" type="file" accept=".diff,.patch,text/plain" onChange={(event) => upload(event.target.files?.[0])} /></label></Button>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="grid gap-3 p-4 lg:grid-cols-[minmax(360px,1fr)_auto_minmax(280px,1fr)_auto] lg:items-end">
            <label className="grid gap-1.5 text-xs font-medium text-muted-foreground">GitHub pull-request URL
              <Input data-testid="pr-url" value={prUrl} onChange={(event) => setPrUrl(event.target.value)} placeholder="https://github.com/owner/repo/pull/123" />
            </label>
            <Button data-testid="open-pr-url" variant="secondary" onClick={openPrUrl} disabled={loading}>{loading ? <LoaderCircle className="size-4 animate-spin" /> : <Link className="size-4" />} {loading ? "Opening…" : "Open PR"}</Button>
            <div className="grid gap-1.5 text-xs font-medium text-muted-foreground">
              <span id="pr-picker-label">Open PRs for repository</span>
              <Popover open={prPickerOpen} onOpenChange={setPrPickerOpen}>
                <PopoverTrigger asChild>
                  <Button data-testid="pr-select" variant="outline" role="combobox" aria-labelledby="pr-picker-label" aria-expanded={prPickerOpen} disabled={!pulls.length || loading} className="h-9 w-full justify-between font-normal">
                    <span className="truncate">{selectedPull ? `#${selectedPull.number} · ${selectedPull.title}` : "List open PRs first"}</span><ChevronsUpDown className="ml-2 size-4 shrink-0 opacity-50" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent align="start" className="w-[var(--radix-popover-trigger-width)]">
                  <Command>
                    <CommandInput placeholder="Search by PR number or title…" />
                    <CommandList>
                      <CommandEmpty>No matching pull request.</CommandEmpty>
                      <CommandGroup heading={`${pulls.length} open pull requests`}>
                        {pulls.map((pull) => <CommandItem key={pull.number} value={`${pull.number} ${pull.title} ${pull.author?.login ?? ""}`} onSelect={() => { setPrNumber(String(pull.number)); setPrPickerOpen(false) }}>
                          <Check className={cn("mr-2 size-4", prNumber === String(pull.number) ? "opacity-100" : "opacity-0")} />
                          <span className="min-w-0 truncate"><span className="font-medium">#{pull.number}</span> · {pull.title}</span>
                        </CommandItem>)}
                      </CommandGroup>
                    </CommandList>
                  </Command>
                </PopoverContent>
              </Popover>
            </div>
            <div className="flex gap-2"><Button data-testid="list-prs" variant="outline" onClick={() => void listPulls()} disabled={loading}>{loading ? <LoaderCircle className="size-4 animate-spin" /> : <GitPullRequest className="size-4" />} {loading ? "Loading…" : "List"}</Button><Button data-testid="refresh-prs" variant="outline" onClick={() => void listPulls(true)} disabled={loading}><GitPullRequest className="size-4" /> Refresh</Button><Button data-testid="open-selected-pr" onClick={openPull} disabled={loading || !prNumber}>{loading ? <LoaderCircle className="size-4 animate-spin" /> : <GitBranch className="size-4" />} {loading ? "Reviewing…" : "Review"}</Button></div>
          </CardContent>
        </Card></>}

        <div ref={reviewGrid} aria-busy={loading} style={{ "--sidebar-width": `${sidebarWidth}px` } as React.CSSProperties} className={cn("grid min-h-[calc(100vh-150px)] gap-4 lg:grid-cols-[minmax(220px,var(--sidebar-width))_minmax(0,1fr)]", chromeHidden && "min-h-[calc(100vh-2rem)]")}>
          <SidebarProfilerBoundary>
          <Card ref={sidebarRef} tabIndex={-1} aria-label="Changed files sidebar" className={cn("relative flex min-h-0 flex-col overflow-visible outline-none", activeRegion === "sidebar" && keyboardOverlay && "ring-2 ring-primary ring-offset-2")}>
            <CardHeader className="gap-3 rounded-t-lg border-b bg-card p-3"><div className="flex items-center justify-between gap-2"><CardTitle className="text-sm">Changed files {session && <span className="font-normal text-muted-foreground">({session.comparison?.changed_paths ?? session.files.length})</span>}</CardTitle><div className="flex items-center gap-0.5"><Button type="button" size="icon" variant="ghost" className="size-7" title="Smaller file text" onClick={() => setSidebarFontSize((size) => Math.max(10, size - 1))}><Minus className="size-3.5" /></Button><span className="w-7 text-center text-[10px] text-muted-foreground" title="File sidebar font size">{sidebarFontSize}px</span><Button type="button" size="icon" variant="ghost" className="size-7" title="Larger file text" onClick={() => setSidebarFontSize((size) => Math.min(18, size + 1))}><Plus className="size-3.5" /></Button><span className="mx-1 h-4 border-l" /><Button type="button" size="icon" variant="ghost" className="size-7" title="Make file sidebar narrower" onClick={() => setSidebarWidth((width) => Math.max(220, width - 40))}><Minus className="size-3.5" /></Button><Button type="button" size="icon" variant="ghost" className="size-7" title="Make file sidebar wider" onClick={() => setSidebarWidth((width) => Math.min(760, width + 40))}><Plus className="size-3.5" /></Button></div></div>
              <div className="relative"><Search className="pointer-events-none absolute left-2 top-2 size-3.5 text-muted-foreground" /><Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Filter files" className="h-8 pl-7 text-xs" /></div>
            </CardHeader>
            <CardContent ref={sidebarContentRef} style={{ contain: "size" }} className="min-h-[240px] flex-1 overflow-hidden lg:min-h-0 rounded-b-2xl bg-card p-2">
              {tree.length ? <SidebarTree tree={tree} treeHeight={treeHeight} rowHeight={sidebarRowHeight} indent={Math.max(9, Math.round(14 * sidebarScale))} searchTerm={deferredSearch} selected={selected} viewedFiles={viewedFiles} sidebarScale={sidebarScale} sidebarFontSize={sidebarFontSize} sidebarIconSize={sidebarIconSize} sidebarGap={sidebarGap} sidebarPadding={sidebarPadding} onSelectFile={selectFile} /> : loading ? <div className="grid h-full place-items-center p-6 text-center text-sm text-muted-foreground"><div><LoaderCircle className="mx-auto mb-3 size-6 animate-spin text-primary" /><p>Preparing changed files<span className="loading-dots text-primary" aria-hidden="true">•••</span></p><p className="mt-1 text-xs">Large pull requests can take a moment to index.</p></div></div> : <p className="p-3 text-xs text-muted-foreground">Generate a Git diff or upload a patch to populate the file tree.</p>}
            </CardContent>
            <div className="flex items-center justify-between gap-3 px-4 pb-4 pt-2 text-[11px] text-muted-foreground">
              <span>{session ? `${session.files.length} ${session.files.length === 1 ? "file" : "files"}` : "No comparison loaded"}</span>
              {session && <span>{viewedFiles.size} viewed</span>}
            </div>
            <button type="button" aria-label="Resize file sidebar" title="Drag to resize the file sidebar" onPointerDown={startSidebarResize} className={cn("absolute -right-3 top-0 z-10 hidden h-full w-6 cursor-col-resize touch-none items-center justify-center lg:flex", resizingSidebar && "bg-primary/5")}><span className="grid h-12 w-3 place-items-center rounded-full border bg-background text-muted-foreground shadow-sm"><GripVertical className="size-3" /></span></button>
          </Card>
          </SidebarProfilerBoundary>

          <Card ref={diffPanelRef} tabIndex={-1} aria-label="Semantic diff panel" className={cn("min-h-0 overflow-hidden outline-none", activeRegion === "diff" && keyboardOverlay && "ring-2 ring-primary ring-offset-2")}>
            {/* The floating "Show controls" button is fixed at the top-right of
                the viewport, so the collapsed header reserves room for it and
                keeps the viewed checkbox clickable underneath. */}
            <CardHeader className={cn("flex-row items-center justify-between gap-3 space-y-0 border-b", chromeHidden ? "h-8 py-1 pl-3 pr-[180px]" : "p-3")}>
              {chromeHidden ? <CardTitle className="min-w-0 truncate text-xs font-medium text-muted-foreground">{selectedFile?.display_path ?? "Semantic diff"}</CardTitle> : <div className="min-w-0"><CardTitle className="break-all text-sm">{selectedFile?.display_path ?? "Semantic diff"}</CardTitle>{session?.comparison?.pull_request && <a href={session.comparison.pull_request.url} target="_blank" rel="noreferrer" className="mt-1 flex w-fit items-center gap-1 text-xs font-medium text-primary hover:underline"><GitPullRequest className="size-3.5" /> #{session.comparison.pull_request.number} · {session.comparison.pull_request.title}</a>}<p className="mt-1 text-xs text-muted-foreground">{status}</p>{session?.comparison && <p className="mt-1 text-[11px] text-muted-foreground/80">{session.comparison.description}</p>}</div>}
              <div className="flex shrink-0 items-center gap-2">
                {loading && <LoaderCircle className="size-3.5 animate-spin text-muted-foreground" />}
                {selectedFile && <label className={cn("flex shrink-0 cursor-pointer select-none items-center gap-1.5 whitespace-nowrap text-xs font-medium transition-colors", selectedViewed ? "text-emerald-600" : "text-muted-foreground hover:text-foreground", loading && "cursor-default opacity-50")} title={selectedViewed ? "Mark as unviewed" : "Mark as viewed"}>
                  <input type="checkbox" data-testid="mark-as-viewed" className="size-3.5 shrink-0 cursor-pointer accent-emerald-600" checked={selectedViewed} disabled={loading} onChange={toggleViewed} />
                  Viewed
                </label>}
              </div>
            </CardHeader>
            <CardContent className={cn("min-h-[580px] p-0", chromeHidden ? "h-[calc(100vh-4.5rem)]" : "h-[calc(100vh-260px)]")}>
              {selectedFile && session && selected !== null ? <DiffViewer key={`${session.id}:${selected}`} sessionId={session.id} index={selected} path={selectedFile.display_path} frameRef={diffFrameRef} /> : <div className="grid h-full place-items-center p-8 text-center text-sm text-muted-foreground"><div>{loading ? <LoaderCircle className="mx-auto mb-3 size-8 animate-spin text-primary" /> : <FileDiff className="mx-auto mb-3 size-8 opacity-40" />}<p>{loading ? "Building your review" : "Pick a file from the tree."}<span className={cn("loading-dots text-primary", !loading && "hidden")} aria-hidden="true">•••</span></p><p className="mt-1 text-xs">{loading ? "Fetching the pull request and preparing diffs." : "Select a file to review its text or semantic diff."}</p></div></div>}
            </CardContent>
          </Card>
        </div>
      </main>
      {keyboardOverlay && <aside data-testid="keyboard-overlay" className={cn("fixed inset-x-0 bottom-5 z-50 mx-auto border border-primary/30 bg-background/95 shadow-2xl backdrop-blur transition-[width,padding] duration-300", keyboardOverlayExpanded ? "w-[min(760px,calc(100%-2rem))] rounded-xl p-3" : "w-fit rounded-full px-3 py-2")} aria-label="Keyboard navigation">
        {keyboardOverlayExpanded ? <>
          <div className="flex items-center justify-between gap-3 px-1 pb-2 text-xs text-muted-foreground"><span className="flex items-center gap-1.5 font-medium text-foreground"><Keyboard className="size-3.5 text-primary" /> Keyboard overlay</span><span><kbd className="rounded border bg-muted px-1.5 py-0.5 font-mono text-foreground">?</kbd> show keys · <kbd className="rounded border bg-muted px-1.5 py-0.5 font-mono text-foreground">Esc</kbd> or <kbd className="rounded border bg-muted px-1.5 py-0.5 font-mono text-foreground">-</kbd> hide</span></div>
          <div className="grid gap-2 sm:grid-cols-3">
            <button type="button" onClick={() => runOverlayCommand("f")} className={cn("rounded-lg border p-3 text-left transition-colors hover:bg-accent", activeRegion === "sidebar" && "border-primary bg-primary/5")}><kbd className="mr-2 rounded bg-foreground px-1.5 py-0.5 font-mono text-xs text-background">F</kbd><span className="font-medium">Files</span><span className="mt-1 block text-xs text-muted-foreground">Focus the changed-file sidebar</span></button>
            <button type="button" onClick={() => runOverlayCommand("d")} className={cn("rounded-lg border p-3 text-left transition-colors hover:bg-accent", activeRegion === "diff" && "border-primary bg-primary/5")}><kbd className="mr-2 rounded bg-foreground px-1.5 py-0.5 font-mono text-xs text-background">D</kbd><span className="font-medium">Diff panel</span><span className="mt-1 block text-xs text-muted-foreground">Focus the SemanticDiff view</span></button>
            <button type="button" onClick={() => runOverlayCommand("v")} className="rounded-lg border p-3 text-left transition-colors hover:bg-accent"><kbd className="mr-2 rounded bg-foreground px-1.5 py-0.5 font-mono text-xs text-background">V</kbd><span className="font-medium">Focus view</span><span className="mt-1 block text-xs text-muted-foreground">Hide controls and enter the diff</span></button>
          </div>
          <div className="mt-2 flex items-center gap-4 rounded-lg bg-muted px-3 py-2 text-xs text-muted-foreground"><span><kbd className="mr-1 rounded border bg-background px-1.5 py-0.5 font-mono text-foreground">J</kbd> {activeRegion === "diff" ? "scroll down" : "next file"}</span><span><kbd className="mr-1 rounded border bg-background px-1.5 py-0.5 font-mono text-foreground">K</kbd> {activeRegion === "diff" ? "scroll up" : "previous file"}</span><span className="ml-auto">{activeRegion === "sidebar" ? "Files sidebar active" : "Diff panel active"}</span></div>
        </> : <button type="button" onClick={showKeyboardHelp} className="flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground"><Keyboard className="size-3.5 text-primary" /><span>{activeRegion === "diff" ? "J/K scroll diff" : "J/K files"}</span><kbd className="rounded border bg-muted px-1.5 py-0.5 font-mono text-foreground">?</kbd><span>keys</span></button>}
      </aside>}
    </div>
  )
}
