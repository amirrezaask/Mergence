import {
  GHOSTTY_RENDER_UPDATE_VERSION,
  validateGhosttyRenderUpdate,
  type GhosttyMouseInput,
  type GhosttyPointInput,
  type GhosttyRenderUpdate,
  type GhosttyTheme,
} from "../core.js";

export const TERMINAL_WORKER_PROTOCOL_VERSION = 1 as const;

export type SerializedKeyEvent = {
  readonly key: string;
  readonly code: string;
  readonly location: number;
  readonly repeat: boolean;
  readonly shiftKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly metaKey: boolean;
  readonly isComposing: boolean;
  readonly capsLock: boolean;
  readonly numLock: boolean;
};

type Envelope = {
  readonly version: typeof TERMINAL_WORKER_PROTOCOL_VERSION;
  readonly terminalId: string;
  readonly sequence: number;
  readonly generation: number;
};

export type TerminalWorkerCommandPayload =
  | { readonly type: "create"; readonly cols: number; readonly rows: number; readonly cellWidth: number; readonly cellHeight: number; readonly theme: GhosttyTheme }
  | { readonly type: "write"; readonly data: string }
  | { readonly type: "writeReplay"; readonly chunks: readonly string[] }
  | { readonly type: "resetAndWrite"; readonly data: string }
  | { readonly type: "resize"; readonly cols: number; readonly rows: number; readonly cellWidth: number; readonly cellHeight: number }
  | { readonly type: "setTheme"; readonly theme: GhosttyTheme }
  | { readonly type: "setFontMetrics"; readonly cellWidth: number; readonly cellHeight: number }
  | { readonly type: "key"; readonly event: SerializedKeyEvent; readonly action: "press" | "release" }
  | { readonly type: "paste"; readonly data: string }
  | { readonly type: "text"; readonly data: string }
  | { readonly type: "mouse"; readonly input: GhosttyMouseInput }
  | { readonly type: "setSelection"; readonly anchor: GhosttyPointInput; readonly end: GhosttyPointInput }
  | { readonly type: "clearSelection" | "selectAll" | "scrollToBottom" | "requestFullFrame" | "dispose" }
  | { readonly type: "selectWord" | "selectLine" | "viewportPointToScreen" | "screenPointToViewport"; readonly col: number; readonly row: number }
  | { readonly type: "scroll"; readonly delta: number };

export type TerminalWorkerCommand = Envelope & TerminalWorkerCommandPayload;

export type TerminalRuntimeState = {
  readonly title: string;
  readonly scrollbar: { readonly total: number; readonly offset: number; readonly len: number } | null;
  readonly selectionText: string;
  readonly viewportActive: boolean;
  readonly mouseTracking: boolean;
  readonly mouseAnyEventTracking: boolean;
  readonly alternateScreen: boolean;
  readonly applicationCursorKeys: boolean;
  readonly synchronizedOutput: boolean;
};

export type TerminalWorkerEvent = Envelope & (
  | { readonly type: "ready" }
  | { readonly type: "packedUpdate"; readonly update: GhosttyRenderUpdate; readonly state: TerminalRuntimeState }
  | { readonly type: "encodedInput"; readonly data: string }
  | { readonly type: "parsed" }
  | { readonly type: "selectionResult"; readonly result: unknown }
  | { readonly type: "recoverableError" | "fatalError"; readonly message: string }
  | { readonly type: "disposed" }
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function validEnvelope(value: Record<string, unknown>): boolean {
  return value.version === TERMINAL_WORKER_PROTOCOL_VERSION &&
    typeof value.terminalId === "string" && value.terminalId.length > 0 &&
    Number.isSafeInteger(value.sequence) && Number(value.sequence) >= 0 &&
    Number.isSafeInteger(value.generation) && Number(value.generation) >= 1;
}

const COMMAND_TYPES = new Set([
  "create", "write", "writeReplay", "resetAndWrite", "resize", "setTheme",
  "setFontMetrics", "key", "paste", "text", "mouse", "setSelection", "clearSelection",
  "selectAll", "selectWord", "selectLine", "scroll", "scrollToBottom",
  "viewportPointToScreen", "screenPointToViewport", "requestFullFrame", "dispose",
]);

export function validateTerminalWorkerCommand(value: unknown): value is TerminalWorkerCommand {
  if (!isRecord(value) || !validEnvelope(value) || !COMMAND_TYPES.has(String(value.type))) return false;
  switch (value.type) {
    case "write": case "resetAndWrite": case "paste": case "text": return typeof value.data === "string";
    case "writeReplay": return Array.isArray(value.chunks) && value.chunks.every(chunk => typeof chunk === "string");
    case "create": case "resize": return Number.isFinite(value.cols) && Number.isFinite(value.rows) && Number.isFinite(value.cellWidth) && Number.isFinite(value.cellHeight) && (value.type !== "create" || isRecord(value.theme));
    case "setTheme": return isRecord(value.theme);
    case "setFontMetrics": return Number.isFinite(value.cellWidth) && Number.isFinite(value.cellHeight);
    case "key": return isRecord(value.event) && (value.action === "press" || value.action === "release");
    case "mouse": return isRecord(value.input);
    case "setSelection": return isRecord(value.anchor) && isRecord(value.end);
    case "selectWord": case "selectLine": case "viewportPointToScreen": case "screenPointToViewport": return Number.isFinite(value.col) && Number.isFinite(value.row);
    case "scroll": return Number.isFinite(value.delta);
    default: return true;
  }
}

function validateState(value: unknown): value is TerminalRuntimeState {
  return isRecord(value) && typeof value.title === "string" &&
    typeof value.selectionText === "string" && typeof value.viewportActive === "boolean" &&
    typeof value.mouseTracking === "boolean" && typeof value.mouseAnyEventTracking === "boolean" &&
    typeof value.alternateScreen === "boolean" && typeof value.applicationCursorKeys === "boolean" &&
    typeof value.synchronizedOutput === "boolean" &&
    (value.scrollbar === null || (isRecord(value.scrollbar) && Number.isFinite(value.scrollbar.total) && Number.isFinite(value.scrollbar.offset) && Number.isFinite(value.scrollbar.len)));
}

export function validateTerminalWorkerEvent(value: unknown): value is TerminalWorkerEvent {
  if (!isRecord(value) || !validEnvelope(value) || typeof value.type !== "string") return false;
  switch (value.type) {
    case "ready": case "parsed": case "disposed": return true;
    case "encodedInput": return typeof value.data === "string";
    case "packedUpdate": return validateGhosttyRenderUpdate(value.update) && validateState(value.state) && value.update.version === GHOSTTY_RENDER_UPDATE_VERSION;
    case "selectionResult": return "result" in value;
    case "recoverableError": case "fatalError": return typeof value.message === "string";
    default: return false;
  }
}

export function terminalRenderUpdateTransferList(update: GhosttyRenderUpdate): Transferable[] {
  return [
    update.dirtyRows.buffer, update.rowFlags.buffer, update.graphemeOffsets.buffer,
    update.graphemeLengths.buffer, update.foregrounds.buffer, update.backgrounds.buffer,
    update.styles.buffer, update.graphemes.buffer,
  ];
}

export function serializeKeyboardEvent(event: KeyboardEvent): SerializedKeyEvent {
  return {
    key: event.key, code: event.code, location: event.location, repeat: event.repeat,
    shiftKey: event.shiftKey, ctrlKey: event.ctrlKey, altKey: event.altKey,
    metaKey: event.metaKey, isComposing: event.isComposing,
    capsLock: event.getModifierState("CapsLock"), numLock: event.getModifierState("NumLock"),
  };
}
