/**
 * Port of `MultiFractal::NoiseGenerator` — Ken Perlin gradient noise.
 *
 * Header:  `~/code/swg-main/src/engine/shared/library/sharedFractal/src/shared/MultiFractal.h:149-184`
 * Impl:    `~/code/swg-main/src/engine/shared/library/sharedFractal/src/shared/MultiFractal.cpp:30-161`
 *
 * Layout:
 * - `m_p`  — 256-entry permutation table, duplicated to 514 entries
 *   (`B + B + 2`) so 2D lookups like `m_p[m_p[bx0] + by0]` are bounds-safe.
 * - `m_g1` — 1D gradient table, float in [-1, 1], 514 entries.
 * - `m_g2` — 2D gradient table, interleaved `[x0,y0, x1,y1, ...]`, 1028 floats
 *   (`(B + B + 2) * 2`). Each pair is unit-length after `PERLIN_normalize2`.
 *
 * Bit-exact requirement: the seed sequence must drain `RandomGenerator.random()`
 * in the same order as the C++ for the resulting tables to match. The C++
 * `init` reads, per i in [0, B): one int for g1, two ints for g2 — so the
 * RNG is consumed 3 × 256 = 768 times before the shuffle phase. The shuffle
 * then consumes B-1 = 255 more ints.
 *
 * `getValue1` / `getValue2` return values in [-1, 1].
 */

import { type INoiseGenerator, RandomGenerator } from '../types.js';

// PERLIN constants — match the inner enum in MultiFractal.h:168-175.
const B = 256;
const BM = 255;
const N = 4096;

const fround = Math.fround;

export class NoiseGenerator implements INoiseGenerator {
  /** Permutation table — 2·B + 2 entries (wrap-around extension). */
  readonly m_p = new Int32Array(B + B + 2);
  /** 1D gradient table — 2·B + 2 entries. */
  readonly m_g1 = new Float32Array(B + B + 2);
  /** 2D gradient table — (2·B + 2) × 2 entries (interleaved as [..xy..]). */
  readonly m_g2 = new Float32Array((B + B + 2) * 2);

  readonly m_random: RandomGenerator;

  constructor(seed = 0) {
    this.m_random = new RandomGenerator(seed);
    this.init(seed);
  }

  /**
   * Re-seed and rebuild the permutation + gradient tables.
   *
   * Mirrors `MultiFractal::NoiseGenerator::init` in MultiFractal.cpp:72-104:
   *   1. setSeed(seed)
   *   2. for i in [0, B): assign m_p[i] = i, draw g1, draw g2 (2 calls), normalize g2.
   *   3. Fisher-Yates shuffle of m_p (i counts B-1..1).
   *   4. Duplicate the first B+2 entries of every table into [B..2B+1].
   */
  init(seed: number): void {
    this.m_random.setSeed(seed);

    // Step 2: seed the base 256-entry tables.
    let i: number;
    let j: number;
    for (i = 0; i < B; i++) {
      this.m_p[i] = i;

      // 1D gradient: ((random() % 512) - 256) / 256 → [-1, 1].
      this.m_g1[i] = fround(((this.m_random.random() % (B + B)) - B) / B);

      // 2D gradient: same pattern, two components.
      const g2Base = i * 2;
      for (j = 0; j < 2; j++) {
        this.m_g2[g2Base + j] = fround(((this.m_random.random() % (B + B)) - B) / B);
      }

      // PERLIN_normalize2 in place over the (x, y) pair we just stored.
      perlinNormalize2(this.m_g2, g2Base);
    }

    // Step 3: Fisher-Yates shuffle. The C++ does `while (--i)`; after the
    // for-loop above i == B (256). The first iteration drops i to B-1 = 255
    // (truthy), the loop ends when --i evaluates to 0 — so we shuffle indices
    // 255 down to 1 inclusive (index 0 may still be a swap *target* via `j`).
    while (--i) {
      const k = this.m_p[i] as number;
      j = this.m_random.random() % B;
      this.m_p[i] = this.m_p[j] as number;
      this.m_p[j] = k;
    }

    // Step 4: wrap-around extension. Indices [B..2B+1] mirror [0..B+1].
    for (i = 0; i < B + 2; i++) {
      this.m_p[B + i] = this.m_p[i] as number;
      this.m_g1[B + i] = this.m_g1[i] as number;
      const srcBase = i * 2;
      const dstBase = (B + i) * 2;
      this.m_g2[dstBase] = this.m_g2[srcBase] as number;
      this.m_g2[dstBase + 1] = this.m_g2[srcBase + 1] as number;
    }
  }

  /** 1D Perlin noise — port of `MultiFractal::NoiseGenerator::getValue(float)`. */
  getValue1(x: number): number {
    const result = this.realGetValue1(x);
    // C++ DEBUG_FATAL — we make it a runtime assertion to surface drift early.
    if (result < -1.0 || result > 1.0) {
      throw new Error(`NoiseGenerator.getValue1: out-of-range result ${result}`);
    }
    return result;
  }

  /** 2D Perlin noise — port of `MultiFractal::NoiseGenerator::getValue(float, float)`. */
  getValue2(x: number, y: number): number {
    const result = this.realGetValue2(x, y);
    if (result < -1.0 || result > 1.0) {
      throw new Error(`NoiseGenerator.getValue2: out-of-range result ${result}`);
    }
    return result;
  }

  /**
   * Internal 1D evaluator with no range check. Matches the C++ body —
   * the C++ `realGetValue` overloads are absent at the source we ported
   * (the inline `getValue` does the work directly), so we keep the same
   * shape under a different name for clarity.
   */
  private realGetValue1(x: number): number {
    const setup = perlinSetup(x);
    const bx0 = setup.b0;
    const bx1 = setup.b1;
    const rx0 = setup.r0;
    const rx1 = setup.r1;

    const sx = perlinScurve(rx0);
    const u = fround(rx0 * (this.m_g1[this.m_p[bx0] as number] as number));
    const v = fround(rx1 * (this.m_g1[this.m_p[bx1] as number] as number));

    return perlinLerp(sx, u, v);
  }

  /** Internal 2D evaluator with no range check. */
  private realGetValue2(x: number, y: number): number {
    const sx_setup = perlinSetup(x);
    const sy_setup = perlinSetup(y);

    const bx0 = sx_setup.b0;
    const bx1 = sx_setup.b1;
    const rx0 = sx_setup.r0;
    const rx1 = sx_setup.r1;

    const by0 = sy_setup.b0;
    const by1 = sy_setup.b1;
    const ry0 = sy_setup.r0;
    const ry1 = sy_setup.r1;

    const sx = perlinScurve(rx0);
    const sy = perlinScurve(ry0);

    const p_bx0 = this.m_p[bx0] as number;
    const p_bx1 = this.m_p[bx1] as number;

    const b00 = this.m_p[p_bx0 + by0] as number;
    const b01 = this.m_p[p_bx0 + by1] as number;
    const b10 = this.m_p[p_bx1 + by0] as number;
    const b11 = this.m_p[p_bx1 + by1] as number;

    // PERLIN_dot2 against m_g2[b**] — interleaved layout, base = b * 2.
    let q = b00 * 2;
    const u00 = perlinDot2(rx0, ry0, this.m_g2[q] as number, this.m_g2[q + 1] as number);
    q = b10 * 2;
    const v10 = perlinDot2(rx1, ry0, this.m_g2[q] as number, this.m_g2[q + 1] as number);
    const a = perlinLerp(sx, u00, v10);

    q = b01 * 2;
    const u01 = perlinDot2(rx0, ry1, this.m_g2[q] as number, this.m_g2[q + 1] as number);
    q = b11 * 2;
    const v11 = perlinDot2(rx1, ry1, this.m_g2[q] as number, this.m_g2[q + 1] as number);
    const b = perlinLerp(sx, u01, v11);

    return perlinLerp(sy, a, b);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// PERLIN_* macro ports — inlined as helper functions.
//
// The C++ versions are `#define`s in MultiFractal.cpp:30-41. We mirror them
// 1:1, wrapping every float-producing line in Math.fround so accumulated
// octave compositions don't drift via JS double-precision intermediates.
// ─────────────────────────────────────────────────────────────────────────

interface PerlinSetup {
  b0: number;
  b1: number;
  r0: number;
  r1: number;
}

/**
 * PERLIN_setup — translate world coord `i` into a pair of integer cell
 * indices (b0, b1) and the fractional offsets from each (r0, r1).
 *
 * C++:
 *   t  = i + N;
 *   it = static_cast<int>(t);
 *   ft = PERLIN_floor(t, it);    // true floor — handles t<0 non-integer
 *   b0 = ft & BM;
 *   b1 = (b0 + 1) & BM;
 *   r0 = t - ft;
 *   r1 = r0 - 1.f;
 */
function perlinSetup(i: number): PerlinSetup {
  const t = fround(i + N);
  // static_cast<int> truncates toward zero — JS `| 0` does exactly that
  // for values in int32 range.
  const it = t | 0;
  // PERLIN_floor: if (t < 0 && t != it) ft = it - 1 else ft = it.
  const ft = t < 0 && t !== it ? it - 1 : it;
  const b0 = ft & BM;
  const b1 = (b0 + 1) & BM;
  const r0 = fround(t - ft);
  const r1 = fround(r0 - 1.0);
  return { b0, b1, r0, r1 };
}

/** PERLIN_scurve — Hermite-style smooth-step: (3 - 2t) · t². */
function perlinScurve(t: number): number {
  return fround(fround(fround(3.0 - fround(2.0 * t)) * t) * t);
}

/** PERLIN_lerp — linear interpolation, a + t·(b - a). */
function perlinLerp(t: number, a: number, b: number): number {
  return fround(a + fround(t * fround(b - a)));
}

/** PERLIN_dot2 — `rx*q[0] + ry*q[1]`, the 2D dot against the gradient. */
function perlinDot2(rx: number, ry: number, qx: number, qy: number): number {
  return fround(fround(rx * qx) + fround(ry * qy));
}

/**
 * PERLIN_normalize2 — in-place unit-length normalization of a 2D vector
 * stored at `g2[base]`, `g2[base+1]`. Matches `PERLIN_normalize2` in
 * MultiFractal.cpp:45-54.
 */
function perlinNormalize2(g2: Float32Array, base: number): void {
  const vx = g2[base] as number;
  const vy = g2[base + 1] as number;
  // C++ uses static_cast<float>(sqrt(sqr(v[0]) + sqr(v[1]))) — sqrt is double,
  // then truncated to float for the division. Mirror that pipeline so any
  // gradient that hits a near-zero magnitude doesn't drift between platforms.
  const s = fround(Math.sqrt(vx * vx + vy * vy));
  g2[base] = fround(vx / s);
  g2[base + 1] = fround(vy / s);
}
