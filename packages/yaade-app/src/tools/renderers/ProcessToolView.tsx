import { lazy, Suspense } from "react";
import { LoaderCircle } from "lucide-react";
import type { CheckoutTarget, ProjectTarget, ToolUse } from "@yaade/rpc";
import type { YaadeTheme } from "@yaade/shared";
import { pathToFileUri } from "@yaade/shared";
const TerminalPanel = lazy(() =>
  import("@yaade/ui/terminal").then((module) => ({
    default: module.TerminalPanel,
  })),
);

export type ProcessToolViewProps = {
  readonly use: ToolUse;
  readonly theme: YaadeTheme;
  readonly projects: readonly ProjectTarget[];
  readonly onContextChange: (
    project: ProjectTarget,
    checkout: CheckoutTarget,
  ) => Promise<void>;
  readonly visible?: boolean;
  readonly focused?: boolean;
  readonly onTitleChange?: (title: string) => void;
};

export function ProcessToolView({
  use,
  theme,
  onTitleChange,
  visible = true,
  focused = visible,
}: ProcessToolViewProps) {
  if (use.output.kind !== "process") return null;
  const status =
    use.output.processState === "disconnected"
      ? "failed"
      : use.output.processState;
  const waitingForPty = !use.output.ptyId && status === "starting";
  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      {waitingForPty ? (
        <div
          className="grid flex-1 place-items-center text-sm text-muted-foreground"
          data-yaade-terminal-starting=""
          role="status"
        >
          <LoaderCircle className="mr-2 size-4 animate-spin" />
          Starting terminal…
        </div>
      ) : (
        <Suspense
          fallback={
            <div className="grid flex-1 place-items-center text-sm text-muted-foreground">
              <LoaderCircle className="mr-2 size-4 animate-spin" />
              Opening terminal…
            </div>
          }
        >
          <TerminalPanel
            cwdRootUri={pathToFileUri(use.context.checkoutPath)}
            theme={theme}
            tabId={use.id}
            focused={focused}
            isActive={visible}
            existingPtyId={use.output.ptyId}
            sessionGeneration={use.output.generation}
            status={status}
            attachOnly
            visible={visible}
            onTitleChange={(_id, title) => onTitleChange?.(title)}
          />
        </Suspense>
      )}
    </div>
  );
}

export function TerminalToolView(props: ProcessToolViewProps) {
  return <ProcessToolView {...props} />;
}
