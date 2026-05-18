/**
 * Port of `MultiFractal` (`sharedFractal/.../MultiFractal.{h,cpp}`).
 *
 * Wraps a `NoiseGenerator` with octave + combination-rule + bias/gain/sin
 * composition. Always returns [0, 1] from the public `getValue*` paths.
 *
 * Six combination rules per `CombinationRule`:
 *   - Add / Multiply — share the same combination fn (`getValueAdd_*` in
 *     cpp); output is `(sum * ooTotal + 1) * 0.5` to shift [-1,1] → [0,1].
 *   - Crest          — `sum += amp * (1 - |noise|)`; output `sum * ooTotal`.
 *   - Turbulence     — `sum += amp * |noise|`; output `sum * ooTotal`.
 *   - CrestClamp     — `sum += amp * (1 - clamp(noise, 0, 1))`; out `sum * ooTotal`.
 *   - TurbulenceClamp- `sum += amp * clamp(noise, 0, 1)`; out `sum * ooTotal`.
 *
 * Float32 discipline: every arithmetic step is wrapped in `Math.fround` to
 * match the C++ `float` pipeline. Skipping this lets double-precision drift
 * compound across octaves and away from the C++ baseline.
 */

import { CombinationRule, type IMultiFractal } from '../types.js';
import { NoiseGenerator } from './noise-generator.js';

const f32 = Math.fround;

// ────────────────────────────────────────────────────────────────────────
// NG_bias / NG_gain — direct ports of the inline helpers in cpp (lines
// 506-529). bias(a, b) = pow(a, log(b) / log(0.5)).
// ────────────────────────────────────────────────────────────────────────

const NG_log_0_5 = f32(Math.log(0.5));

function NG_bias(a: number, b: number): number {
  return f32(Math.pow(a, f32(f32(Math.log(b)) / NG_log_0_5)));
}

function NG_gain(a: number, b: number): number {
  if (a < 0.001) return 0;
  if (a > 0.999) return 1;
  const p = f32(f32(Math.log(f32(1 - b))) / NG_log_0_5);
  if (a < 0.5) {
    return f32(f32(Math.pow(f32(2 * a), p)) * 0.5);
  }
  return f32(1 - f32(f32(Math.pow(f32(2 * f32(1 - a)), p)) * 0.5));
}

function clampF(low: number, v: number, high: number): number {
  return v < low ? low : v > high ? high : v;
}

// ────────────────────────────────────────────────────────────────────────
// Combination function signatures — match the typedefs in MultiFractal.h
// (`CombinationFunction_1` and `_2`). Each receives `(x[, y], mf)` and
// returns the post-octave-loop pre-bias/gain value.
// ────────────────────────────────────────────────────────────────────────

type CombinationFunction1 = (x: number, mf: MultiFractal) => number;
type CombinationFunction2 = (x: number, y: number, mf: MultiFractal) => number;

// 1D combination rules. Each octave loop mirrors the cpp 1:1.

function getValueAdd_1(x: number, mf: MultiFractal): number {
  let frequency = f32(1);
  let amplitude = f32(1);
  let sum = f32(0);
  for (let i = 0; i < mf.m_numberOfOctaves; i++) {
    sum = f32(sum + f32(amplitude * mf.m_noiseGenerator.getValue1(f32(x * frequency))));
    frequency = f32(frequency * mf.m_frequency);
    amplitude = f32(amplitude * mf.m_amplitude);
  }
  if (mf.m_useSin) sum = f32(Math.sin(f32(x + sum)));
  return f32(f32(f32(sum * mf.m_ooTotalAmplitude) + 1) * 0.5);
}

function getValueCrest_1(x: number, mf: MultiFractal): number {
  let frequency = f32(1);
  let amplitude = f32(1);
  let sum = f32(0);
  for (let i = 0; i < mf.m_numberOfOctaves; i++) {
    const n = mf.m_noiseGenerator.getValue1(f32(x * frequency));
    sum = f32(sum + f32(amplitude * f32(1 - Math.abs(n))));
    frequency = f32(frequency * mf.m_frequency);
    amplitude = f32(amplitude * mf.m_amplitude);
  }
  if (mf.m_useSin) sum = f32(Math.sin(f32(x + sum)));
  return f32(sum * mf.m_ooTotalAmplitude);
}

function getValueTurbulence_1(x: number, mf: MultiFractal): number {
  let frequency = f32(1);
  let amplitude = f32(1);
  let sum = f32(0);
  for (let i = 0; i < mf.m_numberOfOctaves; i++) {
    const n = mf.m_noiseGenerator.getValue1(f32(x * frequency));
    sum = f32(sum + f32(amplitude * Math.abs(n)));
    frequency = f32(frequency * mf.m_frequency);
    amplitude = f32(amplitude * mf.m_amplitude);
  }
  if (mf.m_useSin) sum = f32(Math.sin(f32(x + sum)));
  return f32(sum * mf.m_ooTotalAmplitude);
}

function getValueCrestClamp_1(x: number, mf: MultiFractal): number {
  let frequency = f32(1);
  let amplitude = f32(1);
  let sum = f32(0);
  for (let i = 0; i < mf.m_numberOfOctaves; i++) {
    const n = mf.m_noiseGenerator.getValue1(f32(x * frequency));
    sum = f32(sum + f32(amplitude * f32(1 - clampF(0, n, 1))));
    frequency = f32(frequency * mf.m_frequency);
    amplitude = f32(amplitude * mf.m_amplitude);
  }
  if (mf.m_useSin) sum = f32(Math.sin(f32(x + sum)));
  return f32(sum * mf.m_ooTotalAmplitude);
}

function getValueTurbulenceClamp_1(x: number, mf: MultiFractal): number {
  let frequency = f32(1);
  let amplitude = f32(1);
  let sum = f32(0);
  for (let i = 0; i < mf.m_numberOfOctaves; i++) {
    const n = mf.m_noiseGenerator.getValue1(f32(x * frequency));
    sum = f32(sum + f32(amplitude * clampF(0, n, 1)));
    frequency = f32(frequency * mf.m_frequency);
    amplitude = f32(amplitude * mf.m_amplitude);
  }
  if (mf.m_useSin) sum = f32(Math.sin(f32(x + sum)));
  return f32(sum * mf.m_ooTotalAmplitude);
}

// 2D combination rules.

function getValueAdd_2(x: number, y: number, mf: MultiFractal): number {
  let frequency = f32(1);
  let amplitude = f32(1);
  let sum = f32(0);
  for (let i = 0; i < mf.m_numberOfOctaves; i++) {
    const n = mf.m_noiseGenerator.getValue2(f32(x * frequency), f32(y * frequency));
    sum = f32(sum + f32(amplitude * n));
    frequency = f32(frequency * mf.m_frequency);
    amplitude = f32(amplitude * mf.m_amplitude);
  }
  if (mf.m_useSin) sum = f32(Math.sin(f32(x + sum)));
  return f32(f32(f32(sum * mf.m_ooTotalAmplitude) + 1) * 0.5);
}

function getValueCrest_2(x: number, y: number, mf: MultiFractal): number {
  let frequency = f32(1);
  let amplitude = f32(1);
  let sum = f32(0);
  for (let i = 0; i < mf.m_numberOfOctaves; i++) {
    const n = mf.m_noiseGenerator.getValue2(f32(x * frequency), f32(y * frequency));
    sum = f32(sum + f32(amplitude * f32(1 - Math.abs(n))));
    frequency = f32(frequency * mf.m_frequency);
    amplitude = f32(amplitude * mf.m_amplitude);
  }
  if (mf.m_useSin) sum = f32(Math.sin(f32(x + sum)));
  return f32(sum * mf.m_ooTotalAmplitude);
}

function getValueTurbulence_2(x: number, y: number, mf: MultiFractal): number {
  let frequency = f32(1);
  let amplitude = f32(1);
  let sum = f32(0);
  for (let i = 0; i < mf.m_numberOfOctaves; i++) {
    const n = mf.m_noiseGenerator.getValue2(f32(x * frequency), f32(y * frequency));
    sum = f32(sum + f32(amplitude * Math.abs(n)));
    frequency = f32(frequency * mf.m_frequency);
    amplitude = f32(amplitude * mf.m_amplitude);
  }
  if (mf.m_useSin) sum = f32(Math.sin(f32(x + sum)));
  return f32(sum * mf.m_ooTotalAmplitude);
}

function getValueCrestClamp_2(x: number, y: number, mf: MultiFractal): number {
  let frequency = f32(1);
  let amplitude = f32(1);
  let sum = f32(0);
  for (let i = 0; i < mf.m_numberOfOctaves; i++) {
    const n = mf.m_noiseGenerator.getValue2(f32(x * frequency), f32(y * frequency));
    sum = f32(sum + f32(amplitude * f32(1 - clampF(0, n, 1))));
    frequency = f32(frequency * mf.m_frequency);
    amplitude = f32(amplitude * mf.m_amplitude);
  }
  if (mf.m_useSin) sum = f32(Math.sin(f32(x + sum)));
  return f32(sum * mf.m_ooTotalAmplitude);
}

function getValueTurbulenceClamp_2(x: number, y: number, mf: MultiFractal): number {
  let frequency = f32(1);
  let amplitude = f32(1);
  let sum = f32(0);
  for (let i = 0; i < mf.m_numberOfOctaves; i++) {
    const n = mf.m_noiseGenerator.getValue2(f32(x * frequency), f32(y * frequency));
    sum = f32(sum + f32(amplitude * clampF(0, n, 1)));
    frequency = f32(frequency * mf.m_frequency);
    amplitude = f32(amplitude * mf.m_amplitude);
  }
  if (mf.m_useSin) sum = f32(Math.sin(f32(x + sum)));
  return f32(sum * mf.m_ooTotalAmplitude);
}

// ────────────────────────────────────────────────────────────────────────
// Rule → combination-fn table. Mirrors the switch in
// `MultiFractal::setCombinationRule` (cpp:421-460). Add and Multiply
// share the same combination function in cpp.
// ────────────────────────────────────────────────────────────────────────

const COMBINATION_TABLE: Record<
  CombinationRule,
  { fn1: CombinationFunction1; fn2: CombinationFunction2 }
> = {
  [CombinationRule.Add]: { fn1: getValueAdd_1, fn2: getValueAdd_2 },
  [CombinationRule.Multiply]: { fn1: getValueAdd_1, fn2: getValueAdd_2 },
  [CombinationRule.Crest]: { fn1: getValueCrest_1, fn2: getValueCrest_2 },
  [CombinationRule.Turbulence]: { fn1: getValueTurbulence_1, fn2: getValueTurbulence_2 },
  [CombinationRule.CrestClamp]: { fn1: getValueCrestClamp_1, fn2: getValueCrestClamp_2 },
  [CombinationRule.TurbulenceClamp]: { fn1: getValueTurbulenceClamp_1, fn2: getValueTurbulenceClamp_2 },
};

export class MultiFractal implements IMultiFractal {
  m_seed = 0;
  m_scaleX = 0.01;
  m_scaleY = 0.01;
  m_offsetX = 0;
  m_offsetY = 0;
  m_numberOfOctaves = 2;
  m_frequency = 4.0;
  m_amplitude = 0.5;
  m_ooTotalAmplitude = 1.0;
  m_useBias = false;
  m_bias = 0.5;
  m_useGain = false;
  m_gain = 0.7;
  m_useSin = false;
  m_combinationRule: CombinationRule = CombinationRule.Add;

  m_combinationFunction_1: CombinationFunction1 = getValueAdd_1;
  m_combinationFunction_2: CombinationFunction2 = getValueAdd_2;

  m_noiseGenerator: NoiseGenerator = new NoiseGenerator(0);

  // Cache state — populated by `allocateCache`.
  m_cacheX = 0;
  m_cacheY = 0;
  m_cache: Float32Array | null = null;
  m_cacheValid: Uint8Array | null = null;

  constructor() {
    this.initTotalAmplitude();
    this.setCombinationRule(CombinationRule.Add);
    this.m_noiseGenerator.init(this.m_seed);
  }

  // ────────────────────────────────────────────────────────────────────
  // Cache management — task spec: simple Float32Array + Uint8Array pair.
  // The cpp uses `CachedNode { bool cached; float x; float y; float value; }`
  // with per-key (x, y) verification; we use a positional cache only.
  // ────────────────────────────────────────────────────────────────────

  allocateCache(cx: number, cy: number): void {
    if (cx > this.m_cacheX || cy > this.m_cacheY) {
      if (cx !== 0 && cy !== 0) {
        this.m_cacheX = cx;
        this.m_cacheY = cy;
        const total = cx * cy;
        this.m_cache = new Float32Array(total);
        this.m_cacheValid = new Uint8Array(total);
      } else {
        this.m_cache = null;
        this.m_cacheValid = null;
      }
    }
  }

  private resetCache(): void {
    if (this.m_cacheValid) this.m_cacheValid.fill(0);
  }

  private initTotalAmplitude(): void {
    let total = f32(0);
    let amplitude = f32(1);
    for (let i = 0; i < this.m_numberOfOctaves; i++) {
      total = f32(total + amplitude);
      amplitude = f32(amplitude * this.m_amplitude);
    }
    // C++ uses RECIP() — 1 / total. Guard against the zero case (no octaves).
    this.m_ooTotalAmplitude = total === 0 ? 0 : f32(1 / total);
  }

  // ────────────────────────────────────────────────────────────────────
  // Public evaluation paths. Match `MultiFractal::getValue(x)` (cpp:623),
  // `getValue2(x,y)` (cpp:736), and `getValueCache(x,y,cx,cy)` (cpp:916).
  // ────────────────────────────────────────────────────────────────────

  getValue1(x: number): number {
    const xs = f32(f32(x * this.m_scaleX) + this.m_offsetX);
    let result = this.m_combinationFunction_1(xs, this);
    if (this.m_useBias) result = NG_bias(result, this.m_bias);
    if (this.m_useGain) result = NG_gain(result, this.m_gain);
    return clampF(0, result, 1);
  }

  getValue2(x: number, y: number): number {
    const xs = f32(f32(x * this.m_scaleX) + this.m_offsetX);
    const ys = f32(f32(y * this.m_scaleY) + this.m_offsetY);
    let result = this.m_combinationFunction_2(xs, ys, this);
    if (this.m_useBias) result = NG_bias(result, this.m_bias);
    if (this.m_useGain) result = NG_gain(result, this.m_gain);
    return clampF(0, result, 1);
  }

  getValueCache(x: number, y: number, cx: number, cy: number): number {
    if (this.m_cache === null || this.m_cacheValid === null) {
      // No cache allocated — compute directly. C++ would fatal here via
      // NOT_NULL(m_cache); we degrade gracefully so callers can use the
      // method without explicit allocation.
      return this.getValue2(x, y);
    }
    if (cx < 0 || cx >= this.m_cacheX || cy < 0 || cy >= this.m_cacheY) {
      // Out of cache range — compute directly.
      return this.getValue2(x, y);
    }
    const idx = cy * this.m_cacheX + cx;
    if (this.m_cacheValid[idx] === 1) {
      return this.m_cache[idx] as number;
    }
    const value = this.getValue2(x, y);
    this.m_cache[idx] = value;
    this.m_cacheValid[idx] = 1;
    return value;
  }

  // ────────────────────────────────────────────────────────────────────
  // Accessors — frozen by the IMultiFractal interface.
  // ────────────────────────────────────────────────────────────────────

  getSeed(): number { return this.m_seed; }
  getScaleX(): number { return this.m_scaleX; }
  getScaleY(): number { return this.m_scaleY; }
  getOffsetX(): number { return this.m_offsetX; }
  getOffsetY(): number { return this.m_offsetY; }
  getNumberOfOctaves(): number { return this.m_numberOfOctaves; }
  getFrequency(): number { return this.m_frequency; }
  getAmplitude(): number { return this.m_amplitude; }
  getCombinationRule(): CombinationRule { return this.m_combinationRule; }
  getUseBias(): boolean { return this.m_useBias; }
  getBias(): number { return this.m_bias; }
  getUseGain(): boolean { return this.m_useGain; }
  getGain(): number { return this.m_gain; }
  getUseSin(): boolean { return this.m_useSin; }

  // ────────────────────────────────────────────────────────────────────
  // Mutators — each invalidates the value cache (mirrors cpp::setSeed
  // and friends which all call resetCache after mutating). Octave /
  // amplitude / frequency changes also rebuild `m_ooTotalAmplitude`.
  // Combination-rule changes rebind the function pointers.
  // ────────────────────────────────────────────────────────────────────

  setSeed(seed: number): void {
    if (this.m_seed !== seed) {
      this.m_seed = seed;
      this.m_noiseGenerator.init(seed);
      this.resetCache();
    }
  }

  setScale(x: number, y: number): void {
    this.m_scaleX = x;
    this.m_scaleY = y;
    this.resetCache();
  }

  setOffset(x: number, y: number): void {
    this.m_offsetX = x;
    this.m_offsetY = y;
    this.resetCache();
  }

  setNumberOfOctaves(n: number): void {
    this.m_numberOfOctaves = n;
    this.initTotalAmplitude();
    this.resetCache();
  }

  setFrequency(f: number): void {
    this.m_frequency = f;
    this.initTotalAmplitude();
    this.resetCache();
  }

  setAmplitude(a: number): void {
    this.m_amplitude = a;
    this.initTotalAmplitude();
    this.resetCache();
  }

  setCombinationRule(r: CombinationRule): void {
    this.m_combinationRule = r;
    const entry = COMBINATION_TABLE[r];
    if (!entry) {
      throw new Error(`MultiFractal.setCombinationRule: invalid rule ${r}`);
    }
    this.m_combinationFunction_1 = entry.fn1;
    this.m_combinationFunction_2 = entry.fn2;
    this.resetCache();
  }

  setBias(useBias: boolean, bias: number): void {
    this.m_useBias = useBias;
    this.m_bias = bias;
    this.resetCache();
  }

  setGain(useGain: boolean, gain: number): void {
    this.m_useGain = useGain;
    this.m_gain = gain;
    this.resetCache();
  }

  setUseSin(use: boolean): void {
    this.m_useSin = use;
    this.resetCache();
  }
}
