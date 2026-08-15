interface LanguageAliasMap {
  [language: string]: string
}

const LANGUAGE_ALIASES: LanguageAliasMap = {
  tsx: "typescript",
  jsx: "javascript",
  mts: "typescript",
  cts: "typescript",
  mjs: "javascript",
  cjs: "javascript",
  plaintext: "plaintext",
  text: "plaintext",
  md: "markdown",
  yml: "yaml",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  rs: "rust",
  py: "python",
  rb: "ruby",
  cs: "csharp",
  c: "c",
  cpp: "cpp",
  hpp: "cpp",
  h: "c",
  kt: "kotlin",
  kts: "kotlin",
  swift: "swift",
  sql: "sql",
  dockerfile: "dockerfile",
  toml: "ini",
  jsonc: "json",
  gql: "graphql",
  ex: "elixir",
  exs: "elixir",
  pl: "perl",
  pm: "perl",
  ps1: "powershell",
  psm1: "powershell",
}

/** Map Yaade language ids to Monaco editor language ids. */
export function monacoLanguageId(languageId: string): string {
  const normalized = languageId.trim().toLowerCase()
  if (!normalized) return "plaintext"
  return LANGUAGE_ALIASES[normalized] ?? normalized
}

/** Skip expensive editor features for large buffers (earlier threshold to cut RAM). */
export function isLargeFile(content: string): boolean {
  if (content.length > 1 * 1024 * 1024) return true
  let lines = 0
  for (let i = 0; i < content.length; i++) {
    if (content.charCodeAt(i) === 10 && ++lines > 20_000) return true
  }
  return false
}

/** Large-file classification without serializing an existing Monaco model. */
export function isLargeModel(model: {
  getValueLength(): number
  getLineCount(): number
}): boolean {
  return model.getValueLength() > 1 * 1024 * 1024 || model.getLineCount() > 20_000
}
