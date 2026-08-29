import { Maximize2, Minus, X } from "lucide-react";
import { isDesktopClient } from "../client-environment.js";

type WindowAction = "close" | "maximize" | "minimize";

const controls = [
	{ action: "close", label: "Close window", icon: X },
	{ action: "minimize", label: "Minimize window", icon: Minus },
	{ action: "maximize", label: "Toggle maximize window", icon: Maximize2 },
] as const;

function runWindowAction(action: WindowAction): void {
	void import("@tauri-apps/api/window")
		.then(({ getCurrentWindow }) => {
			const appWindow = getCurrentWindow();
			switch (action) {
				case "close":
					return appWindow.close();
				case "minimize":
					return appWindow.minimize();
				case "maximize":
					return appWindow.toggleMaximize();
			}
		})
		.catch(() => undefined);
}

/** Shared title-bar controls: functional in Tauri and visual chrome in the browser. */
export function ClientWindowControls() {
	const desktop = isDesktopClient(window.location);
	if (!desktop) return null;

	return (
		<div
			className="group/window-controls flex shrink-0 items-center gap-2 px-2"
			role="toolbar"
			aria-label="Window controls"
			data-yaade-window-controls=""
		>
			{controls.map(({ action, label, icon: Icon }) => (
				<button
					key={action}
					type="button"
					aria-label={label}
					title={label}
					data-yaade-window-control={action}
					className="grid size-3.5 shrink-0 place-items-center rounded-full border border-foreground/10 outline-none transition-[filter,transform] duration-[var(--yaade-motion-hot)] ease-[var(--yaade-ease-out)] enabled:hover:brightness-90 enabled:active:scale-95 focus-visible:ring-2 focus-visible:ring-ring/70"
					onClick={() => runWindowAction(action)}
				>
					<Icon
						className="size-2.5 opacity-0 transition-opacity duration-[var(--yaade-motion-hot)] group-hover/window-controls:opacity-60 group-focus-within/window-controls:opacity-60"
						aria-hidden
					/>
				</button>
			))}
		</div>
	);
}
