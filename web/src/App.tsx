import {
  createContext,
  memo,
  Profiler,
  useCallback,
  useContext,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react"
import { Tree, type NodeRendererProps } from "react-arborist"
import {
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  ChevronUp,
  ChevronsUpDown,
  Check,
  FileUp,
  FolderGit2,
  GitCompareArrows,
  Layers,
  RefreshCw,
  SkipForward,
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
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { cn } from "@/lib/utils"
import { DiffViewer, preferredMode, rememberMode, type DiffMode } from "@/components/DiffViewer"
import { buildFileNavigation, makeTree, type TreeItem } from "./sidebarTree"
import { groupPulls, type PullRequest } from "./stacks"
import { PERFORMANCE_BUILD_ENABLED, onRender } from "./lib/performance"
import { normalizePrUrl, type ReviewLocation } from "./lib/review-location"
import {
  useReviewNavigation,
  writeReviewLocation,
  type ReviewHistory,
} from "./lib/use-review-navigation"

import {
  api,
  pullsSchema,
  sessionSchema,
  type PatchFile,
  type Commit,
  type Session,
  type StackMode,
} from "./lib/review-api"
import { readViewerKey } from "./lib/viewer-keyboard"
import { stackReviewContext, reviewFileSelection } from "./lib/stack-review"
import { StackRail } from "./components/StackRail"
import { StackHistoryPanel } from "./components/StackHistoryPanel"
import { DEFAULT_COORDINATES, type ReviewCoordinates } from "./lib/review-location"
import { descendantTips, inFolder } from "./lib/stack-history"
import { useStackHistory } from "./lib/use-stack-history"
import { reviewEvidenceContext, evidenceFor } from "./lib/review-evidence"
import { useReviewEvidence } from "./lib/use-review-evidence"
type ScopeMode = "commit" | "cumulative"
type SourceTab = "pr" | "branches" | "patch"
const EMPTY_FILES: PatchFile[] = []
const EMPTY_COMMITS: Commit[] = []
const OVERLAY_KEYS = ["f", "d", "v", "j", "k", "[", "]", "{", "}", "n", "m"]
const SOURCE_TABS = [
  ["pr", "Pull request", GitPullRequest],
  ["branches", "Branches", GitCompareArrows],
  ["patch", "Patch file", FileUp],
] as const
const STACK_MODES = [
  ["pr", "This PR", "Only this PR's changes, compared with the PR below it"],
  ["cumulative", "Through here", "Everything from the trunk through this PR"],
  ["final", "Final stack", "The final result at an explicitly chosen descendant tip"],
] as const
const COMMIT_MODES = [
  ["commit", "This commit", "Changes made by the selected commit alone"],
  ["cumulative", "Up to commit", "Everything from the comparison base through the selected commit"],
] as const
const DIFF_MODES = [
  ["semantic", "Semantic", "SemanticDiff: hides moves and formatting-only changes"],
  ["text", "Text", "Plain unified text diff"],
] as const

type ReviewRegion = "sidebar" | "diff"

function isEditableTarget(target: EventTarget | null) {
  return (
    target instanceof HTMLElement &&
    Boolean(target.closest('input, textarea, select, [contenteditable="true"], [role="textbox"]'))
  )
}

const initialRepo = "/Users/abhishek/hydradb/hydradb-application"
const INITIAL_STATUS = "Ready to compare origin/staging with the checked-out branch."
type SessionLoadOptions = {
  signal?: AbortSignal
  history?: ReviewHistory
  coordinates?: ReviewCoordinates
}

function comparisonStatus(session: Session) {
  if (!session.comparison)
    return `${session.files.length} text patches loaded · select one to inspect its semantic diff`
  const { base, target, changed_paths, semantic_paths, pull_request } = session.comparison
  const revisions = `${base.commit.slice(0, 7)} → ${target.commit.slice(0, 7)}`
  if (pull_request)
    return `PR #${pull_request.number} · ${changed_paths} changed paths · ${semantic_paths} content diffs · ${revisions}`
  return `${changed_paths} changed paths · ${semantic_paths} content diffs · ${base.revision}@${base.commit.slice(0, 7)} → ${target.revision}@${target.commit.slice(0, 7)}`
}

function scopeStatus(scoped: Session, commits: Commit[], index: number, mode: ScopeMode) {
  const commit = commits[index]
  const position =
    mode === "commit"
      ? `Commit ${index + 1} of ${commits.length}`
      : `Commits 1–${index + 1} of ${commits.length}`
  const changed = scoped.comparison?.changed_paths ?? scoped.files.length
  return `${position} · ${commit.short} ${commit.subject} · ${changed ? `${changed} changed paths · ${scoped.comparison?.semantic_paths ?? 0} content diffs` : "no file changes"}`
}

function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
  testId,
  className,
}: {
  value: T
  options: readonly (readonly [T, string, string])[]
  onChange: (value: T) => void
  label: string
  testId: string
  className?: string
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={cn(
        "grid auto-cols-fr grid-flow-col gap-0.5 rounded-full bg-muted p-0.5 text-[11px] font-medium",
        className,
      )}
    >
      {options.map(([option, text, title]) => (
        <button
          key={option}
          type="button"
          role="radio"
          data-testid={`${testId}-${option}`}
          aria-checked={value === option}
          title={title}
          onClick={() => onChange(option)}
          className={cn(
            "whitespace-nowrap rounded-full px-2.5 py-1 transition-colors",
            value === option
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {text}
        </button>
      ))}
    </div>
  )
}

function BranchChip({ name }: { name: string }) {
  return (
    <span
      className="max-w-[16rem] truncate rounded-md bg-muted px-1.5 py-0.5 font-mono text-[11px] text-foreground/80"
      title={name}
    >
      {name}
    </span>
  )
}

function FilePath({ path }: { path: string }) {
  const slash = path.lastIndexOf("/")
  return (
    <span className="flex min-w-0 items-baseline font-mono text-xs" title={path}>
      {slash !== -1 && (
        <span className="min-w-0 truncate text-muted-foreground">{path.slice(0, slash + 1)}</span>
      )}
      <span className="shrink-0 font-semibold text-foreground">{path.slice(slash + 1)}</span>
    </span>
  )
}

function formatCommitDate(iso: string) {
  const date = new Date(iso)
  return Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        year: date.getFullYear() === new Date().getFullYear() ? undefined : "numeric",
      })
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
    <div
      style={{ ...style, paddingRight: Math.max(1, Math.round(4 * sidebarScale)) }}
      ref={dragHandle}
    >
      <button
        type="button"
        data-file-index={isFile ? item.fileIndex : undefined}
        onClick={() => (isFile ? canRender && onSelectFile(item.fileIndex!) : node.toggle())}
        title={
          isFile && !canRender
            ? "Empty or metadata-only Git change — no semantic text diff"
            : undefined
        }
        style={{
          fontSize: sidebarFontSize,
          height: sidebarRowHeight,
          gap: sidebarGap,
          paddingInline: sidebarPadding,
        }}
        className={cn(
          "flex w-full items-center rounded text-left hover:bg-accent",
          active && "bg-accent text-accent-foreground",
          !canRender && "cursor-default opacity-45 hover:bg-transparent",
        )}
      >
        {isFile ? (
          <span className="shrink-0" style={{ width: sidebarIconSize }} />
        ) : (
          <ChevronRight
            style={{ width: sidebarIconSize, height: sidebarIconSize }}
            className={cn("shrink-0 transition-transform", node.isOpen && "rotate-90")}
          />
        )}
        {isFile ? (
          <FileCode2
            style={{ width: sidebarIconSize, height: sidebarIconSize }}
            className={cn("shrink-0", canRender ? "text-sky-600" : "text-muted-foreground")}
          />
        ) : node.isOpen ? (
          <FolderOpen
            style={{ width: sidebarIconSize, height: sidebarIconSize }}
            className="shrink-0 text-amber-500"
          />
        ) : (
          <Folder
            style={{ width: sidebarIconSize, height: sidebarIconSize }}
            className="shrink-0 text-amber-500"
          />
        )}
        <span className="truncate">{item.name}</span>
        {isFile && viewed && (
          <span className="ml-auto shrink-0 text-emerald-600" title="Viewed">
            <Check aria-hidden="true" style={{ width: sidebarIconSize, height: sidebarIconSize }} />
            <span className="sr-only">Viewed</span>
          </span>
        )}
      </button>
    </div>
  )
})

type SidebarTreeContextValue = Omit<
  TreeRowProps,
  "node" | "style" | "dragHandle" | "tree" | "active" | "viewed"
> & {
  selected: number | null
  viewedFiles: ReadonlySet<number>
}
const SidebarTreeContext = createContext<SidebarTreeContextValue | null>(null)

const SidebarTreeRow = (props: NodeRendererProps<TreeItem>) => {
  const context = useContext(SidebarTreeContext)
  if (!context) return null
  const fileIndex = props.node.data.fileIndex
  const { selected, viewedFiles, ...rowProps } = context
  return (
    <TreeRow
      {...props}
      {...rowProps}
      active={fileIndex !== undefined && fileIndex === selected}
      viewed={fileIndex !== undefined && viewedFiles.has(fileIndex)}
    />
  )
}

function SidebarProfilerBoundary({ children }: { children: ReactNode }) {
  return PERFORMANCE_BUILD_ENABLED ? (
    <Profiler id="Sidebar" onRender={onRender}>
      {children}
    </Profiler>
  ) : (
    <>{children}</>
  )
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
  const context = useMemo(
    () => ({
      selected,
      viewedFiles,
      sidebarScale,
      sidebarFontSize,
      sidebarRowHeight: rowHeight,
      sidebarIconSize,
      sidebarGap,
      sidebarPadding,
      onSelectFile,
    }),
    [
      onSelectFile,
      rowHeight,
      selected,
      sidebarFontSize,
      sidebarGap,
      sidebarIconSize,
      sidebarPadding,
      sidebarScale,
      viewedFiles,
    ],
  )
  return (
    <SidebarTreeContext.Provider value={context}>
      <Tree<TreeItem>
        data={tree}
        width="100%"
        height={treeHeight}
        rowHeight={rowHeight}
        indent={indent}
        openByDefault
        disableDrag
        disableDrop
        searchTerm={searchTerm}
      >
        {SidebarTreeRow}
      </Tree>
    </SidebarTreeContext.Provider>
  )
})

export default function App() {
  const [repo, setRepo] = useState(initialRepo)
  const [base, setBase] = useState("origin/staging")
  const [target, setTarget] = useState("HEAD")
  const [prUrl, setPrUrl] = useState(
    () => new URLSearchParams(window.location.search).get("pr") ?? "",
  )
  const [pulls, setPulls] = useState<PullRequest[]>([])
  const [prNumber, setPrNumber] = useState("")
  const [prPickerOpen, setPrPickerOpen] = useState(false)
  const [sourceTab, setSourceTab] = useState<SourceTab>("pr")
  const [diffMode, setDiffMode] = useState<DiffMode>(preferredMode)
  const [stackLoading, setStackLoading] = useState(false)
  const [reviewError, setReviewError] = useState("")
  const [coordinates, setCoordinates] = useState<ReviewCoordinates>(DEFAULT_COORDINATES)
  const [finalReview, setFinalReview] = useState<{ anchor: Session; tip: number } | null>(null)
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
  const [search, setSearch] = useState("")
  const [status, setStatus] = useState(INITIAL_STATUS)
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
  const semanticScrollCacheRef = useRef<
    { document: Document; target: HTMLElement | null } | undefined
  >(undefined)
  const scopeCacheRef = useRef(new Map<string, Session>())
  const scopeRequestRef = useRef(0)
  const stackCacheRef = useRef(new Map<string, Session>())
  const stackRequestRef = useRef(0)
  const sourceRequestRef = useRef<AbortController | null>(null)
  const shownCommitIndexRef = useRef<number | null>(null)
  const selectionRef = useRef({ session, selected })
  useLayoutEffect(() => {
    selectionRef.current = { session, selected }
  }, [session, selected])
  const [treeHeight, setTreeHeight] = useState(480)
  const files = session?.files ?? EMPTY_FILES
  const tree = useMemo(() => makeTree(files), [files])
  const fileNavigation = useMemo(() => buildFileNavigation(files), [files])
  const deferredSearch = useDeferredValue(search)
  const selectedPull = useMemo(
    () => pulls.find((pull) => String(pull.number) === prNumber),
    [pulls, prNumber],
  )
  const pullGroups = useMemo(() => groupPulls(pulls), [pulls])
  const commits = rootSession?.commits ?? EMPTY_COMMITS
  const workspaceRoot = finalReview?.anchor ?? rootSession
  const stack = workspaceRoot?.stack ?? null
  const stackContext = stackReviewContext(rootSession, session, finalReview?.tip ?? null)
  const selectedStackNumber = workspaceRoot?.stack?.current
  const laneTips = stack ? descendantTips(stack, stack.current) : []
  const laneTip =
    coordinates.tip !== null && laneTips.includes(coordinates.tip)
      ? coordinates.tip
      : coordinates.tip === null && laneTips.length === 1
        ? laneTips[0]
        : null
  const historyState = useStackHistory(stack ? (workspaceRoot?.id ?? null) : null)
  const evidenceContext = reviewEvidenceContext(rootSession, session, finalReview?.tip ?? null)
  const {
    records,
    viewedFiles,
    warning: evidenceWarning,
    toggle: toggleEvidence,
  } = useReviewEvidence(evidenceContext, files)
  const stackPosition = stack
    ? stack.members.findIndex((member) => member.pull.number === stack.current)
    : -1
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
      resizePendingWidthRef.current = Math.max(
        220,
        Math.min(760, event.clientX - resizeOriginLeftRef.current),
      )
      if (resizeFrameRef.current !== null) return
      resizeFrameRef.current = requestAnimationFrame(() => {
        resizeFrameRef.current = null
        const nextWidth = resizePendingWidthRef.current
        if (nextWidth !== null)
          setSidebarWidth((current) => (current === nextWidth ? current : nextWidth))
      })
    }
    const stop = () => {
      if (resizeFrameRef.current !== null) cancelAnimationFrame(resizeFrameRef.current)
      resizeFrameRef.current = null
      const nextWidth = resizePendingWidthRef.current
      resizePendingWidthRef.current = null
      if (nextWidth !== null)
        setSidebarWidth((current) => (current === nextWidth ? current : nextWidth))
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
      setTreeHeight((current) => (current === nextHeight ? current : nextHeight))
    }
    const observer = new ResizeObserver(([entry]) => updateHeight(entry))
    observer.observe(element)
    return () => observer.disconnect()
  }, [session, chromeHidden])

  useEffect(() => {
    // DiffViewer replaces both viewports when the selected file changes.
    // Keyboard scrolling validates connected cached nodes and retries when a
    // renderer has not mounted yet, so no subtree observer is needed here.
    textViewportCacheRef.current = undefined
    semanticScrollCacheRef.current = undefined
  }, [selected, session?.id])

  // Show a full comparison (a review, or one PR of a stack), dropping any
  // in-flight commit scope of the previous one. The reviewed file stays
  // selected when the new comparison has it; otherwise its first file opens.
  const showRoot = useCallback(
    (next: Session, keepPath: string | null, strictPath = false, includeMetadata = false) => {
      setReviewError("")
      scopeRequestRef.current += 1
      scopeCacheRef.current = new Map()
      shownCommitIndexRef.current = null
      setScopeLoading(false)
      setCommitIndex(null)
      setRootSession(next)
      setSession(next)
      setSelected(reviewFileSelection(next.files, keepPath, strictPath, includeMetadata))
      setStatus(comparisonStatus(next))
    },
    [],
  )

  const loadSession = useCallback(
    async (
      endpoint: string,
      payload: unknown,
      progress: string,
      options: SessionLoadOptions = {},
    ) => {
      setReviewError("")
      sourceRequestRef.current?.abort()
      const controller = new AbortController()
      sourceRequestRef.current = controller
      const signal = options.signal
        ? AbortSignal.any([controller.signal, options.signal])
        : controller.signal
      // Invalidate old scope responses as soon as a new review starts, not only
      // when it finishes. A slow old request must never replace a newer review.
      scopeRequestRef.current += 1
      stackRequestRef.current += 1
      setScopeLoading(false)
      setStackLoading(false)
      setLoading(true)
      setStatus(progress)
      try {
        // Let synchronous effect cleanup cancel StrictMode's first setup before
        // sending a potentially expensive clone/fetch request to the backend.
        await Promise.resolve()
        if (signal.aborted) return
        const next = await api(endpoint, payload, sessionSchema, signal)
        if (signal.aborted || sourceRequestRef.current !== controller) return
        const wanted = options.coordinates ?? { ...DEFAULT_COORDINATES }
        let applied = wanted
        let displayed = next
        let final: { anchor: Session; tip: number } | null = null
        let notice = ""
        if (
          next.stack &&
          wanted.tip !== null &&
          !descendantTips(next.stack, next.stack.current).includes(wanted.tip)
        ) {
          applied = { ...wanted, scope: "pr", tip: null }
          notice = "That tip is not a descendant of the selected PR. Choose a valid stack lane."
        } else if (wanted.scope === "final" && next.stack) {
          const tips = descendantTips(next.stack, next.stack.current)
          const tip =
            wanted.tip !== null && tips.includes(wanted.tip)
              ? wanted.tip
              : wanted.tip === null && tips.length === 1
                ? tips[0]
                : null
          if (tip !== null) {
            displayed = await api(
              "/api/stack-scope",
              { id: next.id, number: tip, mode: "cumulative" },
              sessionSchema,
              signal,
            )
            final = { anchor: next, tip }
            applied = { ...wanted, tip }
          } else {
            applied = { ...wanted, scope: "pr", tip: null }
            notice =
              "Choose a descendant tip before opening Final stack; sibling branches are alternatives."
          }
        } else if (wanted.scope === "final") {
          applied = { ...wanted, scope: "pr", tip: null }
          notice = "Final stack requires a detected PR stack."
        } else if (wanted.scope === "cumulative" && next.stack) {
          displayed = await api(
            "/api/stack-scope",
            { id: next.id, number: next.stack.current, mode: "cumulative" },
            sessionSchema,
            signal,
          )
        }
        if (signal.aborted || sourceRequestRef.current !== controller) return
        const keep =
          applied.pathKind === "folder" && applied.path
            ? (displayed.files.find(
                (file) => file.renderable && inFolder(file.display_path, applied.path ?? ""),
              )?.display_path ?? applied.path)
            : applied.path
        const selectedIndex = reviewFileSelection(
          displayed.files,
          keep,
          applied.layout === "files",
          applied.diff === "text",
        )
        if (applied.layout === "pr" && applied.path !== null)
          applied = {
            ...applied,
            path: selectedIndex === null ? null : displayed.files[selectedIndex].display_path,
            pathKind: "file",
          }
        const pullUrl = next.comparison?.pull_request?.url ?? null
        writeReviewLocation(pullUrl, options.history, applied)
        if (pullUrl) setPrUrl(normalizePrUrl(pullUrl))
        stackCacheRef.current = new Map()
        if (next.stack) stackCacheRef.current.set(`${next.stack.current}:${next.stack.mode}`, next)
        if (displayed.stack)
          stackCacheRef.current.set(`${displayed.stack.current}:${displayed.stack.mode}`, displayed)
        setFinalReview(final)
        setCoordinates(applied)
        setDiffMode(applied.diff ?? (next.stack ? "semantic" : preferredMode()))
        showRoot(displayed, keep, applied.layout === "files", applied.diff === "text")
        if (notice) setStatus(notice)
      } catch (error) {
        if (!signal.aborted && sourceRequestRef.current === controller) {
          const message = error instanceof Error ? error.message : "Unable to create comparison"
          setStatus(message)
          setReviewError(message)
        }
      } finally {
        if (!signal.aborted && sourceRequestRef.current === controller) setLoading(false)
      }
    },
    [showRoot],
  )

  const navigateReview = useCallback(
    (location: ReviewLocation, signal: AbortSignal) => {
      setSourceTab("pr")
      setReviewError("")
      setFinalReview(null)
      if (location.kind === "pr") {
        // Do not leave another PR visible under this URL if navigation fails.
        setRootSession(null)
        setSession(null)
        setSelected(null)
        setCommitIndex(null)
        setPrUrl(location.url)
        void loadSession(
          "/api/github/open-url",
          { url: location.url },
          "Downloading the GitHub pull request if needed and generating its merge-base diff…",
          { signal, history: "replace", coordinates: location.coordinates },
        )
        return
      }
      sourceRequestRef.current?.abort()
      scopeRequestRef.current += 1
      stackRequestRef.current += 1
      scopeCacheRef.current = new Map()
      stackCacheRef.current = new Map()
      shownCommitIndexRef.current = null
      setLoading(false)
      setScopeLoading(false)
      setStackLoading(false)
      setRootSession(null)
      setSession(null)
      setSelected(null)
      setCommitIndex(null)
      setCoordinates(DEFAULT_COORDINATES)
      setPrUrl(location.kind === "invalid" ? location.input : "")
      setStatus(location.kind === "invalid" ? location.message : INITIAL_STATUS)
    },
    [loadSession],
  )
  useReviewNavigation(navigateReview)
  useEffect(() => () => sourceRequestRef.current?.abort(), [])

  const generate = () =>
    loadSession("/api/git-diff", { repo, base, target }, `Generating ${base} → ${target}…`)
  const upload = async (file?: File) => {
    if (!file) return
    await loadSession(
      "/api/patch",
      { repo, base, target, patch: await file.text() },
      `Reading ${file.name}…`,
    )
  }
  const listPulls = async (refresh = false) => {
    sourceRequestRef.current?.abort()
    const controller = new AbortController()
    sourceRequestRef.current = controller
    setLoading(true)
    setStatus(
      refresh
        ? "Refreshing open pull requests from GitHub…"
        : "Checking GitHub for open pull requests…",
    )
    try {
      const next = await api(
        "/api/github/open-prs",
        { repo, refresh },
        pullsSchema,
        controller.signal,
      )
      if (controller.signal.aborted || sourceRequestRef.current !== controller) return
      setPulls(next)
      setPrNumber(next[0] ? String(next[0].number) : "")
      setStatus(
        next.length
          ? `${next.length} open pull requests found; downloading them into the PR cache in the background.`
          : "No open pull requests found for this repository.",
      )
    } catch (error) {
      if (!controller.signal.aborted && sourceRequestRef.current === controller) {
        setStatus(error instanceof Error ? error.message : "Unable to list pull requests")
      }
    } finally {
      if (!controller.signal.aborted && sourceRequestRef.current === controller) setLoading(false)
    }
  }
  const openPull = () => {
    if (!prNumber) {
      setStatus("Choose an open pull request first.")
      return
    }
    void loadSession(
      "/api/github/compare",
      { repo, number: Number(prNumber) },
      `Fetching PR #${prNumber} and generating its merge-base diff…`,
    )
  }
  const openPrUrl = () => {
    if (!prUrl.trim()) {
      setStatus("Paste a GitHub pull-request URL first.")
      return
    }
    try {
      const url = normalizePrUrl(prUrl)
      setPrUrl(url)
      void loadSession(
        "/api/github/open-url",
        { url },
        "Downloading the GitHub pull request if needed and generating its merge-base diff…",
      )
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Invalid GitHub pull-request URL")
    }
  }

  // Show one commit (or `null` for all changes). Scopes are cached per commit
  // and mode, and the reviewed file stays selected when the next scope has it.
  const selectScope = useCallback(
    async (index: number | null, mode: ScopeMode) => {
      if (!rootSession || loading || stackLoading) return
      setReviewError("")
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
            next = await api(
              "/api/commit-scope",
              { id: rootSession.id, sha: commit.sha, mode },
              sessionSchema,
            )
            if (request !== scopeRequestRef.current) return
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
      const selectedPath =
        currentSelected === null ? null : current?.files[currentSelected]?.display_path
      const keep = selectedPath
        ? next.files.findIndex((file) => file.renderable && file.display_path === selectedPath)
        : -1
      shownCommitIndexRef.current = index
      setScopeLoading(false)
      setSession(next)
      setSelected(keep === -1 ? null : keep)
      setStatus(
        index === null
          ? comparisonStatus(next)
          : scopeStatus(next, rootSession.commits ?? EMPTY_COMMITS, index, mode),
      )
    },
    [rootSession, loading, stackLoading],
  )

  // `[` from the first commit returns to all changes; neither end wraps.
  const stepCommit = useCallback(
    (direction: 1 | -1) => {
      if (!commits.length) return
      const next =
        direction === 1
          ? commitIndex === null
            ? 0
            : Math.min(commits.length - 1, commitIndex + 1)
          : commitIndex === null || commitIndex === 0
            ? null
            : commitIndex - 1
      if (next !== commitIndex) void selectScope(next, scopeMode)
    },
    [commitIndex, commits.length, scopeMode, selectScope],
  )

  // Open another PR of the stack, or the same PR in the other stack mode.
  const selectStack = useCallback(
    async (
      number: number,
      mode: StackMode,
      preferredPath?: string,
      text = false,
      layout = coordinates.layout,
      requestedDiff?: DiffMode,
    ) => {
      if (!rootSession?.stack || loading) return
      setReviewError("")
      // A commit from the old PR must not land while a new member is loading.
      scopeRequestRef.current += 1
      setScopeLoading(false)
      setCommitIndex(shownCommitIndexRef.current)
      const request = ++stackRequestRef.current
      const cacheKey = `${number}:${mode}`
      let next = stackCacheRef.current.get(cacheKey)
      if (!next) {
        setStackLoading(true)
        try {
          next = await api("/api/stack-scope", { id: rootSession.id, number, mode }, sessionSchema)
          if (request !== stackRequestRef.current) return
          stackCacheRef.current.set(cacheKey, next)
        } catch (error) {
          if (request !== stackRequestRef.current) return
          setStackLoading(false)
          const message =
            error instanceof Error ? error.message : "Unable to open this pull request"
          setStatus(message)
          setReviewError(message)
          return
        }
      }
      if (request !== stackRequestRef.current) return
      setStackLoading(false)
      const { session: current, selected: currentSelected } = selectionRef.current
      const priorPath =
        currentSelected === null ? null : (current?.files[currentSelected]?.display_path ?? null)
      const keep =
        preferredPath ??
        (layout === "files"
          ? coordinates.pathKind === "folder" && coordinates.path
            ? (next.files.find(
                (file) =>
                  file.renderable &&
                  inFolder(file.display_path, coordinates.folder ?? coordinates.path ?? ""),
              )?.display_path ?? coordinates.path)
            : coordinates.path
          : priorPath)
      const nextMode =
        requestedDiff ?? (text ? "text" : number !== selectedStackNumber ? "semantic" : diffMode)
      const chosen = reviewFileSelection(next.files, keep, layout === "files", nextMode === "text")
      const applied: ReviewCoordinates = {
        ...coordinates,
        scope: mode === "cumulative" ? "cumulative" : "pr",
        layout,
        diff: nextMode,
        ...(preferredPath ? { path: preferredPath, pathKind: "file" } : {}),
        ...(layout === "pr"
          ? { path: chosen === null ? null : next.files[chosen].display_path, pathKind: "file" }
          : {}),
      }
      if (
        applied.tip !== null &&
        next.stack &&
        !descendantTips(next.stack, number).includes(applied.tip)
      )
        applied.tip = null
      const pullUrl = next.comparison?.pull_request?.url
      if (pullUrl) {
        writeReviewLocation(pullUrl, "push", applied)
        setPrUrl(normalizePrUrl(pullUrl))
      }
      setFinalReview(null)
      setCoordinates(applied)
      setDiffMode(nextMode)
      showRoot(next, keep, layout === "files", nextMode === "text")
    },
    [rootSession, selectedStackNumber, showRoot, loading, coordinates, diffMode],
  )

  const showFinalStack = async (requestedTip: number | null = laneTip) => {
    const anchor = workspaceRoot
    if (!anchor?.stack || loading) return
    const tips = descendantTips(anchor.stack, anchor.stack.current)
    if (requestedTip === null || !tips.includes(requestedTip)) {
      setStatus(
        "Choose a descendant tip before opening Final stack; sibling branches are alternatives.",
      )
      return
    }
    setReviewError("")
    scopeRequestRef.current += 1
    setScopeLoading(false)
    const request = ++stackRequestRef.current
    setStackLoading(true)
    try {
      const key = `${requestedTip}:cumulative`
      const next =
        stackCacheRef.current.get(key) ??
        (await api(
          "/api/stack-scope",
          { id: anchor.id, number: requestedTip, mode: "cumulative" },
          sessionSchema,
        ))
      if (request !== stackRequestRef.current) return
      stackCacheRef.current.set(key, next)
      const applied: ReviewCoordinates = {
        ...coordinates,
        scope: "final",
        tip: requestedTip,
        diff: diffMode,
      }
      const current = selectionRef.current
      const keep =
        coordinates.layout === "files"
          ? coordinates.pathKind === "folder" && coordinates.path
            ? (next.files.find(
                (file) =>
                  file.renderable &&
                  inFolder(file.display_path, coordinates.folder ?? coordinates.path ?? ""),
              )?.display_path ?? coordinates.path)
            : coordinates.path
          : current.selected === null
            ? null
            : (current.session?.files[current.selected]?.display_path ?? null)
      const selectedIndex = reviewFileSelection(
        next.files,
        keep,
        applied.layout === "files",
        diffMode === "text",
      )
      const canonical =
        applied.layout === "pr"
          ? {
              ...applied,
              path: selectedIndex === null ? null : next.files[selectedIndex].display_path,
              pathKind: "file" as const,
            }
          : applied
      showRoot(next, keep, applied.layout === "files", diffMode === "text")
      setFinalReview({ anchor, tip: requestedTip })
      setCoordinates(canonical)
      const url = anchor.comparison?.pull_request?.url
      if (url) writeReviewLocation(url, "push", canonical)
    } catch (error) {
      if (request === stackRequestRef.current) {
        const message = error instanceof Error ? error.message : "Final stack unavailable."
        setStatus(message)
        setReviewError(message)
      }
    } finally {
      if (request === stackRequestRef.current) setStackLoading(false)
    }
  }

  const updateCoordinates = useCallback(
    (next: ReviewCoordinates) => {
      setReviewError("")
      const index =
        next.layout === "files" && next.path
          ? files.findIndex((file) =>
              next.pathKind === "folder"
                ? file.renderable && inFolder(file.display_path, next.folder ?? next.path ?? "")
                : [file.display_path, file.old_path, file.new_path].includes(next.path),
            )
          : -1
      const forceText = index >= 0 && !files[index].renderable
      const applied = { ...next, diff: forceText ? ("text" as const) : (next.diff ?? diffMode) }
      setCoordinates(applied)
      if (next.layout === "files" && next.path) setSelected(index < 0 ? null : index)
      if (forceText) setDiffMode("text")
      const url = workspaceRoot?.comparison?.pull_request?.url
      if (url) writeReviewLocation(url, "push", applied)
    },
    [workspaceRoot, files, diffMode],
  )

  const selectFile = useCallback(
    (fileIndex: number) => {
      setReviewError("")
      setSelected(fileIndex)
      const file = files[fileIndex]
      if (file) updateCoordinates({ ...coordinates, path: file.display_path, pathKind: "file" })
    },
    [files, coordinates, updateCoordinates],
  )

  const reviewFromBottom = useCallback(() => {
    const bottom = stack?.members[0]
    if (!bottom || loading) return
    setDiffMode("semantic")
    void selectStack(bottom.pull.number, "pr", undefined, false, coordinates.layout, "semantic")
  }, [stack, loading, selectStack, coordinates.layout])

  const stepStack = useCallback(
    (direction: 1 | -1) => {
      if (!stack) return
      const next = stack.members[stackPosition + direction]
      if (next) void selectStack(next.pull.number, stack.mode)
    },
    [selectStack, stack, stackPosition],
  )

  const changeDiffMode = (mode: DiffMode) => {
    setDiffMode(mode)
    updateCoordinates({ ...coordinates, diff: mode })
    if (!rootSession?.stack) rememberMode(mode)
  }

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
    if (selected === null && firstRenderable !== undefined) selectFile(firstRenderable)
    setActiveRegion("diff")
  }, [fileNavigation, selected, selectFile])

  const moveFile = useCallback(
    (direction: 1 | -1) => {
      const { indices, positions } = fileNavigation
      if (!indices.length) return
      const current = selected === null ? -1 : (positions.get(selected) ?? -1)
      const next =
        current === -1
          ? direction === 1
            ? 0
            : indices.length - 1
          : (current + direction + indices.length) % indices.length
      selectFile(indices[next])
    },
    [fileNavigation, selected, selectFile],
  )

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
    let scrollTarget =
      semanticScrollCacheRef.current?.document === document
        ? semanticScrollCacheRef.current.target
        : null
    if (
      !scrollTarget ||
      !scrollTarget.isConnected ||
      scrollTarget.ownerDocument !== document ||
      scrollTarget.scrollHeight <= scrollTarget.clientHeight + 1
    ) {
      scrollTarget =
        [document.scrollingElement, ...document.querySelectorAll<HTMLElement>("*")]
          .filter((element): element is HTMLElement =>
            Boolean(element && element.scrollHeight > element.clientHeight + 1),
          )
          .sort(
            (left, right) =>
              right.scrollHeight - right.clientHeight - (left.scrollHeight - left.clientHeight),
          )[0] ?? null
      semanticScrollCacheRef.current = scrollTarget ? { document, target: scrollTarget } : undefined
    }
    const distance = Math.max(160, Math.round(viewport.innerHeight * 0.72)) * direction
    if (scrollTarget) {
      const nextTop = Math.max(
        0,
        Math.min(
          scrollTarget.scrollHeight - scrollTarget.clientHeight,
          scrollTarget.scrollTop + distance,
        ),
      )
      scrollTarget.scrollTo({ top: nextTop })
    } else viewport.scrollBy({ top: distance, behavior: "smooth" })
  }, [])

  const toggleViewed = useCallback(() => {
    if (
      selected === null ||
      !files[selected] ||
      !session ||
      session.comparison?.kind === "since-review" ||
      scopeLoading ||
      stackLoading ||
      loading
    )
      return
    setReviewError("")
    toggleEvidence(files[selected], session.id, selected)
  }, [files, selected, session, toggleEvidence, scopeLoading, stackLoading, loading])

  const showSinceReview = useCallback(async () => {
    if (stackLoading || scopeLoading || loading) return
    const file = selected === null ? undefined : files[selected]
    const previous = evidenceFor(evidenceContext, file, records).outdated
    if (!session || selected === null || !previous?.snapshot_id) {
      setStatus(
        "Reviewed snapshot unavailable. Return to the current comparison and perform a fresh review.",
      )
      return
    }
    setReviewError("")
    const request = ++scopeRequestRef.current
    setScopeLoading(true)
    try {
      const next = await api(
        "/api/since-review",
        { id: session.id, index: selected, snapshot_id: previous.snapshot_id },
        sessionSchema,
      )
      if (
        request !== scopeRequestRef.current ||
        selectionRef.current.session?.id !== session.id ||
        selectionRef.current.selected !== selected
      )
        return
      setSession(next)
      setSelected(next.files.length ? 0 : null)
      shownCommitIndexRef.current = null
      setCommitIndex(null)
      setStatus(next.comparison?.description ?? "Changes since my review")
    } catch (error) {
      if (request === scopeRequestRef.current) {
        const message =
          error instanceof Error
            ? error.message
            : "Reviewed snapshot unavailable; perform a fresh review."
        setStatus(message)
        setReviewError(message)
      }
    } finally {
      if (request === scopeRequestRef.current) setScopeLoading(false)
    }
  }, [session, selected, files, evidenceContext, records, stackLoading, scopeLoading, loading])

  const nextUnviewed = useCallback(() => {
    const { indices, positions } = fileNavigation
    const start = selected === null ? -1 : (positions.get(selected) ?? -1)
    for (let step = 1; step <= indices.length; step++) {
      const candidate = indices[(start + step) % indices.length]
      if (!viewedFiles.has(candidate)) {
        selectFile(candidate)
        return
      }
    }
    if (indices.length) setStatus("Every file in this view is marked as viewed.")
  }, [fileNavigation, selected, viewedFiles, selectFile])

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

  const runOverlayCommand = useCallback(
    (key: string) => {
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
        case "{":
          stepStack(-1)
          break
        case "}":
          stepStack(1)
          break
        case "n":
          nextUnviewed()
          break
        case "m":
          toggleViewed()
          break
      }
    },
    [
      activeRegion,
      focusDiff,
      focusSidebar,
      moveFile,
      nextUnviewed,
      scrollDiff,
      stepCommit,
      stepStack,
      toggleViewed,
    ],
  )

  useEffect(() => {
    if (activeRegion !== "diff") return
    const frame = requestAnimationFrame(() =>
      (diffFrameRef.current ?? diffPanelRef.current)?.focus(),
    )
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
    const onMessage = (event: MessageEvent<unknown>) => {
      if (
        event.origin !== window.location.origin ||
        !diffFrameRef.current ||
        event.source !== diffFrameRef.current.contentWindow
      )
        return
      const key = readViewerKey(event.data)
      if (!key) return
      if (key === "-") {
        toggleKeyboardOverlay()
      } else if (key === "?") {
        showKeyboardHelp()
      } else if (key === "Escape" && keyboardOverlay) {
        setKeyboardOverlay(false)
      } else if (keyboardOverlay && OVERLAY_KEYS.includes(key.toLowerCase())) {
        runOverlayCommand(key)
      }
    }
    window.addEventListener("keydown", onKeyDown)
    window.addEventListener("message", onMessage)
    return () => {
      window.removeEventListener("keydown", onKeyDown)
      window.removeEventListener("message", onMessage)
    }
  }, [keyboardOverlay, runOverlayCommand, showKeyboardHelp, toggleKeyboardOverlay])

  const selectedFile = selected === null ? null : session?.files[selected]
  const previousReviews = evidenceContext
    ? records.filter(
        (record) =>
          !record.symbol &&
          record.context.repository === evidenceContext.repository &&
          record.context.pr === evidenceContext.pr &&
          record.context.scope === evidenceContext.scope &&
          record.context.tip === evidenceContext.tip &&
          (record.context.base !== evidenceContext.base ||
            record.context.target !== evidenceContext.target),
      )
    : []
  const selectedViewed = selected !== null && viewedFiles.has(selected)
  const selectedEvidence = evidenceFor(evidenceContext, selectedFile, records)
  const sinceReview = session?.comparison?.kind === "since-review"
  const reviewable = fileNavigation.indices.length
  const viewedCount = fileNavigation.indices.filter((index) => viewedFiles.has(index)).length
  const selectedPosition = selected === null ? null : fileNavigation.positions.get(selected)
  const pullRequest = rootSession?.comparison?.pull_request ?? null
  const renderPullItem = (pull: PullRequest, depth = 0) => (
    <CommandItem
      key={pull.number}
      value={`${pull.number} ${pull.title} ${pull.author?.login ?? ""} ${pull.headRefName}`}
      onSelect={() => {
        setPrNumber(String(pull.number))
        setPrPickerOpen(false)
      }}
    >
      <Check
        className={cn(
          "mr-1 size-4 shrink-0",
          prNumber === String(pull.number) ? "opacity-100" : "opacity-0",
        )}
      />
      <span
        className="flex min-w-0 flex-1 items-center gap-1.5"
        style={{ paddingLeft: depth * 14 }}
      >
        {depth > 0 && (
          <span className="shrink-0 text-muted-foreground" aria-hidden="true">
            ↳
          </span>
        )}
        <span className="shrink-0 font-medium tabular-nums">#{pull.number}</span>
        <span className="min-w-0 truncate">{pull.title}</span>
      </span>
      {pull.isDraft && (
        <span className="ml-2 shrink-0 rounded bg-muted px-1.5 text-[10px] font-medium uppercase text-muted-foreground">
          Draft
        </span>
      )}
    </CommandItem>
  )
  const gridStyle: CSSProperties & { "--sidebar-width": string } = {
    "--sidebar-width": `${sidebarWidth}px`,
  }

  return (
    <div className="min-h-screen bg-muted/40">
      {loading && (
        <div
          className="fixed inset-x-0 top-0 z-[60] h-1 overflow-hidden bg-primary/10"
          role="progressbar"
          aria-label="Loading comparison"
        >
          <div className="loading-sheen h-full w-1/3 bg-primary" />
        </div>
      )}
      {!chromeHidden && (
        <header className="border-b bg-background">
          <div className="flex h-12 w-full items-center gap-3 px-4">
            <div className="flex items-center gap-2 font-semibold">
              <FileDiff className="size-5 text-primary" /> Local Diffe
            </div>
            <span className="hidden text-sm text-muted-foreground md:inline">
              GitHub-style review, SemanticDiff display engine
            </span>
            <div className="ml-auto flex items-center gap-2">
              <div className="hidden items-center gap-1.5 text-xs text-muted-foreground sm:flex">
                <Sparkles className="size-3.5" /> local only
              </div>
              <Button
                data-testid="keyboard-overlay-toggle"
                size="sm"
                variant={keyboardOverlay ? "secondary" : "outline"}
                onClick={toggleKeyboardOverlay}
                aria-pressed={keyboardOverlay}
                title="Toggle keyboard overlay (-)"
              >
                <Keyboard className="size-4" /> Keys
              </Button>
              <Button
                data-testid="hide-chrome"
                size="sm"
                variant="outline"
                onClick={() => setChromeHidden(true)}
              >
                <ChevronUp className="size-4" /> Focus view
              </Button>
            </div>
          </div>
        </header>
      )}

      <main className="flex w-full flex-col gap-3 p-4">
        {loading && (
          <div
            className="flex items-center gap-3 rounded-2xl bg-primary/[.07] px-4 py-3 text-sm text-foreground shadow-[0_12px_32px_-28px_rgba(0,113,227,0.8)]"
            role="status"
            aria-live="polite"
          >
            <LoaderCircle className="size-4 shrink-0 animate-spin text-primary" />
            <span className="min-w-0 truncate">{status}</span>
            <span className="loading-dots shrink-0 text-primary" aria-hidden="true">
              •••
            </span>
          </div>
        )}
        {chromeHidden && (
          <Button
            data-testid="show-chrome"
            size="sm"
            variant="outline"
            className="fixed right-4 top-4 z-20 shadow-md"
            onClick={() => setChromeHidden(false)}
          >
            <ChevronDown className="size-4" /> Show controls
          </Button>
        )}
        {!chromeHidden && (
          <Card data-testid="source-card">
            <CardContent className="grid gap-3 p-3">
              <div className="flex flex-wrap items-center gap-3">
                <div
                  role="tablist"
                  aria-label="Review source"
                  className="flex rounded-full bg-muted p-0.5 text-xs font-medium"
                >
                  {SOURCE_TABS.map(([tab, label, Icon]) => (
                    <button
                      key={tab}
                      type="button"
                      role="tab"
                      data-testid={`source-${tab}`}
                      aria-selected={sourceTab === tab}
                      onClick={() => setSourceTab(tab)}
                      className={cn(
                        "flex items-center gap-1.5 rounded-full px-3 py-1.5 transition-colors",
                        sourceTab === tab
                          ? "bg-background text-foreground shadow-sm"
                          : "text-muted-foreground hover:text-foreground",
                      )}
                    >
                      <Icon className="size-3.5" />
                      {label}
                    </button>
                  ))}
                </div>
                <label
                  className="flex min-w-[260px] flex-1 items-center gap-2 text-xs font-medium text-muted-foreground lg:ml-auto lg:max-w-[560px]"
                  title="Local repository: used to list its PRs and to generate branch diffs"
                >
                  <FolderGit2 className="size-3.5 shrink-0" />
                  <span className="shrink-0">Repository</span>
                  <Input
                    data-testid="repo"
                    value={repo}
                    onChange={(event) => setRepo(event.target.value)}
                    className="h-8 font-mono text-xs"
                  />
                </label>
              </div>
              {sourceTab === "pr" && (
                <div className="grid gap-2 lg:grid-cols-[minmax(0,1fr)_auto_minmax(0,1.25fr)_auto] lg:items-center">
                  <Input
                    data-testid="pr-url"
                    aria-label="GitHub pull-request URL"
                    value={prUrl}
                    onChange={(event) => setPrUrl(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") openPrUrl()
                    }}
                    placeholder="Paste a PR link — https://github.com/owner/repo/pull/123"
                    className="h-9"
                  />
                  <Button
                    data-testid="open-pr-url"
                    variant="secondary"
                    onClick={openPrUrl}
                    disabled={loading}
                  >
                    <Link className="size-4" /> Open
                  </Button>
                  <Popover open={prPickerOpen} onOpenChange={setPrPickerOpen}>
                    <PopoverTrigger asChild>
                      <Button
                        data-testid="pr-select"
                        variant="outline"
                        aria-label="Open pull requests"
                        aria-expanded={prPickerOpen}
                        disabled={!pulls.length || loading}
                        className="h-9 w-full min-w-0 justify-between font-normal"
                      >
                        <span className="min-w-0 truncate">
                          {selectedPull ? (
                            <>
                              <span className="font-medium tabular-nums">
                                #{selectedPull.number}
                              </span>{" "}
                              · {selectedPull.title}
                            </>
                          ) : pulls.length ? (
                            "Choose an open PR"
                          ) : (
                            "or list this repository's open PRs →"
                          )}
                        </span>
                        <ChevronsUpDown className="ml-2 size-4 shrink-0 opacity-50" />
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent
                      aria-label="Choose a pull request"
                      align="start"
                      className="w-[max(var(--radix-popover-trigger-width),420px)]"
                    >
                      <Command label="Search pull requests">
                        <CommandInput placeholder="Search by PR number, title, author or branch…" />
                        <CommandList className="max-h-96">
                          <CommandEmpty>No matching pull request.</CommandEmpty>
                          {pullGroups.stacks.map((rows) => (
                            <CommandGroup
                              key={rows[0].pull.number}
                              heading={`Stack on ${rows[0].pull.baseRefName} · ${rows.length} PRs`}
                            >
                              {rows.map(({ pull, depth }) => renderPullItem(pull, depth))}
                            </CommandGroup>
                          ))}
                          {pullGroups.standalone.length > 0 && (
                            <CommandGroup
                              heading={
                                pullGroups.stacks.length
                                  ? `Other open PRs · ${pullGroups.standalone.length}`
                                  : `${pulls.length} open pull requests`
                              }
                            >
                              {pullGroups.standalone.map((pull) => renderPullItem(pull))}
                            </CommandGroup>
                          )}
                        </CommandList>
                      </Command>
                    </PopoverContent>
                  </Popover>
                  <div className="flex gap-2">
                    <Button
                      data-testid="list-prs"
                      variant="outline"
                      onClick={() => void listPulls()}
                      disabled={loading}
                    >
                      <GitPullRequest className="size-4" /> List
                    </Button>
                    <Button
                      data-testid="refresh-prs"
                      size="icon"
                      variant="outline"
                      onClick={() => void listPulls(true)}
                      disabled={loading}
                      title="Refresh open PRs from GitHub"
                      aria-label="Refresh open PRs"
                    >
                      <RefreshCw className="size-4" />
                    </Button>
                    <Button
                      data-testid="open-selected-pr"
                      onClick={openPull}
                      disabled={loading || !prNumber}
                    >
                      {loading ? (
                        <LoaderCircle className="size-4 animate-spin" />
                      ) : (
                        <GitBranch className="size-4" />
                      )}{" "}
                      Review
                    </Button>
                  </div>
                </div>
              )}
              {sourceTab !== "pr" && (
                <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-center">
                  <label className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                    <span className="w-14 shrink-0">Base</span>
                    <Input
                      data-testid="base"
                      value={base}
                      onChange={(event) => setBase(event.target.value)}
                      className="h-9 font-mono text-xs"
                    />
                  </label>
                  <label className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                    <span className="w-14 shrink-0">Compare</span>
                    <Input
                      data-testid="target"
                      value={target}
                      onChange={(event) => setTarget(event.target.value)}
                      className="h-9 font-mono text-xs"
                    />
                  </label>
                  {sourceTab === "branches" ? (
                    <Button data-testid="generate-diff" onClick={generate} disabled={loading}>
                      {loading ? (
                        <LoaderCircle className="size-4 animate-spin" />
                      ) : (
                        <GitBranch className="size-4" />
                      )}{" "}
                      Generate diff
                    </Button>
                  ) : (
                    <Button asChild variant="outline" disabled={loading}>
                      <label className="cursor-pointer">
                        {loading ? (
                          <LoaderCircle className="size-4 animate-spin" />
                        ) : (
                          <Upload className="size-4" />
                        )}{" "}
                        Upload patch
                        <input
                          className="hidden"
                          type="file"
                          accept=".diff,.patch,text/plain"
                          onChange={(event) => upload(event.target.files?.[0])}
                        />
                      </label>
                    </Button>
                  )}
                </div>
              )}
              {!loading && (
                <p
                  data-testid="status"
                  role="status"
                  className="truncate px-1 text-xs text-muted-foreground"
                  title={status}
                >
                  {status}
                </p>
              )}
            </CardContent>
          </Card>
        )}

        {reviewError && (
          <p
            data-testid="review-error"
            role="alert"
            className="rounded border border-amber-500/30 px-3 py-2 text-sm"
          >
            {reviewError}
          </p>
        )}
        {rootSession && evidenceWarning && (
          <p
            data-testid="evidence-warning"
            className="rounded border px-3 py-2 text-xs text-muted-foreground"
          >
            {evidenceWarning}
          </p>
        )}
        {rootSession && previousReviews.length > 0 && (
          <details
            data-testid="previous-review-evidence"
            className="rounded border px-3 py-2 text-xs text-muted-foreground"
          >
            <summary>
              {previousReviews.length} earlier file reviews at other comparison revisions (not
              current approval)
            </summary>
            <ul className="mt-1 max-h-32 overflow-auto">
              {previousReviews.slice(0, 20).map((record) => (
                <li key={`${record.path}:${record.context.base}:${record.context.target}`}>
                  {record.path} · {record.context.base.slice(0, 7)} →{" "}
                  {record.context.target.slice(0, 7)}
                </li>
              ))}
            </ul>
            <p>
              Evidence is local and bounded to 512 records / approximately 1 MiB. Historical
              snapshot IDs are retained by this server for at most 128 versions and become
              unavailable after eviction, restart, or missing Git objects.
            </p>
          </details>
        )}
        {rootSession && !chromeHidden && (
          <Card
            data-testid="review-summary"
            className="flex flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3"
          >
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 items-center gap-2">
                {pullRequest ? (
                  <GitPullRequest className="size-4 shrink-0 text-primary" />
                ) : (
                  <GitCompareArrows className="size-4 shrink-0 text-primary" />
                )}
                {pullRequest ? (
                  <a
                    href={pullRequest.url}
                    target="_blank"
                    rel="noreferrer"
                    className="min-w-0 truncate text-sm font-semibold hover:underline"
                  >
                    {pullRequest.title}
                  </a>
                ) : (
                  <span className="min-w-0 truncate font-mono text-sm font-semibold">
                    {rootSession.comparison
                      ? `${rootSession.comparison.base.revision} → ${rootSession.comparison.target.revision}`
                      : "Uploaded patch"}
                  </span>
                )}
                {pullRequest && (
                  <span className="shrink-0 text-sm tabular-nums text-muted-foreground">
                    #{pullRequest.number}
                  </span>
                )}
                {pullRequest?.isDraft && (
                  <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase text-muted-foreground">
                    Draft
                  </span>
                )}
                {stack && (
                  <span className="flex shrink-0 items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary">
                    <Layers className="size-3" /> {stackPosition + 1} of {stack.members.length} in
                    stack
                  </span>
                )}
              </div>
              <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                {pullRequest && (
                  <span className="flex min-w-0 items-center gap-1.5">
                    <BranchChip name={pullRequest.baseRefName} />
                    <span aria-label="from">←</span>
                    <BranchChip name={pullRequest.headRefName} />
                  </span>
                )}
                {pullRequest?.author && <span>by {pullRequest.author.login}</span>}
                {session?.comparison && (
                  <span className="min-w-0 truncate" title={session.comparison.description}>
                    {session.comparison.description}
                  </span>
                )}
              </div>
            </div>
            <dl className="flex shrink-0 items-center gap-5 text-xs">
              <div>
                <dt className="text-muted-foreground">Files</dt>
                <dd className="font-semibold tabular-nums">
                  {session?.comparison?.changed_paths ?? session?.files.length ?? 0}
                </dd>
              </div>
              {commits.length > 0 && (
                <div>
                  <dt className="text-muted-foreground">Commits</dt>
                  <dd className="font-semibold tabular-nums">{commits.length}</dd>
                </div>
              )}
              <div className="w-36">
                <dt className="flex justify-between text-muted-foreground">
                  <span>Viewed</span>
                  <span className="tabular-nums">
                    {viewedCount}/{reviewable}
                  </span>
                </dt>
                <dd className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full rounded-full bg-emerald-500 transition-[width] duration-300"
                    style={{ width: `${reviewable ? (viewedCount / reviewable) * 100 : 0}%` }}
                  />
                </dd>
              </div>
            </dl>
          </Card>
        )}

        <div
          ref={reviewGrid}
          aria-busy={loading}
          style={gridStyle}
          className={cn(
            "grid min-h-[calc(100vh-150px)] gap-3 lg:grid-cols-[minmax(220px,var(--sidebar-width))_minmax(0,1fr)]",
            chromeHidden && "min-h-[calc(100vh-2rem)]",
          )}
        >
          <SidebarProfilerBoundary>
            <Card
              ref={sidebarRef}
              tabIndex={-1}
              aria-label="Changed files sidebar"
              className={cn(
                "relative flex min-h-0 flex-col overflow-visible outline-none",
                activeRegion === "sidebar" &&
                  keyboardOverlay &&
                  "ring-2 ring-primary ring-offset-2",
              )}
            >
              <CardHeader className="gap-3 rounded-t-lg bg-card p-3">
                {stack && (
                  <StackRail
                    stack={stack}
                    busy={stackLoading}
                    disabled={loading}
                    onSelect={(number) => void selectStack(number, stack.mode)}
                    onStep={stepStack}
                    onStart={reviewFromBottom}
                  >
                    <Segmented
                      value={finalReview ? "final" : stack.mode}
                      options={STACK_MODES}
                      onChange={(mode) => {
                        if (mode === "final") void showFinalStack()
                        else if (finalReview || mode !== stack.mode)
                          void selectStack(stack.current, mode)
                      }}
                      label="Stack scope"
                      testId="stack-scope"
                    />
                    <label className="grid gap-1 text-xs">
                      Stack lane tip
                      <select
                        data-testid="stack-tip"
                        className="min-w-0 rounded border bg-background p-1.5"
                        value={laneTip ?? ""}
                        onChange={(event) => {
                          const tip = Number(event.target.value)
                          if (!tip) return
                          if (finalReview) void showFinalStack(tip)
                          else updateCoordinates({ ...coordinates, tip })
                        }}
                      >
                        {(laneTip === null || laneTips.length !== 1) && (
                          <option value="">Choose a descendant tip</option>
                        )}
                        {laneTips.map((number) => (
                          <option key={number} value={number}>
                            #{number} ·{" "}
                            {
                              stack.members.find((member) => member.pull.number === number)?.pull
                                .headRefName
                            }
                          </option>
                        ))}
                      </select>
                    </label>
                    <div role="group" aria-label="Review layout" className="flex gap-1">
                      <Button
                        data-testid="layout-pr"
                        size="sm"
                        variant={coordinates.layout === "pr" ? "secondary" : "ghost"}
                        onClick={() => updateCoordinates({ ...coordinates, layout: "pr" })}
                      >
                        PR by PR
                      </Button>
                      <Button
                        data-testid="layout-files"
                        size="sm"
                        variant={coordinates.layout === "files" ? "secondary" : "ghost"}
                        onClick={() =>
                          updateCoordinates({
                            ...coordinates,
                            layout: "files",
                            path: coordinates.path ?? selectedFile?.display_path ?? null,
                          })
                        }
                      >
                        Files across stack
                      </Button>
                    </div>
                  </StackRail>
                )}
                {stack && workspaceRoot && coordinates.layout === "files" && (
                  <StackHistoryPanel
                    root={workspaceRoot}
                    coordinates={coordinates}
                    tip={laneTip}
                    history={historyState.history}
                    error={historyState.error}
                    records={records}
                    canReviewSymbols={
                      !finalReview &&
                      session?.id === rootSession?.id &&
                      rootSession?.stack?.mode === "pr"
                    }
                    onRetry={historyState.retry}
                    onCoordinates={updateCoordinates}
                    onOpen={(number, file) =>
                      void selectStack(number, "pr", file.display_path, !file.renderable)
                    }
                    onPrLayout={() =>
                      void selectStack(
                        stack.current,
                        "pr",
                        coordinates.path ?? undefined,
                        false,
                        "pr",
                      )
                    }
                    onSymbolReview={(file, key, hash) => {
                      if (
                        !rootSession ||
                        finalReview ||
                        session?.id !== rootSession.id ||
                        rootSession.stack?.mode !== "pr"
                      ) {
                        setStatus(
                          "Open this declaration's own PR comparison before recording a function review.",
                        )
                        return
                      }
                      const index = rootSession.files.findIndex(
                        (entry) => entry.display_path === file.display_path,
                      )
                      if (index >= 0)
                        toggleEvidence(rootSession.files[index], rootSession.id, index, {
                          key,
                          hash,
                        })
                    }}
                  />
                )}
                <div className="flex items-center justify-between gap-2">
                  <CardTitle className="text-sm">
                    Changed files{" "}
                    {session && (
                      <span className="font-normal text-muted-foreground">
                        ({session.comparison?.changed_paths ?? session.files.length})
                      </span>
                    )}
                  </CardTitle>
                  <div className="flex items-center gap-0.5">
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      className="size-7"
                      title="Smaller file text"
                      onClick={() => setSidebarFontSize((size) => Math.max(10, size - 1))}
                    >
                      <Minus className="size-3.5" />
                    </Button>
                    <span
                      className="w-7 text-center text-[10px] text-muted-foreground"
                      title="File sidebar font size"
                    >
                      {sidebarFontSize}px
                    </span>
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      className="size-7"
                      title="Larger file text"
                      onClick={() => setSidebarFontSize((size) => Math.min(18, size + 1))}
                    >
                      <Plus className="size-3.5" />
                    </Button>
                    <span className="mx-1 h-4 border-l" />
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      className="size-7"
                      title="Make file sidebar narrower"
                      onClick={() => setSidebarWidth((width) => Math.max(220, width - 40))}
                    >
                      <Minus className="size-3.5" />
                    </Button>
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      className="size-7"
                      title="Make file sidebar wider"
                      onClick={() => setSidebarWidth((width) => Math.min(760, width + 40))}
                    >
                      <Plus className="size-3.5" />
                    </Button>
                  </div>
                </div>
                {commits.length > 0 && (
                  <div data-testid="commit-rail" className="grid grid-cols-[minmax(0,1fr)] gap-1.5">
                    <div className="flex items-center gap-1">
                      <Button
                        type="button"
                        data-testid="previous-commit"
                        size="icon"
                        variant="outline"
                        className="size-8 shrink-0"
                        title="Previous commit ([)"
                        disabled={commitIndex === null}
                        onClick={() => stepCommit(-1)}
                      >
                        <ChevronLeft className="size-4" />
                      </Button>
                      <Popover open={commitPickerOpen} onOpenChange={setCommitPickerOpen}>
                        <PopoverTrigger asChild>
                          <Button
                            type="button"
                            data-testid="commit-select"
                            variant="outline"
                            aria-label="Commit to review"
                            aria-expanded={commitPickerOpen}
                            className="h-8 min-w-0 flex-1 justify-between px-2 font-normal"
                          >
                            <span className="flex min-w-0 items-center gap-1.5 text-xs">
                              {scopeLoading ? (
                                <LoaderCircle className="size-3.5 shrink-0 animate-spin text-primary" />
                              ) : (
                                <GitCommitHorizontal className="size-3.5 shrink-0 text-muted-foreground" />
                              )}
                              <span className="min-w-0 truncate">
                                {commitIndex === null ? (
                                  `All changes · ${commits.length} ${commits.length === 1 ? "commit" : "commits"}`
                                ) : (
                                  <>
                                    <span className="tabular-nums text-muted-foreground">
                                      {commitIndex + 1}/{commits.length}
                                    </span>{" "}
                                    <span className="font-mono">{commits[commitIndex].short}</span>{" "}
                                    {commits[commitIndex].subject}
                                  </>
                                )}
                              </span>
                            </span>
                            <ChevronsUpDown className="ml-1 size-3.5 shrink-0 opacity-50" />
                          </Button>
                        </PopoverTrigger>
                        <PopoverContent
                          aria-label="Choose a commit"
                          align="start"
                          className="w-[min(480px,calc(100vw-2rem))]"
                        >
                          <Command label="Search commits">
                            <CommandInput placeholder="Search commits by subject, SHA or author…" />
                            <CommandList className="max-h-80">
                              <CommandEmpty>No matching commit.</CommandEmpty>
                              <CommandGroup>
                                <CommandItem
                                  value="all changes"
                                  onSelect={() => {
                                    setCommitPickerOpen(false)
                                    void selectScope(null, scopeMode)
                                  }}
                                >
                                  <Check
                                    className={cn(
                                      "mr-2 size-4 shrink-0",
                                      commitIndex === null ? "opacity-100" : "opacity-0",
                                    )}
                                  />
                                  <span className="font-medium">All changes</span>
                                  <span className="ml-auto pl-3 text-xs text-muted-foreground">
                                    {rootSession?.comparison?.changed_paths ??
                                      rootSession?.files.length}{" "}
                                    files
                                  </span>
                                </CommandItem>
                              </CommandGroup>
                              <CommandGroup
                                heading={
                                  rootSession?.commits_truncated
                                    ? `Newest ${commits.length} commits`
                                    : `${commits.length} ${commits.length === 1 ? "commit" : "commits"}, oldest first`
                                }
                              >
                                {commits.map((commit, index) => (
                                  <CommandItem
                                    key={commit.sha}
                                    value={`${commit.sha} ${commit.subject} ${commit.author}`}
                                    onSelect={() => {
                                      setCommitPickerOpen(false)
                                      void selectScope(index, scopeMode)
                                    }}
                                  >
                                    <Check
                                      className={cn(
                                        "mr-2 size-4 shrink-0",
                                        commitIndex === index ? "opacity-100" : "opacity-0",
                                      )}
                                    />
                                    <span className="mr-2 w-6 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                                      {index + 1}
                                    </span>
                                    <span className="min-w-0 flex-1">
                                      <span className="block truncate">
                                        {commit.subject || "(no message)"}
                                      </span>
                                      <span className="block truncate text-[11px] text-muted-foreground">
                                        <span className="font-mono">{commit.short}</span> ·{" "}
                                        {commit.author} · {formatCommitDate(commit.date)} ·{" "}
                                        {commit.files_changed
                                          ? `${commit.files_changed} ${commit.files_changed === 1 ? "file" : "files"}`
                                          : "no file changes"}
                                        {commit.parents.length > 1 ? " · merge" : ""}
                                      </span>
                                    </span>
                                  </CommandItem>
                                ))}
                              </CommandGroup>
                            </CommandList>
                          </Command>
                        </PopoverContent>
                      </Popover>
                      <Button
                        type="button"
                        data-testid="next-commit"
                        size="icon"
                        variant="outline"
                        className="size-8 shrink-0"
                        title="Next commit (])"
                        disabled={commitIndex === commits.length - 1}
                        onClick={() => stepCommit(1)}
                      >
                        <ChevronRight className="size-4" />
                      </Button>
                    </div>
                    {commitIndex !== null && (
                      <Segmented
                        value={scopeMode}
                        options={COMMIT_MODES}
                        onChange={changeScopeMode}
                        label="Commit scope"
                        testId="scope"
                      />
                    )}
                  </div>
                )}
                <div className="relative">
                  <Search className="pointer-events-none absolute left-2 top-2 size-3.5 text-muted-foreground" />
                  <Input
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    placeholder="Filter files"
                    className="h-8 pl-7 text-xs"
                  />
                </div>
              </CardHeader>
              <CardContent
                ref={sidebarContentRef}
                style={{ contain: "size" }}
                className="min-h-[240px] flex-1 overflow-hidden lg:min-h-0 rounded-b-2xl bg-card p-2"
              >
                {tree.length ? (
                  <SidebarTree
                    tree={tree}
                    treeHeight={treeHeight}
                    rowHeight={sidebarRowHeight}
                    indent={Math.max(9, Math.round(14 * sidebarScale))}
                    searchTerm={deferredSearch}
                    selected={selected}
                    viewedFiles={viewedFiles}
                    sidebarScale={sidebarScale}
                    sidebarFontSize={sidebarFontSize}
                    sidebarIconSize={sidebarIconSize}
                    sidebarGap={sidebarGap}
                    sidebarPadding={sidebarPadding}
                    onSelectFile={selectFile}
                  />
                ) : loading ? (
                  <div className="grid h-full place-items-center p-6 text-center text-sm text-muted-foreground">
                    <div>
                      <LoaderCircle className="mx-auto mb-3 size-6 animate-spin text-primary" />
                      <p>
                        Preparing changed files
                        <span className="loading-dots text-primary" aria-hidden="true">
                          •••
                        </span>
                      </p>
                      <p className="mt-1 text-xs">
                        Large pull requests can take a moment to index.
                      </p>
                    </div>
                  </div>
                ) : session ? (
                  <p className="p-3 text-xs text-muted-foreground">
                    {commitIndex !== null
                      ? "No file changes in this commit."
                      : "No file changes in this view."}
                  </p>
                ) : (
                  <p className="p-3 text-xs text-muted-foreground">
                    Open a pull request, compare branches, or upload a patch to populate the file
                    tree.
                  </p>
                )}
              </CardContent>
              <div className="grid gap-1.5 px-4 pb-4 pt-2 text-[11px] text-muted-foreground">
                <div className="flex items-center justify-between gap-3">
                  <span>
                    {session
                      ? `${session.files.length} ${session.files.length === 1 ? "file" : "files"}`
                      : "No comparison loaded"}
                  </span>
                  {session && (
                    <span className="tabular-nums">
                      {viewedCount} of {reviewable} viewed
                    </span>
                  )}
                </div>
                {session && (
                  <div className="h-1 overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-full rounded-full bg-emerald-500 transition-[width] duration-300"
                      style={{ width: `${reviewable ? (viewedCount / reviewable) * 100 : 0}%` }}
                    />
                  </div>
                )}
              </div>
              <button
                type="button"
                aria-label="Resize file sidebar"
                title="Drag to resize the file sidebar"
                onPointerDown={startSidebarResize}
                className={cn(
                  "absolute -right-3 top-0 z-10 hidden h-full w-6 cursor-col-resize touch-none items-center justify-center lg:flex",
                  resizingSidebar && "bg-primary/5",
                )}
              >
                <span className="grid h-12 w-3 place-items-center rounded-full border bg-background text-muted-foreground shadow-sm">
                  <GripVertical className="size-3" />
                </span>
              </button>
            </Card>
          </SidebarProfilerBoundary>

          <Card
            ref={diffPanelRef}
            tabIndex={-1}
            aria-label="Diff panel"
            className={cn(
              "flex min-h-0 flex-col overflow-hidden outline-none lg:sticky lg:top-4 lg:self-start",
              activeRegion === "diff" && keyboardOverlay && "ring-2 ring-primary ring-offset-2",
            )}
          >
            {stackContext && (
              <div
                data-testid="stack-review-context"
                aria-live="polite"
                aria-atomic="true"
                className={cn("border-b bg-muted/35 px-4 py-2.5", chromeHidden && "pr-[180px]")}
              >
                <p className="text-sm font-semibold">{stackContext.title}</p>
                {finalReview && (
                  <p className="text-xs text-muted-foreground">
                    Selected member #{finalReview.anchor.stack?.current}; final lane tip #
                    {finalReview.tip}. PR contributions and final-result reviews are separate.
                  </p>
                )}
                <p className="mt-0.5 text-xs text-muted-foreground">{stackContext.description}</p>
                {stackContext.range && (
                  <p className="mt-1 font-mono text-[11px] text-muted-foreground">
                    {stackContext.range}
                  </p>
                )}
              </div>
            )}
            {selectedEvidence.outdated && !selectedEvidence.current && !sinceReview && (
              <div
                data-testid="outdated-review"
                className="flex flex-wrap items-center gap-2 border-b bg-amber-500/5 px-4 py-2 text-xs"
              >
                <span>
                  Outdated review · this file's comparison base or target changed. It is not marked
                  reviewed at this revision.
                </span>
                <Button
                  data-testid="changes-since-review"
                  size="sm"
                  variant="outline"
                  disabled={
                    !selectedEvidence.outdated.snapshot_id ||
                    scopeLoading ||
                    stackLoading ||
                    loading
                  }
                  onClick={() => void showSinceReview()}
                >
                  Changes since my review
                </Button>
                {!selectedEvidence.outdated.snapshot_id && (
                  <span>Historical snapshot unavailable; perform a fresh review.</span>
                )}
              </div>
            )}
            {sinceReview && (
              <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2 text-xs">
                <span>
                  This is only the delta from your retained reviewed target, not the full PR
                  contribution. Return before explicitly marking the new review.
                </span>
                <Button
                  data-testid="return-current-review"
                  size="sm"
                  variant="outline"
                  onClick={() => void selectScope(null, scopeMode)}
                >
                  Return to current comparison
                </Button>
              </div>
            )}
            {/* The floating "Show controls" button is fixed at the top-right of
                the viewport, so the collapsed header reserves room for it and
                keeps the viewed checkbox clickable underneath. */}
            <CardHeader
              className={cn(
                "flex-row flex-wrap items-center gap-x-3 gap-y-2 space-y-0 border-b px-3",
                chromeHidden ? "py-1 pr-[180px]" : "py-2",
              )}
            >
              <div className="flex min-w-0 flex-1 items-center gap-1">
                <Button
                  type="button"
                  data-testid="previous-file"
                  size="icon"
                  variant="ghost"
                  className="size-7 shrink-0"
                  title="Previous file (K)"
                  aria-label="Previous file"
                  disabled={!reviewable}
                  onClick={() => moveFile(-1)}
                >
                  <ChevronLeft className="size-4" />
                </Button>
                <Button
                  type="button"
                  data-testid="next-file"
                  size="icon"
                  variant="ghost"
                  className="size-7 shrink-0"
                  title="Next file (J)"
                  aria-label="Next file"
                  disabled={!reviewable}
                  onClick={() => moveFile(1)}
                >
                  <ChevronRight className="size-4" />
                </Button>
                {selectedFile ? (
                  <CardTitle className="ml-1 flex min-w-0 items-center gap-2 font-normal">
                    <FilePath path={selectedFile.display_path} />
                    {selectedPosition !== undefined && selectedPosition !== null && (
                      <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                        {selectedPosition + 1}/{reviewable}
                      </span>
                    )}
                  </CardTitle>
                ) : (
                  <CardTitle className="ml-1 text-xs font-medium text-muted-foreground">
                    {session ? "Pick a file to review" : "No comparison loaded"}
                  </CardTitle>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {(loading || scopeLoading || stackLoading) && (
                  <LoaderCircle className="size-3.5 animate-spin text-muted-foreground" />
                )}
                <Segmented
                  value={diffMode}
                  options={DIFF_MODES}
                  onChange={changeDiffMode}
                  label="Diff view"
                  testId="diff-mode"
                />
                {session && (
                  <Button
                    type="button"
                    data-testid="next-unviewed"
                    size="sm"
                    variant="ghost"
                    className="h-7 px-2"
                    title="Next unviewed file (N)"
                    disabled={!reviewable || viewedCount === reviewable}
                    onClick={nextUnviewed}
                  >
                    <SkipForward className="size-3.5" /> Next unviewed
                  </Button>
                )}
                {selectedFile && (
                  <label
                    className={cn(
                      "flex shrink-0 cursor-pointer select-none items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-1 text-xs font-medium transition-colors",
                      selectedViewed
                        ? "bg-emerald-500/10 text-emerald-600"
                        : "text-muted-foreground hover:text-foreground",
                      loading && "cursor-default opacity-50",
                    )}
                    title={selectedViewed ? "Mark as unviewed (M)" : "Mark as viewed (M)"}
                  >
                    <input
                      type="checkbox"
                      data-testid="mark-as-viewed"
                      className="size-3.5 shrink-0 cursor-pointer accent-emerald-600"
                      checked={!sinceReview && selectedViewed}
                      disabled={loading || sinceReview || scopeLoading || stackLoading}
                      onChange={toggleViewed}
                    />
                    Viewed
                  </label>
                )}
              </div>
            </CardHeader>
            <CardContent
              className={cn(
                "min-h-[580px] p-0",
                chromeHidden ? "h-[calc(100vh-4.5rem)]" : "h-[calc(100vh-240px)]",
              )}
            >
              {selectedFile && session && selected !== null ? (
                <DiffViewer
                  key={`${session.id}:${selected}`}
                  sessionId={session.id}
                  index={selected}
                  path={selectedFile.display_path}
                  mode={diffMode}
                  frameRef={diffFrameRef}
                />
              ) : (
                <div className="grid h-full place-items-center p-8 text-center text-sm text-muted-foreground">
                  <div>
                    {loading ? (
                      <LoaderCircle className="mx-auto mb-3 size-8 animate-spin text-primary" />
                    ) : (
                      <FileDiff className="mx-auto mb-3 size-8 opacity-40" />
                    )}
                    <p>
                      {loading
                        ? "Building your review"
                        : session
                          ? coordinates.layout === "files" && coordinates.path
                            ? "This comparison does not change the watched path. Select a modifying PR from its timeline."
                            : "Pick a file from the tree."
                          : "Nothing to review yet."}
                      {loading && (
                        <span className="loading-dots text-primary" aria-hidden="true">
                          •••
                        </span>
                      )}
                    </p>
                    <p className="mt-1 text-xs">
                      {loading ? (
                        "Fetching the pull request and preparing diffs."
                      ) : session ? (
                        <>
                          Or press <kbd className="rounded border bg-muted px-1 font-mono">-</kbd>{" "}
                          then <kbd className="rounded border bg-muted px-1 font-mono">N</kbd> to
                          jump to the next unviewed file.
                        </>
                      ) : (
                        "Open a pull request above to start."
                      )}
                    </p>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </main>
      {keyboardOverlay && (
        <aside
          data-testid="keyboard-overlay"
          className={cn(
            "fixed inset-x-0 bottom-5 z-50 mx-auto border border-primary/30 bg-background/95 shadow-2xl backdrop-blur transition-[width,padding] duration-300",
            keyboardOverlayExpanded
              ? "w-[min(760px,calc(100%-2rem))] rounded-xl p-3"
              : "w-fit rounded-full px-3 py-2",
          )}
          aria-label="Keyboard navigation"
        >
          {keyboardOverlayExpanded ? (
            <>
              <div className="flex items-center justify-between gap-3 px-1 pb-2 text-xs text-muted-foreground">
                <span className="flex items-center gap-1.5 font-medium text-foreground">
                  <Keyboard className="size-3.5 text-primary" /> Keyboard overlay
                </span>
                <span>
                  <kbd className="rounded border bg-muted px-1.5 py-0.5 font-mono text-foreground">
                    ?
                  </kbd>{" "}
                  show keys ·{" "}
                  <kbd className="rounded border bg-muted px-1.5 py-0.5 font-mono text-foreground">
                    Esc
                  </kbd>{" "}
                  or{" "}
                  <kbd className="rounded border bg-muted px-1.5 py-0.5 font-mono text-foreground">
                    -
                  </kbd>{" "}
                  hide
                </span>
              </div>
              <div className="grid gap-2 sm:grid-cols-3">
                <button
                  type="button"
                  onClick={() => runOverlayCommand("f")}
                  className={cn(
                    "rounded-lg border p-3 text-left transition-colors hover:bg-accent",
                    activeRegion === "sidebar" && "border-primary bg-primary/5",
                  )}
                >
                  <kbd className="mr-2 rounded bg-foreground px-1.5 py-0.5 font-mono text-xs text-background">
                    F
                  </kbd>
                  <span className="font-medium">Files</span>
                  <span className="mt-1 block text-xs text-muted-foreground">
                    Focus the changed-file sidebar
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => runOverlayCommand("d")}
                  className={cn(
                    "rounded-lg border p-3 text-left transition-colors hover:bg-accent",
                    activeRegion === "diff" && "border-primary bg-primary/5",
                  )}
                >
                  <kbd className="mr-2 rounded bg-foreground px-1.5 py-0.5 font-mono text-xs text-background">
                    D
                  </kbd>
                  <span className="font-medium">Diff panel</span>
                  <span className="mt-1 block text-xs text-muted-foreground">
                    Focus the SemanticDiff view
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => runOverlayCommand("v")}
                  className="rounded-lg border p-3 text-left transition-colors hover:bg-accent"
                >
                  <kbd className="mr-2 rounded bg-foreground px-1.5 py-0.5 font-mono text-xs text-background">
                    V
                  </kbd>
                  <span className="font-medium">Focus view</span>
                  <span className="mt-1 block text-xs text-muted-foreground">
                    Hide controls and enter the diff
                  </span>
                </button>
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1.5 rounded-lg bg-muted px-3 py-2 text-xs text-muted-foreground">
                <span>
                  <kbd className="mr-1 rounded border bg-background px-1.5 py-0.5 font-mono text-foreground">
                    J
                  </kbd>
                  <kbd className="mr-1 rounded border bg-background px-1.5 py-0.5 font-mono text-foreground">
                    K
                  </kbd>{" "}
                  {activeRegion === "diff" ? "scroll" : "next / previous file"}
                </span>
                <span>
                  <kbd className="mr-1 rounded border bg-background px-1.5 py-0.5 font-mono text-foreground">
                    N
                  </kbd>{" "}
                  next unviewed
                </span>
                <span>
                  <kbd className="mr-1 rounded border bg-background px-1.5 py-0.5 font-mono text-foreground">
                    M
                  </kbd>{" "}
                  mark viewed
                </span>
                {commits.length > 0 && (
                  <span>
                    <kbd className="mr-1 rounded border bg-background px-1.5 py-0.5 font-mono text-foreground">
                      [
                    </kbd>
                    <kbd className="mr-1 rounded border bg-background px-1.5 py-0.5 font-mono text-foreground">
                      ]
                    </kbd>{" "}
                    commit
                  </span>
                )}
                {stack && (
                  <span>
                    <kbd className="mr-1 rounded border bg-background px-1.5 py-0.5 font-mono text-foreground">
                      {"{"}
                    </kbd>
                    <kbd className="mr-1 rounded border bg-background px-1.5 py-0.5 font-mono text-foreground">
                      {"}"}
                    </kbd>{" "}
                    stacked PR
                  </span>
                )}
                <span className="ml-auto">
                  {activeRegion === "sidebar" ? "Files sidebar active" : "Diff panel active"}
                </span>
              </div>
            </>
          ) : (
            <button
              type="button"
              onClick={showKeyboardHelp}
              className="flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground"
            >
              <Keyboard className="size-3.5 text-primary" />
              <span>
                {activeRegion === "diff" ? "J/K scroll diff" : "J/K files"} · N next unviewed
              </span>
              <kbd className="rounded border bg-muted px-1.5 py-0.5 font-mono text-foreground">
                ?
              </kbd>
              <span>keys</span>
            </button>
          )}
        </aside>
      )}
    </div>
  )
}
