import type { ReactNode } from "react";
import type { CheckoutTarget, ProjectTarget, ToolUse } from "@yaade/rpc";
import { pathToFileUri, type YaadeTheme } from "@yaade/shared";
import { GitWorkspace } from "@yaade/ui/git";

export type GitToolViewProps = {
  readonly use: ToolUse;
  readonly theme: YaadeTheme;
  readonly toolbar: ReactNode;
  readonly projects: readonly ProjectTarget[];
  readonly onContextChange: (
    project: ProjectTarget,
    checkout: CheckoutTarget,
  ) => Promise<void>;
  readonly visible?: boolean;
};

/** The session-shell Git tool starts on the repository history surface. */
export function GitToolView(props: GitToolViewProps) {
  if (props.use.output.kind !== "git") return null;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {props.toolbar}
      <div className="min-h-0 flex-1">
        <GitWorkspace
          rootUri={pathToFileUri(props.use.context.checkoutPath)}
          theme={props.theme}
          initialView="history"
          unifiedHistory
          active={props.visible}
          onOpenFile={() => undefined}
        />
      </div>
    </div>
  );
}

export default GitToolView;
