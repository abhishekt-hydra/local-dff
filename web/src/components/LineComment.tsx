import { useEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { MessageSquare, X } from "lucide-react"
import { Button } from "./ui/button"
import { api } from "../lib/review-api"
import { commentsSchema } from "./CommentsPanel"

const draftBodies = new Map<string, string>()

export type SelectedLine = { line: number; side: "LEFT" | "RIGHT"; x: number; y: number }

export function LineComment({
  selection,
  prUrl,
  sessionId,
  index,
  path,
  onClose,
  onSaved,
}: {
  selection: SelectedLine
  prUrl: string
  sessionId: string
  index: number
  path: string
  onClose: () => void
  onSaved: () => void
}) {
  const draftKey = JSON.stringify([prUrl, sessionId, index, selection.side, selection.line])
  const [body, setBody] = useState(() => draftBodies.get(draftKey) ?? "")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const textarea = useRef<HTMLTextAreaElement>(null)
  const dialogRef = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    dialog.showModal()
    textarea.current?.focus()
    const viewport = window.visualViewport
    const fitViewport = () => {
      if (!viewport) return
      dialog.style.setProperty(
        "--comment-keyboard-inset",
        `${Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop)}px`,
      )
      dialog.style.setProperty("--comment-viewport-height", `${viewport.height}px`)
    }
    fitViewport()
    viewport?.addEventListener("resize", fitViewport)
    viewport?.addEventListener("scroll", fitViewport)
    return () => {
      viewport?.removeEventListener("resize", fitViewport)
      viewport?.removeEventListener("scroll", fitViewport)
      dialog.close()
    }
  }, [])
  async function save() {
    if (!body.trim() || busy) return
    setBusy(true)
    setError("")
    try {
      await api(
        "/api/comments/save",
        {
          pr_url: prUrl,
          body,
          location: {
            kind: "line",
            session_id: sessionId,
            index,
            line: selection.line,
            side: selection.side,
          },
        },
        commentsSchema,
      )
      draftBodies.delete(draftKey)
      onSaved()
      onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save comment")
      setBusy(false)
    }
  }
  return createPortal(
    <dialog
      ref={dialogRef}
      aria-label="Comment on selected line"
      className="line-comment-dialog fixed z-50 m-0 w-[360px] max-w-[calc(100vw-24px)] rounded-xl border border-muted bg-popover p-4 text-popover-foreground shadow-2xl"
      onCancel={(event) => {
        event.preventDefault()
        if (!busy) onClose()
      }}
      style={{
        left: Math.max(12, Math.min(selection.x, window.innerWidth - 380)),
        top: Math.max(12, Math.min(selection.y + 8, window.innerHeight - 300)),
      }}
    >
      <div className="mb-3 flex items-center gap-2 text-sm font-medium">
        <MessageSquare className="size-4 text-primary" />
        <span className="flex-1">
          Line {selection.line} · {selection.side === "LEFT" ? "Old file" : "New file"}
        </span>
        <Button
          size="icon"
          variant="ghost"
          aria-label="Close comment"
          disabled={busy}
          onClick={onClose}
        >
          <X className="size-4" />
        </Button>
      </div>
      <p className="mb-2 truncate font-mono text-xs text-muted-foreground" title={path}>
        {path}
      </p>
      <textarea
        ref={textarea}
        onKeyDown={(event) => {
          if (event.key === "Escape" && !busy) {
            event.stopPropagation()
            onClose()
          }
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault()
            void save()
          }
        }}
        aria-label="Line comment"
        placeholder="Leave a comment…"
        value={body}
        onChange={(event) => {
          setBody(event.target.value)
          draftBodies.set(draftKey, event.target.value)
        }}
        disabled={busy}
        maxLength={60000}
        className="min-h-28 w-full resize-y rounded-lg bg-muted/50 p-3 text-sm outline-none focus:ring-2 focus:ring-primary"
      />
      {error && (
        <p role="alert" className="my-2 text-xs text-amber-500">
          {error}
        </p>
      )}
      <div className="mt-3 flex items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">
          Saved locally<span className="hidden lg:inline"> · ⌘/Ctrl Enter</span>
        </span>
        <Button size="sm" disabled={busy || !body.trim()} onClick={() => void save()}>
          {busy ? "Saving…" : "Save comment"}
        </Button>
      </div>
    </dialog>,
    document.body,
  )
}
