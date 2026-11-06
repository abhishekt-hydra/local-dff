import { useEffect, useState } from "react"
import { Check, Copy } from "lucide-react"
import { Button } from "@/components/ui/button"
import { ShortcutTooltip } from "./ShortcutTooltip"

export function CopyFilePath({ path }: { path: string }) {
  const [status, setStatus] = useState<"idle" | "copied" | "failed">("idle")
  useEffect(() => {
    if (status === "idle") return
    const timer = window.setTimeout(() => setStatus("idle"), 2000)
    return () => window.clearTimeout(timer)
  }, [status])

  async function copy() {
    try {
      await navigator.clipboard.writeText(path)
      setStatus("copied")
    } catch {
      setStatus("failed")
    }
  }

  return (
    <ShortcutTooltip
      label={
        status === "copied"
          ? "Copied"
          : status === "failed"
            ? "Copy failed. Try again"
            : "Copy file path"
      }
      className="min-w-0"
      align="end"
    >
      <Button
        variant="ghost"
        className="group h-7 min-w-0 gap-2 rounded-md px-2 font-mono text-xs font-normal text-muted-foreground"
        aria-label={`Copy file path: ${path}`}
        onClick={() => void copy()}
      >
        <span className="truncate">{path}</span>
        {status === "copied" ? (
          <Check className="size-3 shrink-0 text-emerald-600" />
        ) : (
          <Copy className="size-3 shrink-0 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" />
        )}
        <span role="status" className="sr-only">
          {status === "copied"
            ? "File path copied"
            : status === "failed"
              ? "Could not copy file path"
              : ""}
        </span>
      </Button>
    </ShortcutTooltip>
  )
}
