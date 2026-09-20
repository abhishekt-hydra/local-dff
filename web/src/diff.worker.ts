import { parseDiffBatches, type DiffBatch } from "./lib/diff"

export type DiffWorkerMessage =
  | ({ type: "batch" } & DiffBatch)
  | { type: "done"; width: number; truncated: boolean; limited: boolean; profile?: { startedAt: number; parseDurationMs: number; firstBatchDurationMs: number } }
  | { type: "error"; error: string }

declare const __LOCAL_DIFFE_PROFILE_BUILD__: boolean | undefined
const PROFILE_BUILD_ENABLED = typeof __LOCAL_DIFFE_PROFILE_BUILD__ !== "undefined" && __LOCAL_DIFFE_PROFILE_BUILD__

self.onmessage = (event: MessageEvent<string | { patch: string }>) => {
  try {
    const patch = typeof event.data === "string" ? event.data : event.data.patch
    const startedAt = PROFILE_BUILD_ENABLED ? performance.now() : 0
    let firstBatchDurationMs = 0
    let firstBatchSent = false
    const result = parseDiffBatches(patch, (batch) => {
      if (PROFILE_BUILD_ENABLED && !firstBatchSent) {
        firstBatchSent = true
        firstBatchDurationMs = performance.now() - startedAt
      }
      self.postMessage({ type: "batch", ...batch } satisfies DiffWorkerMessage)
    })
    // The final message contains metadata only. Rows have already been sent
    // in bounded batches, so the worker never clones a second full result.
    self.postMessage({
      type: "done",
      width: result.width,
      truncated: result.truncated,
      limited: result.limited,
      ...(PROFILE_BUILD_ENABLED ? { profile: { startedAt: performance.timeOrigin + startedAt, parseDurationMs: performance.now() - startedAt, firstBatchDurationMs } } : {}),
    } satisfies DiffWorkerMessage)
  } catch (error) {
    self.postMessage({ type: "error", error: error instanceof Error ? error.message : "Could not parse diff." } satisfies DiffWorkerMessage)
  }
}
