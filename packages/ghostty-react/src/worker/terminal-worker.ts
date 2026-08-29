import { GhosttyTerminalCore, type GhosttyKeyInput } from "../core.js";
import { browserGhosttyWasmSource } from "@yaade/ghostty-core/loaders/browser";
import {
  TERMINAL_WORKER_PROTOCOL_VERSION,
  terminalRenderUpdateTransferList,
  validateTerminalWorkerCommand,
  type SerializedKeyEvent,
  type TerminalRuntimeState,
  type TerminalWorkerCommand,
  type TerminalWorkerEvent,
} from "./protocol.js";

type RuntimeEntry = { core: GhosttyTerminalCore; generation: number };
const runtimes = new Map<string, RuntimeEntry>();
const pendingUpdates = new Map<string, {
  command: TerminalWorkerCommand;
  core: GhosttyTerminalCore;
  forceFull: boolean;
  timer: number;
}>();

function post(event: TerminalWorkerEvent, transfer: Transferable[] = []): void {
  Reflect.apply(globalThis.postMessage, globalThis, [event, transfer]);
}

function envelope(command: TerminalWorkerCommand) {
  return {
    version: TERMINAL_WORKER_PROTOCOL_VERSION,
    terminalId: command.terminalId,
    sequence: command.sequence,
    generation: command.generation,
  } as const;
}

function keyInput(event: SerializedKeyEvent): GhosttyKeyInput {
  return {
    ...event,
    getModifierState: key => key === "CapsLock" ? event.capsLock : key === "NumLock" && event.numLock,
  };
}

function state(core: GhosttyTerminalCore): TerminalRuntimeState {
  return {
    title: core.title(),
    scrollbar: core.scrollbarState(),
    selectionText: core.selectionText(),
    viewportActive: core.isViewportActive(),
    mouseTracking: core.isMouseTracking(),
    mouseAnyEventTracking: core.isMouseAnyEventTracking(),
    alternateScreen: core.isAlternateScreen(),
    applicationCursorKeys: core.isApplicationCursorKeys(),
    synchronizedOutput: core.isModeEnabled(2026),
  };
}

function emitUpdate(command: TerminalWorkerCommand, core: GhosttyTerminalCore, forceFull = false): void {
  const update = core.renderUpdate(true, forceFull);
  post({ ...envelope(command), type: "packedUpdate", update, state: state(core) }, terminalRenderUpdateTransferList(update));
  core.releaseRenderUpdate(update);
}

function scheduleUpdate(command: TerminalWorkerCommand, core: GhosttyTerminalCore, forceFull = false): void {
  const pending = pendingUpdates.get(command.terminalId);
  if (pending) {
    pending.command = command;
    pending.forceFull ||= forceFull;
    return;
  }
  const entry = { command, core, forceFull, timer: 0 };
  entry.timer = setTimeout(() => {
    pendingUpdates.delete(command.terminalId);
    emitUpdate(entry.command, entry.core, entry.forceFull);
  }, 0);
  pendingUpdates.set(command.terminalId, entry);
}

function flushPendingUpdate(terminalId: string): void {
  const pending = pendingUpdates.get(terminalId);
  if (!pending) return;
  clearTimeout(pending.timer);
  pendingUpdates.delete(terminalId);
  emitUpdate(pending.command, pending.core, pending.forceFull);
}

async function create(command: Extract<TerminalWorkerCommand, { type: "create" }>): Promise<void> {
  const previous = runtimes.get(command.terminalId);
  previous?.core.dispose();
  const core = await GhosttyTerminalCore.create(
    command.cols, command.rows, command.cellWidth, command.cellHeight,
    command.theme, () => undefined, browserGhosttyWasmSource(), "render-only",
  );
  runtimes.set(command.terminalId, { core, generation: command.generation });
  post({ ...envelope(command), type: "ready" });
  emitUpdate(command, core);
}

function process(command: TerminalWorkerCommand, entry: RuntimeEntry): void {
  const { core } = entry;
  switch (command.type) {
    case "write": core.write(command.data); scheduleUpdate(command, core); post({ ...envelope(command), type: "parsed" }); return;
    case "writeReplay": core.writeReplay(command.chunks); scheduleUpdate(command, core); post({ ...envelope(command), type: "parsed" }); return;
    case "resetAndWrite": core.resetAndWrite(command.data); scheduleUpdate(command, core, true); post({ ...envelope(command), type: "parsed" }); return;
    case "resize": flushPendingUpdate(command.terminalId); core.resize(command.cols, command.rows, command.cellWidth, command.cellHeight); emitUpdate(command, core); return;
    case "setTheme": flushPendingUpdate(command.terminalId); core.setTheme(command.theme); emitUpdate(command, core); return;
    case "setFontMetrics": return;
    case "key": post({ ...envelope(command), type: "encodedInput", data: core.encodeKey(keyInput(command.event), command.action) }); return;
    case "paste": post({ ...envelope(command), type: "encodedInput", data: core.encodePaste(command.data) }); return;
    case "text": post({ ...envelope(command), type: "encodedInput", data: command.data }); return;
    case "mouse": post({ ...envelope(command), type: "encodedInput", data: core.encodeMouse(command.input) }); return;
    case "setSelection": core.setSelection(command.anchor, command.end); emitUpdate(command, core); return;
    case "clearSelection": core.clearSelection(); emitUpdate(command, core); return;
    case "selectAll": core.selectAll(); emitUpdate(command, core); return;
    case "selectWord": post({ ...envelope(command), type: "selectionResult", result: core.selectWord(command.col, command.row) }); emitUpdate(command, core); return;
    case "selectLine": post({ ...envelope(command), type: "selectionResult", result: core.selectLine(command.col, command.row) }); emitUpdate(command, core); return;
    case "scroll": core.scroll(command.delta); emitUpdate(command, core); return;
    case "scrollToBottom": core.scrollToBottom(); emitUpdate(command, core); return;
    case "viewportPointToScreen": post({ ...envelope(command), type: "selectionResult", result: core.viewportPointToScreen(command.col, command.row) }); return;
    case "screenPointToViewport": post({ ...envelope(command), type: "selectionResult", result: core.screenPointToViewport(command.col, command.row) }); return;
    case "requestFullFrame": emitUpdate(command, core, true); return;
    case "dispose": {
      const pending = pendingUpdates.get(command.terminalId);
      if (pending) clearTimeout(pending.timer);
      pendingUpdates.delete(command.terminalId);
      core.dispose();
      runtimes.delete(command.terminalId);
      post({ ...envelope(command), type: "disposed" });
      return;
    }
    case "create": return;
  }
}

globalThis.addEventListener("message", (message: MessageEvent<unknown>) => {
  const command = message.data;
  if (!validateTerminalWorkerCommand(command)) return;
  if (command.type === "create") {
    void create(command).catch(error => post({
      ...envelope(command), type: "fatalError",
      message: error instanceof Error ? error.message : String(error),
    }));
    return;
  }
  const entry = runtimes.get(command.terminalId);
  if (!entry || entry.generation !== command.generation) return;
  try {
    process(command, entry);
  } catch (error) {
    post({
      ...envelope(command), type: "recoverableError",
      message: error instanceof Error ? error.message : String(error),
    });
  }
});
