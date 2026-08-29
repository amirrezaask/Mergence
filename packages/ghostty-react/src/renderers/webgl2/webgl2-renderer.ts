import {
  GHOSTTY_RENDER_STYLE,
  type GhosttyRenderUpdate,
  type GhosttyViewportModel,
} from "@yaade/ghostty-core";
import type { GhosttyColor } from "../../core.js";
import type {
  TerminalRenderer,
  TerminalRenderFont,
  TerminalRenderOverlays,
  TerminalRenderViewport,
} from "../terminal-renderer.js";
import { terminalRowEdges, terminalUnderlineRects } from "../render-semantics.js";
import { WebGlGlyphBatch, WebGlRectBatch } from "./batches.js";
import { WebGlGlyphAtlas } from "./glyph-atlas.js";
import { assertWebGlSelfTest, createWebGlProgram } from "./program.js";

const RECT_VERTEX = `#version 300 es
precision highp float;
layout(location=0) in vec4 rect;
layout(location=1) in vec4 color;
uniform vec2 viewport;
out vec4 instanceColor;
const vec2 corners[6] = vec2[6](
  vec2(0,0), vec2(1,0), vec2(0,1), vec2(0,1), vec2(1,0), vec2(1,1)
);
void main() {
  vec2 point = rect.xy + corners[gl_VertexID] * rect.zw;
  vec2 clip = vec2(point.x / viewport.x * 2.0 - 1.0, 1.0 - point.y / viewport.y * 2.0);
  gl_Position = vec4(clip, 0.0, 1.0);
  instanceColor = color;
}`;
const RECT_FRAGMENT = `#version 300 es
precision mediump float;
in vec4 instanceColor;
out vec4 outColor;
void main() { outColor = instanceColor; }`;
const GLYPH_VERTEX = `#version 300 es
precision highp float;
layout(location=0) in vec4 rect;
layout(location=1) in vec4 uvRect;
layout(location=2) in vec4 color;
layout(location=3) in float colorGlyph;
uniform vec2 viewport;
out vec2 uv;
out vec4 instanceColor;
flat out float useTextureColor;
const vec2 corners[6] = vec2[6](
  vec2(0,0), vec2(1,0), vec2(0,1), vec2(0,1), vec2(1,0), vec2(1,1)
);
void main() {
  vec2 corner = corners[gl_VertexID];
  vec2 point = rect.xy + corner * rect.zw;
  vec2 clip = vec2(point.x / viewport.x * 2.0 - 1.0, 1.0 - point.y / viewport.y * 2.0);
  gl_Position = vec4(clip, 0.0, 1.0);
  uv = mix(uvRect.xy, uvRect.zw, corner);
  instanceColor = color;
  useTextureColor = colorGlyph;
}`;
const GLYPH_FRAGMENT = `#version 300 es
precision mediump float;
in vec2 uv;
in vec4 instanceColor;
flat in float useTextureColor;
uniform sampler2D atlas;
out vec4 outColor;
void main() {
  vec4 sampleColor = texture(atlas, uv);
  vec3 rgb = mix(instanceColor.rgb, sampleColor.rgb, useTextureColor);
  outColor = vec4(rgb, sampleColor.a * instanceColor.a);
}`;

export interface WebGlTerminalDebugCounters {
  readonly dirtyRows: number;
  readonly retainedRows: number;
  readonly glyphInstances: number;
  readonly rectangleInstances: number;
  readonly textureUploads: number;
  readonly atlasResets: number;
  readonly atlasBytes: number;
  readonly bufferBytes: number;
  readonly drawCalls: number;
  readonly atlasOccupancy: number;
}

type RetainedRow = {
  readonly backgrounds: WebGlRectBatch;
  readonly decorations: WebGlRectBatch;
  readonly glyphs: WebGlGlyphBatch;
  version: number;
};

type BufferState = { readonly buffer: WebGLBuffer; capacity: number };

function colorValues(packed: number): readonly [number, number, number] {
  return [((packed >>> 16) & 0xff) / 255, ((packed >>> 8) & 0xff) / 255, (packed & 0xff) / 255];
}

function packedColor(color: GhosttyColor): number {
  return ((color.r & 0xff) << 16) | ((color.g & 0xff) << 8) | (color.b & 0xff);
}

function selectionColor(value: string | undefined): readonly [number, number, number, number] {
  if (value === undefined) return [72 / 255, 122 / 255, 191 / 255, 0.35];
  const match = /^rgba?\(\s*([\d.]+)[, ]+\s*([\d.]+)[, ]+\s*([\d.]+)(?:\s*[,/]\s*([\d.]+))?\s*\)$/i.exec(value);
  if (!match) return [72 / 255, 122 / 255, 191 / 255, 0.35];
  return [
    Number(match[1]) / 255,
    Number(match[2]) / 255,
    Number(match[3]) / 255,
    match[4] === undefined ? 1 : Number(match[4]),
  ];
}

function createBuffer(gl: WebGL2RenderingContext): BufferState {
  const buffer = gl.createBuffer();
  if (buffer === null) throw new Error("WebGL buffer allocation failed");
  return { buffer, capacity: 0 };
}

export class WebGl2TerminalRenderer implements TerminalRenderer {
  readonly kind = "webgl2" as const;
  private readonly rectProgram: WebGLProgram;
  private readonly glyphProgram: WebGLProgram;
  private readonly rectVao: WebGLVertexArrayObject;
  private readonly glyphVao: WebGLVertexArrayObject;
  private readonly backgroundBuffer: BufferState;
  private readonly decorationBuffer: BufferState;
  private readonly cursorBuffer: BufferState;
  private readonly glyphBuffer: BufferState;
  private readonly cursorGlyphBuffer: BufferState;
  private readonly retainedBackgrounds = new WebGlRectBatch(262_144);
  private readonly retainedDecorations = new WebGlRectBatch(262_144);
  private readonly retainedGlyphs = new WebGlGlyphBatch(131_072);
  private readonly cursors = new WebGlRectBatch(8);
  private readonly cursorGlyphs = new WebGlGlyphBatch(2);
  private readonly atlas: WebGlGlyphAtlas;
  private readonly rows: RetainedRow[] = [];
  private readonly rectViewportUniform: WebGLUniformLocation;
  private readonly glyphViewportUniform: WebGLUniformLocation;
  private readonly atlasUniform: WebGLUniformLocation;
  private viewport: TerminalRenderViewport;
  private font: TerminalRenderFont;
  private sceneUploaded = false;
  private sceneGeneration = 0;
  private hoverKey = "";
  private disposed = false;
  private debugValidation = false;
  private debug: WebGlTerminalDebugCounters = {
    dirtyRows: 0,
    retainedRows: 0,
    glyphInstances: 0,
    rectangleInstances: 0,
    textureUploads: 0,
    atlasResets: 0,
    atlasBytes: 0,
    bufferBytes: 0,
    drawCalls: 0,
    atlasOccupancy: 0,
  };

  constructor(
    readonly gl: WebGL2RenderingContext,
    font: TerminalRenderFont,
    viewport: TerminalRenderViewport,
  ) {
    assertWebGlSelfTest(gl);
    this.font = font;
    this.viewport = viewport;
    this.rectProgram = createWebGlProgram(gl, RECT_VERTEX, RECT_FRAGMENT);
    this.glyphProgram = createWebGlProgram(gl, GLYPH_VERTEX, GLYPH_FRAGMENT);
    const rectVao = gl.createVertexArray();
    const glyphVao = gl.createVertexArray();
    if (rectVao === null || glyphVao === null) throw new Error("WebGL VAO allocation failed");
    this.rectVao = rectVao;
    this.glyphVao = glyphVao;
    this.backgroundBuffer = createBuffer(gl);
    this.decorationBuffer = createBuffer(gl);
    this.cursorBuffer = createBuffer(gl);
    this.glyphBuffer = createBuffer(gl);
    this.cursorGlyphBuffer = createBuffer(gl);
    const rectViewportUniform = gl.getUniformLocation(this.rectProgram, "viewport");
    const glyphViewportUniform = gl.getUniformLocation(this.glyphProgram, "viewport");
    const atlasUniform = gl.getUniformLocation(this.glyphProgram, "atlas");
    if (rectViewportUniform === null || glyphViewportUniform === null || atlasUniform === null) {
      throw new Error("WebGL terminal uniforms are unavailable");
    }
    this.rectViewportUniform = rectViewportUniform;
    this.glyphViewportUniform = glyphViewportUniform;
    this.atlasUniform = atlasUniform;
    this.atlas = new WebGlGlyphAtlas(gl);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  }

  get debugCounters(): WebGlTerminalDebugCounters { return this.debug; }

  setDebugValidation(enabled: boolean): void { this.debugValidation = enabled; }

  resize(viewport: TerminalRenderViewport): void {
    if (viewport.pixelRatio !== this.viewport.pixelRatio) {
      this.atlas.clear();
      this.invalidateScene();
    }
    if (viewport.originY !== this.viewport.originY || viewport.padding !== this.viewport.padding) {
      this.invalidateScene();
    }
    this.viewport = viewport;
    this.gl.viewport(0, 0, this.gl.drawingBufferWidth, this.gl.drawingBufferHeight);
  }

  setFont(font: TerminalRenderFont): Promise<TerminalRenderOverlays["metrics"]> {
    this.font = font;
    this.atlas.clear();
    this.invalidateScene();
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    if (context === null) return Promise.reject(new Error("Canvas text measurement unavailable"));
    context.font = `normal 400 ${font.size}px ${font.family}`;
    const width = Math.max(1, context.measureText("M").width);
    const vertical = context.measureText("Mg");
    const ascent = vertical.actualBoundingBoxAscent || font.size;
    const descent = vertical.actualBoundingBoxDescent;
    const height = Math.max(1, Math.round(font.size * 1.35), Math.ceil(ascent + descent));
    return Promise.resolve({ width, height, baseline: Math.round((height - ascent - descent) / 2 + ascent) });
  }

  render(
    model: GhosttyViewportModel,
    update: GhosttyRenderUpdate | null,
    overlays: TerminalRenderOverlays,
  ): void {
    if (this.disposed) return;
    const uploadStart = this.atlas.uploads;
    const resetStart = this.atlas.resets;
    const nextHoverKey = overlays.hoveredLinkRange === null || overlays.hoveredLinkRange === undefined
      ? ""
      : `${overlays.hoveredLinkRange.start.x}:${overlays.hoveredLinkRange.start.y}:${overlays.hoveredLinkRange.end.x}:${overlays.hoveredLinkRange.end.y}`;
    const overlayChanged = nextHoverKey !== this.hoverKey;
    this.hoverKey = nextHoverKey;
    const full = overlays.forceFull || update?.full === true || overlayChanged ||
      this.rows.length !== model.rows || this.sceneGeneration !== model.currentGeneration;
    const dirty = full
      ? Array.from({ length: model.rows }, (_, row) => row)
      : [...(overlays.dirtyRows ?? model.dirtyRows)];

    let atlasGeneration = this.atlas.generation;
    this.updateRows(model, overlays, dirty, full);
    if (atlasGeneration !== this.atlas.generation) {
      // Pressure reset invalidated retained UVs. Rebuild once against the fresh
      // bounded atlas; this is normal cache policy, not renderer recovery.
      atlasGeneration = this.atlas.generation;
      this.updateRows(
        model,
        overlays,
        Array.from({ length: model.rows }, (_, row) => row),
        true,
      );
      if (atlasGeneration !== this.atlas.generation) {
        // The complete unique cluster set cannot fit the configured budget.
        // Keep rendering the most recent complete atlas generation without
        // escalating through the context recovery ladder.
        this.invalidateScene();
      }
    }
    this.sceneGeneration = model.currentGeneration;

    if (!this.sceneUploaded) this.uploadRetainedScene();
    this.buildCursor(model, overlays);
    const gl = this.gl;
    const background = colorValues(packedColor(model.background));
    gl.clearColor(background[0], background[1], background[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    let drawCalls = 0;
    drawCalls += this.drawRects(this.backgroundBuffer, this.retainedBackgrounds.count, false);
    drawCalls += this.drawGlyphs(this.glyphBuffer, this.retainedGlyphs.count, false);
    drawCalls += this.drawRects(this.decorationBuffer, this.retainedDecorations.count, false);
    drawCalls += this.drawRects(this.cursorBuffer, this.cursors.count, true, this.cursors.data);
    drawCalls += this.drawGlyphs(this.cursorGlyphBuffer, this.cursorGlyphs.count, true, this.cursorGlyphs.data);
    if (this.debugValidation) {
      const error = gl.getError();
      if (error !== gl.NO_ERROR) throw new Error(`WebGL render failed with error ${error}`);
    }
    this.debug = {
      dirtyRows: dirty.length,
      retainedRows: this.rows.length,
      glyphInstances: this.retainedGlyphs.count + this.cursorGlyphs.count,
      rectangleInstances:
        this.retainedBackgrounds.count + this.retainedDecorations.count + this.cursors.count,
      textureUploads: this.atlas.uploads - uploadStart,
      atlasResets: this.atlas.resets - resetStart,
      atlasBytes: this.atlas.allocatedBytes,
      bufferBytes:
        this.retainedBackgrounds.data.byteLength + this.retainedGlyphs.data.byteLength +
        this.retainedDecorations.data.byteLength + this.cursors.data.byteLength +
        this.cursorGlyphs.data.byteLength,
      drawCalls,
      atlasOccupancy: this.atlas.occupancy,
    };
  }

  capturePixels(): Promise<ImageData> {
    const gl = this.gl;
    const width = gl.drawingBufferWidth;
    const height = gl.drawingBufferHeight;
    const texture = gl.createTexture();
    const framebuffer = gl.createFramebuffer();
    if (texture === null || framebuffer === null) {
      if (texture !== null) gl.deleteTexture(texture);
      if (framebuffer !== null) gl.deleteFramebuffer(framebuffer);
      return Promise.reject(new Error("WebGL capture framebuffer allocation failed"));
    }
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(
      gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0,
      gl.RGBA, gl.UNSIGNED_BYTE, null,
    );
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D,
      texture,
      0,
    );
    gl.viewport(0, 0, width, height);
    const background = colorValues(this.rows.length > 0 ? 0 : 0);
    gl.clearColor(background[0], background[1], background[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    this.drawRects(this.backgroundBuffer, this.retainedBackgrounds.count, false);
    this.drawGlyphs(this.glyphBuffer, this.retainedGlyphs.count, false);
    this.drawRects(this.decorationBuffer, this.retainedDecorations.count, false);
    this.drawRects(this.cursorBuffer, this.cursors.count, false);
    this.drawGlyphs(this.cursorGlyphBuffer, this.cursorGlyphs.count, false);
    const source = new Uint8Array(width * height * 4);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.deleteFramebuffer(framebuffer);
    gl.deleteTexture(texture);
    const normalized = new Uint8ClampedArray(source.length);
    const stride = width * 4;
    for (let row = 0; row < height; row += 1) {
      normalized.set(source.subarray(row * stride, (row + 1) * stride), (height - row - 1) * stride);
    }
    return Promise.resolve(new ImageData(normalized, width, height));
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const gl = this.gl;
    this.atlas.dispose();
    for (const state of [
      this.backgroundBuffer,
      this.decorationBuffer,
      this.cursorBuffer,
      this.glyphBuffer,
      this.cursorGlyphBuffer,
    ]) gl.deleteBuffer(state.buffer);
    gl.deleteVertexArray(this.rectVao);
    gl.deleteVertexArray(this.glyphVao);
    gl.deleteProgram(this.rectProgram);
    gl.deleteProgram(this.glyphProgram);
  }

  private updateRows(
    model: GhosttyViewportModel,
    overlays: TerminalRenderOverlays,
    rows: readonly number[],
    full: boolean,
  ): void {
    if (full) {
      this.rows.length = model.rows;
      for (let row = 0; row < model.rows; row += 1) this.rows[row] = this.buildRow(model, overlays, row);
    } else {
      for (const row of rows) {
        if (row >= 0 && row < model.rows) this.rows[row] = this.buildRow(model, overlays, row);
      }
    }
    this.sceneUploaded = false;
  }

  private buildRow(
    model: GhosttyViewportModel,
    overlays: TerminalRenderOverlays,
    row: number,
  ): RetainedRow {
    const backgrounds = new WebGlRectBatch(Math.max(8, model.cols * 2));
    const decorations = new WebGlRectBatch(Math.max(8, model.cols * 8));
    const glyphs = new WebGlGlyphBatch(Math.max(8, model.cols));
    const edges = terminalRowEdges(
      overlays.viewport.originY,
      row,
      overlays.metrics.height,
      overlays.viewport.pixelRatio,
    );
    const top = edges.top;
    const height = Math.max(0, edges.bottom - edges.top);
    const selection = selectionColor(overlays.selectionBackground);
    const defaultBackgroundPacked = packedColor(model.background);
    for (let column = 0; column < model.cols; column += 1) {
      const style = model.styleAt(row, column);
      const left = overlays.viewport.padding + column * overlays.metrics.width;
      const backgroundPacked = model.backgroundAt(row, column);
      if (backgroundPacked !== defaultBackgroundPacked) {
        const color = colorValues(backgroundPacked);
        backgrounds.push(left, top, overlays.metrics.width, height, color[0], color[1], color[2]);
      }
      if ((style & GHOSTTY_RENDER_STYLE.selected) !== 0) {
        backgrounds.push(
          left, top, overlays.metrics.width, height,
          selection[0], selection[1], selection[2], selection[3],
        );
      }
      const foreground = colorValues(model.foregroundAt(row, column));
      const explicitUnderline =
        (style & GHOSTTY_RENDER_STYLE.underlineMask) >>> GHOSTTY_RENDER_STYLE.underlineShift;
      const hoverUnderline = explicitUnderline === 0 &&
        overlays.hoveredLinkRange !== null && overlays.hoveredLinkRange !== undefined &&
        row >= overlays.hoveredLinkRange.start.y && row <= overlays.hoveredLinkRange.end.y &&
        (row > overlays.hoveredLinkRange.start.y || column >= overlays.hoveredLinkRange.start.x) &&
        (row < overlays.hoveredLinkRange.end.y || column <= overlays.hoveredLinkRange.end.x);
      const underline = explicitUnderline || (hoverUnderline ? 1 : 0);
      for (const rect of terminalUnderlineRects(
        underline,
        left,
        edges.bottom - 1,
        overlays.metrics.width,
        overlays.viewport.pixelRatio,
      )) {
        decorations.push(rect.x, rect.y, rect.width, rect.height, foreground[0], foreground[1], foreground[2]);
      }
      if ((style & GHOSTTY_RENDER_STYLE.strikethrough) !== 0) {
        decorations.push(
          left,
          top + Math.floor(height * 0.55),
          overlays.metrics.width,
          Math.max(1 / overlays.viewport.pixelRatio, 1),
          foreground[0], foreground[1], foreground[2],
        );
      }
      if ((style & GHOSTTY_RENDER_STYLE.overline) !== 0) {
        decorations.push(
          left, top, overlays.metrics.width, Math.max(1 / overlays.viewport.pixelRatio, 1),
          foreground[0], foreground[1], foreground[2],
        );
      }
      const text = model.textAt(row, column);
      const invisible = (style & GHOSTTY_RENDER_STYLE.invisible) !== 0;
      if (text.length === 0 || text === " " || invisible) continue;
      const width = style & GHOSTTY_RENDER_STYLE.widthMask;
      const span = width === 1 ? 2 : 1;
      const entry = this.atlas.get({
        text,
        cellSpan: span,
        metrics: overlays.metrics,
        font: overlays.font,
        bold: (style & GHOSTTY_RENDER_STYLE.bold) !== 0,
        italic: (style & GHOSTTY_RENDER_STYLE.italic) !== 0,
        pixelRatio: overlays.viewport.pixelRatio,
      });
      glyphs.push(
        left, top, overlays.metrics.width * span, height,
        entry.u0, entry.v0, entry.u1, entry.v1,
        foreground[0], foreground[1], foreground[2], 1,
        entry.colorGlyph ? 1 : 0,
      );
    }
    return { backgrounds, decorations, glyphs, version: model.rowVersions[row] ?? 0 };
  }

  private uploadRetainedScene(): void {
    this.retainedBackgrounds.clear();
    this.retainedDecorations.clear();
    this.retainedGlyphs.clear();
    for (const row of this.rows) {
      if (row === undefined) continue;
      this.retainedBackgrounds.append(row.backgrounds);
      this.retainedDecorations.append(row.decorations);
      this.retainedGlyphs.append(row.glyphs);
    }
    this.upload(this.backgroundBuffer, this.retainedBackgrounds.data);
    this.upload(this.decorationBuffer, this.retainedDecorations.data);
    this.upload(this.glyphBuffer, this.retainedGlyphs.data);
    this.sceneUploaded = true;
  }

  private buildCursor(model: GhosttyViewportModel, overlays: TerminalRenderOverlays): void {
    this.cursors.clear();
    this.cursorGlyphs.clear();
    if (!overlays.cursorOn || !model.cursorVisible || model.cursorX < 0 || model.cursorY < 0) return;
    const left = overlays.viewport.padding + model.cursorX * overlays.metrics.width;
    const edges = terminalRowEdges(
      overlays.viewport.originY,
      model.cursorY,
      overlays.metrics.height,
      overlays.viewport.pixelRatio,
    );
    const top = edges.top;
    const height = edges.bottom - edges.top;
    const cursor = colorValues(packedColor(model.cursor));
    if (!overlays.focused || model.cursorStyle === 3) {
      const line = Math.max(1 / overlays.viewport.pixelRatio, 1);
      this.cursors.push(left, top, overlays.metrics.width, line, cursor[0], cursor[1], cursor[2]);
      this.cursors.push(left, edges.bottom - line, overlays.metrics.width, line, cursor[0], cursor[1], cursor[2]);
      this.cursors.push(left, top, line, height, cursor[0], cursor[1], cursor[2]);
      this.cursors.push(left + overlays.metrics.width - line, top, line, height, cursor[0], cursor[1], cursor[2]);
      return;
    }
    if (model.cursorStyle === 0) {
      this.cursors.push(left, top, 2, height, cursor[0], cursor[1], cursor[2]);
      return;
    }
    if (model.cursorStyle === 2) {
      this.cursors.push(left, edges.bottom - 2, overlays.metrics.width, 2, cursor[0], cursor[1], cursor[2]);
      return;
    }
    this.cursors.push(left, top, overlays.metrics.width, height, cursor[0], cursor[1], cursor[2]);
    const text = model.textAt(model.cursorY, model.cursorX);
    const style = model.styleAt(model.cursorY, model.cursorX);
    if (text.length === 0 || text === " " || (style & GHOSTTY_RENDER_STYLE.invisible) !== 0) return;
    const span = (style & GHOSTTY_RENDER_STYLE.widthMask) === 1 ? 2 : 1;
    const entry = this.atlas.get({
      text,
      cellSpan: span,
      metrics: overlays.metrics,
      font: overlays.font,
      bold: (style & GHOSTTY_RENDER_STYLE.bold) !== 0,
      italic: (style & GHOSTTY_RENDER_STYLE.italic) !== 0,
      pixelRatio: overlays.viewport.pixelRatio,
    });
    const inverse = colorValues(model.backgroundAt(model.cursorY, model.cursorX));
    this.cursorGlyphs.push(
      left, top, overlays.metrics.width * span, height,
      entry.u0, entry.v0, entry.u1, entry.v1,
      inverse[0], inverse[1], inverse[2], 1,
      entry.colorGlyph ? 1 : 0,
    );
  }

  private invalidateScene(): void {
    this.rows.length = 0;
    this.sceneGeneration = 0;
    this.sceneUploaded = false;
  }

  private upload(state: BufferState, data: Float32Array): void {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, state.buffer);
    if (data.byteLength > state.capacity) {
      let capacity = 1024;
      while (capacity < data.byteLength) capacity *= 2;
      gl.bufferData(gl.ARRAY_BUFFER, capacity, gl.DYNAMIC_DRAW);
      state.capacity = capacity;
    }
    if (data.byteLength > 0) gl.bufferSubData(gl.ARRAY_BUFFER, 0, data);
  }

  private configureRectVao(buffer: WebGLBuffer): void {
    const gl = this.gl;
    gl.bindVertexArray(this.rectVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    for (let location = 0; location < 2; location += 1) {
      gl.enableVertexAttribArray(location);
      gl.vertexAttribPointer(location, 4, gl.FLOAT, false, 8 * 4, location * 4 * 4);
      gl.vertexAttribDivisor(location, 1);
    }
  }

  private configureGlyphVao(buffer: WebGLBuffer): void {
    const gl = this.gl;
    gl.bindVertexArray(this.glyphVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    for (let location = 0; location < 3; location += 1) {
      gl.enableVertexAttribArray(location);
      gl.vertexAttribPointer(location, 4, gl.FLOAT, false, 13 * 4, location * 4 * 4);
      gl.vertexAttribDivisor(location, 1);
    }
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 1, gl.FLOAT, false, 13 * 4, 12 * 4);
    gl.vertexAttribDivisor(3, 1);
  }

  private drawRects(
    state: BufferState,
    count: number,
    update: boolean,
    data?: Float32Array,
  ): number {
    if (count === 0) return 0;
    if (update && data !== undefined) this.upload(state, data);
    const gl = this.gl;
    this.configureRectVao(state.buffer);
    gl.useProgram(this.rectProgram);
    gl.uniform2f(this.rectViewportUniform, this.viewport.cssWidth, this.viewport.cssHeight);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, count);
    return 1;
  }

  private drawGlyphs(
    state: BufferState,
    count: number,
    update: boolean,
    data?: Float32Array,
  ): number {
    if (count === 0) return 0;
    if (update && data !== undefined) this.upload(state, data);
    const gl = this.gl;
    this.configureGlyphVao(state.buffer);
    gl.useProgram(this.glyphProgram);
    gl.uniform2f(this.glyphViewportUniform, this.viewport.cssWidth, this.viewport.cssHeight);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.atlas.texture);
    gl.uniform1i(this.atlasUniform, 0);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, count);
    return 1;
  }
}
