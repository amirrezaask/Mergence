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

export {
  type FileUri,
  isFileUri,
  pathToFileUri,
  fileUriToPath,
  canonicalizeFileUri,
  normalizeFsPath,
} from "./uri.js";

export * from "./panels.js";
export * from "./servers.js";
export * from "./motion.js";
export * from "./rad-motion.js";
export * from "./rad-scroll.js";
export * from "./wheel-delta.js";
export {
  defaultYaadeTheme,
  applyYaadeThemeCss,
  applyColorScheme,
  applyYaadeHighlightCssVars,
  isDarkTheme,
  type YaadeTheme,
  type YaadeColors,
  type YaadeHighlightColors,
  type YaadeTerminalColors,
  type YaadeTerminalAnsiColors,
  type YaadeShadcnTokens,
  type YaadeSemanticTokens,
  type YaadeSemanticColors,
  type ColorScheme,
  shadcnDefaultDark,
  shadcnDefaultLight,
  yaadeColorsFromShadcn,
  yaadeColorsFromTokens,
  toSrgbColor,
  applyShadcnTokens,
  applySemanticTokens,
} from "./theme/theme-types.js";
