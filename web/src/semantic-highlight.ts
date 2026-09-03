import { createHighlighter, type BundledLanguage } from "shiki"
import { createJavaScriptRegexEngine } from "shiki/engine/javascript"

type ShikiToken = { content: string; color?: string; fontStyle?: number }
type SemanticLine = { line: number; tokens?: unknown[] }
type SemanticBlock = { old_column?: SemanticLine[]; new_column?: SemanticLine[] }
type SemanticPatch = { type?: string; blocks?: SemanticBlock[] }

const languageForExtension: Record<string, BundledLanguage> = {
  go: "go", rs: "rust", ts: "typescript", tsx: "tsx", js: "javascript", jsx: "jsx",
  json: "json", yaml: "yaml", yml: "yaml", md: "markdown", py: "python", rb: "ruby",
  java: "java", kt: "kotlin", swift: "swift", cs: "csharp", cpp: "cpp", cc: "cpp",
  c: "c", h: "c", hpp: "cpp", html: "html", css: "css", scss: "scss", sql: "sql",
  sh: "shellscript", bash: "shellscript", zsh: "shellscript", toml: "toml", xml: "xml",
}

const highlighter = createHighlighter({
  themes: ["github-dark-default"],
  langs: [],
  engine: createJavaScriptRegexEngine(),
})
const loadedLanguages = new Set<string>()

function languageFromPath(path: string) {
  const extension = path.split(".").at(-1)?.toLowerCase() ?? ""
  return languageForExtension[extension]
}

async function tokenize(source: string, path: string): Promise<ShikiToken[][]> {
  const language = languageFromPath(path)
  if (!language || !source) return []
  const instance = await highlighter
  if (!loadedLanguages.has(language)) {
    await instance.loadLanguage(language)
    loadedLanguages.add(language)
  }
  return instance.codeToTokens(source, { lang: language, theme: "github-dark-default" }).tokens
}

function decorateColumn(column: SemanticLine[] | undefined, lines: ShikiToken[][]) {
  if (!column) return
  for (const line of column) {
    const tokens = lines[line.line - 1]
    if (!tokens?.length) continue
    let start = 0
    const highlights = tokens.flatMap((token) => {
      const end = start + token.content.length
      const highlight = token.color && token.content.length
        ? { start, end, foreground: token.color, fontStyle: token.fontStyle ?? 0, kind: "syntax", priority: -1 }
        : null
      start = end
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
  const [oldLines, newLines] = await Promise.all([
    tokenize(input.old, input.oldPath),
    tokenize(input.new, input.newPath),
  ])
  for (const block of patch.blocks ?? []) {
    decorateColumn(block.old_column, oldLines)
    decorateColumn(block.new_column, newLines)
  }
}
