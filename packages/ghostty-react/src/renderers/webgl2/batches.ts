export const WEBGL_RECT_FLOATS = 8;
export const WEBGL_GLYPH_FLOATS = 13;

function nextCapacity(required: number, maximum: number): number {
  let capacity = 64;
  while (capacity < required && capacity < maximum) capacity *= 2;
  return Math.min(capacity, maximum);
}

export class WebGlRectBatch {
  private values = new Float32Array(WEBGL_RECT_FLOATS * 64);
  private countValue = 0;

  constructor(private readonly maximumInstances: number) {}

  get count(): number { return this.countValue; }
  get data(): Float32Array { return this.values.subarray(0, this.countValue * WEBGL_RECT_FLOATS); }

  clear(): void { this.countValue = 0; }

  append(other: WebGlRectBatch): boolean {
    if (!this.reserve(other.count)) return false;
    this.values.set(other.data, this.countValue * WEBGL_RECT_FLOATS);
    this.countValue += other.count;
    return true;
  }

  push(
    x: number,
    y: number,
    width: number,
    height: number,
    red: number,
    green: number,
    blue: number,
    alpha = 1,
  ): boolean {
    if (!this.reserve(1)) return false;
    const offset = this.countValue * WEBGL_RECT_FLOATS;
    this.values[offset] = x;
    this.values[offset + 1] = y;
    this.values[offset + 2] = width;
    this.values[offset + 3] = height;
    this.values[offset + 4] = red;
    this.values[offset + 5] = green;
    this.values[offset + 6] = blue;
    this.values[offset + 7] = alpha;
    this.countValue += 1;
    return true;
  }

  private reserve(additional: number): boolean {
    const requiredInstances = this.countValue + additional;
    if (requiredInstances > this.maximumInstances) return false;
    const required = requiredInstances * WEBGL_RECT_FLOATS;
    if (required <= this.values.length) return true;
    const next = new Float32Array(
      nextCapacity(requiredInstances, this.maximumInstances) * WEBGL_RECT_FLOATS,
    );
    next.set(this.values.subarray(0, this.countValue * WEBGL_RECT_FLOATS));
    this.values = next;
    return true;
  }
}

export class WebGlGlyphBatch {
  private values = new Float32Array(WEBGL_GLYPH_FLOATS * 64);
  private countValue = 0;

  constructor(private readonly maximumInstances: number) {}

  get count(): number { return this.countValue; }
  get data(): Float32Array { return this.values.subarray(0, this.countValue * WEBGL_GLYPH_FLOATS); }

  clear(): void { this.countValue = 0; }

  append(other: WebGlGlyphBatch): boolean {
    if (!this.reserve(other.count)) return false;
    this.values.set(other.data, this.countValue * WEBGL_GLYPH_FLOATS);
    this.countValue += other.count;
    return true;
  }

  push(
    x: number,
    y: number,
    width: number,
    height: number,
    u0: number,
    v0: number,
    u1: number,
    v1: number,
    red: number,
    green: number,
    blue: number,
    alpha = 1,
    colorGlyph = 0,
  ): boolean {
    if (!this.reserve(1)) return false;
    const offset = this.countValue * WEBGL_GLYPH_FLOATS;
    this.values[offset] = x;
    this.values[offset + 1] = y;
    this.values[offset + 2] = width;
    this.values[offset + 3] = height;
    this.values[offset + 4] = u0;
    this.values[offset + 5] = v0;
    this.values[offset + 6] = u1;
    this.values[offset + 7] = v1;
    this.values[offset + 8] = red;
    this.values[offset + 9] = green;
    this.values[offset + 10] = blue;
    this.values[offset + 11] = alpha;
    this.values[offset + 12] = colorGlyph;
    this.countValue += 1;
    return true;
  }

  private reserve(additional: number): boolean {
    const requiredInstances = this.countValue + additional;
    if (requiredInstances > this.maximumInstances) return false;
    const required = requiredInstances * WEBGL_GLYPH_FLOATS;
    if (required <= this.values.length) return true;
    const next = new Float32Array(
      nextCapacity(requiredInstances, this.maximumInstances) * WEBGL_GLYPH_FLOATS,
    );
    next.set(this.values.subarray(0, this.countValue * WEBGL_GLYPH_FLOATS));
    this.values = next;
    return true;
  }
}
