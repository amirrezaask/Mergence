const RECT_FLOATS = 8;
const GLYPH_FLOATS = 13;

function nextCapacity(required: number, maximum: number): number {
  let capacity = 64;
  while (capacity < required && capacity < maximum) capacity *= 2;
  return Math.min(capacity, maximum);
}

export class WebGlRectBatch {
  private values = new Float32Array(RECT_FLOATS * 64);
  private countValue = 0;

  constructor(private readonly maximumInstances: number) {}

  get count(): number { return this.countValue; }
  get data(): Float32Array { return this.values.subarray(0, this.countValue * RECT_FLOATS); }

  clear(): void { this.countValue = 0; }

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
    if (this.countValue >= this.maximumInstances) return false;
    const required = (this.countValue + 1) * RECT_FLOATS;
    if (required > this.values.length) {
      const next = new Float32Array(
        nextCapacity(this.countValue + 1, this.maximumInstances) * RECT_FLOATS,
      );
      next.set(this.values);
      this.values = next;
    }
    const offset = this.countValue * RECT_FLOATS;
    this.values.set([x, y, width, height, red, green, blue, alpha], offset);
    this.countValue += 1;
    return true;
  }
}

export class WebGlGlyphBatch {
  private values = new Float32Array(GLYPH_FLOATS * 64);
  private countValue = 0;

  constructor(private readonly maximumInstances: number) {}

  get count(): number { return this.countValue; }
  get data(): Float32Array { return this.values.subarray(0, this.countValue * GLYPH_FLOATS); }

  clear(): void { this.countValue = 0; }

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
    if (this.countValue >= this.maximumInstances) return false;
    const required = (this.countValue + 1) * GLYPH_FLOATS;
    if (required > this.values.length) {
      const next = new Float32Array(
        nextCapacity(this.countValue + 1, this.maximumInstances) * GLYPH_FLOATS,
      );
      next.set(this.values);
      this.values = next;
    }
    const offset = this.countValue * GLYPH_FLOATS;
    this.values.set(
      [x, y, width, height, u0, v0, u1, v1, red, green, blue, alpha, colorGlyph],
      offset,
    );
    this.countValue += 1;
    return true;
  }
}
