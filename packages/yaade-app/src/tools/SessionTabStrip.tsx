import { useRef, useState } from "react";
import { Plus, Settings, X } from "lucide-react";
import type { AppSession, SessionId } from "@yaade/rpc";
import { SidebarShell } from "@yaade/ui";
import { Button, Input } from "@yaade/ui/primitives";
import { ShortcutTooltip } from "./ShortcutTooltip.js";
import {
  toolSessionDirectShortcutFor,
  toolSessionShortcutFor,
} from "./tool-session-keymap.js";

export type SessionNavigationLayout = "tabs" | "sidebar";

export type SessionTabStripProps = {
  readonly sessions: readonly AppSession[];
  readonly activeSessionId?: SessionId;
  readonly onSelect: (id: SessionId) => void;
  readonly onClose: (id: SessionId) => void;
  readonly onOpenSettings: () => void;
  readonly onCreate: () => void;
  readonly onRename: (id: SessionId, title: string) => void;
  readonly onReorder: (ids: readonly SessionId[]) => void;
  readonly toolCounts?: ReadonlyMap<SessionId, number>;
  readonly layout?: SessionNavigationLayout;
};

export function SessionTabStrip(props: SessionTabStripProps) {
  const dragId = useRef<SessionId | null>(null);
  const [editingId, setEditingId] = useState<SessionId | null>(null);
  const [draftTitle, setDraftTitle] = useState("");
  const layout = props.layout ?? "tabs";
  const settingsChord = toolSessionDirectShortcutFor("settings.show");
  const newSessionChord = toolSessionShortcutFor("session.new");

  const finishRename = (session: AppSession) => {
    const next = draftTitle.trim();
    setEditingId(null);
    if (next && next !== session.title) props.onRename(session.id, next);
  };

  const moveSession = (sessionId: SessionId, index: number) => {
    const from = dragId.current;
    dragId.current = null;
    if (!from || from === sessionId) return;
    const ids = props.sessions.map((item) => item.id);
    const fromIndex = ids.indexOf(from);
    if (fromIndex < 0) return;
    ids.splice(fromIndex, 1);
    ids.splice(index, 0, from);
    props.onReorder(ids);
  };

  const sidebarActions = (
    <div
      className="flex h-full w-full shrink-0 items-center justify-end gap-1"
      role="toolbar"
      aria-label="Session actions"
    >
      <ShortcutTooltip label="Settings" shortcut={settingsChord} side="right">
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="Open settings"
          onClick={props.onOpenSettings}
          data-yaade-session-settings=""
        >
          <Settings />
        </Button>
      </ShortcutTooltip>
      <ShortcutTooltip
        label="New session"
        shortcut={newSessionChord}
        side="right"
      >
        <Button
          size="icon-xs"
          variant="secondary"
          aria-label="New session"
          data-yaade-new-session=""
          onClick={props.onCreate}
        >
          <Plus />
        </Button>
      </ShortcutTooltip>
    </div>
  );

  if (layout === "sidebar") {
    return (
      <SidebarShell
        aria-label="Sessions"
        contentAs="nav"
        contentProps={{
          "aria-label": "Sessions",
          "aria-orientation": "vertical",
          role: "tablist",
        }}
        contentClassName="flex flex-col gap-1 p-2 max-md:flex-row max-md:gap-1 max-md:overflow-x-auto max-md:overflow-y-hidden max-md:p-1"
        footerClassName="border-sidebar-border p-2 max-md:h-full max-md:w-auto max-md:border-t-0 max-md:border-l max-md:p-1"
        className="w-64 border-r border-sidebar-border bg-sidebar text-sidebar-foreground max-md:h-10 max-md:w-full max-md:flex-row max-md:border-r-0 max-md:border-b"
        dataAttributes={{
          "data-yaade-session-sidebar": "",
          // Keep the navigation hook stable for existing integrations.
          "data-yaade-session-tabs": "",
        }}
        footer={sidebarActions}
      >
        {props.sessions.map((session, index) => {
          const active = session.id === props.activeSessionId;
          const toolCount = props.toolCounts?.get(session.id) ?? 0;
          return (
            <div
              key={session.id}
              role="tab"
              tabIndex={active ? 0 : -1}
              aria-selected={active}
              data-active={active ? "true" : undefined}
              draggable={editingId !== session.id}
              onDragStart={() => {
                dragId.current = session.id;
              }}
              onDragOver={(event) => event.preventDefault()}
              onDrop={() => moveSession(session.id, index)}
              className="group relative flex min-h-11 w-full shrink-0 items-center rounded-md border border-transparent px-1 outline-none transition-[color,background-color,border-color] duration-[var(--yaade-motion-hot)] focus-within:ring-2 focus-within:ring-sidebar-ring/50 hover:bg-sidebar-accent/70 data-[active=true]:border-sidebar-border data-[active=true]:bg-sidebar-accent max-md:h-full max-md:min-h-0 max-md:w-36"
            >
              <span
                className="absolute inset-y-2 left-0 w-0.5 origin-center scale-y-0 rounded-full bg-sidebar-primary transition-transform duration-[var(--yaade-motion-menu)] ease-[var(--yaade-ease-out)] group-data-[active=true]:scale-y-100"
                aria-hidden
              />
              {editingId === session.id ? (
                <Input
                  aria-label={`Rename ${session.title}`}
                  className="h-7 min-w-0 flex-1 border-sidebar-primary/50 bg-sidebar px-1.5"
                  autoFocus
                  value={draftTitle}
                  onChange={(event) => setDraftTitle(event.target.value)}
                  onBlur={() => finishRename(session)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") finishRename(session);
                    if (event.key === "Escape") setEditingId(null);
                  }}
                />
              ) : (
                <button
                  type="button"
                  className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden px-1.5 text-left text-xs font-medium text-sidebar-foreground/70 outline-none transition-colors group-data-[active=true]:text-sidebar-accent-foreground"
                  onClick={() => props.onSelect(session.id)}
                  onDoubleClick={() => {
                    setDraftTitle(session.title);
                    setEditingId(session.id);
                  }}
                >
                  <span className="grid size-5 shrink-0 place-items-center rounded border border-sidebar-border font-mono text-3xs tabular-nums text-sidebar-foreground/55 group-data-[active=true]:border-sidebar-primary/50 group-data-[active=true]:text-sidebar-primary">
                    {index + 1}
                  </span>
                  <span className="min-w-0 flex-1 truncate">
                    {session.title}
                  </span>
                  {toolCount > 0 ? (
                    <span
                      className="shrink-0 rounded-full bg-sidebar/70 px-1.5 font-mono text-3xs tabular-nums text-sidebar-foreground/60"
                      data-yaade-session-tool-count={toolCount}
                    >
                      {toolCount}
                    </span>
                  ) : null}
                </button>
              )}
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label={`Close ${session.title}`}
                className="ml-0.5 shrink-0 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 group-data-[active=true]:opacity-70"
                onClick={() => props.onClose(session.id)}
              >
                <X />
              </Button>
            </div>
          );
        })}
      </SidebarShell>
    );
  }

  return (
    <header
      className="flex h-9 shrink-0 items-center border-b border-border bg-card"
      data-yaade-session-tabs
    >
      <div className="flex h-full shrink-0 items-center px-1">
        <ShortcutTooltip
          label="Settings"
          shortcut={settingsChord}
          side="bottom"
        >
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="Open settings"
            onClick={props.onOpenSettings}
            data-yaade-session-settings=""
          >
            <Settings />
          </Button>
        </ShortcutTooltip>
      </div>
      <nav
        className="flex h-full min-w-0 flex-1 items-stretch gap-0.5 overflow-x-auto px-1"
        aria-label="Sessions"
        role="tablist"
      >
        {props.sessions.map((session, index) => {
          const active = session.id === props.activeSessionId;
          const toolCount = props.toolCounts?.get(session.id) ?? 0;
          return (
            <div
              key={session.id}
              role="tab"
              tabIndex={active ? 0 : -1}
              aria-selected={active}
              data-active={active ? "true" : undefined}
              draggable={editingId !== session.id}
              onDragStart={() => {
                dragId.current = session.id;
              }}
              onDragOver={(event) => event.preventDefault()}
              onDrop={() => moveSession(session.id, index)}
              className="group relative flex h-full min-w-24 shrink-0 items-center px-0.5 outline-none transition-[color,background-color] duration-[var(--yaade-motion-hot)] focus-visible:bg-accent data-[active=true]:bg-background"
            >
              <span
                className="absolute inset-x-2 bottom-0 h-0.5 origin-center scale-x-0 rounded-full bg-primary transition-transform duration-[var(--yaade-motion-menu)] ease-[var(--yaade-ease-out)] group-data-[active=true]:scale-x-100"
                aria-hidden
              />
              {editingId === session.id ? (
                <Input
                  aria-label={`Rename ${session.title}`}
                  className="h-6 min-w-24 border-primary/50 bg-background px-1.5"
                  autoFocus
                  value={draftTitle}
                  onChange={(event) => setDraftTitle(event.target.value)}
                  onBlur={() => finishRename(session)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") finishRename(session);
                    if (event.key === "Escape") setEditingId(null);
                  }}
                />
              ) : (
                <button
                  type="button"
                  className="flex min-w-0 flex-1 items-center overflow-hidden px-1.5 text-left text-xs font-medium text-muted-foreground outline-none transition-colors group-data-[active=true]:text-foreground"
                  onClick={() => props.onSelect(session.id)}
                  onDoubleClick={() => {
                    setDraftTitle(session.title);
                    setEditingId(session.id);
                  }}
                >
                  <span className="truncate">{session.title}</span>
                  {toolCount > 0 ? (
                    <span
                      className="ml-1.5 font-mono text-3xs tabular-nums text-muted-foreground"
                      data-yaade-session-tool-count={toolCount}
                    >
                      {toolCount}
                    </span>
                  ) : null}
                </button>
              )}
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label={`Close ${session.title}`}
                className="opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 group-data-[active=true]:opacity-70"
                onClick={() => props.onClose(session.id)}
              >
                <X />
              </Button>
            </div>
          );
        })}
      </nav>
      <div className="flex h-full shrink-0 items-center px-1">
        <ShortcutTooltip label="New session" shortcut={newSessionChord}>
          <Button
            size="icon-xs"
            variant="secondary"
            aria-label="New session"
            data-yaade-new-session=""
            onClick={props.onCreate}
          >
            <Plus />
          </Button>
        </ShortcutTooltip>
      </div>
    </header>
  );
}
