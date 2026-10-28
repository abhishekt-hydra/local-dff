import { useEffect, useState } from "react"
import { api, stackHistorySchema, type StackHistory } from "./review-api"

export function useStackHistory(sessionId: string | null) {
  const [result, setResult] = useState<{ id: string; data?: StackHistory; error?: string } | null>(
    null,
  )
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    if (!sessionId) return
    const controller = new AbortController()
    let timer: number | undefined
    let first = true
    const poll = async () => {
      try {
        const data = await api(
          "/api/stack-history",
          { id: sessionId, retry: first && retry > 0 },
          stackHistorySchema,
          controller.signal,
        )
        first = false
        if (controller.signal.aborted) return
        setResult({ id: sessionId, data })
        if (data.members.some((member) => member.state === "pending"))
          timer = window.setTimeout(poll, 1000)
      } catch (error) {
        if (!controller.signal.aborted)
          setResult({
            id: sessionId,
            error: error instanceof Error ? error.message : "Stack history unavailable.",
          })
      }
    }
    void poll()
    return () => {
      controller.abort()
      clearTimeout(timer)
    }
  }, [sessionId, retry])
  const current = result?.id === sessionId ? result : null
  return {
    history: current?.data ?? null,
    error: current?.error ?? "",
    retry: () => setRetry((value) => value + 1),
  }
}
