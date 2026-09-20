import { createHighlighterCore } from "shiki/core"
import type { BundledLanguage } from "shiki"
import { createJavaScriptRegexEngine } from "shiki/engine/javascript"

type ShikiToken = { content: string; color?: string; fontStyle?: number }
export type SemanticToken = { start: number; end: number; priority?: number; foreground?: string; background?: string; fontStyle?: number }
export type SemanticLine = { line: number; content: string; tokens?: SemanticToken[] }
export type SemanticBlock = { old_column?: SemanticLine[]; new_column?: SemanticLine[] }
export type SemanticPatch = { type?: string; blocks?: SemanticBlock[] }

const languageForExtension: Record<string, BundledLanguage> = {
  go: "go", rs: "rust", ts: "typescript", tsx: "tsx", js: "javascript", jsx: "jsx",
  json: "json", yaml: "yaml", yml: "yaml", md: "markdown", py: "python", rb: "ruby",
  java: "java", kt: "kotlin", swift: "swift", cs: "csharp", cpp: "cpp", cc: "cpp",
  c: "c", h: "c", hpp: "cpp", html: "html", css: "css", scss: "scss", sql: "sql",
  sh: "shellscript", bash: "shellscript", zsh: "shellscript", toml: "toml", xml: "xml",
}

const highlighter = createHighlighterCore({
  // Keep the bootstrap/worker entry small. Grammars are loaded as separate
  // chunks only for the selected file language.
  themes: [import("shiki/themes/github-dark-default.mjs")],
  langs: [],
  engine: createJavaScriptRegexEngine(),
})
const loadedLanguages = new Set<string>()

type LanguageModule = { default: unknown }
const languageLoaders: Partial<Record<BundledLanguage, () => Promise<LanguageModule>>> = {
  go: () => import("shiki/langs/go.mjs"),
  rust: () => import("shiki/langs/rust.mjs"),
  typescript: () => import("shiki/langs/typescript.mjs"),
  tsx: () => import("shiki/langs/tsx.mjs"),
  javascript: () => import("shiki/langs/javascript.mjs"),
  jsx: () => import("shiki/langs/jsx.mjs"),
  json: () => import("shiki/langs/json.mjs"),
  yaml: () => import("shiki/langs/yaml.mjs"),
  markdown: () => import("shiki/langs/markdown.mjs"),
  python: () => import("shiki/langs/python.mjs"),
  ruby: () => import("shiki/langs/ruby.mjs"),
  java: () => import("shiki/langs/java.mjs"),
  kotlin: () => import("shiki/langs/kotlin.mjs"),
  swift: () => import("shiki/langs/swift.mjs"),
  csharp: () => import("shiki/langs/csharp.mjs"),
  cpp: () => import("shiki/langs/cpp.mjs"),
  c: () => import("shiki/langs/c.mjs"),
  html: () => import("shiki/langs/html.mjs"),
  css: () => import("shiki/langs/css.mjs"),
  scss: () => import("shiki/langs/scss.mjs"),
  sql: () => import("shiki/langs/sql.mjs"),
  shellscript: () => import("shiki/langs/shellscript.mjs"),
  toml: () => import("shiki/langs/toml.mjs"),
  xml: () => import("shiki/langs/xml.mjs"),
}

function languageFromPath(path: string) {
  const extension = path.split(".").at(-1)?.toLowerCase() ?? ""
  return languageForExtension[extension]
}

async function tokenize(source: string, path: string): Promise<ShikiToken[][]> {
  const language = languageFromPath(path)
  if (!language || !source) return []
  const instance = await highlighter
  if (!loadedLanguages.has(language)) {
    const loader = languageLoaders[language]
    if (!loader) return []
    const module = await loader()
    await instance.loadLanguage(module.default as never)
    loadedLanguages.add(language)
  }
  return instance.codeToTokens(source, { lang: language, theme: "github-dark-default" }).tokens
}

function unicodeOffsets(value: string) {
  const offsets = new Uint32Array(value.length + 1)
  let codePointOffset = 0
  for (let utf16Offset = 0; utf16Offset < value.length;) {
    const codePoint = value.codePointAt(utf16Offset)!
    const width = codePoint > 0xffff ? 2 : 1
    offsets[utf16Offset] = codePointOffset
    if (width === 2) offsets[utf16Offset + 1] = codePointOffset
    utf16Offset += width
    codePointOffset++
    offsets[utf16Offset] = codePointOffset
  }
  return offsets
}

function decorateColumn(column: SemanticLine[] | undefined, lines: ShikiToken[][]) {
  if (!column) return
  for (const line of column) {
    const tokens = lines[line.line - 1]
    if (!tokens?.length) continue
    const offsets = unicodeOffsets(line.content)
    let utf16Start = 0
    const highlights = tokens.flatMap((token) => {
      const utf16End = utf16Start + token.content.length
      // SemanticDiff's native highlighter uses Unicode scalar offsets. Shiki
      // exposes JavaScript UTF-16 strings, so convert both ends for emoji and
      // other astral characters before appending the exact extension token
      // shape.
      const start = offsets[Math.min(utf16Start, line.content.length)] ?? 0
      const end = offsets[Math.min(utf16End, line.content.length)] ?? start
      const highlight = token.content.length && (token.color || token.fontStyle)
        // Keep the vendor's diff background classes authoritative. Shiki's
        // foreground/font style are safe inline additions; token backgrounds
        // would cover added/removed line colors.
        ? { start, end, priority: 0, ...(token.color ? { foreground: token.color } : {}), ...(token.fontStyle ? { fontStyle: token.fontStyle } : {}) }
        : null
      utf16Start = utf16End
      return highlight ? [highlight] : []
    })
    if (highlights.length) line.tokens = [...(line.tokens ?? []), ...highlights]
  }
}

/** Adds TextMate/Shiki foreground tokens without disturbing SemanticDiff's diff tokens. */
export async function decorateSemanticPatch(
  patch: SemanticPatch,
  input: { old: string; new: string; oldPath: string; newPath: string },
) {
  if (patch.type && patch.type !== "code") return
  try {
    const [oldLines, newLines] = await Promise.all([
      tokenize(input.old, input.oldPath),
      tokenize(input.new, input.newPath),
    ])
    for (const block of patch.blocks ?? []) {
      decorateColumn(block.old_column, oldLines)
      decorateColumn(block.new_column, newLines)
    }
  } catch {
    // Highlighting is an enhancement. Unsupported grammars or a lazy Shiki
    // load failure must leave the semantic diff renderable with its native
    // change tokens intact.
  }
}
