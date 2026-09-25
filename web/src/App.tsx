import { createContext, memo, Profiler, useCallback, useContext, useDeferredValue, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react"
import { Tree, type NodeRendererProps } from "react-arborist"
import {
  ChevronLeft,
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
  GitCommitHorizontal,
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
type Commit = { sha: string; short: string; parents: string[]; author: string; date: string; subject: string; files_changed: number }
type Session = { id: string; files: PatchFile[]; comparison?: Comparison | null; commits?: Commit[]; commits_truncated?: boolean }
type ScopeMode = "commit" | "cumulative"
const EMPTY_FILES: PatchFile[] = []
const EMPTY_COMMITS: Commit[] = []
const OVERLAY_KEYS = ["f", "d", "v", "j", "k", "[", "]"]
const NO_VIEWED: ReadonlySet<number> = new Set()

type ReviewRegion = "sidebar" | "diff"

function isEditableTarget(target: EventTarget | null) {
  return target instanceof HTMLElement && Boolean(target.closest('input, textarea, select, [contenteditable="true"], [role="textbox"]'))
}

const initialRepo = "/Users/abhishek/hydradb/hydradb-application"

// Session ids are fresh UUIDs per comparison, so viewed state is keyed by the
// revisions under review and stored as display paths: both survive a reload and
// a re-generated session whose file order changed. A commit scope is named after
// the full comparison it belongs to, e.g. `pr-123@abc1234`.
function viewedStorageKey(session: Session | null, root: Session | null) {
  if (!session) return null
  const comparison = session.comparison
  const rootComparison = root?.comparison ?? comparison
  if (comparison && rootComparison) {
    const range = rootComparison.pull_request ? `pr-${rootComparison.pull_request.number}` : `${rootComparison.base.revision}..${rootComparison.target.revision}`
    const scope = session === root ? range : `${range}@${comparison.target.revision}`
    return `local-diffe:viewed:${scope}:${comparison.base.commit}:${comparison.target.commit}`
  }
  return `local-diffe:viewed:patch:${session.files.length}:${session.files[0]?.display_path ?? ""}`
}

function comparisonStatus(session: Session) {
  if (!session.comparison) return `${session.files.length} text patches loaded · select one to inspect its semantic diff`
  const { base, target, changed_paths, semantic_paths, pull_request } = session.comparison
  const revisions = `${base.commit.slice(0, 7)} → ${target.commit.slice(0, 7)}`
  if (pull_request) return `PR #${pull_request.number} · ${changed_paths} changed paths · ${semantic_paths} content diffs · ${revisions}`
  return `${changed_paths} changed paths · ${semantic_paths} content diffs · ${base.revision}@${base.commit.slice(0, 7)} → ${target.revision}@${target.commit.slice(0, 7)}`
}

function scopeStatus(scoped: Session, commits: Commit[], index: number, mode: ScopeMode) {
  const commit = commits[index]
  const position = mode === "commit" ? `Commit ${index + 1} of ${commits.length}` : `Commits 1–${index + 1} of ${commits.length}`
  const changed = scoped.comparison?.changed_paths ?? scoped.files.length
  return `${position} · ${commit.short} ${commit.subject} · ${changed ? `${changed} changed paths · ${scoped.comparison?.semantic_paths ?? 0} content diffs` : "no file changes"}`
}

function formatCommitDate(iso: string) {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: date.getFullYear() === new Date().getFullYear() ? undefined : "numeric" })
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
  // The full comparison owns the commit list; `session` is whichever scope of
  // it is on screen (the full comparison itself, or one commit).
  const [rootSession, setRootSession] = useState<Session | null>(null)
  const [commitIndex, setCommitIndex] = useState<number | null>(null)
  const [scopeMode, setScopeMode] = useState<ScopeMode>("commit")
  const [scopeLoading, setScopeLoading] = useState(false)
  const [commitPickerOpen, setCommitPickerOpen] = useState(false)
  const [selected, setSelected] = useState<number | null>(null)
  // Viewed indices are tagged with the storage key and file list they were read
  // for, so a scope switch never shows or persists another scope's marks.
  const [viewedState, setViewedState] = useState<{ key: string | null; files: PatchFile[]; indices: ReadonlySet<number> }>({ key: null, files: EMPTY_FILES, indices: NO_VIEWED })
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
  const textViewportCacheRef = useRef<HTMLElement | null | undefined>(undefined)
  const semanticScrollCacheRef = useRef<{ document: Document; target: HTMLElement | null } | undefined>(undefined)
  const scopeCacheRef = useRef(new Map<string, Session>())
  const scopeRequestRef = useRef(0)
  const shownCommitIndexRef = useRef<number | null>(null)
  const selectionRef = useRef({ session, selected })
  selectionRef.current = { session, selected }
  const [treeHeight, setTreeHeight] = useState(480)
  const files = session?.files ?? EMPTY_FILES
  const tree = useMemo(() => makeTree(files), [files])
  const fileNavigation = useMemo(() => buildFileNavigation(files), [files])
  const deferredSearch = useDeferredValue(search)
  const selectedPull = useMemo(() => pulls.find((pull) => String(pull.number) === prNumber), [pulls, prNumber])
  const commits = rootSession?.commits ?? EMPTY_COMMITS
  const viewedKey = useMemo(() => viewedStorageKey(session, rootSession), [rootSession, session])
  const viewedFiles = viewedState.key === viewedKey && viewedState.files === files ? viewedState.indices : NO_VIEWED
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
    if (!viewedKey) return
    const paths = readViewedPaths(viewedKey)
    const restored = new Set<number>()
    files.forEach((file, index) => { if (paths.has(file.display_path)) restored.add(index) })
    setViewedState({ key: viewedKey, files, indices: restored })
  }, [files, viewedKey])

  useEffect(() => {
    // Only write a set that was read back for this key and file list, so the
    // placeholder a fresh scope starts with never erases what was saved for it.
    if (!viewedKey || viewedState.key !== viewedKey || viewedState.files !== files) return
    const paths = [...viewedState.indices].map((index) => files[index]?.display_path).filter((path): path is string => Boolean(path))
    try {
      if (paths.length) window.localStorage.setItem(viewedKey, JSON.stringify(paths))
      else window.localStorage.removeItem(viewedKey)
    } catch {
      // Private browsing or a full quota: viewed state stays in-memory only.
    }
  }, [files, viewedKey, viewedState])

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
      // Drop any in-flight commit scope of the previous comparison.
      scopeRequestRef.current += 1
      scopeCacheRef.current = new Map()
      shownCommitIndexRef.current = null
      setScopeLoading(false)
      setCommitIndex(null)
      setRootSession(next)
      setSession(next)
      setSelected(null)
      setStatus(comparisonStatus(next))
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

  // Show one commit (or `null` for all changes). Scopes are cached per commit
  // and mode, and the reviewed file stays selected when the next scope has it.
  const selectScope = useCallback(async (index: number | null, mode: ScopeMode) => {
    if (!rootSession) return
    const request = ++scopeRequestRef.current
    setCommitIndex(index)
    let next: Session | undefined = rootSession
    if (index !== null) {
      const commit = rootSession.commits?.[index]
      if (!commit) return
      const cacheKey = `${commit.sha}:${mode}`
      next = scopeCacheRef.current.get(cacheKey)
      if (!next) {
        setScopeLoading(true)
        try {
          next = await api<Session>("/api/commit-scope", { id: rootSession.id, sha: commit.sha, mode })
          scopeCacheRef.current.set(cacheKey, next)
        } catch (error) {
          if (request !== scopeRequestRef.current) return
          setScopeLoading(false)
          setCommitIndex(shownCommitIndexRef.current)
          setStatus(error instanceof Error ? error.message : "Unable to load this commit")
          return
        }
      }
    }
    if (request !== scopeRequestRef.current) return
    const { session: current, selected: currentSelected } = selectionRef.current
    const selectedPath = currentSelected === null ? null : current?.files[currentSelected]?.display_path
    const keep = selectedPath ? next.files.findIndex((file) => file.renderable && file.display_path === selectedPath) : -1
    shownCommitIndexRef.current = index
    setScopeLoading(false)
    setSession(next)
    setSelected(keep === -1 ? null : keep)
    setStatus(index === null ? comparisonStatus(next) : scopeStatus(next, rootSession.commits ?? EMPTY_COMMITS, index, mode))
  }, [rootSession])

  // `[` from the first commit returns to all changes; neither end wraps.
  const stepCommit = useCallback((direction: 1 | -1) => {
    if (!commits.length) return
    const next = direction === 1
      ? (commitIndex === null ? 0 : Math.min(commits.length - 1, commitIndex + 1))
      : (commitIndex === null || commitIndex === 0 ? null : commitIndex - 1)
    if (next !== commitIndex) void selectScope(next, scopeMode)
  }, [commitIndex, commits.length, scopeMode, selectScope])

  const changeScopeMode = (mode: ScopeMode) => {
    if (mode === scopeMode) return
    setScopeMode(mode)
    if (commitIndex !== null) void selectScope(commitIndex, mode)
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
      case "[":
        stepCommit(-1)
        break
      case "]":
        stepCommit(1)
        break
    }
  }, [activeRegion, focusDiff, focusSidebar, moveFile, scrollDiff, stepCommit])

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
      if (OVERLAY_KEYS.includes(key)) {
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
      } else if (keyboardOverlay && OVERLAY_KEYS.includes(data.key.toLowerCase())) {
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
    setViewedState((current) => {
      if (current.key !== viewedKey || current.files !== files) return current
      const indices = new Set(current.indices)
      if (indices.has(selected)) indices.delete(selected)
      else indices.add(selected)
      return { ...current, indices }
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
              {commits.length > 0 && <div data-testid="commit-rail" className="grid grid-cols-[minmax(0,1fr)] gap-1.5">
                <div className="flex items-center gap-1">
                  <Button type="button" data-testid="previous-commit" size="icon" variant="outline" className="size-8 shrink-0" title="Previous commit ([)" disabled={commitIndex === null} onClick={() => stepCommit(-1)}><ChevronLeft className="size-4" /></Button>
                  <Popover open={commitPickerOpen} onOpenChange={setCommitPickerOpen}>
                    <PopoverTrigger asChild>
                      <Button type="button" data-testid="commit-select" variant="outline" role="combobox" aria-label="Commit to review" aria-expanded={commitPickerOpen} className="h-8 min-w-0 flex-1 justify-between px-2 font-normal">
                        <span className="flex min-w-0 items-center gap-1.5 text-xs">
                          {scopeLoading ? <LoaderCircle className="size-3.5 shrink-0 animate-spin text-primary" /> : <GitCommitHorizontal className="size-3.5 shrink-0 text-muted-foreground" />}
                          <span className="min-w-0 truncate">{commitIndex === null ? `All changes · ${commits.length} ${commits.length === 1 ? "commit" : "commits"}` : <><span className="tabular-nums text-muted-foreground">{commitIndex + 1}/{commits.length}</span> <span className="font-mono">{commits[commitIndex].short}</span> {commits[commitIndex].subject}</>}</span>
                        </span>
                        <ChevronsUpDown className="ml-1 size-3.5 shrink-0 opacity-50" />
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent align="start" className="w-[min(480px,calc(100vw-2rem))]">
                      <Command>
                        <CommandInput placeholder="Search commits by subject, SHA or author…" />
                        <CommandList className="max-h-80">
                          <CommandEmpty>No matching commit.</CommandEmpty>
                          <CommandGroup>
                            <CommandItem value="all changes" onSelect={() => { setCommitPickerOpen(false); void selectScope(null, scopeMode) }}>
                              <Check className={cn("mr-2 size-4 shrink-0", commitIndex === null ? "opacity-100" : "opacity-0")} />
                              <span className="font-medium">All changes</span>
                              <span className="ml-auto pl-3 text-xs text-muted-foreground">{rootSession?.comparison?.changed_paths ?? rootSession?.files.length} files</span>
                            </CommandItem>
                          </CommandGroup>
                          <CommandGroup heading={rootSession?.commits_truncated ? `Newest ${commits.length} commits` : `${commits.length} ${commits.length === 1 ? "commit" : "commits"}, oldest first`}>
                            {commits.map((commit, index) => <CommandItem key={commit.sha} value={`${commit.sha} ${commit.subject} ${commit.author}`} onSelect={() => { setCommitPickerOpen(false); void selectScope(index, scopeMode) }}>
                              <Check className={cn("mr-2 size-4 shrink-0", commitIndex === index ? "opacity-100" : "opacity-0")} />
                              <span className="mr-2 w-6 shrink-0 text-right text-xs tabular-nums text-muted-foreground">{index + 1}</span>
                              <span className="min-w-0 flex-1">
                                <span className="block truncate">{commit.subject || "(no message)"}</span>
                                <span className="block truncate text-[11px] text-muted-foreground"><span className="font-mono">{commit.short}</span> · {commit.author} · {formatCommitDate(commit.date)} · {commit.files_changed ? `${commit.files_changed} ${commit.files_changed === 1 ? "file" : "files"}` : "no file changes"}{commit.parents.length > 1 ? " · merge" : ""}</span>
                              </span>
                            </CommandItem>)}
                          </CommandGroup>
                        </CommandList>
                      </Command>
                    </PopoverContent>
                  </Popover>
                  <Button type="button" data-testid="next-commit" size="icon" variant="outline" className="size-8 shrink-0" title="Next commit (])" disabled={commitIndex === commits.length - 1} onClick={() => stepCommit(1)}><ChevronRight className="size-4" /></Button>
                </div>
                <div role="radiogroup" aria-label="Commit scope" className="grid grid-cols-2 gap-0.5 rounded-md bg-muted p-0.5 text-[11px] font-medium">
                  {([["commit", "This commit", "Changes made by the selected commit alone"], ["cumulative", "Up to commit", "Everything from the comparison base through the selected commit"]] as const).map(([mode, label, title]) => <button key={mode} type="button" role="radio" data-testid={`scope-${mode}`} aria-checked={scopeMode === mode} title={title} onClick={() => changeScopeMode(mode)} className={cn("rounded px-2 py-1 transition-colors", scopeMode === mode ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground")}>{label}</button>)}
                </div>
              </div>}
              <div className="relative"><Search className="pointer-events-none absolute left-2 top-2 size-3.5 text-muted-foreground" /><Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Filter files" className="h-8 pl-7 text-xs" /></div>
            </CardHeader>
            <CardContent ref={sidebarContentRef} style={{ contain: "size" }} className="min-h-[240px] flex-1 overflow-hidden lg:min-h-0 rounded-b-2xl bg-card p-2">
              {tree.length ? <SidebarTree tree={tree} treeHeight={treeHeight} rowHeight={sidebarRowHeight} indent={Math.max(9, Math.round(14 * sidebarScale))} searchTerm={deferredSearch} selected={selected} viewedFiles={viewedFiles} sidebarScale={sidebarScale} sidebarFontSize={sidebarFontSize} sidebarIconSize={sidebarIconSize} sidebarGap={sidebarGap} sidebarPadding={sidebarPadding} onSelectFile={selectFile} /> : loading ? <div className="grid h-full place-items-center p-6 text-center text-sm text-muted-foreground"><div><LoaderCircle className="mx-auto mb-3 size-6 animate-spin text-primary" /><p>Preparing changed files<span className="loading-dots text-primary" aria-hidden="true">•••</span></p><p className="mt-1 text-xs">Large pull requests can take a moment to index.</p></div></div> : session ? <p className="p-3 text-xs text-muted-foreground">No file changes in this commit.</p> : <p className="p-3 text-xs text-muted-foreground">Generate a Git diff or upload a patch to populate the file tree.</p>}
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
              {chromeHidden ? <CardTitle className="min-w-0 truncate text-xs font-medium text-muted-foreground">{selectedFile?.display_path ?? "Semantic diff"}</CardTitle> : <div className="min-w-0"><CardTitle className="break-all text-sm">{selectedFile?.display_path ?? "Semantic diff"}</CardTitle>{rootSession?.comparison?.pull_request && <a href={rootSession.comparison.pull_request.url} target="_blank" rel="noreferrer" className="mt-1 flex w-fit items-center gap-1 text-xs font-medium text-primary hover:underline"><GitPullRequest className="size-3.5" /> #{rootSession.comparison.pull_request.number} · {rootSession.comparison.pull_request.title}</a>}<p className="mt-1 text-xs text-muted-foreground">{status}</p>{session?.comparison && <p className="mt-1 text-[11px] text-muted-foreground/80">{session.comparison.description}</p>}</div>}
              <div className="flex shrink-0 items-center gap-2">
                {(loading || scopeLoading) && <LoaderCircle className="size-3.5 animate-spin text-muted-foreground" />}
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
          <div className="mt-2 flex items-center gap-4 rounded-lg bg-muted px-3 py-2 text-xs text-muted-foreground"><span><kbd className="mr-1 rounded border bg-background px-1.5 py-0.5 font-mono text-foreground">J</kbd> {activeRegion === "diff" ? "scroll down" : "next file"}</span><span><kbd className="mr-1 rounded border bg-background px-1.5 py-0.5 font-mono text-foreground">K</kbd> {activeRegion === "diff" ? "scroll up" : "previous file"}</span>{commits.length > 0 && <span><kbd className="mr-1 rounded border bg-background px-1.5 py-0.5 font-mono text-foreground">[</kbd><kbd className="mr-1 rounded border bg-background px-1.5 py-0.5 font-mono text-foreground">]</kbd> previous / next commit</span>}<span className="ml-auto">{activeRegion === "sidebar" ? "Files sidebar active" : "Diff panel active"}</span></div>
        </> : <button type="button" onClick={showKeyboardHelp} className="flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground"><Keyboard className="size-3.5 text-primary" /><span>{activeRegion === "diff" ? "J/K scroll diff" : "J/K files"}</span><kbd className="rounded border bg-muted px-1.5 py-0.5 font-mono text-foreground">?</kbd><span>keys</span></button>}
      </aside>}
    </div>
  )
}
