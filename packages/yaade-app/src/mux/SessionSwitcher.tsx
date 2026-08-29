import { useState } from "react";
import { Check, Layers3, Pencil, Plus, X } from "lucide-react";
import type { AppSession, SessionId } from "@yaade/rpc";
import { cn, formatKeyBinding } from "@yaade/ui/session";
import { Button, Input, Popover, PopoverContent, PopoverTrigger } from "@yaade/ui/primitives";
import { muxSessionShortcutFor } from "./mux-keymap.js";

export type SessionSwitcherProps = {
	readonly open: boolean;
	readonly onOpenChange: (open: boolean) => void;
	readonly sessions: readonly AppSession[];
	readonly activeSessionId?: AppSession["id"];
	readonly onSelect: (session: AppSession) => void;
	readonly onCreate: () => void;
	readonly onClose?: (id: SessionId) => void;
	readonly onRename?: (id: SessionId, title: string) => void;
	readonly terminalCounts?: ReadonlyMap<SessionId, number>;
	readonly serverNamesBySessionId?: ReadonlyMap<SessionId, string>;
	readonly className?: string;
};

export function SessionSwitcher(props: SessionSwitcherProps) {
	const [editingId, setEditingId] = useState<SessionId | null>(null);
	const [draftTitle, setDraftTitle] = useState("");
	const activeSession = props.sessions.find((session) => session.id === props.activeSessionId);
	const switchShortcut = muxSessionShortcutFor("session.switch");

	const finishRename = (session: AppSession) => {
		const next = draftTitle.trim();
		setEditingId(null);
		if (next && next !== session.title) props.onRename?.(session.id, next);
	};

	const startRename = (session: AppSession) => {
		setDraftTitle(session.title);
		setEditingId(session.id);
	};

	const selectSession = (session: AppSession) => {
		setEditingId(null);
		props.onSelect(session);
		props.onOpenChange(false);
	};

	const createSession = () => {
		setEditingId(null);
		props.onOpenChange(false);
		props.onCreate();
	};

	return (
		<Popover open={props.open} onOpenChange={props.onOpenChange}>
			<PopoverTrigger asChild>
				<Button
					type="button"
					variant="ghost"
					size="sm"
					aria-label={`Switch session${activeSession ? `, current ${activeSession.title}` : ""}`}
					aria-haspopup="dialog"
					data-yaade-session-switcher=""
					data-yaade-active-session={activeSession?.id}
					title={
						switchShortcut
							? `Switch session (${formatKeyBinding(switchShortcut)})`
							: "Switch session"
					}
					className={cn(
						"h-[var(--yaade-tab-pill-height)] min-w-0 max-w-40 shrink-0 justify-start gap-1.5 rounded-[var(--yaade-pill-radius)] px-2.5 text-left text-muted-foreground hover:bg-accent/60 hover:text-foreground data-[state=open]:bg-accent/70 data-[state=open]:text-foreground",
						props.className,
					)}
				>
					<Layers3 className="shrink-0" data-icon="inline-start" aria-hidden />
				</Button>
			</PopoverTrigger>
			<PopoverContent
				align="start"
				side="bottom"
				sideOffset={8}
				className="w-[min(22rem,calc(100vw-1rem))] overflow-hidden p-0"
				data-yaade-glass-surface=""
				data-yaade-glass-material="floating"
				data-yaade-glass-elevated="true"
				data-yaade-session-switcher-popover=""
			>
				<div className="relative z-1 flex items-center justify-between px-3 pb-2 pt-3">
					<span className="text-xs font-semibold text-foreground">Sessions</span>
					<span className="font-mono text-3xs tabular-nums text-muted-foreground">
						{props.sessions.length}
					</span>
				</div>
				<div
					className="relative z-1 mx-1.5 flex max-h-[min(22rem,calc(100dvh-12rem))] flex-col gap-1 overflow-y-auto"
					role="listbox"
					aria-label="Sessions"
				>
					{props.sessions.length === 0 ? (
						<p className="px-2.5 py-5 text-xs text-muted-foreground">No active sessions.</p>
					) : (
						props.sessions.map((session) => {
							const active = session.id === props.activeSessionId;
							const editing = editingId === session.id;
							const count = props.terminalCounts?.get(session.id) ?? 0;
							const serverName = props.serverNamesBySessionId?.get(session.id);
							return (
								<div
									key={session.id}
									className={cn(
										"group flex min-w-0 items-center gap-0.5 rounded-[var(--yaade-control-radius)] transition-colors duration-[var(--yaade-motion-hot)]",
										active ? "bg-accent/80" : "hover:bg-accent/45 focus-within:bg-accent/45",
									)}
								>
									{editing ? (
										<div className="flex min-w-0 flex-1 items-center gap-1 p-1">
											<Input
												aria-label={`Rename ${session.title}`}
												autoFocus
												value={draftTitle}
												onChange={(event) => setDraftTitle(event.target.value)}
												onBlur={() => finishRename(session)}
												onKeyDown={(event) => {
													event.stopPropagation();
													if (event.key === "Enter") finishRename(session);
													if (event.key === "Escape") setEditingId(null);
												}}
												className="h-8 min-w-0 flex-1 bg-background/70 px-2"
											/>
											<Button
												type="button"
												variant="ghost"
												size="icon-xs"
												aria-label={`Save name for ${session.title}`}
												onPointerDown={(event) => event.preventDefault()}
												onClick={() => finishRename(session)}
											>
												<Check />
											</Button>
											<Button
												type="button"
												variant="ghost"
												size="icon-xs"
												aria-label={`Cancel renaming ${session.title}`}
												onPointerDown={(event) => event.preventDefault()}
												onClick={() => setEditingId(null)}
											>
												<X />
											</Button>
										</div>
									) : (
										<>
											<button
												type="button"
												role="option"
												aria-selected={active}
												data-yaade-session={session.id}
												data-active={active ? "true" : undefined}
												className="flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-[var(--yaade-control-radius)] px-2.5 text-left outline-none transition-colors duration-[var(--yaade-motion-hot)] focus-visible:ring-2 focus-visible:ring-ring/60"
												onClick={() => selectSession(session)}
												onDoubleClick={() => {
													if (props.onRename) startRename(session);
												}}
											>
												<span
													className={cn(
														"grid size-5 shrink-0 place-items-center rounded-full border border-border/60 text-muted-foreground transition-colors duration-[var(--yaade-motion-hot)]",
														active && "border-primary/30 bg-primary/15 text-primary",
													)}
													aria-hidden
												>
													{active ? <Check className="size-3.5" /> : null}
												</span>
												<span className="flex min-w-0 flex-1 flex-col justify-center gap-0.5">
													<span className="truncate text-xs font-medium text-foreground">
														{session.title}
													</span>
													{serverName ? (
														<span className="truncate text-3xs text-muted-foreground">
															{serverName}
														</span>
													) : null}
												</span>
												{count > 0 ? (
													<span
														className="shrink-0 rounded-full bg-background/45 px-1.5 py-0.5 font-mono text-3xs tabular-nums text-muted-foreground"
														aria-label={`${count} terminal${count === 1 ? "" : "s"}`}
													>
														{count}
													</span>
												) : null}
											</button>
											{props.onRename ? (
												<Button
													type="button"
													variant="ghost"
													size="icon-xs"
													aria-label={`Rename ${session.title}`}
													title={`Rename ${session.title}`}
													className="shrink-0 text-muted-foreground opacity-70 transition-opacity hover:opacity-100 group-focus-within:opacity-100"
													onClick={() => startRename(session)}
												>
													<Pencil />
												</Button>
											) : null}
											{props.onClose ? (
												<Button
													type="button"
													variant="ghost"
													size="icon-xs"
													aria-label={`Close ${session.title}`}
													title={`Close ${session.title}`}
													className="mr-1 shrink-0 text-muted-foreground opacity-70 transition-opacity hover:text-destructive hover:opacity-100 group-focus-within:opacity-100"
													onClick={() => props.onClose?.(session.id)}
												>
													<X />
												</Button>
											) : null}
										</>
									)}
								</div>
							);
						})
					)}
				</div>
				<div className="relative z-1 mt-2 border-t border-border/60 p-1.5">
					<Button
						type="button"
						variant="ghost"
						size="sm"
						className="h-10 w-full justify-start gap-2 rounded-[var(--yaade-control-radius)] text-foreground hover:bg-accent/60"
						aria-label="New session"
						data-yaade-new-session=""
						onClick={createSession}
					>
						<span className="grid size-6 place-items-center rounded-full bg-primary/15 text-primary">
							<Plus />
						</span>
						New session
					</Button>
				</div>
			</PopoverContent>
		</Popover>
	);
}
