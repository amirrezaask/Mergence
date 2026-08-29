import type { GhosttyCellMetrics } from "../../renderer.js";
import type { TerminalRenderFont } from "../terminal-renderer.js";

export interface WebGlGlyphAtlasEntry {
  readonly u0: number;
  readonly v0: number;
  readonly u1: number;
  readonly v1: number;
  readonly colorGlyph: boolean;
}

const PADDING = 2;
const COLOR_GLYPH = /\p{Extended_Pictographic}/u;

export class WebGlGlyphAtlas {
  readonly texture: WebGLTexture;
  readonly size: number;
  private readonly entries = new Map<string, WebGlGlyphAtlasEntry>();
  private readonly canvas = document.createElement("canvas");
  private readonly context: CanvasRenderingContext2D;
  private nextX = 0;
  private nextY = 0;
  private shelfHeight = 0;
  private generationValue = 1;
  private uploadsValue = 0;

  constructor(private readonly gl: WebGL2RenderingContext, maximumSize = 2048) {
    this.size = Math.max(256, Math.min(maximumSize, gl.getParameter(gl.MAX_TEXTURE_SIZE)));
    const context = this.canvas.getContext("2d", { willReadFrequently: true });
    const texture = gl.createTexture();
    if (context === null || texture === null) {
      throw new Error("WebGL glyph atlas initialization failed");
    }
    this.context = context;
    this.texture = texture;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      this.size,
      this.size,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      null,
    );
  }

  get generation(): number { return this.generationValue; }
  get uploads(): number { return this.uploadsValue; }
  get occupancy(): number {
    return (this.nextY * this.size + this.nextX * Math.max(1, this.shelfHeight)) /
      (this.size * this.size);
  }

  get(options: {
    readonly text: string;
    readonly cellSpan: number;
    readonly metrics: GhosttyCellMetrics;
    readonly font: TerminalRenderFont;
    readonly bold: boolean;
    readonly italic: boolean;
    readonly pixelRatio: number;
  }): WebGlGlyphAtlasEntry {
    const colorGlyph = COLOR_GLYPH.test(options.text);
    const key = [
      options.font.family,
      options.font.size,
      options.bold ? 700 : 400,
      options.italic ? "italic" : "normal",
      options.pixelRatio,
      options.cellSpan,
      colorGlyph ? "color" : "mask",
      options.text,
    ].join("\u0000");
    const cached = this.entries.get(key);
    if (cached) return cached;

    const ratio = options.pixelRatio;
    const width = Math.max(1, Math.ceil(options.metrics.width * options.cellSpan * ratio));
    const height = Math.max(1, Math.ceil(options.metrics.height * ratio));
    const atlasWidth = width + PADDING * 2;
    const atlasHeight = height + PADDING * 2;
    if (atlasWidth > this.size || atlasHeight > this.size) {
      throw new Error("Glyph exceeds the bounded WebGL atlas");
    }
    if (this.nextX + atlasWidth > this.size) {
      this.nextX = 0;
      this.nextY += this.shelfHeight;
      this.shelfHeight = 0;
    }
    if (this.nextY + atlasHeight > this.size) {
      this.clear();
    }

    this.canvas.width = atlasWidth;
    this.canvas.height = atlasHeight;
    this.context.clearRect(0, 0, atlasWidth, atlasHeight);
    this.context.setTransform(ratio, 0, 0, ratio, PADDING, PADDING);
    this.context.textBaseline = "alphabetic";
    this.context.font = `${options.italic ? "italic" : "normal"} ${options.bold ? 700 : 400} ${options.font.size}px ${options.font.family}`;
    this.context.fillStyle = "rgb(255, 255, 255)";
    this.context.beginPath();
    this.context.rect(0, 0, options.metrics.width * options.cellSpan, options.metrics.height);
    this.context.clip();
    this.context.fillText(options.text, 0, options.metrics.baseline);
    this.context.setTransform(1, 0, 0, 1, 0, 0);

    const x = this.nextX;
    const y = this.nextY;
    const pixels = this.context.getImageData(0, 0, atlasWidth, atlasHeight);
    this.gl.bindTexture(this.gl.TEXTURE_2D, this.texture);
    this.gl.pixelStorei(this.gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    this.gl.texSubImage2D(
      this.gl.TEXTURE_2D,
      0,
      x,
      y,
      atlasWidth,
      atlasHeight,
      this.gl.RGBA,
      this.gl.UNSIGNED_BYTE,
      pixels.data,
    );
    this.uploadsValue += 1;
    const entry = {
      u0: (x + PADDING) / this.size,
      v0: (y + PADDING) / this.size,
      u1: (x + PADDING + width) / this.size,
      v1: (y + PADDING + height) / this.size,
      colorGlyph,
    };
    this.entries.set(key, entry);
    this.nextX += atlasWidth;
    this.shelfHeight = Math.max(this.shelfHeight, atlasHeight);
    return entry;
  }

  clear(): void {
    this.entries.clear();
    this.nextX = 0;
    this.nextY = 0;
    this.shelfHeight = 0;
    this.generationValue += 1;
    this.gl.bindTexture(this.gl.TEXTURE_2D, this.texture);
    this.gl.texImage2D(
      this.gl.TEXTURE_2D,
      0,
      this.gl.RGBA,
      this.size,
      this.size,
      0,
      this.gl.RGBA,
      this.gl.UNSIGNED_BYTE,
      null,
    );
  }

  dispose(): void {
    this.entries.clear();
    this.gl.deleteTexture(this.texture);
  }
}
