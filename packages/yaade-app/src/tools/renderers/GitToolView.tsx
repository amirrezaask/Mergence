import type { CheckoutTarget, ProjectTarget, ToolUse } from "@yaade/rpc";
import { pathToFileUri, type YaadeTheme } from "@yaade/shared";
import { GitWorkspace } from "@yaade/ui/git";
import { useIsMobile } from "@yaade/ui/session";

export type GitToolViewProps = {
  readonly use: ToolUse;
  readonly theme: YaadeTheme;
  readonly projects: readonly ProjectTarget[];
  readonly onContextChange: (
    project: ProjectTarget,
    checkout: CheckoutTarget,
  ) => Promise<void>;
  readonly visible?: boolean;
  readonly focused?: boolean;
};

/** The session-shell Git tool starts on the repository history surface. */
export function GitToolView(props: GitToolViewProps) {
  const mobile = useIsMobile();
  if (props.use.output.kind !== "git") return null;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1">
        <GitWorkspace
          rootUri={pathToFileUri(props.use.context.checkoutPath)}
          theme={props.theme}
          initialView="history"
          unifiedHistory
          mobile={mobile}
          active={Boolean(props.focused) && props.visible !== false}
          onOpenFile={() => undefined}
        />
      </div>
    </div>
  );
}

export default GitToolView;
