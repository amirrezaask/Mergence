import { describe, it } from "vite-plus/test";
import assert from "node:assert/strict";
import {
	createMuxSessionKeymapState,
	muxSessionDirectShortcutFor,
	resolveMuxSessionKeydown,
	type MuxSessionKeyEvent,
} from "./keybindings.js";

function keyEvent(key: string, code: string): MuxSessionKeyEvent {
	const mac = process.platform === "darwin";
	return {
		key,
		code,
		metaKey: mac,
		ctrlKey: !mac,
		altKey: false,
		shiftKey: false,
		repeat: false,
		isComposing: false,
	};
}

const baseContext = {
	overlayOpen: false,
	inEditable: false,
	inTerminal: true,
	inPrefixButton: false,
	zoomed: false,
};

describe("direct mux session bindings", () => {
	it("uses the primary modifier plus B to toggle a vertical sidebar", () => {
		assert.equal(muxSessionDirectShortcutFor("sidebar.toggle"), "Mod-b");
		assert.deepEqual(
			resolveMuxSessionKeydown(
				keyEvent("b", "KeyB"),
				createMuxSessionKeymapState(),
				{ ...baseContext, sidebarLayout: true },
			),
			{ type: "command", command: "sidebar.toggle" },
		);
	});

	it("does not consume the sidebar shortcut outside a vertical sidebar layout", () => {
		assert.equal(
			resolveMuxSessionKeydown(
				keyEvent("b", "KeyB"),
				createMuxSessionKeymapState(),
				{ ...baseContext, sidebarLayout: false },
			),
			null,
		);
	});

	it("uses the primary modifier plus comma to open settings", () => {
		assert.equal(muxSessionDirectShortcutFor("settings.show"), "Mod-,");
		assert.deepEqual(
			resolveMuxSessionKeydown(
				keyEvent(",", "Comma"),
				createMuxSessionKeymapState(),
				baseContext,
			),
			{ type: "command", command: "settings.show" },
		);
	});
});
