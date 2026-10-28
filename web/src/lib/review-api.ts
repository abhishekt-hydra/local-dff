import * as z from "zod/mini"
import type { PullRequest } from "../stacks"

// Mirrors the serialized StartResponse, ComparisonInfo, and FileEntry contracts
// in src/main.rs and src/domain.rs. Validate once, before data enters React state.
const count = z.int().check(z.nonnegative())
const positiveInt = z.int().check(z.positive())
const pullRequestSchema = z.object({
  number: positiveInt,
  title: z.string(),
  url: z.string(),
  state: z.string(),
  baseRefName: z.string(),
  headRefName: z.string(),
  isDraft: z.boolean(),
  isCrossRepository: z.optional(z.boolean()),
  author: z.nullish(z.object({ login: z.string() })),
  updatedAt: z.string(),
}) satisfies z.ZodMiniType<PullRequest>

export const pullsSchema = z.array(pullRequestSchema)
const patchFileSchema = z.object({
  old_path: z.nullable(z.string()),
  new_path: z.nullable(z.string()),
  display_path: z.string(),
  renderable: z.boolean(),
})
const revisionSchema = z.object({ revision: z.string(), commit: z.string() })
const comparisonSchema = z.object({
  base: revisionSchema,
  target: revisionSchema,
  changed_paths: count,
  semantic_paths: count,
  description: z.string(),
  pull_request: z.nullish(pullRequestSchema),
})
const commitSchema = z.object({
  sha: z.string(),
  short: z.string(),
  parents: z.array(z.string()),
  author: z.string(),
  date: z.string(),
  subject: z.string(),
  files_changed: count,
})
const stackModeSchema = z.enum(["pr", "cumulative"])
const stackSchema = z.object({
  trunk: z.string(),
  current: positiveInt,
  mode: stackModeSchema,
  members: z.array(
    z.object({
      pull: pullRequestSchema,
      parent: z.nullable(positiveInt),
      depth: count,
    }),
  ),
})
export const sessionSchema = z.object({
  id: z.string().check(z.minLength(1)),
  files: z.array(patchFileSchema),
  comparison: z.nullish(comparisonSchema),
  commits: z.optional(z.array(commitSchema)),
  commits_truncated: z.optional(z.boolean()),
  stack: z.nullish(stackSchema),
})
export type Session = z.infer<typeof sessionSchema>
export type PatchFile = z.infer<typeof patchFileSchema>
export type Commit = z.infer<typeof commitSchema>
export type StackMode = z.infer<typeof stackModeSchema>

const apiErrorSchema = z.object({ error: z.string().check(z.minLength(1)) })

export async function readApiResponse<T>(response: Response, schema: z.ZodMiniType<T>): Promise<T> {
  const body: unknown = await response.json().catch(() => null)
  if (!response.ok) {
    const error = apiErrorSchema.safeParse(body)
    throw new Error(error.success ? error.data.error : `Request failed (${response.status}).`)
  }
  const result = schema.safeParse(body)
  if (!result.success)
    throw new Error("The server returned an invalid response. Retry loading this review.")
  return result.data
}

export async function api<T>(
  path: string,
  payload: unknown,
  schema: z.ZodMiniType<T>,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    signal,
  })
  return readApiResponse(response, schema)
}
