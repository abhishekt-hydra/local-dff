import { useEffect, useState } from "react"
import * as z from "zod/mini"
import { api } from "../lib/review-api"
import { Button } from "./ui/button"

const sideSchema = z.enum(["LEFT", "RIGHT"])
export const commentsSchema = z.array(
  z.object({
    id: z.string(),
    body: z.string(),
    version: z.int(),
    state: z.enum(["draft", "posting", "uncertain", "posted"]),
    remote_url: z.nullable(z.string()),
    target: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("general") }),
      z.object({
        kind: z.literal("line"),
        path: z.string(),
        line: z.int(),
        side: sideSchema,
        commit_id: z.string(),
      }),
    ]),
  }),
)
type Comment = z.infer<typeof commentsSchema>[number]
type Props = {
  prUrl: string
  revision?: number
}

// The parent keys this component by PR URL, so late responses and unsaved text
// cannot be transferred to a different PR while navigating a stack.
export function CommentsPanel({ prUrl, revision }: Props) {
  const [comments, setComments] = useState<Comment[]>([])
  const [body, setBody] = useState("")
  const [editing, setEditing] = useState<Comment | null>(null)
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  const [ready, setReady] = useState(false)
  const [refresh, setRefresh] = useState(0)
  const [confirming, setConfirming] = useState<string | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    api("/api/comments/list", { pr_url: prUrl }, commentsSchema, controller.signal)
      .then((result) => {
        setComments(result)
        setReady(true)
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted)
          setError(cause instanceof Error ? cause.message : "Could not load comments.")
      })
    return () => controller.abort()
  }, [prUrl, refresh, revision])

  async function mutate(action: string, payload: unknown) {
    if (!ready) return false
    setBusy(true)
    setError("")
    try {
      const result = await api(`/api/comments/${action}`, payload, commentsSchema)
      setComments(result)
      setConfirming(null)
      return true
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Comment request failed.")
      setReady(false)
      setRefresh((value) => value + 1)
      return false
    } finally {
      setBusy(false)
    }
  }

  async function save() {
    const location = editing ? { kind: "keep" } : { kind: "general" }
    if (
      await mutate("save", {
        pr_url: prUrl,
        id: editing?.id,
        version: editing?.version,
        body,
        location,
      })
    ) {
      setBody("")
      setEditing(null)
    }
  }

  return (
    <details className="rounded-xl bg-muted/20 px-4 py-3" data-testid="comments-panel">
      <summary className="cursor-pointer text-sm">
        Comments · {comments.filter((comment) => comment.state !== "posted").length} local
      </summary>
      <p className="my-2 text-xs text-muted-foreground">
        Local drafts for PR #{prUrl.split("/").at(-1)}. Select a diff line to comment on code.
      </p>
      {error && (
        <p role="alert" className="my-2 text-sm text-amber-400">
          {error}
        </p>
      )}
      <Button
        variant="outline"
        size="sm"
        disabled={busy}
        onClick={() => {
          setReady(false)
          setRefresh((value) => value + 1)
        }}
      >
        Reload comments
      </Button>
      <ul className="my-3 max-h-64 space-y-3 overflow-auto">
        {comments.map((comment) => (
          <li key={comment.id} className="rounded-xl bg-muted/50 p-3 text-sm">
            <p className="text-xs text-muted-foreground">
              {comment.state} ·{" "}
              {comment.target.kind === "general"
                ? "PR conversation"
                : `${comment.target.path}:${comment.target.line} (${comment.target.side}) @ ${comment.target.commit_id.slice(0, 7)}`}
            </p>
            <p className="my-2 whitespace-pre-wrap break-words">{comment.body}</p>
            {comment.remote_url && (
              <a className="underline" href={comment.remote_url} target="_blank" rel="noreferrer">
                View on GitHub
              </a>
            )}
            {comment.state === "draft" && (
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() => {
                    setEditing(comment)
                    setBody(comment.body)
                    setConfirming(null)
                  }}
                >
                  Edit
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() => {
                    void mutate("delete", {
                      pr_url: prUrl,
                      id: comment.id,
                      version: comment.version,
                    }).then((removed) => {
                      if (removed && editing?.id === comment.id) {
                        setEditing(null)
                        setBody("")
                      }
                    })
                  }}
                >
                  Delete
                </Button>
                <Button
                  size="sm"
                  disabled={busy || editing?.id === comment.id}
                  onClick={() => setConfirming(comment.id)}
                >
                  Post to GitHub
                </Button>
              </div>
            )}
            {confirming === comment.id && (
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <p>
                  Publish this saved comment to PR #{prUrl.split("/").at(-1)} using your gh account?
                </p>
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={() => {
                    void mutate("publish", {
                      pr_url: prUrl,
                      id: comment.id,
                      version: comment.version,
                    })
                  }}
                >
                  Confirm post
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() => setConfirming(null)}
                >
                  Cancel
                </Button>
              </div>
            )}
            {comment.state === "uncertain" && (
              <div className="mt-2">
                <p className="mb-1 text-xs">
                  The result of the last post is unknown. Check for its receipt before posting
                  another copy.
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() => {
                    void mutate("publish", {
                      pr_url: prUrl,
                      id: comment.id,
                      version: comment.version,
                    })
                  }}
                >
                  Check GitHub
                </Button>
              </div>
            )}
          </li>
        ))}
      </ul>
      <form
        className="space-y-2"
        onSubmit={(event) => {
          event.preventDefault()
          void save()
        }}
      >
        <label className="block text-sm">
          {editing ? "Edit draft" : "General comment"}
          <textarea
            aria-label="Comment body"
            className="mt-1 min-h-24 w-full rounded border bg-background p-2"
            value={body}
            maxLength={60000}
            onChange={(event) => setBody(event.target.value)}
            disabled={busy || !ready}
          />
        </label>
        <div className="flex gap-2">
          <Button type="submit" size="sm" disabled={busy || !ready || !body.trim()}>
            Save locally
          </Button>
          {editing && (
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => {
                setEditing(null)
                setBody("")
              }}
            >
              Cancel edit
            </Button>
          )}
        </div>
      </form>
    </details>
  )
}
