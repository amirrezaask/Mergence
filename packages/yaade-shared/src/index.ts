export type Disposable = { dispose(): void };

export class Emitter<T> {
  private listeners = new Set<(value: T) => void>();

  event = (listener: (value: T) => void): Disposable => {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  };

  fire(value: T): void {
    for (const listener of this.listeners) listener(value);
  }
}

import { fileUriToPath } from "./uri.js";

export {
  type FileUri,
  isFileUri,
  pathToFileUri,
  fileUriToPath,
  canonicalizeFileUri,
  normalizeFsPath,
} from "./uri.js";

export function basename(uriOrPath: string): string {
  const path = uriOrPath.startsWith("file://")
    ? fileUriToPath(uriOrPath)
    : uriOrPath;
  const parts = path.split(/[/\\]/);
  return parts[parts.length - 1] || path;
}

export function extname(uriOrPath: string): string {
  const name = basename(uriOrPath);
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot) : "";
}

interface LanguageMap {
  [extension: string]: string;
}

const LANGUAGE_BY_EXT: LanguageMap = {
  ".ts": "typescript",
  ".tsx": "tsx",
  ".mts": "mts",
  ".cts": "cts",
  ".js": "javascript",
  ".jsx": "jsx",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".rs": "rust",
  ".go": "go",
  ".py": "python",
  ".pyi": "python",
  ".pyw": "python",
  ".rb": "ruby",
  ".rake": "ruby",
  ".gemspec": "ruby",
  ".json": "json",
  ".jsonc": "jsonc",
  ".md": "markdown",
  ".mdx": "mdx",
  ".css": "css",
  ".scss": "scss",
  ".less": "less",
  ".html": "html",
  ".htm": "html",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".toml": "toml",
  ".sh": "shell",
  ".bash": "shell",
  ".zsh": "shell",
  ".php": "php",
  ".java": "java",
  ".kt": "kotlin",
  ".kts": "kotlin",
  ".swift": "swift",
  ".cs": "csharp",
  ".c": "cpp",
  ".h": "cpp",
  ".cpp": "cpp",
  ".cc": "cpp",
  ".cxx": "cpp",
  ".hpp": "cpp",
  ".hh": "cpp",
  ".sql": "sql",
  ".xml": "xml",
  ".dockerfile": "dockerfile",
  ".lua": "lua",
  ".r": "r",
  ".pl": "perl",
  ".pm": "perl",
  ".ps1": "powershell",
  ".psm1": "powershell",
  ".graphql": "graphql",
  ".gql": "graphql",
  ".dart": "dart",
  ".scala": "scala",
  ".ex": "elixir",
  ".exs": "elixir",
};

/** Basename → language when extension alone is ambiguous or missing. */
const LANGUAGE_BY_BASENAME: LanguageMap = {
  dockerfile: "dockerfile",
  makefile: "shell",
  gemfile: "ruby",
  rakefile: "ruby",
};

export function languageIdFromPath(path: string): string {
  const name = basename(path).toLowerCase();
  const byName = LANGUAGE_BY_BASENAME[name];
  if (byName) return byName;
  const ext = extname(path).toLowerCase();
  return LANGUAGE_BY_EXT[ext] ?? "plaintext";
}

/** Map Yaade language ids to LSP `textDocument/languageId` values. */
export function lspLanguageIdFromJet(languageId: string): string {
  switch (languageId) {
    case "tsx":
    case "mts":
    case "cts":
      return "typescript";
    case "jsx":
      return "javascript";
    default:
      return languageId;
  }
}

export const UNTITLED_SCHEME = "untitled:";

export function isUntitledUri(uri: string): boolean {
  return uri.startsWith(UNTITLED_SCHEME);
}

export function makeUntitledUri(n: number): string {
  return `${UNTITLED_SCHEME}untitled-${n}`;
}

export * from "./git.js";
export * from "./panels.js";
export * from "./diagnostics.js";
export * from "./notifications.js";
export * from "./providers.js";
export * from "./servers.js";
export * from "./motion.js";
export * from "./rad-motion.js";
export * from "./rad-scroll.js";
export * from "./wheel-delta.js";
export {
  defaultYaadeTheme,
  applyYaadeThemeCss,
  applyColorScheme,
  applyJetHighlightCssVars,
  isDarkTheme,
  type YaadeTheme,
  type JetColors,
  type JetHighlightColors,
  type JetTerminalColors,
  type JetTerminalAnsiColors,
  type JetShadcnTokens,
  type YaadeSemanticTokens,
  type JetSemanticColors,
  type ColorScheme,
  shadcnDefaultDark,
  shadcnDefaultLight,
  jetColorsFromShadcn,
  jetColorsFromTokens,
  toSrgbColor,
  applyShadcnTokens,
  applySemanticTokens,
} from "./theme/theme-types.js";
