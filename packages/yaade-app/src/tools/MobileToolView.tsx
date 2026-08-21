import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react"
import { AnimatePresence } from "motion/react"
import { div as MotionDiv } from "motion/react-m"
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ChevronRight,
  Clipboard,
  Plus,
  Settings2,
  Terminal as TerminalIcon,
  X,
  type LucideIcon,
} from "lucide-react"
import type {
  AppSession,
  CheckoutTarget,
  ProjectTarget,
  SessionId,
  ToolKind,
  ToolUse,
  ToolUseId,
} from "@yaade/rpc"
import {
  pasteIntoRegisteredTerminal,
  sendTerminalVirtualKey,
  setTerminalVirtualModifier,
} from "@yaade/ui/terminal-registry"
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Button,
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@yaade/ui/primitives"
import { GlassSurface, cn, yaadeMotion } from "@yaade/ui/session"
import { ToolContextControls } from "./ToolContextControls.js"
import {
  toolUseContextCaption,
  toolUseWorkTitle,
  type RuntimeToolTitle,
} from "./tool-title.js"

const MAX_RETAINED_MOBILE_TERMINALS = 6
const MOBILE_TOOL_KINDS = ["terminal"] as const

type MobileToolKind = (typeof MOBILE_TOOL_KINDS)[number]

function isMobileToolKind(kind: ToolKind): kind is MobileToolKind {
  return kind === "terminal"
}

function statusClass(use: ToolUse): string {
  switch (use.status) {
    case "waiting":
      return "bg-warning"
    case "created":
    case "starting":
      return "bg-info"
    case "failed":
    case "cancelled":
      return "bg-destructive"
    case "disconnected":
      return "bg-muted-foreground"
    case "running":
    case "succeeded":
      return "bg-success"
  }
}

function statusLabel(use: ToolUse): string {
  if (use.output.kind === "process") {
    switch (use.output.activityState) {
      case "waiting_for_permission":
        return "Needs approval"
      case "waiting_for_user":
        return "Waiting for you"
      case "running_tool":
      case "working":
        return "Working"
      case "starting":
        return "Starting"
      case "failed":
        return "Failed"
      case "idle":
        break
    }
  }

  switch (use.status) {
    case "created":
      return "Created"
    case "starting":
      return "Starting"
    case "running":
      return "Running"
    case "waiting":
      return "Waiting"
    case "succeeded":
      return "Finished"
    case "failed":
      return "Failed"
    case "cancelled":
      return "Cancelled"
    case "disconnected":
      return "Disconnected"
  }
}

const TOOL_KIND_META = {
  terminal: { label: "Terminal", Icon: TerminalIcon },
} satisfies Record<
  MobileToolKind,
  { readonly label: string; readonly Icon: LucideIcon }
>

function toolCountLabel(count: number): string {
  return `${count} ${count === 1 ? "tool" : "tools"}`
}

export type MobileToolViewProps = {
  readonly sessions: readonly AppSession[]
  readonly usesById: ReadonlyMap<ToolUseId, ToolUse>
  readonly useIdsBySession: ReadonlyMap<SessionId, readonly ToolUseId[]>
  readonly routeToolUseId?: ToolUseId
  readonly runtimeTitles: ReadonlyMap<ToolUseId, RuntimeToolTitle>
  readonly projects: readonly ProjectTarget[]
  readonly onSelect: (use: ToolUse) => void
  readonly onShowToolList: (use: ToolUse) => void
  readonly onCreateTool: (
    sessionId: SessionId,
    kind: MobileToolKind,
  ) => Promise<ToolUse | undefined>
  readonly onCreateSession: () => Promise<void>
  readonly onCloseSession: (sessionId: SessionId) => void
  readonly actionError?: string
  readonly onCloseTool: (use: ToolUse) => Promise<void>
  readonly onAddProject: (rootPath: string) => Promise<ProjectTarget | undefined>
  readonly onContextChange: (
    use: ToolUse,
    project: ProjectTarget,
    checkout: CheckoutTarget,
  ) => Promise<void>
  /** Render the selected or retained tool; the argument order matches the desktop renderer. */
  readonly renderTool: (
    use: ToolUse,
    focused: boolean,
    visible: boolean,
  ) => ReactNode
}

type MobileToolGroup = {
  readonly session: AppSession
  readonly uses: readonly ToolUse[]
}

export function MobileToolView(props: MobileToolViewProps) {
  const [selectedToolUseId, setSelectedToolUseId] = useState<ToolUseId | null>(
    props.routeToolUseId ?? null,
  )
  const [creating, setCreating] = useState<string | null>(null)
  const [contextUseId, setContextUseId] = useState<ToolUseId | null>(null)
  const [sessionActionsId, setSessionActionsId] = useState<SessionId | null>(null)
  const [retainedTerminalIds, setRetainedTerminalIds] = useState<
    readonly ToolUseId[]
  >([])

  const groups = useMemo<readonly MobileToolGroup[]>(
    () =>
      props.sessions.map(session => ({
        session,
        uses: (props.useIdsBySession.get(session.id) ?? [])
          .map(id => props.usesById.get(id))
          .filter(
            (use): use is ToolUse =>
              use != null && isMobileToolKind(use.kind),
          ),
      })),
    [props.sessions, props.useIdsBySession, props.usesById],
  )

  const visibleUses = useMemo(
    () => new Map(groups.flatMap(group => group.uses.map(use => [use.id, use]))),
    [groups],
  )

  useEffect(() => {
    const routed = props.routeToolUseId
      ? visibleUses.get(props.routeToolUseId)
      : undefined
    setSelectedToolUseId(routed ? routed.id : null)
  }, [props.routeToolUseId, visibleUses])

  const selectedUse = selectedToolUseId
    ? visibleUses.get(selectedToolUseId)
    : undefined

  useEffect(() => {
    if (selectedUse?.kind !== "terminal") return
    setRetainedTerminalIds(previous => [
      selectedUse.id,
      ...previous.filter(id => id !== selectedUse.id),
    ].slice(0, MAX_RETAINED_MOBILE_TERMINALS))
  }, [selectedUse?.id, selectedUse?.kind])

  const mountedTerminalIds = useMemo(() => {
    const ids = selectedUse?.kind === "terminal"
      ? [selectedUse.id, ...retainedTerminalIds]
      : [...retainedTerminalIds]
    return [...new Set(ids)].filter(id => {
      const use = visibleUses.get(id)
      return use?.kind === "terminal"
    }).slice(0, MAX_RETAINED_MOBILE_TERMINALS)
  }, [retainedTerminalIds, selectedUse, visibleUses])

  const openTool = (use: ToolUse) => {
    setSelectedToolUseId(use.id)
    props.onSelect(use)
  }

  const createTool = async (sessionId: SessionId, kind: MobileToolKind) => {
    const key = `${sessionId}:${kind}`
    if (creating) return
    setCreating(key)
    try {
      const created = await props.onCreateTool(sessionId, kind)
      if (created) openTool(created)
    } finally {
      setCreating(null)
    }
  }

  const contextUse = contextUseId ? visibleUses.get(contextUseId) : undefined
  const sessionActions = sessionActionsId
    ? props.sessions.find(session => session.id === sessionActionsId)
    : undefined
  const selectedTerminal = selectedUse?.kind === "terminal" ? selectedUse : undefined

  return (
    <div
      className="relative flex h-full min-h-0 flex-col overflow-hidden"
      data-yaade-mobile-shell=""
      data-yaade-mobile-view={selectedUse ? "tool" : "tools"}
    >
      <AnimatePresence initial={false} mode="wait">
        {!selectedUse ? (
          <MobileToolList
            key="tool-list"
            groups={groups}
            runtimeTitles={props.runtimeTitles}
            creating={creating}
            actionError={props.actionError}
            onCreateTool={(sessionId, kind) => void createTool(sessionId, kind)}
            onCreateSession={() => void props.onCreateSession()}
            onOpenSessionActions={session => setSessionActionsId(session.id)}
            onSelect={openTool}
          />
        ) : (
          <MobileToolDetail
            key={`tool:${selectedUse.id}`}
            use={selectedUse}
            runtimeTitle={props.runtimeTitles.get(selectedUse.id)}
            onBack={() => {
              setSelectedToolUseId(null)
              props.onShowToolList(selectedUse)
            }}
            onOpenContext={() => setContextUseId(selectedUse.id)}
            onClose={async () => {
              await props.onCloseTool(selectedUse)
              setSelectedToolUseId(null)
            }}
          >
            {props.renderTool(selectedUse, true, true)}
          </MobileToolDetail>
        )}
      </AnimatePresence>

      <div
        className={cn(
          "absolute inset-x-0 top-[var(--yaade-touch-target)] bottom-[calc(var(--yaade-touch-target)+env(safe-area-inset-bottom))] min-h-0 overflow-hidden",
          selectedTerminal
            ? "visible"
            : "pointer-events-none invisible",
        )}
        aria-hidden={selectedTerminal ? undefined : true}
        data-yaade-mobile-terminal-deck=""
      >
        {mountedTerminalIds.map(id => {
          const use = visibleUses.get(id)
          if (!use || use.kind !== "terminal") return null
          const active = use.id === selectedTerminal?.id
          return (
            <div
              key={use.id}
              className={cn(
                "absolute inset-0 min-h-0 overflow-hidden",
                active ? "visible" : "pointer-events-none invisible",
              )}
              aria-hidden={active ? undefined : true}
              data-yaade-mobile-retained-terminal={use.id}
              data-active={active ? "true" : undefined}
            >
              {props.renderTool(use, active, active)}
            </div>
          )
        })}
      </div>

      {selectedTerminal ? <MobileTerminalAccessory use={selectedTerminal} /> : null}

      <Drawer
        open={contextUse != null}
        onOpenChange={open => {
          if (!open) setContextUseId(null)
        }}
      >
        <DrawerContent data-yaade-mobile-tool-context="">
          <DrawerHeader className="text-left">
            <DrawerTitle>Tool workspace</DrawerTitle>
            <DrawerDescription>
              Changing the project or worktree restarts this tool.
            </DrawerDescription>
          </DrawerHeader>
          {contextUse ? (
            <ToolContextControls
              use={contextUse}
              projects={props.projects}
              onAddProject={props.onAddProject}
              presentation="popover"
              onChange={(project, checkout) =>
                props.onContextChange(contextUse, project, checkout)
              }
            />
          ) : null}
        </DrawerContent>
      </Drawer>

      <Drawer
        open={sessionActions != null}
        onOpenChange={open => {
          if (!open) setSessionActionsId(null)
        }}
      >
        <DrawerContent data-yaade-mobile-session-actions="">
          <DrawerHeader className="text-left">
            <DrawerTitle>{sessionActions?.title ?? "Session"}</DrawerTitle>
            <DrawerDescription>Session actions</DrawerDescription>
          </DrawerHeader>
          <div className="flex flex-col gap-2 px-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
            <Button
              type="button"
              variant="destructive"
              className="min-h-11 w-full"
              onClick={() => {
                if (!sessionActions) return
                setSessionActionsId(null)
                props.onCloseSession(sessionActions.id)
              }}
            >
              <X data-icon="inline-start" />
              Close session
            </Button>
            <DrawerClose asChild>
              <Button type="button" variant="outline" className="min-h-11 w-full">
                Cancel
              </Button>
            </DrawerClose>
          </div>
        </DrawerContent>
      </Drawer>
    </div>
  )
}

function MobileToolList(props: {
  readonly groups: readonly MobileToolGroup[]
  readonly runtimeTitles: ReadonlyMap<ToolUseId, RuntimeToolTitle>
  readonly creating: string | null
  readonly actionError?: string
  readonly onCreateTool: (sessionId: SessionId, kind: MobileToolKind) => void
  readonly onCreateSession: () => void
  readonly onOpenSessionActions: (session: AppSession) => void
  readonly onSelect: (use: ToolUse) => void
}) {
  return (
    <MotionDiv
      initial={{ opacity: 0, transform: "translateX(-10px)" }}
      animate={{ opacity: 1, transform: "translateX(0px)" }}
      exit={{ opacity: 0, transform: "translateX(-10px)" }}
      transition={yaadeMotion.layoutTransition}
      className="flex min-h-0 flex-1 flex-col"
      data-yaade-mobile-tool-list=""
    >
      {props.actionError ? (
        <div className="shrink-0 px-3 pt-3">
          <Alert variant="destructive">
            <AlertTitle>Action failed</AlertTitle>
            <AlertDescription>{props.actionError}</AlertDescription>
          </Alert>
        </div>
      ) : null}

      <main className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-3 touch-pan-y">
        <div className="flex flex-col gap-4" role="list" aria-label="Tools by session">
          {props.groups.map(group => (
            <MobileSessionGroup
              key={group.session.id}
              group={group}
              runtimeTitles={props.runtimeTitles}
              creating={props.creating}
              onCreateTool={props.onCreateTool}
              onOpenActions={() => props.onOpenSessionActions(group.session)}
              onSelect={props.onSelect}
            />
          ))}
          <Button
            type="button"
            variant="outline"
            className="min-h-11 w-full border-dashed"
            onClick={props.onCreateSession}
            data-yaade-mobile-new-session=""
          >
            <Plus data-icon="inline-start" />
            New session
          </Button>
        </div>
      </main>
    </MotionDiv>
  )
}

function MobileSessionGroup(props: {
  readonly group: MobileToolGroup
  readonly runtimeTitles: ReadonlyMap<ToolUseId, RuntimeToolTitle>
  readonly creating: string | null
  readonly onCreateTool: (sessionId: SessionId, kind: MobileToolKind) => void
  readonly onOpenActions: () => void
  readonly onSelect: (use: ToolUse) => void
}) {
  const holdTimer = useRef<number | null>(null)
  const holdStart = useRef<{ x: number; y: number } | null>(null)

  const clearHold = () => {
    if (holdTimer.current !== null) window.clearTimeout(holdTimer.current)
    holdTimer.current = null
    holdStart.current = null
  }
  const onPointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.pointerType !== "touch") return
    if (event.target instanceof HTMLElement && event.target.closest("button")) return
    holdStart.current = { x: event.clientX, y: event.clientY }
    holdTimer.current = window.setTimeout(() => {
      holdTimer.current = null
      navigator.vibrate?.(8)
      props.onOpenActions()
    }, 500)
  }
  const onPointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    const start = holdStart.current
    if (!start || Math.hypot(event.clientX - start.x, event.clientY - start.y) < 8) return
    clearHold()
  }

  return (
    <section
      className="flex flex-col gap-1.5"
      role="listitem"
      data-yaade-mobile-session-group={props.group.session.id}
      aria-labelledby={`mobile-session-${props.group.session.id}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={clearHold}
      onPointerCancel={clearHold}
      onContextMenu={event => {
        event.preventDefault()
        props.onOpenActions()
      }}
    >
      <div className="flex min-h-11 items-center gap-2 px-1">
        <div className="min-w-0 flex-1">
          <h2
            id={`mobile-session-${props.group.session.id}`}
            className="truncate text-xs font-semibold"
          >
            {props.group.session.title}
          </h2>
          <p className="font-mono text-3xs tabular-nums text-muted-foreground">
            {toolCountLabel(props.group.uses.length)}
          </p>
        </div>
        <MobileNewToolMenu
          sessionId={props.group.session.id}
          creating={props.creating}
          onCreateTool={props.onCreateTool}
        />
      </div>
      <div className="flex flex-col gap-1.5" role="group">
        {props.group.uses.length > 0 ? (
          <AnimatePresence initial={false} mode="popLayout">
            {props.group.uses.map(use => (
              <MobileToolRow
                key={use.id}
                use={use}
                runtimeTitle={props.runtimeTitles.get(use.id)}
                onSelect={() => props.onSelect(use)}
              />
            ))}
          </AnimatePresence>
        ) : (
          <div
            className="flex min-h-12 items-center justify-between gap-2 rounded-[var(--yaade-control-radius)] border border-dashed border-border/70 px-3"
            data-yaade-mobile-session-empty=""
          >
            <span className="text-xs text-muted-foreground">No mobile tools</span>
            <MobileNewToolMenu
              sessionId={props.group.session.id}
              creating={props.creating}
              onCreateTool={props.onCreateTool}
              labelled
            />
          </div>
        )}
      </div>
    </section>
  )
}

function MobileNewToolMenu(props: {
  readonly sessionId: SessionId
  readonly creating: string | null
  readonly onCreateTool: (sessionId: SessionId, kind: MobileToolKind) => void
  readonly labelled?: boolean
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          size={props.labelled ? "sm" : "icon-lg"}
          variant="ghost"
          aria-label={`New tool in session`}
          disabled={props.creating != null}
          data-yaade-mobile-new-tool={props.sessionId}
        >
          <Plus data-icon={props.labelled ? "inline-start" : undefined} />
          {props.labelled ? "New tool" : null}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        <DropdownMenuLabel>New tool</DropdownMenuLabel>
        <DropdownMenuGroup>
          {MOBILE_TOOL_KINDS.map(kind => {
            const { Icon, label } = TOOL_KIND_META[kind]
            return (
              <DropdownMenuItem
                key={kind}
                className="min-h-11"
                data-yaade-mobile-new-tool-kind={kind}
                onSelect={() => props.onCreateTool(props.sessionId, kind)}
              >
                <Icon />
                {label}
              </DropdownMenuItem>
            )
          })}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function MobileToolRow(props: {
  readonly use: ToolUse
  readonly runtimeTitle?: RuntimeToolTitle
  readonly onSelect: () => void
}) {
  if (!isMobileToolKind(props.use.kind)) return null
  const { Icon, label } = TOOL_KIND_META[props.use.kind]
  const title = toolUseWorkTitle(props.use, props.runtimeTitle)
  const context = toolUseContextCaption(props.use)
  const status = statusLabel(props.use)

  return (
    <MotionDiv
      layout
      initial={{ opacity: 0, transform: "translateY(5px)" }}
      animate={{ opacity: 1, transform: "translateY(0px)" }}
      exit={{ opacity: 0, transform: "translateY(-5px)" }}
      transition={yaadeMotion.layoutTransition}
    >
      <button
        type="button"
        className="group flex min-h-14 w-full items-center gap-2.5 rounded-[var(--yaade-control-radius)] border border-border/70 bg-card/55 px-2.5 py-2 text-left outline-none transition-[background-color,border-color,box-shadow,transform] duration-[var(--yaade-motion-hot)] active:scale-[var(--yaade-press-scale)] focus-visible:ring-2 focus-visible:ring-ring/60"
        aria-label={`Open ${label}: ${title}`}
        data-yaade-mobile-tool={props.use.id}
        data-tool-kind={props.use.kind}
        onClick={props.onSelect}
      >
        <span
          className="grid size-9 shrink-0 place-items-center rounded-[var(--yaade-control-radius)] border border-border/70 bg-secondary/80 text-muted-foreground"
          aria-hidden
        >
          <Icon className="size-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{title}</span>
          <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-2xs text-muted-foreground">
            <span className="shrink-0">{label}</span>
            {context ? (
              <>
                <span aria-hidden>·</span>
                <span className="min-w-0 truncate font-mono">{context}</span>
              </>
            ) : null}
          </span>
        </span>
        <span
          className={cn("size-2 shrink-0 rounded-full", statusClass(props.use))}
          aria-label={status}
          title={status}
        />
        <ChevronRight className="size-4 shrink-0 text-muted-foreground/60" />
      </button>
    </MotionDiv>
  )
}

function MobileToolDetail(props: {
  readonly use: ToolUse
  readonly runtimeTitle?: RuntimeToolTitle
  readonly onBack: () => void
  readonly onOpenContext: () => void
  readonly onClose: () => Promise<void>
  readonly children: ReactNode
}) {
  const title = toolUseWorkTitle(props.use, props.runtimeTitle)
  const status = statusLabel(props.use)

  return (
    <MotionDiv
      initial={{ opacity: 0, transform: "translateX(12px)" }}
      animate={{ opacity: 1, transform: "translateX(0px)" }}
      exit={{ opacity: 0, transform: "translateX(12px)" }}
      transition={yaadeMotion.layoutTransition}
      className="flex min-h-0 flex-1 flex-col"
      data-yaade-mobile-tool-detail=""
    >
      <GlassSurface material="shell" asChild>
        <header className="flex h-[var(--yaade-touch-target)] shrink-0 items-center gap-1 border-b border-border/70 px-1">
          <Button
            type="button"
            size="icon-lg"
            variant="ghost"
            aria-label="Back to tools"
            onClick={props.onBack}
            data-yaade-mobile-tool-back=""
          >
            <ArrowLeft />
          </Button>
          <p className="min-w-0 flex-1 truncate text-sm font-medium">{title}</p>
          <span
            className={cn("size-2 shrink-0 rounded-full", statusClass(props.use))}
            aria-label={status}
            title={status}
          />
          <Button
            type="button"
            size="icon-lg"
            variant="ghost"
            aria-label="Change tool project or worktree"
            onClick={props.onOpenContext}
            data-yaade-mobile-tool-context-trigger=""
          >
            <Settings2 />
          </Button>
          <Button
            type="button"
            size="icon-lg"
            variant="ghost"
            aria-label="Close tool"
            onClick={() => void props.onClose()}
            data-yaade-mobile-tool-close=""
          >
            <X />
          </Button>
        </header>
      </GlassSurface>
      <main
        className="min-h-0 flex-1 overflow-hidden"
        data-yaade-mobile-tool-surface=""
      >
        {props.children}
      </main>
    </MotionDiv>
  )
}

function MobileTerminalAccessory(props: { readonly use: ToolUse }) {
  const [ctrl, setCtrl] = useState(false)
  const [alt, setAlt] = useState(false)

  useEffect(() => {
    setCtrl(false)
    setAlt(false)
    setTerminalVirtualModifier("ctrl", false, props.use.id)
    setTerminalVirtualModifier("alt", false, props.use.id)
  }, [props.use.id])

  useEffect(() => {
    if (!ctrl && !alt) return
    const consume = (event: Event) => {
      if (!(event.target instanceof HTMLElement)) return
      if (!event.target.matches("[data-ghostty-terminal-input]")) return
      queueMicrotask(() => {
        setCtrl(false)
        setAlt(false)
        setTerminalVirtualModifier("ctrl", false, props.use.id)
        setTerminalVirtualModifier("alt", false, props.use.id)
      })
    }
    window.addEventListener("keydown", consume, true)
    window.addEventListener("input", consume, true)
    return () => {
      window.removeEventListener("keydown", consume, true)
      window.removeEventListener("input", consume, true)
    }
  }, [alt, ctrl, props.use.id])

  const toggleModifier = (modifier: "ctrl" | "alt") => {
    if (modifier === "ctrl") {
      const next = !ctrl
      setCtrl(next)
      setTerminalVirtualModifier("ctrl", next, props.use.id)
      return
    }
    const next = !alt
    setAlt(next)
    setTerminalVirtualModifier("alt", next, props.use.id)
  }
  const sendKey = (key: string, code: string) => {
    sendTerminalVirtualKey(key, code, props.use.id)
    setCtrl(false)
    setAlt(false)
  }

  return (
    <GlassSurface material="shell" asChild>
      <nav
        className="absolute inset-x-0 bottom-0 z-10 flex h-[calc(var(--yaade-touch-target)+env(safe-area-inset-bottom))] items-start gap-1 overflow-x-auto border-t border-border/70 px-1 pb-[env(safe-area-inset-bottom)]"
        aria-label="Terminal keys"
        data-yaade-mobile-terminal-keys=""
      >
        <Button type="button" size="sm" variant="ghost" className="min-w-11" onClick={() => sendKey("Escape", "Escape")}>
          Esc
        </Button>
        <Button type="button" size="sm" variant="ghost" className="min-w-11" onClick={() => sendKey("Tab", "Tab")}>
          Tab
        </Button>
        <Button
          type="button"
          size="sm"
          variant={ctrl ? "secondary" : "ghost"}
          className="min-w-11"
          aria-pressed={ctrl}
          onClick={() => toggleModifier("ctrl")}
        >
          Ctrl
        </Button>
        <Button
          type="button"
          size="sm"
          variant={alt ? "secondary" : "ghost"}
          className="min-w-11"
          aria-pressed={alt}
          onClick={() => toggleModifier("alt")}
        >
          Alt
        </Button>
        <Button type="button" size="icon-lg" variant="ghost" aria-label="Arrow left" onClick={() => sendKey("ArrowLeft", "ArrowLeft")}>
          <ArrowLeft />
        </Button>
        <Button type="button" size="icon-lg" variant="ghost" aria-label="Arrow down" onClick={() => sendKey("ArrowDown", "ArrowDown")}>
          <ArrowDown />
        </Button>
        <Button type="button" size="icon-lg" variant="ghost" aria-label="Arrow up" onClick={() => sendKey("ArrowUp", "ArrowUp")}>
          <ArrowUp />
        </Button>
        <Button type="button" size="icon-lg" variant="ghost" aria-label="Arrow right" onClick={() => sendKey("ArrowRight", "ArrowRight")}>
          <ArrowRight />
        </Button>
        <Button
          type="button"
          size="icon-lg"
          variant="ghost"
          aria-label="Paste"
          onClick={() => void pasteIntoRegisteredTerminal(props.use.id).catch(() => undefined)}
        >
          <Clipboard />
        </Button>
      </nav>
    </GlassSurface>
  )
}
