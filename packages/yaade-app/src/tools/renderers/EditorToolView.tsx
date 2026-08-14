import type { CheckoutTarget, ProjectTarget, ToolUse } from "@yaade/rpc"
import type { YaadeTheme } from "@yaade/shared"
import type { ReactNode } from "react"
import { ToolEditorSurface } from "./ToolEditorSurface.js"

export type EditorToolViewProps = {
  readonly use: ToolUse
  readonly theme: YaadeTheme
  readonly fontSize: number
  readonly toolbar: ReactNode
  readonly projects: readonly ProjectTarget[]
  readonly onContextChange: (
    project: ProjectTarget,
    checkout: CheckoutTarget,
  ) => Promise<void>
  readonly visible?: boolean
}

/** The workspace editor tool is the canonical shared Monaco/LSP surface. */
export function EditorToolView(props: EditorToolViewProps) {
  return (
    <ToolEditorSurface
      key={`${props.use.id}:${props.use.context.checkoutPath}`}
      use={props.use}
      checkoutPath={props.use.context.checkoutPath}
      theme={props.theme}
      fontSize={props.fontSize}
      toolbar={props.toolbar}
      visible={props.visible}
    />
  )
}

export default EditorToolView
