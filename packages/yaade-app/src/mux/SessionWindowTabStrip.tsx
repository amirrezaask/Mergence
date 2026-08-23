import { useState, type KeyboardEvent, type ReactNode } from "react";
import { AnimatePresence, LayoutGroup } from "motion/react";
import { div as MotionDiv } from "motion/react-m";
import { AppWindow, Plus, X } from "lucide-react";
import type { MuxTerminalId, SessionTab, SessionTabId } from "@yaade/rpc";
import { Button, Input } from "@yaade/ui/primitives";
import { cn, useDockReorderTarget, useDockSource, yaadeMotion } from "@yaade/ui/session";
import { ShortcutTooltip } from "./ShortcutTooltip.js";
import { muxSessionShortcutFor } from "./mux-keymap.js";

function handleWindowTabKeyDown(event: KeyboardEvent<HTMLElement>): void {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  const tabs = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]')];
  if (tabs.length === 0) return;
  const activeElement = document.activeElement;
  const current = Math.max(
    0,
    activeElement instanceof HTMLElement ? tabs.indexOf(activeElement) : -1,
  );
  const next =
    event.key === "Home"
      ? 0
      : event.key === "End"
        ? tabs.length - 1
        : (current + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
  event.preventDefault();
  tabs[next]?.focus();
  tabs[next]?.click();
}

function WindowTabProcessTile() {
  return <AppWindow className="size-3.5 shrink-0" aria-hidden />;
}

export type SessionWindowTabStripProps = {
  readonly tabs: readonly SessionTab[];
  readonly activeTabId?: SessionTabId;
  readonly onSelect: (tab: SessionTab) => void;
  readonly onCreate: () => void;
  readonly onClose: (tab: SessionTab) => void;
  readonly onRename: (id: SessionTabId, title: string) => void;
  readonly dockTerminalIdsByTab: ReadonlyMap<SessionTabId, MuxTerminalId>;
};

type DockableWindowTabProps = {
  readonly tab: SessionTab;
  readonly dockTerminalId?: MuxTerminalId;
  readonly disabled: boolean;
  readonly children: (
    source: ReturnType<typeof useDockSource>,
    target: ReturnType<typeof useDockReorderTarget>,
  ) => ReactNode;
};

function DockableWindowTab(props: DockableWindowTabProps) {
  const source = useDockSource({
    tabId: props.dockTerminalId ?? props.tab.id,
    sourceId: props.tab.id,
    label: props.tab.title,
    disabled: props.disabled || !props.dockTerminalId,
  });
  const target = useDockReorderTarget(props.tab.id);
  return props.children(source, target);
}

export function SessionWindowTabStrip(props: SessionWindowTabStripProps) {
  const [editingId, setEditingId] = useState<SessionTabId | null>(null);
  const [draftTitle, setDraftTitle] = useState("");
  const newTabShortcut = muxSessionShortcutFor("tab.new");

  const finishRename = (tab: SessionTab) => {
    const title = draftTitle.trim();
    setEditingId(null);
    if (title && title !== tab.title) props.onRename(tab.id, title);
  };

  const startRename = (tab: SessionTab) => {
    setDraftTitle(tab.title);
    setEditingId(tab.id);
  };

  return (
    <div
      className="flex h-[var(--yaade-tab-bar-height)] min-w-0 flex-1 items-center px-0"
      data-yaade-window-tabs=""
    >
      <LayoutGroup id="yaade-window-tabs">
        <nav
          className="flex h-full min-w-0 items-center overflow-x-auto"
          aria-label="Windows"
          role="tablist"
          onKeyDown={handleWindowTabKeyDown}
        >
          <AnimatePresence initial={false} mode="popLayout">
            {props.tabs.map((tab) => {
              const active = tab.id === props.activeTabId;
              const editing = editingId === tab.id;
              const dockTerminalId = props.dockTerminalIdsByTab.get(tab.id);
              return (
                <DockableWindowTab
                  key={tab.id}
                  tab={tab}
                  dockTerminalId={dockTerminalId}
                  disabled={editing}
                >
                  {(dockSource, dropTarget) => (
                    <MotionDiv
                      layout
                      initial={{ opacity: 0, scale: 0.97, y: 3 }}
                      animate={{ opacity: 1, scale: 1, y: 0 }}
                      exit={{ opacity: 0, scale: 0.97, y: -3 }}
                      transition={{
                        layout: yaadeMotion.layoutTransition,
                        default: yaadeMotion.layoutTransition,
                      }}
                      className="flex h-full min-w-0 shrink-0 items-center transition-opacity duration-[var(--yaade-motion-fast)] ease-[var(--yaade-ease-out)] data-[dragging]:opacity-35"
                      data-dragging={dockSource.isDragging ? "" : undefined}
                    >
                      <div
                        ref={dropTarget.setNodeRef}
                        className={cn(
                          "group relative isolate flex min-w-0 shrink-0 items-center rounded-[var(--yaade-pill-radius)] transition-[background-color,box-shadow] duration-[var(--yaade-motion-fast)] ease-[var(--yaade-ease-out)]",
                          dropTarget.isOver &&
                            !dockSource.isDragging &&
                            "bg-accent/60 ring-1 ring-ring/30",
                        )}
                        data-yaade-session-tab={tab.id}
                        data-active={active ? "true" : undefined}
                        data-yaade-window-tab-drop-target={dropTarget.isOver ? "" : undefined}
                      >
                        {active ? (
                          <MotionDiv
                            layoutId="yaade-window-tab-pill"
                            className="pointer-events-none absolute inset-0 -z-10"
                            data-yaade-window-tab-pill=""
                            transition={yaadeMotion.layoutTransition}
                          />
                        ) : null}
                        {editing ? (
                          <Input
                            aria-label={`Rename ${tab.title}`}
                            autoFocus
                            value={draftTitle}
                            className="h-7 min-w-24 bg-background px-2"
                            onChange={(event) => setDraftTitle(event.target.value)}
                            onBlur={() => finishRename(tab)}
                            onKeyDown={(event) => {
                              event.stopPropagation();
                              if (event.key === "Enter") finishRename(tab);
                              if (event.key === "Escape") setEditingId(null);
                            }}
                          />
                        ) : (
                          <button
                            ref={dockSource.setNodeRef}
                            {...dockSource.attributes}
                            {...dockSource.listeners}
                            type="button"
                            role="tab"
                            tabIndex={active ? 0 : -1}
                            aria-selected={active}
                            aria-label={tab.title}
                            aria-roledescription={
                              dockTerminalId ? "draggable Window tab" : undefined
                            }
                            title={
                              dockTerminalId
                                ? `${tab.title} — drag into the workspace to dock its focused terminal`
                                : tab.title
                            }
                            data-yaade-window-tab-dockable={dockTerminalId ? "" : undefined}
                            onClick={() => props.onSelect(tab)}
                            onDoubleClick={() => startRename(tab)}
                            onKeyDown={(event) => {
                              if (event.key === "Enter" || event.key === " ") {
                                event.preventDefault();
                                props.onSelect(tab);
                              }
                            }}
                            className={cn(
                              "flex h-full min-w-0 flex-1 cursor-grab touch-none items-center gap-1.5 py-1 pl-2 pr-7 outline-none transition-colors duration-[var(--yaade-motion-hot)] active:cursor-grabbing focus-visible:ring-2 focus-visible:ring-ring/50",
                              active ? "text-foreground" : "text-muted-foreground",
                            )}
                          >
                            <WindowTabProcessTile />
                            <span className="min-w-0 flex-1 truncate text-xs font-medium">
                              {tab.title}
                            </span>
                          </button>
                        )}
                        {!editing ? (
                          <Button
                            type="button"
                            size="icon-xs"
                            variant="ghost"
                            aria-label={`Close ${tab.title}`}
                            title={`Close ${tab.title}`}
                            tabIndex={active ? 0 : -1}
                            className="absolute right-0.5 top-1/2 size-[var(--yaade-pointer-target)] -translate-y-1/2 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 group-data-[active=true]:opacity-70"
                            onClick={(event) => {
                              event.stopPropagation();
                              props.onClose(tab);
                            }}
                            onPointerDown={(event) => event.stopPropagation()}
                            onKeyDown={(event) => event.stopPropagation()}
                          >
                            <X />
                          </Button>
                        ) : null}
                      </div>
                    </MotionDiv>
                  )}
                </DockableWindowTab>
              );
            })}
          </AnimatePresence>
        </nav>
      </LayoutGroup>
      <ShortcutTooltip label="New tab" shortcut={newTabShortcut} side="bottom">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="New tab"
          data-yaade-new-session-tab=""
          className="size-[var(--yaade-tab-pill-height)]"
          onClick={props.onCreate}
        >
          <Plus />
        </Button>
      </ShortcutTooltip>
    </div>
  );
}
