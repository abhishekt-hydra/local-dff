import { useEffect, useRef, useState, type ReactNode } from "react"
import {
  Check,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  Folder,
  LoaderCircle,
  MoreHorizontal,
  PanelTop,
  X,
} from "lucide-react"
import { Button } from "./ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover"
import { CopyFilePath } from "./CopyFilePath"
import type { DiffMode } from "./DiffViewer"

export function MobileReviewDrawer({
  enabled,
  open,
  onClose,
  children,
}: {
  enabled: boolean
  open: boolean
  onClose: () => void
  children: ReactNode
}) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog || !open) return
    dialog.showModal()
    const dismissBackdrop = (event: MouseEvent) => {
      if (event.target !== dialog) return
      const bounds = dialog.getBoundingClientRect()
      if (
        event.clientX < bounds.left ||
        event.clientX > bounds.right ||
        event.clientY < bounds.top ||
        event.clientY > bounds.bottom
      )
        onClose()
    }
    dialog.addEventListener("click", dismissBackdrop)
    return () => {
      dialog.removeEventListener("click", dismissBackdrop)
      dialog.close()
    }
  }, [enabled, open, onClose])
  if (!enabled) return children
  return (
    <dialog
      ref={dialogRef}
      aria-label="Review navigation"
      className="mobile-review-drawer"
      onCancel={(event) => {
        event.preventDefault()
        onClose()
      }}
    >
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-foreground/10 px-4 py-1">
        <h2 className="text-sm font-semibold">Review navigation</h2>
        <Button
          variant="ghost"
          size="icon"
          className="size-11 rounded-xl"
          aria-label="Close changed files"
          onClick={onClose}
        >
          <X className="size-5" />
        </Button>
      </div>
      {children}
    </dialog>
  )
}

export function MobileReviewHeader({
  path,
  position,
  total,
  viewed,
  title,
  url,
  context,
  busy,
  sidebarOpen,
  onToggleSidebar,
  onOverview,
  mode,
  onModeChange,
  selectedViewed,
  canMarkViewed,
  onToggleViewed,
}: {
  path: string | null
  position: number | null
  total: number
  viewed: number
  title: string
  url?: string
  context?: string
  busy: boolean
  sidebarOpen: boolean
  onToggleSidebar: () => void
  onOverview: () => void
  mode: DiffMode
  onModeChange: (mode: DiffMode) => void
  selectedViewed: boolean
  canMarkViewed: boolean
  onToggleViewed: () => void
}) {
  const [menuOpen, setMenuOpen] = useState(false)
  return (
    <header className="mobile-review-header" data-testid="mobile-review-header" inert={sidebarOpen}>
      <div className="flex min-w-0 items-center gap-1 px-2">
        <Button
          data-testid="mobile-files"
          variant="ghost"
          size="icon"
          className="size-11 shrink-0 rounded-xl"
          aria-label="Open changed files"
          aria-haspopup="dialog"
          aria-expanded={sidebarOpen}
          aria-controls="review-sidebar"
          onClick={onToggleSidebar}
        >
          <Folder className="size-5" />
        </Button>
        <button
          type="button"
          className="min-h-11 min-w-0 flex-1 truncate px-1 text-left text-sm font-medium"
          title={path ?? title}
          aria-label={path ? `Choose file, current file: ${path}` : "Choose a file"}
          onClick={onToggleSidebar}
        >
          {path?.split("/").at(-1) ?? "Open a review"}
        </button>
        {busy ? (
          <LoaderCircle
            aria-label="Loading comparison"
            className="size-4 shrink-0 animate-spin text-primary"
          />
        ) : (
          <span
            className="shrink-0 px-2 text-xs tabular-nums text-muted-foreground"
            aria-label={`File ${position ?? 0} of ${total}`}
          >
            {position ?? 0}
            <span className="px-0.5 text-muted-foreground/50">/</span>
            {total}
          </span>
        )}
        <Popover open={menuOpen} onOpenChange={setMenuOpen}>
          <PopoverTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="size-11 shrink-0 rounded-xl"
              aria-label="Review options"
            >
              <MoreHorizontal className="size-5" />
            </Button>
          </PopoverTrigger>
          <PopoverContent
            align="end"
            className="mobile-review-options w-[min(320px,calc(100vw-24px))] p-3"
          >
            <p className="px-1 text-sm font-medium break-words">{title}</p>
            {context && <p className="mt-1 px-1 text-xs text-muted-foreground">{context}</p>}
            <p className="mt-1 px-1 text-xs text-muted-foreground" role="status">
              {viewed} of {total} files viewed
            </p>
            {path && (
              <div className="my-2 min-w-0">
                <CopyFilePath path={path} />
              </div>
            )}
            <div
              className="my-3 grid grid-cols-2 gap-1 rounded-xl bg-muted p-1"
              role="group"
              aria-label="Diff view"
            >
              {(["text", "semantic"] as const).map((value) => (
                <Button
                  key={value}
                  variant={mode === value ? "secondary" : "ghost"}
                  className="min-h-11"
                  aria-pressed={mode === value}
                  onClick={() => {
                    onModeChange(value)
                    setMenuOpen(false)
                  }}
                >
                  {value === "text" ? "Unified text" : "Semantic"}
                </Button>
              ))}
            </div>
            {path && (
              <Button
                variant="ghost"
                className="min-h-11 w-full justify-start"
                disabled={!canMarkViewed}
                onClick={() => {
                  onToggleViewed()
                  setMenuOpen(false)
                }}
              >
                <Check className="size-4" />
                {selectedViewed ? "Mark as unviewed" : "Mark as viewed"}
              </Button>
            )}
            {url && (
              <a
                href={url}
                target="_blank"
                rel="noreferrer"
                className="flex min-h-11 items-center gap-2 rounded-lg px-4 text-sm hover:bg-accent"
              >
                <ExternalLink className="size-4" /> Open on GitHub
              </a>
            )}
            <Button
              variant="ghost"
              className="min-h-11 w-full justify-start"
              onClick={() => {
                setMenuOpen(false)
                onOverview()
              }}
            >
              <PanelTop className="size-4" /> Overview & setup
            </Button>
          </PopoverContent>
        </Popover>
      </div>
      <div
        className="h-0.5 bg-muted"
        role="progressbar"
        aria-label="Files viewed"
        aria-valuenow={viewed}
        aria-valuemin={0}
        aria-valuemax={total || 1}
      >
        <div
          className="h-full bg-emerald-500 transition-[width] duration-200"
          style={{ width: `${total ? (viewed / total) * 100 : 0}%` }}
        />
      </div>
    </header>
  )
}

export function MobileReviewFooter({
  position,
  total,
  complete,
  selectedViewed,
  disabled,
  onPrevious,
  onNext,
  onViewedAndNext,
  sidebarOpen,
}: {
  position: number | null
  total: number
  complete: boolean
  selectedViewed: boolean
  disabled: boolean
  onPrevious: () => void
  onNext: () => void
  onViewedAndNext: () => void
  sidebarOpen: boolean
}) {
  return (
    <nav
      aria-label="Review files sequentially"
      className="mobile-review-footer"
      data-testid="mobile-review-footer"
      inert={sidebarOpen}
    >
      <Button
        size="icon"
        variant="ghost"
        className="size-11 shrink-0 rounded-xl"
        aria-label="Previous file"
        disabled={disabled || position === null || position <= 1}
        onClick={onPrevious}
      >
        <ChevronLeft className="size-5" />
      </Button>
      <Button
        size="icon"
        variant="ghost"
        className="size-11 shrink-0 rounded-xl"
        aria-label="Next file"
        disabled={disabled || position === null || position >= total}
        onClick={onNext}
      >
        <ChevronRight className="size-5" />
      </Button>
      <Button
        className="ml-2 h-11 min-w-0 flex-1 rounded-xl"
        data-testid="viewed-and-next"
        disabled={disabled || position === null || complete}
        onClick={onViewedAndNext}
      >
        <Check className="size-4 shrink-0" />
        {complete ? "All files viewed" : selectedViewed ? "Next unviewed" : "Viewed & next"}
        {!complete && <ChevronRight className="ml-auto size-4 shrink-0" />}
      </Button>
    </nav>
  )
}
