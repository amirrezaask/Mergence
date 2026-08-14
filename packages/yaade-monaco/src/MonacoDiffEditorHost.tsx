import { useEffect, useId, useRef } from "react"
import * as monaco from "monaco-editor/esm/vs/editor/editor.api.js"
import type { YaadeTheme } from "@yaade/shared"
import "./monaco-features.js"
import { ensureMonacoEnvironment } from "./monaco-env.js"
import { isLargeFile } from "./language.js"
import { ensureLanguageContribution } from "./language-contributions.js"
import { monacoModels } from "./model-registry.js"
import { applyYaadeMonacoTheme } from "./theme.js"
export type MonacoDiffEditorHostProps = {
  originalUri: string
  modifiedUri: string
  originalContent: string
  modifiedContent: string
  languageId: string
  theme: YaadeTheme
  readOnly?: boolean
  renderSideBySide?: boolean
  /** Editor font size in px (default 13). Line height is derived from it. */
  fontSize?: number
  onReady?: (editor: monaco.editor.IStandaloneDiffEditor) => void
  className?: string
}

function lineHeightForFontSize(fontSize: number): number {
  return Math.round(fontSize * 1.6)
}

function largeFileOptions(large: boolean): monaco.editor.IDiffEditorConstructionOptions {
  if (!large) return {}
  return {
    renderSideBySide: true,
    ignoreTrimWhitespace: false,
    renderOverviewRuler: false,
  }
}

export function MonacoDiffEditorHost({
  originalUri,
  modifiedUri,
  originalContent,
  modifiedContent,
  languageId,
  theme,
  readOnly = true,
  renderSideBySide = true,
  fontSize = 13,
  onReady,
  className,
}: MonacoDiffEditorHostProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const editorRef = useRef<monaco.editor.IStandaloneDiffEditor | null>(null)
  const editorId = useId()
  const viewOwnerId = `view:${editorId}`
  const onReadyRef = useRef(onReady)
  onReadyRef.current = onReady

  useEffect(() => {
    void ensureLanguageContribution(languageId)
  }, [languageId])

  useEffect(() => {
    ensureMonacoEnvironment()
    const container = containerRef.current
    if (!container) return

    const large = isLargeFile(originalContent) || isLargeFile(modifiedContent)

    const originalModel = monacoModels.getOrCreate(originalUri, originalContent, languageId)
    const modifiedModel = monacoModels.getOrCreate(modifiedUri, modifiedContent, languageId)
    monacoModels.retain(originalUri, viewOwnerId)
    monacoModels.retain(modifiedUri, viewOwnerId)

    const editor = monaco.editor.createDiffEditor(container, {
      automaticLayout: false,
      readOnly,
      renderSideBySide,
      scrollBeyondLastLine: false,
      minimap: { enabled: false },
      fontFamily: "var(--font-mono, 'Geist Mono Variable', ui-monospace, monospace)",
      fontWeight: "450",
      fontSize,
      lineHeight: lineHeightForFontSize(fontSize),
      ...largeFileOptions(large),
    })

    editor.setModel({
      original: originalModel,
      modified: modifiedModel,
    })

    editorRef.current = editor
    applyYaadeMonacoTheme(theme)

    const resizeObserver = new ResizeObserver(() => {
      editor.layout()
    })
    resizeObserver.observe(container)

    onReadyRef.current?.(editor)

    return () => {
      resizeObserver.disconnect()
      editor.dispose()
      editorRef.current = null
      monacoModels.release(originalUri, viewOwnerId)
      monacoModels.release(modifiedUri, viewOwnerId)
    }
  // Content and presentation changes are updated in place below. Recreating the
  // diff editor for every Git refresh discards scroll state and repeats layout.
  }, [originalUri, modifiedUri, languageId, viewOwnerId])

  useEffect(() => {
    applyYaadeMonacoTheme(theme)
  }, [theme])

  useEffect(() => {
    const editor = editorRef.current
    if (!editor) return
    monacoModels.updateContent(originalUri, originalContent, { preserveCursor: true })
    monacoModels.updateContent(modifiedUri, modifiedContent, { preserveCursor: true })
    monacoModels.setLanguage(originalUri, languageId)
    monacoModels.setLanguage(modifiedUri, languageId)
    editor.updateOptions({
      readOnly,
      renderSideBySide,
      fontSize,
      lineHeight: lineHeightForFontSize(fontSize),
    })
  }, [originalUri, modifiedUri, originalContent, modifiedContent, languageId, readOnly, renderSideBySide, fontSize])

  return (
    <div
      ref={containerRef}
      className={className}
      data-yaade-monaco-diff-editor
      aria-label="Diff editor"
      style={{ width: "100%", height: "100%", minHeight: 0, minWidth: 0 }}
    />
  )
}
