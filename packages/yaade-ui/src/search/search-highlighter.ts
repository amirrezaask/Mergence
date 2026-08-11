import type { HighlighterCore, ThemedToken } from "@shikijs/core"
import { languageIdFromPath } from "@yaade/shared"

type ThemeName = "github-dark" | "github-light"

let highlighterPromise: Promise<HighlighterCore> | null = null
const loadedLangs = new Set<string>([
  "typescript",
  "javascript",
  "tsx",
  "jsx",
  "json",
  "markdown",
  "html",
  "css",
  "text",
])

const LANG_LOADERS: Record<string, () => Promise<unknown>> = {
  typescript: () => import("@shikijs/langs/typescript"),
  javascript: () => import("@shikijs/langs/javascript"),
  tsx: () => import("@shikijs/langs/tsx"),
  jsx: () => import("@shikijs/langs/jsx"),
  json: () => import("@shikijs/langs/json"),
  markdown: () => import("@shikijs/langs/markdown"),
  html: () => import("@shikijs/langs/html"),
  css: () => import("@shikijs/langs/css"),
  bash: () => import("@shikijs/langs/bash"),
  shell: () => import("@shikijs/langs/shell"),
  python: () => import("@shikijs/langs/python"),
  go: () => import("@shikijs/langs/go"),
  rust: () => import("@shikijs/langs/rust"),
  ruby: () => import("@shikijs/langs/ruby"),
  yaml: () => import("@shikijs/langs/yaml"),
  toml: () => import("@shikijs/langs/toml"),
  scss: () => import("@shikijs/langs/scss"),
  graphql: () => import("@shikijs/langs/graphql"),
  jsonc: () => import("@shikijs/langs/jsonc"),
  dockerfile: () => import("@shikijs/langs/dockerfile"),
}

function preferDarkTheme(): boolean {
  if (typeof document === "undefined") return true
  return document.documentElement.classList.contains("dark")
}

async function getHighlighter(): Promise<HighlighterCore> {
  if (!highlighterPromise) {
    // Core + JS engine stays out of the startup graph and avoids Oniguruma WASM
    // (CSP blocks wasm-unsafe-eval). Lang grammars load on demand.
    highlighterPromise = Promise.all([
      import("shiki/core"),
      import("shiki/engine/javascript"),
    ]).then(async ([{ createHighlighterCore }, { createJavaScriptRegexEngine }]) =>
      createHighlighterCore({
        engine: createJavaScriptRegexEngine(),
        themes: [
          import("@shikijs/themes/github-dark"),
          import("@shikijs/themes/github-light"),
        ],
        langs: [
          import("@shikijs/langs/typescript"),
          import("@shikijs/langs/javascript"),
          import("@shikijs/langs/tsx"),
          import("@shikijs/langs/jsx"),
          import("@shikijs/langs/json"),
          import("@shikijs/langs/markdown"),
          import("@shikijs/langs/html"),
          import("@shikijs/langs/css"),
        ],
      }),
    )
  }
  return highlighterPromise
}

function shikiLang(path: string): string {
  const id = languageIdFromPath(path)
  switch (id) {
    case "shellscript":
    case "shell":
      return "bash"
    case "plaintext":
      return "text"
    default:
      return id
  }
}

export async function tokenizeSearchLines(
  path: string,
  lines: readonly string[],
): Promise<ThemedToken[][]> {
  const highlighter = await getHighlighter()
  let lang = shikiLang(path)
  if (!loadedLangs.has(lang)) {
    const loader = LANG_LOADERS[lang]
    if (loader) {
      try {
        await highlighter.loadLanguage(loader as () => Promise<never>)
        loadedLangs.add(lang)
      } catch {
        lang = "text"
      }
    } else {
      lang = "text"
    }
  }
  const theme: ThemeName = preferDarkTheme() ? "github-dark" : "github-light"
  const code = lines.join("\n")
  try {
    const result = highlighter.codeToTokens(code, {
      lang: lang as "text",
      theme,
    })
    return result.tokens
  } catch {
    return lines.map(line => [{ content: line, offset: 0 }])
  }
}
