/**
 * Small, opt-in performance telemetry for the diff viewer.
 *
 * Nothing is recorded unless `?perf=1` (or `LOCAL_DIFFE_PERF=1` at build
 * time) is present. Samples stay in memory and are capped so profiling a
 * long session cannot become an unbounded allocation or a console stream.
 */

export type PerformanceDetail = Record<string, string | number | boolean | null>

export type PerformanceSample = {
  name: string
  durationMs: number
  startTimeMs: number
  endTimeMs: number
  detail?: PerformanceDetail
  /** React Profiler fields, when the sample came from a React commit. */
  id?: string
  phase?: "mount" | "update" | "nested-update"
  actualDuration?: number
  baseDuration?: number
  startTime?: number
  commitTime?: number
}

export type PerformanceSampleCallback = (sample: PerformanceSample) => void

export type PerformanceProfilerOptions = {
  enabled?: boolean
  maxSamples?: number
  onSample?: PerformanceSampleCallback
}

const DEFAULT_MAX_SAMPLES = 200
const MAX_MAX_SAMPLES = 1_000
const MAX_MARKS = 128
const TRUTHY = new Set(["1", "true", "yes", "on"])

function enabledValue(value: unknown) {
  return typeof value === "string" ? TRUTHY.has(value.toLowerCase()) : value === true
}

function buildOptInState() {
  if (typeof window !== "undefined") {
    const query = new URLSearchParams(window.location.search)
    if (enabledValue(query.get("perf")) || enabledValue(query.get("performance")) || enabledValue(query.get("local-diffe-perf"))) return true
  }
  // Vite replaces this constant for profile builds. `typeof` keeps importing
  // this module safe in tests and in non-Vite tooling.
  if (typeof __LOCAL_DIFFE_PERF__ !== "undefined" && enabledValue(__LOCAL_DIFFE_PERF__)) return true
  return false
}

function clock() {
  return typeof performance !== "undefined" ? performance.now() : Date.now()
}

function boundedName(name: string) {
  return name.trim().slice(0, 96) || "unnamed"
}

function boundedDetails(detail: PerformanceDetail | undefined) {
  if (!detail) return undefined
  const result: PerformanceDetail = {}
  for (const [key, value] of Object.entries(detail).slice(0, 12)) result[key.slice(0, 48)] = value
  return result
}

export function isPerformanceProfilingEnabled() {
  return buildOptInState()
}

/** True only for `vite build --mode profile`/`LOCAL_DIFFE_PROFILE_BUILD=1`. */
export const PERFORMANCE_BUILD_ENABLED: boolean = typeof __LOCAL_DIFFE_PROFILE_BUILD__ !== "undefined" ? __LOCAL_DIFFE_PROFILE_BUILD__ : false

export function createPerformanceProfiler(options: PerformanceProfilerOptions = {}) {
  const enabled = options.enabled ?? buildOptInState()
  const maxSamples = Math.max(1, Math.min(MAX_MAX_SAMPLES, Math.floor(options.maxSamples ?? DEFAULT_MAX_SAMPLES)))
  const samples: PerformanceSample[] = []
  const marks = new Map<string, { time: number; detail?: PerformanceDetail }>()
  let callback = options.onSample

  const record = (sample: PerformanceSample) => {
    if (!enabled || !Number.isFinite(sample.durationMs) || sample.durationMs < 0) return undefined
    const bounded: PerformanceSample = {
      ...sample,
      name: boundedName(sample.name),
      durationMs: Math.round(sample.durationMs * 100) / 100,
      startTimeMs: sample.startTimeMs,
      endTimeMs: sample.endTimeMs,
      detail: boundedDetails(sample.detail),
    }
    // Keep the newest bounded window. This captures the end of a long browser
    // session while keeping memory and callback work predictable.
    if (samples.length === maxSamples) samples.shift()
    samples.push(bounded)
    callback?.(bounded)
    return bounded
  }

  const mark = (name: string, detail?: PerformanceDetail) => {
    if (!enabled) return undefined
    const key = boundedName(name)
    if (marks.size >= MAX_MARKS && !marks.has(key)) marks.delete(marks.keys().next().value!)
    const time = clock()
    marks.set(key, { time, detail: boundedDetails(detail) })
    return time
  }

  const measure = (name: string, startMark?: string, detail?: PerformanceDetail) => {
    if (!enabled) return undefined
    const endTimeMs = clock()
    const markValue = startMark ? marks.get(boundedName(startMark)) : undefined
    const startTimeMs = markValue?.time ?? endTimeMs
    const sample = record({ name, durationMs: endTimeMs - startTimeMs, startTimeMs, endTimeMs, detail: { ...markValue?.detail, ...detail } })
    if (startMark) marks.delete(boundedName(startMark))
    return sample?.durationMs
  }

  return {
    enabled,
    maxSamples,
    mark,
    measure,
    record,
    getSamples: () => samples.slice(),
    clear: () => { samples.length = 0; marks.clear() },
    setCallback: (next: PerformanceSampleCallback | undefined) => { callback = next },
  }
}

export type PerformanceProfiler = ReturnType<typeof createPerformanceProfiler>

const disabledProfiler: PerformanceProfiler = {
  enabled: false,
  maxSamples: 0,
  mark: () => undefined,
  measure: () => undefined,
  record: () => undefined,
  getSamples: () => [],
  clear: () => undefined,
  setCallback: () => undefined,
}

/** The shared browser profiler used by exported helpers below. */
export const profiler: PerformanceProfiler = PERFORMANCE_BUILD_ENABLED
  ? /*#__PURE__*/ createPerformanceProfiler()
  : disabledProfiler
export const performanceProfiler = profiler

declare global {
  interface Window {
    __LOCAL_DIFFE_PERF__?: {
      enabled: boolean
      getSamples: () => PerformanceSample[]
      clear: () => void
    }
    __localDiffePerformance?: {
      getSamples: () => PerformanceSample[]
      clear: () => void
    }
  }
}

// A local, bounded inspection handle is useful to the browser benchmark. It
// is created only after the same opt-in check as the in-memory profiler.
if (PERFORMANCE_BUILD_ENABLED && typeof window !== "undefined" && profiler.enabled) {
  const handle = { enabled: profiler.enabled, getSamples: profiler.getSamples, clear: profiler.clear }
  window.__LOCAL_DIFFE_PERF__ = handle
  window.__localDiffePerformance = handle
}

export function mark(name: string, detail?: PerformanceDetail) {
  return profiler.mark(name, detail)
}

export function measure(name: string, startMark?: string, detail?: PerformanceDetail) {
  return profiler.measure(name, startMark, detail)
}

export function recordPerformance(sample: PerformanceSample) {
  return profiler.record(sample)
}

export function getPerformanceSamples() {
  return profiler.getSamples()
}

export function clearPerformanceSamples() {
  profiler.clear()
}

/**
 * Adapter for React's <Profiler onRender> callback. All six timing values are
 * retained so benchmark output can distinguish render work from commit timing.
 */
export type ReactProfilerCallback = (
  id: string,
  phase: "mount" | "update" | "nested-update",
  actualDuration: number,
  baseDuration: number,
  startTime: number,
  commitTime: number,
  interactions?: unknown,
) => void

export const onRender: ReactProfilerCallback = (id, phase, actualDuration, baseDuration, startTime, commitTime) => {
  profiler.record({
    name: `react:${id}`,
    durationMs: actualDuration,
    startTimeMs: startTime,
    endTimeMs: commitTime,
    id,
    phase,
    actualDuration,
    baseDuration,
    startTime,
    commitTime,
  })
}

// Convenience factory for consumers that want to fan out React samples while
// keeping the shared profiler's bounded storage and opt-in behavior.
export function createReactProfilerCallback(callback?: PerformanceSampleCallback): ReactProfilerCallback {
  return (id, phase, actualDuration, baseDuration, startTime, commitTime) => {
    const sample = profiler.record({
      name: `react:${id}`,
      durationMs: actualDuration,
      startTimeMs: startTime,
      endTimeMs: commitTime,
      id,
      phase,
      actualDuration,
      baseDuration,
      startTime,
      commitTime,
    })
    if (sample) callback?.(sample)
  }
}

declare const __LOCAL_DIFFE_PERF__: boolean | string | undefined
declare const __LOCAL_DIFFE_PROFILE_BUILD__: boolean | undefined
