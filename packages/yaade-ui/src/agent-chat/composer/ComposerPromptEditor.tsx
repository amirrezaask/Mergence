import {
  LexicalComposer,
  type InitialConfigType,
} from "@lexical/react/LexicalComposer"
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext"
import { ContentEditable } from "@lexical/react/LexicalContentEditable"
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary"
import { HistoryPlugin } from "@lexical/react/LexicalHistoryPlugin"
import { OnChangePlugin } from "@lexical/react/LexicalOnChangePlugin"
import { PlainTextPlugin } from "@lexical/react/LexicalPlainTextPlugin"
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  COMMAND_PRIORITY_HIGH,
  KEY_ENTER_COMMAND,
  type EditorState,
  type LexicalEditor,
} from "lexical"
import {
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  type Ref,
} from "react"
import { cn } from "./lib/cn.js"

export type ComposerPromptEditorHandle = {
  focus: () => void
  blur: () => void
  getEditor: () => LexicalEditor | null
}

export function ComposerPromptEditor(props: {
  editorRef?: Ref<ComposerPromptEditorHandle | null>
  value: string
  onChange: (value: string) => void
  onSubmit?: () => void
  placeholder?: string
  disabled?: boolean
  className?: string
}) {
  const initialConfig = useMemo<InitialConfigType>(
    () => ({
      namespace: "YaadeComposerPrompt",
      onError(error) {
        console.error(error)
      },
      editable: !props.disabled,
    }),
    // Recreate only when disabled flips so placeholder/editor stay stable while typing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [props.disabled],
  )

  return (
    <LexicalComposer initialConfig={initialConfig}>
      <div className={cn("relative min-h-[3.25rem]", props.className)} data-composer-prompt-editor="">
        <PlainTextPlugin
          contentEditable={
            <ContentEditable
              aria-label="Message agent"
              className={cn(
                "max-h-48 min-h-[3.25rem] w-full resize-none overflow-y-auto bg-transparent px-3 py-3 text-sm leading-relaxed outline-none sm:px-4",
                "whitespace-pre-wrap break-words",
                props.disabled && "opacity-60",
              )}
              data-chat-composer-input=""
            />
          }
          placeholder={
            <div className="pointer-events-none absolute inset-x-3 top-3 text-sm text-muted-foreground/70 sm:inset-x-4">
              {props.placeholder ?? "Ask anything…"}
            </div>
          }
          ErrorBoundary={LexicalErrorBoundary}
        />
        <HistoryPlugin />
        <OnChangePlugin
          onChange={(editorState: EditorState) => {
            editorState.read(() => {
              const text = $getRoot().getTextContent()
              if (text !== props.value) props.onChange(text)
            })
          }}
        />
        <SyncValuePlugin value={props.value} />
        <EnterSubmitPlugin onSubmit={props.onSubmit} disabled={props.disabled} />
        <HandlePlugin editorRef={props.editorRef} />
      </div>
    </LexicalComposer>
  )
}

function SyncValuePlugin({ value }: { value: string }) {
  const [editor] = useLexicalComposerContext()
  const lastValue = useRef(value)
  useEffect(() => {
    if (lastValue.current === value) return
    lastValue.current = value
    editor.update(() => {
      const root = $getRoot()
      const current = root.getTextContent()
      if (current === value) return
      root.clear()
      const paragraph = $createParagraphNode()
      if (value.length > 0) paragraph.append($createTextNode(value))
      root.append(paragraph)
    })
  }, [editor, value])
  return null
}

function EnterSubmitPlugin({
  onSubmit,
  disabled,
}: {
  onSubmit?: () => void
  disabled?: boolean
}) {
  const [editor] = useLexicalComposerContext()
  useEffect(() => {
    return editor.registerCommand(
      KEY_ENTER_COMMAND,
      event => {
        if (!onSubmit || disabled || !event || event.shiftKey) return false
        event.preventDefault()
        onSubmit()
        return true
      },
      COMMAND_PRIORITY_HIGH,
    )
  }, [disabled, editor, onSubmit])
  return null
}

function HandlePlugin({
  editorRef,
}: {
  editorRef?: Ref<ComposerPromptEditorHandle | null>
}) {
  const [editor] = useLexicalComposerContext()
  useImperativeHandle(
    editorRef,
    () => ({
      focus: () => editor.focus(),
      blur: () => editor.blur(),
      getEditor: () => editor,
    }),
    [editor],
  )
  useEffect(() => {
    // Keep selection helpers available for future mention plugins.
    editor.getEditorState().read(() => {
      const selection = $getSelection()
      void $isRangeSelection(selection)
    })
  }, [editor])
  return null
}
