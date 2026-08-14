import { useRef, useState } from "react";
import { Plus, Settings, X } from "lucide-react";
import type { AppSession, SessionId } from "@yaade/rpc";
import { Button, Input } from "@yaade/ui/primitives";
import { ShortcutTooltip } from "./ShortcutTooltip.js";
import {
  toolSessionDirectShortcutFor,
  toolSessionShortcutFor,
} from "./tool-session-keymap.js";

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
};

export function SessionTabStrip(props: SessionTabStripProps) {
  const dragId = useRef<SessionId | null>(null);
  const [editingId, setEditingId] = useState<SessionId | null>(null);
  const [draftTitle, setDraftTitle] = useState("");
  const settingsChord = toolSessionDirectShortcutFor("settings.show");
  const newSessionChord = toolSessionShortcutFor("session.new");

  const finishRename = (session: AppSession) => {
    const next = draftTitle.trim();
    setEditingId(null);
    if (next && next !== session.title) props.onRename(session.id, next);
  };

  return (
    <header
      className="flex h-9 shrink-0 items-center border-b border-border bg-card"
      data-yaade-session-tabs
    >
      <div className="flex h-full shrink-0 items-center px-1">
        <ShortcutTooltip label="Settings" shortcut={settingsChord} side="bottom">
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
              onDrop={() => {
                const from = dragId.current;
                dragId.current = null;
                if (!from || from === session.id) return;
                const ids = props.sessions.map((item) => item.id);
                const fromIndex = ids.indexOf(from);
                if (fromIndex < 0) return;
                ids.splice(fromIndex, 1);
                ids.splice(index, 0, from);
                props.onReorder(ids);
              }}
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
