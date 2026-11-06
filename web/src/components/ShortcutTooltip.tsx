import { useId, type ReactElement } from "react"
import { Slot } from "@radix-ui/react-slot"
import type { KeyboardCommandKey } from "@/lib/keyboard"
import { cn } from "@/lib/utils"

export function ShortcutKey({ shortcut }: { shortcut: KeyboardCommandKey }) {
  return <kbd className="shortcut-key">{shortcut.toUpperCase()}</kbd>
}

export function ShortcutTooltip({
  label,
  shortcut,
  children,
  align = "center",
  className,
}: {
  label: string
  shortcut?: KeyboardCommandKey
  children: ReactElement
  align?: "start" | "center" | "end"
  className?: string
}) {
  const id = useId()
  return (
    <span className={cn("shortcut-tooltip", className)}>
      <Slot aria-describedby={id} aria-keyshortcuts={shortcut}>
        {children}
      </Slot>
      <span id={id} role="tooltip" className="shortcut-tooltip-content" data-align={align}>
        {label}
        {shortcut && <ShortcutKey shortcut={shortcut} />}
      </span>
    </span>
  )
}
