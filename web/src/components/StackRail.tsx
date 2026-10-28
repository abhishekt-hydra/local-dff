import { useLayoutEffect, useRef, type ReactNode } from "react"
import { ChevronDown, ChevronUp, GitBranch, Layers, LoaderCircle } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import type { Session } from "../lib/review-api"

type Stack = NonNullable<Session["stack"]>

type StackRailProps = {
  stack: Stack
  busy: boolean
  disabled: boolean
  onSelect: (number: number) => void
  onStep: (direction: 1 | -1) => void
  onStart: () => void
  children: ReactNode
}

export function StackRail({
  stack,
  busy,
  disabled,
  onSelect,
  onStep,
  onStart,
  children,
}: StackRailProps) {
  const position = stack.members.findIndex((member) => member.pull.number === stack.current)
  const listRef = useRef<HTMLOListElement>(null)
  const currentRef = useRef<HTMLButtonElement>(null)

  useLayoutEffect(() => {
    const list = listRef.current
    const current = currentRef.current
    if (!list || !current) return
    // Reveal the active PR inside the rail without scrolling the whole page
    // or moving keyboard focus away from the control that initiated navigation.
    const listBounds = list.getBoundingClientRect()
    const currentBounds = current.getBoundingClientRect()
    if (currentBounds.top < listBounds.top) list.scrollTop += currentBounds.top - listBounds.top
    else if (currentBounds.bottom > listBounds.bottom)
      list.scrollTop += currentBounds.bottom - listBounds.bottom
  }, [stack.current])

  return (
    <section
      data-testid="stack-rail"
      aria-label="Pull-request stack"
      aria-busy={busy}
      className="grid gap-2 rounded-xl bg-muted/55 p-2"
    >
      <div className="flex items-center justify-between gap-2 pl-1">
        <span className="flex items-center gap-1.5 text-xs font-semibold">
          <Layers className="size-3.5 text-primary" /> Stack review
          <span className="font-normal tabular-nums text-muted-foreground">
            {position + 1}/{stack.members.length}
          </span>
        </span>
        <div className="flex items-center gap-0.5">
          {busy && <LoaderCircle className="mr-1 size-3.5 animate-spin text-primary" />}
          <Button
            type="button"
            data-testid="previous-stack-pr"
            size="icon"
            variant="ghost"
            className="size-7"
            title="PR below in the stack ({)"
            aria-label="PR below in the stack"
            disabled={disabled || position <= 0}
            onClick={() => onStep(-1)}
          >
            <ChevronUp className="size-4" />
          </Button>
          <Button
            type="button"
            data-testid="next-stack-pr"
            size="icon"
            variant="ghost"
            className="size-7"
            title="PR above in the stack (})"
            aria-label="PR above in the stack"
            disabled={disabled || position >= stack.members.length - 1}
            onClick={() => onStep(1)}
          >
            <ChevronDown className="size-4" />
          </Button>
        </div>
      </div>
      <ol ref={listRef} className="grid max-h-48 gap-0.5 overflow-auto">
        <li className="flex items-center gap-2 px-1.5 py-0.5 text-[11px] text-muted-foreground">
          <GitBranch className="size-3 shrink-0" />
          <span className="truncate font-mono">{stack.trunk}</span>
        </li>
        {stack.members.map((member) => {
          const current = member.pull.number === stack.current
          return (
            <li key={member.pull.number}>
              <button
                ref={current ? currentRef : undefined}
                type="button"
                data-testid={`stack-pr-${member.pull.number}`}
                aria-current={current ? "true" : undefined}
                disabled={disabled}
                title={`#${member.pull.number} ${member.pull.title} · ${member.pull.headRefName}`}
                onClick={() => onSelect(member.pull.number)}
                style={{ paddingLeft: 6 + (member.depth + 1) * 10 }}
                className={cn(
                  "flex w-full items-center gap-2 rounded-lg py-1 pr-2 text-left text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50",
                  current
                    ? "bg-background font-medium text-foreground shadow-sm"
                    : "text-muted-foreground hover:bg-background/60 hover:text-foreground",
                )}
              >
                <span
                  className={cn(
                    "size-1.5 shrink-0 rounded-full",
                    current ? "bg-primary" : "bg-muted-foreground/40",
                  )}
                />
                <span className="shrink-0 font-medium tabular-nums">#{member.pull.number}</span>
                <span className="min-w-0 truncate">{member.pull.title}</span>
                {member.pull.isDraft && (
                  <span className="ml-auto shrink-0 text-[10px] font-medium uppercase opacity-70">
                    Draft
                  </span>
                )}
              </button>
            </li>
          )
        })}
      </ol>
      <Button
        type="button"
        data-testid="review-from-bottom"
        size="sm"
        variant="outline"
        className="h-7 justify-start px-2 text-xs"
        disabled={disabled || !stack.members.length}
        title="Open the first PR's own changes in Semantic view. Your viewed marks are kept."
        onClick={onStart}
      >
        <ChevronUp className="size-3.5" /> Review from bottom
      </Button>
      {children}
    </section>
  )
}
