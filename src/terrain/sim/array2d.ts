/**
 * Generic 2D grid container — port of `sharedTerrain/Array2d.h`.
 *
 * Backing store is a single flat array indexed as `row * width + col`.
 * For numeric types we can swap in a typed Float32Array via the
 * `Array2dF32` specialization for hot paths (the height map, the
 * boundary mask, the amount map).
 */

export class Array2d<T> {
  width: number;
  height: number;
  data: T[];

  constructor(width: number, height: number, fill: T) {
    this.width = width;
    this.height = height;
    this.data = new Array<T>(width * height);
    for (let i = 0; i < this.data.length; i++) this.data[i] = fill;
  }

  /** Return the value at (x, z). 0-based; (0, 0) is top-left. */
  get(x: number, z: number): T {
    return this.data[z * this.width + x] as T;
  }

  /** Set the value at (x, z). */
  set(x: number, z: number, value: T): void {
    this.data[z * this.width + x] = value;
  }

  /** Fill every cell with `value`. */
  fill(value: T): void {
    for (let i = 0; i < this.data.length; i++) this.data[i] = value;
  }

  /** Iterate every cell. */
  forEach(cb: (value: T, x: number, z: number) => void): void {
    for (let z = 0; z < this.height; z++) {
      for (let x = 0; x < this.width; x++) {
        cb(this.data[z * this.width + x] as T, x, z);
      }
    }
  }
}

/**
 * Float32-specialized variant for the hot paths (heightMap, amount mask,
 * boundary mask). Avoids per-cell number boxing and ensures the implicit
 * float32 truncation that the C++ pipeline expects.
 */
export class Array2dF32 {
  readonly width: number;
  readonly height: number;
  readonly data: Float32Array;

  constructor(width: number, height: number, fill = 0) {
    this.width = width;
    this.height = height;
    this.data = new Float32Array(width * height);
    if (fill !== 0) this.data.fill(fill);
  }

  get(x: number, z: number): number {
    return this.data[z * this.width + x] as number;
  }

  set(x: number, z: number, value: number): void {
    this.data[z * this.width + x] = value;
  }

  fill(value: number): void {
    this.data.fill(value);
  }
}
