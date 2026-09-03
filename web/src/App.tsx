import { useMemo, useState } from "react"
import { Tree, type NodeRendererProps } from "react-arborist"
import {
  ChevronRight,
  FileCode2,
  FileDiff,
  Folder,
  FolderOpen,
  GitBranch,
  GitPullRequest,
  Link,
  LoaderCircle,
  Search,
  Sparkles,
  Upload,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"

type PatchFile = { old_path: string | null; new_path: string | null; display_path: string; renderable: boolean }
type Revision = { revision: string; commit: string }
type PullRequest = { number: number; title: string; url: string; state: string; baseRefName: string; headRefName: string; isDraft: boolean; author?: { login: string } | null; updatedAt: string }
type Comparison = { base: Revision; target: Revision; changed_paths: number; semantic_paths: number; description: string; pull_request?: PullRequest | null }
type Session = { id: string; files: PatchFile[]; comparison?: Comparison | null }
type TreeItem = { id: string; name: string; children?: TreeItem[]; fileIndex?: number; renderable?: boolean }

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
  const [session, setSession] = useState<Session | null>(null)
  const [selected, setSelected] = useState<number | null>(null)
  const [search, setSearch] = useState("")
  const [status, setStatus] = useState("Ready to compare origin/staging with the checked-out branch.")
  const [loading, setLoading] = useState(false)
  const tree = useMemo(() => makeTree(session?.files ?? []), [session])

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
  const listPulls = async () => {
    setLoading(true)
    setStatus("Checking GitHub for open pull requests…")
    try {
      const next = await api<PullRequest[]>("/api/github/open-prs", { repo })
      setPulls(next)
      setPrNumber(next[0] ? String(next[0].number) : "")
      setStatus(next.length ? `${next.length} open pull requests found for this repository.` : "No open pull requests found for this repository.")
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
    void loadSession("/api/github/open-url", { repo, url: prUrl }, "Fetching the GitHub pull request and generating its merge-base diff…")
  }

  const renderNode = ({ node, style, dragHandle }: NodeRendererProps<TreeItem>) => {
    const item = node.data
    const isFile = item.fileIndex !== undefined
    const canRender = !isFile || item.renderable !== false
    const active = isFile && item.fileIndex === selected
    return (
      <div style={style} ref={dragHandle} className="px-1">
        <button
          type="button"
          data-file-index={isFile ? item.fileIndex : undefined}
          onClick={() => isFile ? canRender && setSelected(item.fileIndex!) : node.toggle()}
          title={isFile && !canRender ? "Empty or metadata-only Git change — no semantic text diff" : undefined}
          className={cn("flex h-7 w-full items-center gap-1.5 rounded px-1.5 text-left text-xs hover:bg-accent", active && "bg-accent text-accent-foreground", !canRender && "cursor-default opacity-45 hover:bg-transparent")}
        >
          {isFile ? <span className="w-3.5" /> : <ChevronRight className={cn("size-3.5 shrink-0 transition-transform", node.isOpen && "rotate-90")} />}
          {isFile ? <FileCode2 className={cn("size-3.5 shrink-0", canRender ? "text-sky-600" : "text-muted-foreground")} /> : node.isOpen ? <FolderOpen className="size-3.5 shrink-0 text-amber-500" /> : <Folder className="size-3.5 shrink-0 text-amber-500" />}
          <span className="truncate">{item.name}</span>
        </button>
      </div>
    )
  }

  const selectedFile = selected === null ? null : session?.files[selected]
  return (
    <div className="min-h-screen bg-muted/40">
      <header className="border-b bg-background">
        <div className="mx-auto flex h-14 max-w-[1800px] items-center gap-3 px-4">
          <div className="flex items-center gap-2 font-semibold"><FileDiff className="size-5 text-primary" /> Local Diffe</div>
          <span className="hidden text-sm text-muted-foreground md:inline">GitHub-style review, SemanticDiff display engine</span>
          <div className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground"><Sparkles className="size-3.5" /> local only</div>
        </div>
      </header>

      <main className="mx-auto flex max-w-[1800px] flex-col gap-4 p-4">
        <Card>
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
            <label className="grid gap-1.5 text-xs font-medium text-muted-foreground">Open PRs for repository
              <select data-testid="pr-select" value={prNumber} onChange={(event) => setPrNumber(event.target.value)} disabled={!pulls.length || loading} className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50">
                {pulls.length ? pulls.map((pull) => <option key={pull.number} value={pull.number}>#{pull.number} · {pull.title}</option>) : <option value="">List open PRs first</option>}
              </select>
            </label>
            <div className="flex gap-2"><Button data-testid="list-prs" variant="outline" onClick={listPulls} disabled={loading}><GitPullRequest className="size-4" /> List</Button><Button data-testid="open-selected-pr" onClick={openPull} disabled={loading || !prNumber}><GitBranch className="size-4" /> Review</Button></div>
          </CardContent>
        </Card>

        <div className="grid min-h-[calc(100vh-150px)] gap-4 lg:grid-cols-[320px_minmax(0,1fr)]">
          <Card className="flex min-h-0 flex-col overflow-hidden">
            <CardHeader className="gap-3 border-b p-3"><CardTitle className="text-sm">Changed files {session && <span className="font-normal text-muted-foreground">({session.comparison?.changed_paths ?? session.files.length})</span>}</CardTitle>
              <div className="relative"><Search className="pointer-events-none absolute left-2 top-2 size-3.5 text-muted-foreground" /><Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Filter files" className="h-8 pl-7 text-xs" /></div>
            </CardHeader>
            <CardContent className="min-h-0 flex-1 p-2">
              {tree.length ? <Tree<TreeItem> data={tree} width="100%" height={720} rowHeight={28} indent={14} openByDefault disableDrag disableDrop searchTerm={search}>{renderNode}</Tree> : <p className="p-3 text-xs text-muted-foreground">Generate a Git diff or upload a patch to populate the file tree.</p>}
            </CardContent>
          </Card>

          <Card className="min-h-0 overflow-hidden">
            <CardHeader className="flex-row items-center justify-between space-y-0 border-b p-3"><div><CardTitle className="text-sm">{selectedFile?.display_path ?? "Semantic diff"}</CardTitle>{session?.comparison?.pull_request && <a href={session.comparison.pull_request.url} target="_blank" rel="noreferrer" className="mt-1 flex w-fit items-center gap-1 text-xs font-medium text-primary hover:underline"><GitPullRequest className="size-3.5" /> #{session.comparison.pull_request.number} · {session.comparison.pull_request.title}</a>}<p className="mt-1 text-xs text-muted-foreground">{status}</p>{session?.comparison && <p className="mt-1 text-[11px] text-muted-foreground/80">{session.comparison.description}</p>}</div>{loading && <LoaderCircle className="size-4 animate-spin text-muted-foreground" />}</CardHeader>
            <CardContent className="h-[calc(100vh-260px)] min-h-[580px] p-0">
              {selectedFile && session ? <iframe key={`${session.id}:${selected}`} title={`Semantic diff for ${selectedFile.display_path}`} src={`/semanticdiff-view/${session.id}/${selected}`} className="h-full w-full border-0 bg-[#0d1117]" sandbox="allow-scripts allow-same-origin" /> : <div className="grid h-full place-items-center p-8 text-center text-sm text-muted-foreground"><div><FileDiff className="mx-auto mb-3 size-8 opacity-40" /><p>Pick a file from the tree.</p><p className="mt-1 text-xs">SemanticDiff will compute and render the language-aware view here.</p></div></div>}
            </CardContent>
          </Card>
        </div>
      </main>
    </div>
  )
}
