import { useEffect } from "react"
import type { PanelId } from "@yaade/shared"
import {
  anyOverlayOpen,
  CHORD_TIMEOUT_MS,
  createChordState,
  isChordBinding,
  isEditorKeyBinding,
  keyEventMatchesBinding,
  keyEventMatchesBindingPart,
  parseBindingKey,
  resolveKeydownBinding,
  type JetKeyBinding,
  type KeymapContext,
  type WorkspaceService,
} from "@yaade/workspace"
import { useLatest } from "./useLatest.js"

export type GlobalKeymapRefs = {
  /** Prefer a live getter so registerUser races can't leave an empty snapshot. */
  getKeyBindings?: () => JetKeyBinding[]
  keymapBindings: JetKeyBinding[]
  keymapContext: KeymapContext
  workspace: WorkspaceService
  getFocusedPanel: () => PanelId | null
  getEditorPanel: () => PanelId | null
  executeCommand: (name: string) => Promise<void>
  runKeyBinding: (binding: JetKeyBinding) => void
  setPendingChordPrefix: (prefix: string | null) => void
}

export function useGlobalKeymap(refs: GlobalKeymapRefs): void {
  const bindingsRef = useLatest(refs.keymapBindings)
  const getBindingsRef = useLatest(refs.getKeyBindings)
  const contextRef = useLatest(refs.keymapContext)
  const workspaceRef = useLatest(refs.workspace)
  const getFocusedPanelRef = useLatest(refs.getFocusedPanel)
  const getEditorPanelRef = useLatest(refs.getEditorPanel)
  const executeCommandRef = useLatest(refs.executeCommand)
  const runKeyBindingRef = useLatest(refs.runKeyBinding)
  const setPendingChordPrefixRef = useLatest(refs.setPendingChordPrefix)

  useEffect(() => {
    let lastCloseAt = 0
    const chordState = createChordState()
    let chordTimeout: number | null = null

    const clearPendingChord = () => {
      if (chordTimeout != null) window.clearTimeout(chordTimeout)
      chordTimeout = null
      setPendingChordPrefixRef.current(null)
    }

    const closeActiveTab = () => {
      const ctx = contextRef.current
      if (!workspaceRef.current.manager.hasFolders() || anyOverlayOpen(ctx)) return
      const now = Date.now()
      if (now - lastCloseAt < 100) return
      lastCloseAt = now
      void executeCommandRef.current("layout.closeTab")
    }

    const dispatchKeyBinding = (e: KeyboardEvent, opts?: { allowEditor?: boolean }): boolean => {
      const allowEditor = opts?.allowEditor ?? false
      const ctx = contextRef.current
      const bindings = getBindingsRef.current?.() ?? bindingsRef.current
      const hadPendingChord = chordState.prefix != null
      const result = resolveKeydownBinding(e, bindings, ctx, chordState)
      if (result === "chord-started") {
        // stopPropagation matters as much as preventDefault here: without it a
        // prefix like Ctrl-a still reaches the terminal and moves the shell cursor.
        e.preventDefault()
        e.stopPropagation()
        setPendingChordPrefixRef.current(chordState.prefix)
        if (chordTimeout != null) window.clearTimeout(chordTimeout)
        chordTimeout = window.setTimeout(clearPendingChord, CHORD_TIMEOUT_MS)
        return true
      }
      if (hadPendingChord && chordState.prefix == null) clearPendingChord()
      if (result && isChordBinding(result.key)) {
        e.preventDefault()
        e.stopPropagation()
        runKeyBindingRef.current(result)
        return true
      }
      if (result && !isEditorKeyBinding(result, ctx)) {
        e.preventDefault()
        e.stopPropagation()
        runKeyBindingRef.current(result)
        return true
      }
      if (allowEditor && result && isEditorKeyBinding(result, ctx)) {
        return false
      }
      if (allowEditor && result) {
        e.preventDefault()
        runKeyBindingRef.current(result)
        return true
      }
      return false
    }

    const onKey = (e: KeyboardEvent) => {
      const ctx = contextRef.current
      if (anyOverlayOpen(ctx)) return
      const target = e.target
      // Radix portal content owns Escape and menu navigation. Let it receive
      // those keys before the shell-level Escape → Home binding.
      if (target instanceof Element && target.closest('[data-slot="context-menu-content"]')) return
      const inTerminal =
        target instanceof HTMLElement &&
        target.closest("[data-yaade-terminal-input], [data-yaade-terminal-canvas]") != null
      // Monaco find/replace inputs stay focused after the widget hides; still
      // allow shell chords (Mod-Shift-f → editor find, etc.) to run.
      const inMonacoChrome =
        target instanceof HTMLElement &&
        target.closest(".monaco-editor, .find-widget, .replace-widget") != null
      if (
        !inMonacoChrome &&
        (target instanceof HTMLInputElement ||
          (target instanceof HTMLTextAreaElement && !inTerminal))
      ) {
        const bindings = getBindingsRef.current?.() ?? bindingsRef.current
        const startsShellChord = bindings.some(binding => {
          if (!isChordBinding(binding.key)) return false
          const prefix = parseBindingKey(binding.key)[0]
          return prefix ? keyEventMatchesBindingPart(e, prefix) : false
        })
        if (chordState.prefix != null || startsShellChord) {
          dispatchKeyBinding(e)
        }
        return
      }

      if (ctx.terminalFocus || inTerminal) {
        // Hard-wire the palette so it never depends on the registerUser →
        // revision → snapshot pipeline (repeated empty-map races). Everything
        // else reaches the terminal through the prefix key, which the browser
        // has no claim on.
        if (
          keyEventMatchesBinding(e, "Mod-Shift-p") ||
          keyEventMatchesBinding(e, "Cmd-Shift-p")
        ) {
          e.preventDefault()
          e.stopPropagation()
          void executeCommandRef.current("ui.showCommandPalette")
          return
        }
        if (dispatchKeyBinding(e)) return
        if (ctx.terminalFocus && !inTerminal) {
          const panel = getFocusedPanelRef.current()
          const selector = panel
            ? `[data-yaade-panel-leaf="${panel.id}"] [data-yaade-tab-slot][data-yaade-tab-active] [data-yaade-terminal-panel] [data-yaade-terminal-input], [data-yaade-mux-terminal-host][data-focused] [data-yaade-terminal-panel] [data-yaade-terminal-input]`
            : "[data-yaade-tab-slot][data-yaade-tab-active] [data-yaade-terminal-panel] [data-yaade-terminal-input], [data-yaade-mux-terminal-host][data-focused] [data-yaade-terminal-panel] [data-yaade-terminal-input]"
          const textarea = document.querySelector<HTMLTextAreaElement>(selector)
          if (textarea && document.activeElement !== textarea) textarea.focus()
        }
        return
      }

      dispatchKeyBinding(e, { allowEditor: true })
    }

    const onNativeCloseTab = () => closeActiveTab()

    window.addEventListener("keydown", onKey, true)
    window.addEventListener("jet-close-tab", onNativeCloseTab)
    return () => {
      window.removeEventListener("keydown", onKey, true)
      window.removeEventListener("jet-close-tab", onNativeCloseTab)
      if (chordTimeout != null) window.clearTimeout(chordTimeout)
    }
  }, [
    bindingsRef,
    getBindingsRef,
    contextRef,
    workspaceRef,
    getFocusedPanelRef,
    getEditorPanelRef,
    executeCommandRef,
    runKeyBindingRef,
    setPendingChordPrefixRef,
  ])
}
