import { lazy, Suspense, useCallback, useEffect, useRef } from "react";
import { LoaderCircle } from "lucide-react";
import type { CheckoutTarget, ProjectTarget, ToolUse } from "@yaade/rpc";
import type { YaadeTheme } from "@yaade/shared";
import { fileUriToPath, pathToFileUri } from "@yaade/shared";
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
  readonly onCwdChange?: (cwdPath: string) => void;
  readonly visible?: boolean;
  readonly focused?: boolean;
  readonly onTitleChange?: (title: string) => void;
};

export function ProcessToolView({
  use,
  theme,
  onCwdChange,
  onTitleChange,
  visible = true,
  focused = visible,
}: ProcessToolViewProps) {
  const ptyId = use.output.kind === "process" ? use.output.ptyId : undefined;
  const probeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const probeInFlightRef = useRef(false);
  const cwdProbeArmedRef = useRef(false);
  const handleInput = useCallback(
    (_tabId: string, data?: string) => {
      if (!visible || !data) return;
      if (data.includes("\r") || data.includes("\n")) {
        cwdProbeArmedRef.current = true;
      }
    },
    [visible],
  );
  const probeCwd = useCallback(() => {
    if (
      !ptyId ||
      !onCwdChange ||
      !cwdProbeArmedRef.current ||
      probeInFlightRef.current
    ) return;
    const getCwd = window.yaade?.terminal?.getCwd;
    if (!getCwd) return;
    probeInFlightRef.current = true;
    void getCwd(ptyId)
      .then((uri) => {
        if (!uri) return;
        try {
          onCwdChange(fileUriToPath(uri));
        } catch {
          // Ignore malformed terminal URIs; the next prompt boundary retries.
        }
      })
      .catch(() => undefined)
      .finally(() => {
        probeInFlightRef.current = false;
        cwdProbeArmedRef.current = false;
      });
  }, [onCwdChange, ptyId]);
  const scheduleCwdProbe = useCallback(() => {
    if (
      !visible ||
      !ptyId ||
      !onCwdChange ||
      !cwdProbeArmedRef.current
    ) return;
    if (probeTimerRef.current !== null) {
      clearTimeout(probeTimerRef.current);
    }
    probeTimerRef.current = setTimeout(() => {
      probeTimerRef.current = null;
      probeCwd();
    }, 120);
  }, [onCwdChange, ptyId, probeCwd, visible]);

  useEffect(() => {
    return () => {
      cwdProbeArmedRef.current = false;
      if (probeTimerRef.current !== null) {
        clearTimeout(probeTimerRef.current);
      }
    };
  }, [ptyId, visible]);

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
            onInput={handleInput}
            onTitleChange={(_id, title) => onTitleChange?.(title)}
            onOutput={scheduleCwdProbe}
          />
        </Suspense>
      )}
    </div>
  );
}
