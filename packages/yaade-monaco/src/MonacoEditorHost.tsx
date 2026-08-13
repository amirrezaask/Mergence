import { useEffect, useId, useRef, useState } from "react"
import * as monaco from "monaco-editor/esm/vs/editor/editor.api.js"
import type { YaadeTheme } from "@yaade/shared"
import "./monaco-features.js"
import { ensureMonacoEnvironment } from "./monaco-env.js"
import { isLargeModel, monacoLanguageId } from "./language.js"
import { ensureLanguageContribution } from "./language-contributions.js"
import { monacoModels } from "./model-registry.js"
import { applyYaadeMonacoTheme } from "./theme.js"
import {
  applyPendingNavigation,
  consumePendingInitialContent,
} from "./navigation.js"
import {
  getActiveMonacoEditor,
  setActiveMonacoEditor,
  type MonacoEditorHandle,
} from "./editor-api.js"
import {
  interceptPrimaryCommandPaletteShortcut,
  interceptPrimaryQuickOpenShortcut,
  interceptPrimarySaveShortcut,
} from "./editor-shortcuts.js"
import {
  recordMonacoEditorBlurred,
  recordMonacoEditorDisposed,
  recordMonacoEditorFocused,
  recordMonacoEditorModelChanged,
  recordMonacoEditorMounted,
} from "./editor-diagnostics.js"

export type MonacoEditorHostProps = {
  uri: string
  content: string
  languageId: string
  theme: YaadeTheme
  readOnly?: boolean
  autoFocus?: boolean
  fontSize?: number
  /** Stable surface identity used to restore cursor, selections, folds, and scroll. */
  viewStateId?: string
  initialViewState?: monaco.editor.ICodeEditorViewState | null
  onViewStateChange?: (
    uri: string,
    state: monaco.editor.ICodeEditorViewState | null,
  ) => void
  onReady?: (editor: MonacoEditorHandle) => void
  onContentChange?: (model: monaco.editor.ITextModel) => void
  onFocusChange?: (focused: boolean) => void
  onCursorChange?: (line: number, column: number) => void
  onQuickOpen?: () => void
  onCommandPalette?: () => void
  onSave?: () => void
  className?: string
}

function largeFileOptions(large: boolean): monaco.editor.IStandaloneEditorConstructionOptions {
  if (!large) return {}
  return {
    minimap: { enabled: false },
    folding: false,
    renderLineHighlight: "none",
    wordBasedSuggestions: "off",
    quickSuggestions: false,
    suggestOnTriggerCharacters: false,
    parameterHints: { enabled: false },
    occurrencesHighlight: "off",
    selectionHighlight: false,
    codeLens: false,
    links: false,
    colorDecorators: false,
    hover: { enabled: false },
  }
}

export function MonacoEditorHost({
  uri,
  content,
  languageId,
  theme,
  readOnly = false,
  autoFocus = false,
  fontSize = 14,
  viewStateId,
  initialViewState,
  onViewStateChange,
  onReady,
  onContentChange,
  onFocusChange,
  onCursorChange,
  onQuickOpen,
  onCommandPalette,
  onSave,
  className,
}: MonacoEditorHostProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const editorRef = useRef<MonacoEditorHandle | null>(null)
  const [initialLanguageReady, setInitialLanguageReady] = useState(false)
  const generatedEditorId = useId()
  const editorId = viewStateId ?? generatedEditorId
  const viewOwnerId = `view:${editorId}`
  const uriRef = useRef(uri)
  const onReadyRef = useRef(onReady)
  const onContentChangeRef = useRef(onContentChange)
  const onFocusChangeRef = useRef(onFocusChange)
  const onCursorChangeRef = useRef(onCursorChange)
  const onQuickOpenRef = useRef(onQuickOpen)
  const onCommandPaletteRef = useRef(onCommandPalette)
  const onSaveRef = useRef(onSave)
  const onViewStateChangeRef = useRef(onViewStateChange)

  onReadyRef.current = onReady
  onContentChangeRef.current = onContentChange
  onFocusChangeRef.current = onFocusChange
  onCursorChangeRef.current = onCursorChange
  onQuickOpenRef.current = onQuickOpen
  onCommandPaletteRef.current = onCommandPalette
  onSaveRef.current = onSave
  onViewStateChangeRef.current = onViewStateChange

  useEffect(() => {
    let cancelled = false
    void ensureLanguageContribution(languageId)
      .catch(() => undefined)
      .then(() => {
        if (cancelled) return
        // Re-assigning after Monarch registration forces existing models to
        // tokenize. The first editor waits for this path before it is created.
        monacoModels.setLanguage(uri, languageId)
        setInitialLanguageReady(true)
      })
    return () => {
      cancelled = true
    }
  }, [languageId, uri])

  useEffect(() => {
    if (!initialLanguageReady) return
    ensureMonacoEnvironment()
    const container = containerRef.current
    if (!container) return

    const pending = consumePendingInitialContent(uri)
    const initialContent = pending ?? content
    const model = monacoModels.getOrCreate(
      uri,
      initialContent,
      languageId,
    )
    monacoModels.retain(uri, viewOwnerId)
    const large = isLargeModel(model)

    const editor = monaco.editor.create(container, {
      model,
      automaticLayout: false,
      readOnly,
      scrollBeyondLastLine: false,
      minimap: { enabled: false },
      stickyScroll: { enabled: true, maxLineCount: 5 },
      links: true,
      hover: { enabled: true, delay: 250 },
      fontFamily: "var(--font-mono, 'Commit Mono', ui-monospace, monospace)",
      fontSize,
      lineHeight: Math.round(fontSize * (22 / 14)),
      padding: { top: 8, bottom: 8 },
      renderWhitespace: "selection",
      bracketPairColorization: { enabled: true },
      smoothScrolling: true,
      cursorBlinking: "blink",
      cursorSmoothCaretAnimation: "off",
      ...largeFileOptions(large),
    })

    editorRef.current = editor
    recordMonacoEditorMounted(editorId, uri, editor)
    applyYaadeMonacoTheme(theme)

    const savedState =
      monacoModels.restoreViewState(editorId, uri) ?? initialViewState
    if (savedState) editor.restoreViewState(savedState)

    applyPendingNavigation(editor, uri)

    if (autoFocus) {
      editor.focus()
      recordMonacoEditorFocused(editorId)
    }

    const disposables: monaco.IDisposable[] = []

    disposables.push(
      editor.onDidChangeModelContent(() => {
        const currentModel = editor.getModel()
        if (currentModel) onContentChangeRef.current?.(currentModel)
      }),
    )

    disposables.push(
      editor.onDidFocusEditorText(() => {
        setActiveMonacoEditor(editor)
        recordMonacoEditorFocused(editorId)
        onFocusChangeRef.current?.(true)
      }),
    )

    disposables.push(
      editor.onDidBlurEditorText(() => {
        recordMonacoEditorBlurred(editorId)
        onFocusChangeRef.current?.(false)
      }),
    )

    disposables.push(
      editor.onDidChangeCursorPosition(e => {
        onCursorChangeRef.current?.(e.position.lineNumber, e.position.column)
      }),
    )

    disposables.push(
      editor.onKeyDown(event => {
        const browserEvent = event.browserEvent
        const platform = navigator.platform
        if (
          interceptPrimaryQuickOpenShortcut(
            browserEvent,
            platform,
            () => onQuickOpenRef.current?.(),
          ) ||
          interceptPrimarySaveShortcut(
            browserEvent,
            platform,
            () => onSaveRef.current?.(),
          )
        ) {
          return
        }
        interceptPrimaryCommandPaletteShortcut(
          browserEvent,
          platform,
          () => onCommandPaletteRef.current?.(),
        )
      }),
    )

    const resizeObserver = new ResizeObserver(() => {
      editor.layout()
    })
    resizeObserver.observe(container)

    const saveCurrentViewState = () => {
      const currentUri = uriRef.current
      const state = editor.saveViewState()
      monacoModels.saveViewState(editorId, currentUri, state)
      onViewStateChangeRef.current?.(currentUri, state)
    }
    window.addEventListener("pagehide", saveCurrentViewState)
    window.addEventListener("yaade:save-editor-view-state", saveCurrentViewState)

    onReadyRef.current?.(editor)

    return () => {
      const currentUri = uriRef.current
      saveCurrentViewState()
      window.removeEventListener("pagehide", saveCurrentViewState)
      window.removeEventListener(
        "yaade:save-editor-view-state",
        saveCurrentViewState,
      )
      resizeObserver.disconnect()
      for (const d of disposables) d.dispose()
      editor.dispose()
      recordMonacoEditorDisposed(editorId)
      if (getActiveMonacoEditor() === editor) setActiveMonacoEditor(null)
      editorRef.current = null
      monacoModels.release(currentUri, viewOwnerId)
    }
  }, [editorId, initialLanguageReady])

  useEffect(() => {
    uriRef.current = uri
    const editor = editorRef.current
    if (!editor) return

    const previousUri = editor.getModel()?.uri.toString()
    if (previousUri === monacoModels.canonicalKey(uri)) {
      monacoModels.setLanguage(uri, languageId)
      return
    }

    const state = editor.saveViewState()
    if (previousUri) {
      monacoModels.saveViewState(editorId, previousUri, state)
      onViewStateChangeRef.current?.(previousUri, state)
    }

    const pending = consumePendingInitialContent(uri)
    const model = monacoModels.getOrCreate(
      uri,
      pending ?? content,
      languageId,
    )
    monacoModels.retain(uri, viewOwnerId)

    editor.setModel(model)
    recordMonacoEditorModelChanged(editorId, uri)
    monacoModels.setLanguage(uri, languageId)

    const restored =
      monacoModels.restoreViewState(editorId, uri) ?? initialViewState
    if (restored) editor.restoreViewState(restored)
    else editor.setPosition({ lineNumber: 1, column: 1 })

    applyPendingNavigation(editor, uri)

    if (previousUri && previousUri !== monacoModels.canonicalKey(uri)) {
      monacoModels.release(previousUri, viewOwnerId)
    }
  }, [uri, content, languageId, editorId, initialViewState, viewOwnerId])

  useEffect(() => {
    applyYaadeMonacoTheme(theme)
  }, [theme])

  useEffect(() => {
    editorRef.current?.updateOptions({ readOnly })
  }, [readOnly])

  useEffect(() => {
    editorRef.current?.updateOptions({
      fontSize,
      lineHeight: Math.round(fontSize * (22 / 14)),
    })
  }, [fontSize])

  useEffect(() => {
    if (autoFocus) editorRef.current?.focus()
  }, [autoFocus])

  return (
    <div
      ref={containerRef}
      className={className}
      data-yaade-monaco-editor
      data-yaade-monaco-language={monacoLanguageId(languageId)}
      aria-label="Code editor"
      style={{ width: "100%", height: "100%", minHeight: 0, minWidth: 0 }}
    />
  )
}
