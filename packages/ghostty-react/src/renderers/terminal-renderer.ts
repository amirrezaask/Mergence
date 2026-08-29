import type {
  GhosttyRenderUpdate,
  GhosttyViewportModel,
} from "@yaade/ghostty-core";
import type { GhosttyCellMetrics, GhosttyCellRange } from "../renderer.js";

export interface TerminalRenderViewport {
  readonly cssWidth: number;
  readonly cssHeight: number;
  readonly pixelRatio: number;
  readonly padding: number;
  readonly originY: number;
}

export interface TerminalRenderFont {
  readonly family: string;
  readonly size: number;
}

export interface TerminalRenderOverlays {
  readonly forceFull: boolean;
  readonly cursorOn: boolean;
  readonly previousCursorY?: number | null;
  readonly focused: boolean;
  readonly selectionBackground?: string;
  readonly hoveredLinkRange?: GhosttyCellRange | null;
  readonly dirtyRows?: ReadonlySet<number>;
  readonly metrics: GhosttyCellMetrics;
  readonly font: TerminalRenderFont;
  readonly viewport: TerminalRenderViewport;
}

export interface TerminalRenderer {
  readonly kind: "canvas2d" | "webgl2" | "webgpu";
  resize(viewport: TerminalRenderViewport): void;
  setFont(font: TerminalRenderFont): Promise<GhosttyCellMetrics>;
  render(
    model: GhosttyViewportModel,
    update: GhosttyRenderUpdate | null,
    overlays: TerminalRenderOverlays,
  ): void;
  capturePixels?(): Promise<ImageData>;
  dispose(): void;
}
