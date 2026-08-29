import {
  type GhosttyRenderUpdate,
  type GhosttyViewportModel,
} from "@yaade/ghostty-core";
import { ghosttyColorsEqual, type GhosttyColor } from "../../core.js";
import { ghosttyTextRunEnd } from "../../renderer.js";
import type {
  TerminalRenderer,
  TerminalRenderFont,
  TerminalRenderOverlays,
  TerminalRenderViewport,
} from "../terminal-renderer.js";
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
  readonly glyphInstances: number;
  readonly rectangleInstances: number;
  readonly textureUploads: number;
  readonly bufferBytes: number;
  readonly drawCalls: number;
  readonly atlasOccupancy: number;
}

function colorValues(color: GhosttyColor): readonly [number, number, number] {
  return [color.r / 255, color.g / 255, color.b / 255];
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

export class WebGl2TerminalRenderer implements TerminalRenderer {
  readonly kind = "webgl2" as const;
  private readonly rectProgram: WebGLProgram;
  private readonly glyphProgram: WebGLProgram;
  private readonly rectVao: WebGLVertexArrayObject;
  private readonly glyphVao: WebGLVertexArrayObject;
  private readonly rectBuffer: WebGLBuffer;
  private readonly glyphBuffer: WebGLBuffer;
  private readonly backgrounds = new WebGlRectBatch(262_144);
  private readonly decorations = new WebGlRectBatch(262_144);
  private readonly cursors = new WebGlRectBatch(8);
  private readonly glyphs = new WebGlGlyphBatch(131_072);
  private readonly atlas: WebGlGlyphAtlas;
  private viewport: TerminalRenderViewport;
  private font: TerminalRenderFont;
  private rectBufferCapacity = 0;
  private glyphBufferCapacity = 0;
  private disposed = false;
  private debug: WebGlTerminalDebugCounters = {
    dirtyRows: 0,
    glyphInstances: 0,
    rectangleInstances: 0,
    textureUploads: 0,
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
    const rectBuffer = gl.createBuffer();
    const glyphBuffer = gl.createBuffer();
    if (rectVao === null || glyphVao === null || rectBuffer === null || glyphBuffer === null) {
      throw new Error("WebGL buffer allocation failed");
    }
    this.rectVao = rectVao;
    this.glyphVao = glyphVao;
    this.rectBuffer = rectBuffer;
    this.glyphBuffer = glyphBuffer;
    this.configureRectVao();
    this.configureGlyphVao();
    this.atlas = new WebGlGlyphAtlas(gl);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  }

  get debugCounters(): WebGlTerminalDebugCounters { return this.debug; }

  resize(viewport: TerminalRenderViewport): void {
    if (viewport.pixelRatio !== this.viewport.pixelRatio) this.atlas.clear();
    this.viewport = viewport;
    this.gl.viewport(0, 0, this.gl.drawingBufferWidth, this.gl.drawingBufferHeight);
  }

  setFont(font: TerminalRenderFont): Promise<TerminalRenderOverlays["metrics"]> {
    this.font = font;
    this.atlas.clear();
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
    _update: GhosttyRenderUpdate | null,
    overlays: TerminalRenderOverlays,
  ): void {
    if (this.disposed) return;
    const gl = this.gl;
    const rows = overlays.forceFull
      ? Array.from({ length: model.rows }, (_, index) => index)
      : [...(overlays.dirtyRows ?? model.dirtyRows)];
    if (
      overlays.previousCursorY !== null && overlays.previousCursorY !== undefined &&
      !rows.includes(overlays.previousCursorY)
    ) rows.push(overlays.previousCursorY);
    if (model.cursorVisible && model.cursorY >= 0 && !rows.includes(model.cursorY)) {
      rows.push(model.cursorY);
    }
    this.backgrounds.clear();
    this.decorations.clear();
    this.cursors.clear();
    this.glyphs.clear();
    const selection = selectionColor(overlays.selectionBackground);
    const defaultBackground = colorValues(model.background);
    const uploadStart = this.atlas.uploads;
    const atlasGeneration = this.atlas.generation;

    if (overlays.forceFull) {
      gl.clearColor(defaultBackground[0], defaultBackground[1], defaultBackground[2], 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    for (const rowIndex of rows) {
      const row = model.rowData[rowIndex];
      if (!row) continue;
      const top = overlays.viewport.originY + rowIndex * overlays.metrics.height;
      this.backgrounds.push(
        overlays.viewport.padding,
        top,
        model.cols * overlays.metrics.width,
        overlays.metrics.height,
        defaultBackground[0],
        defaultBackground[1],
        defaultBackground[2],
      );
      for (let column = 0; column < row.cells.length; column += 1) {
        const cell = row.cells[column];
        if (!cell) continue;
        const left = overlays.viewport.padding + column * overlays.metrics.width;
        const background = colorValues(cell.background);
        if (
          cell.background.r !== model.background.r ||
          cell.background.g !== model.background.g ||
          cell.background.b !== model.background.b
        ) {
          this.backgrounds.push(
            left, top, overlays.metrics.width, overlays.metrics.height,
            background[0], background[1], background[2],
          );
        }
        if (cell.selected) {
          this.backgrounds.push(
            left, top, overlays.metrics.width, overlays.metrics.height,
            selection[0], selection[1], selection[2], selection[3],
          );
        }
        const foreground = colorValues(cell.foreground);
        const underline =
          cell.underline > 0 ||
          (overlays.hoveredLinkRange !== null && overlays.hoveredLinkRange !== undefined &&
            rowIndex >= overlays.hoveredLinkRange.start.y &&
            rowIndex <= overlays.hoveredLinkRange.end.y &&
            (rowIndex > overlays.hoveredLinkRange.start.y || column >= overlays.hoveredLinkRange.start.x) &&
            (rowIndex < overlays.hoveredLinkRange.end.y || column <= overlays.hoveredLinkRange.end.x));
        if (underline) {
          this.decorations.push(
            left, top + overlays.metrics.height - 2,
            overlays.metrics.width, 1,
            foreground[0], foreground[1], foreground[2],
          );
        }
        if (cell.strikethrough) {
          this.decorations.push(
            left, top + Math.floor(overlays.metrics.height * 0.55),
            overlays.metrics.width, 1,
            foreground[0], foreground[1], foreground[2],
          );
        }
        if (cell.overline) {
          this.decorations.push(
            left, top + 1, overlays.metrics.width, 1,
            foreground[0], foreground[1], foreground[2],
          );
        }
      }

      // Match Canvas shaping: adjacent cells with the same face/color become
      // one atlas glyph run. Floods of uniform text therefore emit one instance
      // per row rather than one instance per cell.
      let runStart = 0;
      const maxRunCells = Math.max(
        1,
        Math.floor((this.atlas.size - 4) / (overlays.metrics.width * overlays.viewport.pixelRatio)),
      );
      while (runStart < row.cells.length) {
        const first = row.cells[runStart];
        if (!first || first.text.length === 0) {
          runStart += 1;
          continue;
        }
        const styleEnd = ghosttyTextRunEnd(row.cells, runStart, (next) =>
          ghosttyColorsEqual(next.foreground, first.foreground) &&
          next.bold === first.bold &&
          next.italic === first.italic &&
          next.invisible === first.invisible,
        );
        let chunkStart = runStart;
        while (chunkStart < styleEnd) {
          const chunkEnd = Math.min(styleEnd, chunkStart + maxRunCells);
          let text = "";
          let hasVisibleText = false;
          for (let column = chunkStart; column < chunkEnd; column += 1) {
            const value = row.cells[column]?.text ?? "";
            text += value;
            if (value !== "" && value !== " ") hasVisibleText = true;
          }
          if (!first.invisible && hasVisibleText) {
            const span = chunkEnd - chunkStart;
            const entry = this.atlas.get({
              text,
              cellSpan: span,
              metrics: overlays.metrics,
              font: overlays.font,
              bold: first.bold,
              italic: first.italic,
              pixelRatio: overlays.viewport.pixelRatio,
            });
            const foreground = colorValues(first.foreground);
            this.glyphs.push(
              overlays.viewport.padding + chunkStart * overlays.metrics.width,
              top,
              overlays.metrics.width * span,
              overlays.metrics.height,
              entry.u0, entry.v0, entry.u1, entry.v1,
              foreground[0], foreground[1], foreground[2], 1,
              entry.colorGlyph ? 1 : 0,
            );
          }
          chunkStart = chunkEnd;
        }
        runStart = styleEnd;
      }
    }
    if (atlasGeneration !== this.atlas.generation) {
      // A bounded-atlas rebuild invalidates UVs emitted earlier in this frame.
      // The next authoritative frame rebuilds all rows against the new atlas.
      throw new Error("WebGL glyph atlas rebuilt during frame construction");
    }

    if (overlays.cursorOn && model.cursorVisible && model.cursorX >= 0 && model.cursorY >= 0) {
      const left = overlays.viewport.padding + model.cursorX * overlays.metrics.width;
      const top = overlays.viewport.originY + model.cursorY * overlays.metrics.height;
      const cursor = colorValues(model.cursor);
      if (!overlays.focused || model.cursorStyle === 3) {
        this.cursors.push(left, top, overlays.metrics.width, 1, cursor[0], cursor[1], cursor[2]);
        this.cursors.push(left, top + overlays.metrics.height - 1, overlays.metrics.width, 1, cursor[0], cursor[1], cursor[2]);
        this.cursors.push(left, top, 1, overlays.metrics.height, cursor[0], cursor[1], cursor[2]);
        this.cursors.push(left + overlays.metrics.width - 1, top, 1, overlays.metrics.height, cursor[0], cursor[1], cursor[2]);
      } else if (model.cursorStyle === 0) {
        this.cursors.push(left, top, 2, overlays.metrics.height, cursor[0], cursor[1], cursor[2]);
      } else if (model.cursorStyle === 2) {
        this.cursors.push(left, top + overlays.metrics.height - 2, overlays.metrics.width, 2, cursor[0], cursor[1], cursor[2]);
      } else {
        this.cursors.push(left, top, overlays.metrics.width, overlays.metrics.height, cursor[0], cursor[1], cursor[2]);
      }
    }

    let drawCalls = 0;
    drawCalls += this.drawRects(this.backgrounds);
    drawCalls += this.drawGlyphs();
    drawCalls += this.drawRects(this.decorations);
    drawCalls += this.drawRects(this.cursors);
    const error = gl.getError();
    if (error !== gl.NO_ERROR) throw new Error(`WebGL render failed with error ${error}`);
    this.debug = {
      dirtyRows: rows.length,
      glyphInstances: this.glyphs.count,
      rectangleInstances: this.backgrounds.count + this.decorations.count + this.cursors.count,
      textureUploads: this.atlas.uploads - uploadStart,
      bufferBytes: this.backgrounds.data.byteLength + this.glyphs.data.byteLength +
        this.decorations.data.byteLength + this.cursors.data.byteLength,
      drawCalls,
      atlasOccupancy: this.atlas.occupancy,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const gl = this.gl;
    this.atlas.dispose();
    gl.deleteBuffer(this.rectBuffer);
    gl.deleteBuffer(this.glyphBuffer);
    gl.deleteVertexArray(this.rectVao);
    gl.deleteVertexArray(this.glyphVao);
    gl.deleteProgram(this.rectProgram);
    gl.deleteProgram(this.glyphProgram);
  }

  private configureRectVao(): void {
    const gl = this.gl;
    gl.bindVertexArray(this.rectVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.rectBuffer);
    for (let location = 0; location < 2; location += 1) {
      gl.enableVertexAttribArray(location);
      gl.vertexAttribPointer(location, 4, gl.FLOAT, false, 8 * 4, location * 4 * 4);
      gl.vertexAttribDivisor(location, 1);
    }
    gl.bindVertexArray(null);
  }

  private configureGlyphVao(): void {
    const gl = this.gl;
    gl.bindVertexArray(this.glyphVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.glyphBuffer);
    for (let location = 0; location < 3; location += 1) {
      gl.enableVertexAttribArray(location);
      gl.vertexAttribPointer(location, 4, gl.FLOAT, false, 13 * 4, location * 4 * 4);
      gl.vertexAttribDivisor(location, 1);
    }
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 1, gl.FLOAT, false, 13 * 4, 12 * 4);
    gl.vertexAttribDivisor(3, 1);
    gl.bindVertexArray(null);
  }

  private upload(buffer: WebGLBuffer, data: Float32Array, glyph: boolean): void {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    const current = glyph ? this.glyphBufferCapacity : this.rectBufferCapacity;
    if (data.byteLength > current) {
      let capacity = 1024;
      while (capacity < data.byteLength) capacity *= 2;
      gl.bufferData(gl.ARRAY_BUFFER, capacity, gl.DYNAMIC_DRAW);
      if (glyph) this.glyphBufferCapacity = capacity;
      else this.rectBufferCapacity = capacity;
    }
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, data);
  }

  private drawRects(batch: WebGlRectBatch): number {
    if (batch.count === 0) return 0;
    const gl = this.gl;
    this.upload(this.rectBuffer, batch.data, false);
    gl.useProgram(this.rectProgram);
    gl.uniform2f(
      gl.getUniformLocation(this.rectProgram, "viewport"),
      this.viewport.cssWidth,
      this.viewport.cssHeight,
    );
    gl.bindVertexArray(this.rectVao);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, batch.count);
    return 1;
  }

  private drawGlyphs(): number {
    if (this.glyphs.count === 0) return 0;
    const gl = this.gl;
    this.upload(this.glyphBuffer, this.glyphs.data, true);
    gl.useProgram(this.glyphProgram);
    gl.uniform2f(
      gl.getUniformLocation(this.glyphProgram, "viewport"),
      this.viewport.cssWidth,
      this.viewport.cssHeight,
    );
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.atlas.texture);
    gl.uniform1i(gl.getUniformLocation(this.glyphProgram, "atlas"), 0);
    gl.bindVertexArray(this.glyphVao);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, this.glyphs.count);
    return 1;
  }
}
