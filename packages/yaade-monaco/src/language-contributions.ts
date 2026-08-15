import { monacoLanguageId } from "./language.js"

type ContributionLoader = () => Promise<object>
interface ContributionLoaderMap {
  [language: string]: ContributionLoader
}

const loadCss = () => import("monaco-editor/esm/vs/language/css/monaco.contribution.js")
const loadHtml = () => import("monaco-editor/esm/vs/language/html/monaco.contribution.js")

/** Static dynamic-import map keeps every supported tokenizer in its own Vite chunk. */
const loaders: ContributionLoaderMap = {
  typescript: () => import("monaco-editor/esm/vs/basic-languages/typescript/typescript.contribution.js"),
  javascript: () => import("monaco-editor/esm/vs/basic-languages/javascript/javascript.contribution.js"),
  rust: () => import("monaco-editor/esm/vs/basic-languages/rust/rust.contribution.js"),
  go: () => import("monaco-editor/esm/vs/basic-languages/go/go.contribution.js"),
  python: () => import("monaco-editor/esm/vs/basic-languages/python/python.contribution.js"),
  ruby: () => import("monaco-editor/esm/vs/basic-languages/ruby/ruby.contribution.js"),
  json: () => import("monaco-editor/esm/vs/language/json/monaco.contribution.js"),
  markdown: () => import("monaco-editor/esm/vs/basic-languages/markdown/markdown.contribution.js"),
  mdx: () => import("monaco-editor/esm/vs/basic-languages/mdx/mdx.contribution.js"),
  css: loadCss,
  scss: loadCss,
  less: loadCss,
  html: loadHtml,
  handlebars: loadHtml,
  yaml: () => import("monaco-editor/esm/vs/basic-languages/yaml/yaml.contribution.js"),
  ini: () => import("monaco-editor/esm/vs/basic-languages/ini/ini.contribution.js"),
  shell: () => import("monaco-editor/esm/vs/basic-languages/shell/shell.contribution.js"),
  php: () => import("monaco-editor/esm/vs/basic-languages/php/php.contribution.js"),
  java: () => import("monaco-editor/esm/vs/basic-languages/java/java.contribution.js"),
  kotlin: () => import("monaco-editor/esm/vs/basic-languages/kotlin/kotlin.contribution.js"),
  swift: () => import("monaco-editor/esm/vs/basic-languages/swift/swift.contribution.js"),
  csharp: () => import("monaco-editor/esm/vs/basic-languages/csharp/csharp.contribution.js"),
  cpp: () => import("monaco-editor/esm/vs/basic-languages/cpp/cpp.contribution.js"),
  sql: () => import("monaco-editor/esm/vs/basic-languages/sql/sql.contribution.js"),
  xml: () => import("monaco-editor/esm/vs/basic-languages/xml/xml.contribution.js"),
  dockerfile: () => import("monaco-editor/esm/vs/basic-languages/dockerfile/dockerfile.contribution.js"),
  lua: () => import("monaco-editor/esm/vs/basic-languages/lua/lua.contribution.js"),
  r: () => import("monaco-editor/esm/vs/basic-languages/r/r.contribution.js"),
  perl: () => import("monaco-editor/esm/vs/basic-languages/perl/perl.contribution.js"),
  powershell: () => import("monaco-editor/esm/vs/basic-languages/powershell/powershell.contribution.js"),
  graphql: () => import("monaco-editor/esm/vs/basic-languages/graphql/graphql.contribution.js"),
  dart: () => import("monaco-editor/esm/vs/basic-languages/dart/dart.contribution.js"),
  scala: () => import("monaco-editor/esm/vs/basic-languages/scala/scala.contribution.js"),
  elixir: () => import("monaco-editor/esm/vs/basic-languages/elixir/elixir.contribution.js"),
}

const pending = new Map<string, Promise<void>>()

export function ensureLanguageContribution(languageId: string): Promise<void> {
  const id = monacoLanguageId(languageId)
  const loader = loaders[id]
  if (!loader) return Promise.resolve()
  const existing = pending.get(id)
  if (existing) return existing
  const loading = loader().then(() => undefined, error => {
    pending.delete(id)
    throw error
  })
  pending.set(id, loading)
  return loading
}
