import type { CheckoutTarget, ProjectTarget, ToolUse } from "@yaade/rpc"
import type { YaadeTheme } from "@yaade/shared"
import type { ReactNode } from "react"

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

/** Browser editing is temporarily disabled while file navigation uses Neovim. */
export function EditorToolView(props: EditorToolViewProps) {
  return (
    <div
      className="flex min-h-0 flex-1 flex-col"
      data-yaade-editor-disabled=""
    >
      {props.toolbar}
      <div className="grid min-h-0 flex-1 place-items-center p-8 text-center">
        <div className="max-w-sm">
          <p className="text-sm font-medium text-foreground">
            The in-browser editor is temporarily disabled.
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Search results open in Neovim inside a terminal pane.
          </p>
        </div>
      </div>
    </div>
  )
}

export default EditorToolView
