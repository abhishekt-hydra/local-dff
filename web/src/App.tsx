import { useCallback, useEffect, useMemo, useRef, useState } from "react"
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

type PatchFile = { old_path: string | null; new_path: string | null; display_path: string; renderable: boolean }
type Revision = { revision: string; commit: string }
type PullRequest = { number: number; title: string; url: string; state: string; baseRefName: string; headRefName: string; isDraft: boolean; author?: { login: string } | null; updatedAt: string }
type Comparison = { base: Revision; target: Revision; changed_paths: number; semantic_paths: number; description: string; pull_request?: PullRequest | null }
type Session = { id: string; files: PatchFile[]; comparison?: Comparison | null }
type TreeItem = { id: string; name: string; children?: TreeItem[]; fileIndex?: number; renderable?: boolean }

type ReviewRegion = "sidebar" | "diff"

function isEditableTarget(target: EventTarget | null) {
  return target instanceof HTMLElement && Boolean(target.closest('input, textarea, select, [contenteditable="true"], [role="textbox"]'))
}

const initialRepo = "/Users/abhishek/hydradb/hydradb-application"

function makeTree(files: PatchFile[]): TreeItem[] {
  const roots: TreeItem[] = []
  for (const [fileIndex, file] of files.entries()) {
    const parts = file.display_path.split("/").filter(Boolean)
    let level = roots
    let id = ""
    parts.forEach((name, partIndex) => {
      id = id ? `${id}/${name}` : name
      let node = level.find((candidate) => candidate.id === id)
      if (!node) {
        node = { id, name, children: partIndex === parts.length - 1 ? undefined : [] }
        level.push(node)
      }
      if (partIndex === parts.length - 1) {
        node.fileIndex = fileIndex
        node.renderable = file.renderable
      }
      else level = node.children ?? (node.children = [])
    })
  }
  return roots
}

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
  const [search, setSearch] = useState("")
  const [status, setStatus] = useState("Ready to compare origin/staging with the checked-out branch.")
  const [loading, setLoading] = useState(false)
  const reviewGrid = useRef<HTMLDivElement>(null)
  const sidebarRef = useRef<HTMLDivElement>(null)
  const diffPanelRef = useRef<HTMLDivElement>(null)
  const diffFrameRef = useRef<HTMLIFrameElement>(null)
  const tree = useMemo(() => makeTree(session?.files ?? []), [session])
  const selectedPull = useMemo(() => pulls.find((pull) => String(pull.number) === prNumber), [pulls, prNumber])
  const sidebarScale = sidebarFontSize / 12
  const sidebarRowHeight = Math.max(20, Math.round(28 * sidebarScale))
  const sidebarIconSize = Math.max(11, Math.round(14 * sidebarScale))
  const sidebarGap = Math.max(2, Math.round(6 * sidebarScale))
  const sidebarPadding = Math.max(2, Math.round(6 * sidebarScale))

  useEffect(() => {
    if (!resizingSidebar) return
    const resize = (event: PointerEvent) => {
      const left = reviewGrid.current?.getBoundingClientRect().left ?? 0
      setSidebarWidth(Math.max(220, Math.min(760, event.clientX - left)))
    }
    const stop = () => setResizingSidebar(false)
    window.addEventListener("pointermove", resize)
    window.addEventListener("pointerup", stop, { once: true })
    return () => {
      window.removeEventListener("pointermove", resize)
      window.removeEventListener("pointerup", stop)
    }
  }, [resizingSidebar])

  const loadSession = async (endpoint: string, payload: unknown, progress: string) => {
    setLoading(true)
    setStatus(progress)
    try {
      const next = await api<Session>(endpoint, payload)
      setSession(next)
      setSelected(null)
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
    const firstRenderable = session?.files.findIndex((file) => file.renderable)
    if (selected === null && firstRenderable !== undefined && firstRenderable >= 0) setSelected(firstRenderable)
    setActiveRegion("diff")
  }, [selected, session])

  const moveFile = useCallback((direction: 1 | -1) => {
    const files = session?.files ?? []
    const available = files.flatMap((file, index) => file.renderable ? [index] : [])
    if (!available.length) return
    const current = selected === null ? -1 : available.indexOf(selected)
    const next = current === -1
      ? (direction === 1 ? 0 : available.length - 1)
      : (current + direction + available.length) % available.length
    setSelected(available[next])
  }, [selected, session])

  const scrollDiff = useCallback((direction: 1 | -1) => {
    const frame = diffFrameRef.current
    const document = frame?.contentDocument
    const viewport = frame?.contentWindow
    if (!document || !viewport) return
    const scrollTarget = [document.scrollingElement, ...document.querySelectorAll<HTMLElement>("*")]
      .filter((element): element is HTMLElement => Boolean(element && element.scrollHeight > element.clientHeight + 1))
      .sort((left, right) => (right.scrollHeight - right.clientHeight) - (left.scrollHeight - left.clientHeight))[0]
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

  const renderNode = ({ node, style, dragHandle }: NodeRendererProps<TreeItem>) => {
    const item = node.data
    const isFile = item.fileIndex !== undefined
    const canRender = !isFile || item.renderable !== false
    const active = isFile && item.fileIndex === selected
    return (
      <div style={{ ...style, paddingInline: Math.max(1, Math.round(4 * sidebarScale)) }} ref={dragHandle}>
        <button
          type="button"
          data-file-index={isFile ? item.fileIndex : undefined}
          onClick={() => isFile ? canRender && setSelected(item.fileIndex!) : node.toggle()}
          title={isFile && !canRender ? "Empty or metadata-only Git change — no semantic text diff" : undefined}
          style={{ fontSize: sidebarFontSize, height: sidebarRowHeight, gap: sidebarGap, paddingInline: sidebarPadding }}
          className={cn("flex w-full items-center rounded text-left hover:bg-accent", active && "bg-accent text-accent-foreground", !canRender && "cursor-default opacity-45 hover:bg-transparent")}
        >
          {isFile ? <span style={{ width: sidebarIconSize }} /> : <ChevronRight style={{ width: sidebarIconSize, height: sidebarIconSize }} className={cn("shrink-0 transition-transform", node.isOpen && "rotate-90")} />}
          {isFile ? <FileCode2 style={{ width: sidebarIconSize, height: sidebarIconSize }} className={cn("shrink-0", canRender ? "text-sky-600" : "text-muted-foreground")} /> : node.isOpen ? <FolderOpen style={{ width: sidebarIconSize, height: sidebarIconSize }} className="shrink-0 text-amber-500" /> : <Folder style={{ width: sidebarIconSize, height: sidebarIconSize }} className="shrink-0 text-amber-500" />}
          <span className="truncate">{item.name}</span>
        </button>
      </div>
    )
  }

  const selectedFile = selected === null ? null : session?.files[selected]
  return (
    <div className="min-h-screen bg-muted/40">
      {!chromeHidden && <header className="border-b bg-background">
        <div className="flex h-14 w-full items-center gap-3 px-4">
          <div className="flex items-center gap-2 font-semibold"><FileDiff className="size-5 text-primary" /> Local Diffe</div>
          <span className="hidden text-sm text-muted-foreground md:inline">GitHub-style review, SemanticDiff display engine</span>
          <div className="ml-auto flex items-center gap-2"><div className="flex items-center gap-1.5 text-xs text-muted-foreground"><Sparkles className="size-3.5" /> local only</div><Button data-testid="keyboard-overlay-toggle" size="sm" variant={keyboardOverlay ? "secondary" : "outline"} onClick={toggleKeyboardOverlay} aria-pressed={keyboardOverlay} title="Toggle keyboard overlay (-)"><Keyboard className="size-4" /> Keys</Button><Button data-testid="hide-chrome" size="sm" variant="outline" onClick={() => setChromeHidden(true)}><ChevronUp className="size-4" /> Focus view</Button></div>
        </div>
      </header>}

      <main className="flex w-full flex-col gap-4 p-4">
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
            <Button data-testid="generate-diff" onClick={generate} disabled={loading}><GitBranch className="size-4" /> Generate diff</Button>
            <Button asChild variant="outline" disabled={loading}><label className="cursor-pointer"><Upload className="size-4" /> Upload patch<input className="hidden" type="file" accept=".diff,.patch,text/plain" onChange={(event) => upload(event.target.files?.[0])} /></label></Button>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="grid gap-3 p-4 lg:grid-cols-[minmax(360px,1fr)_auto_minmax(280px,1fr)_auto] lg:items-end">
            <label className="grid gap-1.5 text-xs font-medium text-muted-foreground">GitHub pull-request URL
              <Input data-testid="pr-url" value={prUrl} onChange={(event) => setPrUrl(event.target.value)} placeholder="https://github.com/owner/repo/pull/123" />
            </label>
            <Button data-testid="open-pr-url" variant="secondary" onClick={openPrUrl} disabled={loading}><Link className="size-4" /> Open PR</Button>
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
            <div className="flex gap-2"><Button data-testid="list-prs" variant="outline" onClick={() => void listPulls()} disabled={loading}><GitPullRequest className="size-4" /> List</Button><Button data-testid="refresh-prs" variant="outline" onClick={() => void listPulls(true)} disabled={loading}><GitPullRequest className="size-4" /> Refresh</Button><Button data-testid="open-selected-pr" onClick={openPull} disabled={loading || !prNumber}><GitBranch className="size-4" /> Review</Button></div>
          </CardContent>
        </Card></>}

        <div ref={reviewGrid} style={{ "--sidebar-width": `${sidebarWidth}px` } as React.CSSProperties} className={cn("grid min-h-[calc(100vh-150px)] gap-4 lg:grid-cols-[minmax(220px,var(--sidebar-width))_minmax(0,1fr)]", chromeHidden && "min-h-[calc(100vh-2rem)]")}>
          <Card ref={sidebarRef} tabIndex={-1} aria-label="Changed files sidebar" className={cn("relative flex min-h-0 flex-col overflow-visible outline-none", activeRegion === "sidebar" && keyboardOverlay && "ring-2 ring-primary ring-offset-2")}>
            <CardHeader className="gap-3 rounded-t-lg border-b bg-card p-3"><div className="flex items-center justify-between gap-2"><CardTitle className="text-sm">Changed files {session && <span className="font-normal text-muted-foreground">({session.comparison?.changed_paths ?? session.files.length})</span>}</CardTitle><div className="flex items-center gap-0.5"><Button type="button" size="icon" variant="ghost" className="size-7" title="Smaller file text" onClick={() => setSidebarFontSize((size) => Math.max(10, size - 1))}><Minus className="size-3.5" /></Button><span className="w-7 text-center text-[10px] text-muted-foreground" title="File sidebar font size">{sidebarFontSize}px</span><Button type="button" size="icon" variant="ghost" className="size-7" title="Larger file text" onClick={() => setSidebarFontSize((size) => Math.min(18, size + 1))}><Plus className="size-3.5" /></Button><span className="mx-1 h-4 border-l" /><Button type="button" size="icon" variant="ghost" className="size-7" title="Make file sidebar narrower" onClick={() => setSidebarWidth((width) => Math.max(220, width - 40))}><Minus className="size-3.5" /></Button><Button type="button" size="icon" variant="ghost" className="size-7" title="Make file sidebar wider" onClick={() => setSidebarWidth((width) => Math.min(760, width + 40))}><Plus className="size-3.5" /></Button></div></div>
              <div className="relative"><Search className="pointer-events-none absolute left-2 top-2 size-3.5 text-muted-foreground" /><Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Filter files" className="h-8 pl-7 text-xs" /></div>
            </CardHeader>
            <CardContent className="min-h-0 flex-1 overflow-hidden rounded-b-lg bg-card p-2">
              {tree.length ? <Tree<TreeItem> data={tree} width="100%" height={720} rowHeight={sidebarRowHeight} indent={Math.max(9, Math.round(14 * sidebarScale))} openByDefault disableDrag disableDrop searchTerm={search}>{renderNode}</Tree> : <p className="p-3 text-xs text-muted-foreground">Generate a Git diff or upload a patch to populate the file tree.</p>}
            </CardContent>
            <button type="button" aria-label="Resize file sidebar" title="Drag to resize the file sidebar" onPointerDown={(event) => { event.preventDefault(); setResizingSidebar(true) }} className={cn("absolute -right-3 top-0 z-10 hidden h-full w-6 cursor-col-resize touch-none items-center justify-center lg:flex", resizingSidebar && "bg-primary/5")}><span className="grid h-12 w-3 place-items-center rounded-full border bg-background text-muted-foreground shadow-sm"><GripVertical className="size-3" /></span></button>
          </Card>

          <Card ref={diffPanelRef} tabIndex={-1} aria-label="Semantic diff panel" className={cn("min-h-0 overflow-hidden outline-none", activeRegion === "diff" && keyboardOverlay && "ring-2 ring-primary ring-offset-2")}>
            <CardHeader className={cn("flex-row items-center justify-between space-y-0 border-b", chromeHidden ? "h-8 px-3 py-1" : "p-3")}>{chromeHidden ? <><CardTitle className="truncate text-xs font-medium text-muted-foreground">{selectedFile?.display_path ?? "Semantic diff"}</CardTitle>{loading && <LoaderCircle className="size-3.5 animate-spin text-muted-foreground" />}</> : <><div><CardTitle className="text-sm">{selectedFile?.display_path ?? "Semantic diff"}</CardTitle>{session?.comparison?.pull_request && <a href={session.comparison.pull_request.url} target="_blank" rel="noreferrer" className="mt-1 flex w-fit items-center gap-1 text-xs font-medium text-primary hover:underline"><GitPullRequest className="size-3.5" /> #{session.comparison.pull_request.number} · {session.comparison.pull_request.title}</a>}<p className="mt-1 text-xs text-muted-foreground">{status}</p>{session?.comparison && <p className="mt-1 text-[11px] text-muted-foreground/80">{session.comparison.description}</p>}</div>{loading && <LoaderCircle className="size-4 animate-spin text-muted-foreground" />}</>}</CardHeader>
            <CardContent className={cn("min-h-[580px] p-0", chromeHidden ? "h-[calc(100vh-4.5rem)]" : "h-[calc(100vh-260px)]")}>
              {selectedFile && session ? <iframe ref={diffFrameRef} key={`${session.id}:${selected}`} title={`Semantic diff for ${selectedFile.display_path}`} src={`/semanticdiff-view/${session.id}/${selected}`} className="h-full w-full border-0 bg-card" sandbox="allow-scripts allow-same-origin" /> : <div className="grid h-full place-items-center p-8 text-center text-sm text-muted-foreground"><div><FileDiff className="mx-auto mb-3 size-8 opacity-40" /><p>Pick a file from the tree.</p><p className="mt-1 text-xs">SemanticDiff will compute and render the language-aware view here.</p></div></div>}
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
