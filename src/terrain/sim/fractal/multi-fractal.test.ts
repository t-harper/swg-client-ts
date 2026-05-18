/**
 * `MultiFractal` unit tests.
 *
 * Verifies:
 *   - Default-constructed instance produces a deterministic, in-range value.
 *   - Re-seeding produces a different value at the same coords.
 *   - `getValueCache` returns the same value as `getValue2` for the same
 *     (x, y) input, regardless of (cx, cy) cache key.
 *   - All six combination rules execute and return values in [0, 1].
 *   - A swept grid of 100 random points stays in [0, 1].
 *
 * The NoiseGenerator stub is owned by agent 1; until that lands, the
 * underlying calls will throw and these tests will fail at the `getValue2`
 * call. Once both are implemented the entire suite passes.
 */

import { describe, expect, it } from 'vitest';
import { CombinationRule } from '../types.js';
import { MultiFractal } from './multi-fractal.js';

describe('MultiFractal', () => {
  it('default-constructed: getValue2(0, 0) is deterministic and in [0, 1]', () => {
    const mf = new MultiFractal();
    const v1 = mf.getValue2(0, 0);
    const v2 = mf.getValue2(0, 0);
    expect(v1).toBe(v2);
    expect(v1).toBeGreaterThanOrEqual(0);
    expect(v1).toBeLessThanOrEqual(1);
    expect(Number.isFinite(v1)).toBe(true);
  });

  it('setSeed produces a different value at (0, 0)', () => {
    const a = new MultiFractal();
    const va = a.getValue2(0.5, 0.5);

    const b = new MultiFractal();
    b.setSeed(424242);
    const vb = b.getValue2(0.5, 0.5);

    // Different seeds → different permutation tables → different noise field.
    // Both must remain in [0, 1].
    expect(va).not.toBe(vb);
    expect(vb).toBeGreaterThanOrEqual(0);
    expect(vb).toBeLessThanOrEqual(1);
  });

  it('getValueCache returns the same value as getValue2 for the same (x, y)', () => {
    const mf = new MultiFractal();
    mf.allocateCache(8, 8);

    const x = 1.25;
    const y = -3.5;
    const direct = mf.getValue2(x, y);

    // First call populates the cache at (0, 0).
    const cached0 = mf.getValueCache(x, y, 0, 0);
    expect(cached0).toBe(direct);

    // Second call at the same cache cell returns the cached value.
    const cached0Repeat = mf.getValueCache(x, y, 0, 0);
    expect(cached0Repeat).toBe(direct);

    // A different cache cell — same (x, y) — still computes the same value.
    const cached1 = mf.getValueCache(x, y, 3, 5);
    expect(cached1).toBe(direct);
  });

  it('all six combination rules return values in [0, 1] at (1, 1)', () => {
    const rules: CombinationRule[] = [
      CombinationRule.Add,
      CombinationRule.Multiply,
      CombinationRule.Crest,
      CombinationRule.Turbulence,
      CombinationRule.CrestClamp,
      CombinationRule.TurbulenceClamp,
    ];

    for (const rule of rules) {
      const mf = new MultiFractal();
      mf.setCombinationRule(rule);
      const v = mf.getValue2(1, 1);
      expect(Number.isFinite(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it('100 random points all stay in [0, 1]', () => {
    const mf = new MultiFractal();
    // Deterministic LCG so the test is repeatable without affecting Math.random.
    let s = 12345;
    const rand = (): number => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 0x100000000;
    };

    for (let i = 0; i < 100; i++) {
      const x = (rand() - 0.5) * 10000;
      const y = (rand() - 0.5) * 10000;
      const v = mf.getValue2(x, y);
      expect(Number.isFinite(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it('setSeed invalidates the cache (post-reseed value differs)', () => {
    const mf = new MultiFractal();
    mf.allocateCache(4, 4);

    const x = 2.5;
    const y = 4.25;

    // Prime cache with seed=0.
    const before = mf.getValueCache(x, y, 1, 1);

    // Re-seed → cache must be invalidated → next call recomputes.
    mf.setSeed(99);
    const after = mf.getValueCache(x, y, 1, 1);

    expect(after).not.toBe(before);
    expect(after).toBeGreaterThanOrEqual(0);
    expect(after).toBeLessThanOrEqual(1);
  });

  it('bias + gain stack stays in [0, 1]', () => {
    const mf = new MultiFractal();
    mf.setBias(true, 0.7);
    mf.setGain(true, 0.3);

    for (let i = 0; i < 10; i++) {
      const v = mf.getValue2(i * 0.5, i * 0.25);
      expect(Number.isFinite(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it('useSin path produces in-range values', () => {
    const mf = new MultiFractal();
    mf.setUseSin(true);
    const v = mf.getValue2(1.5, -2.5);
    expect(Number.isFinite(v)).toBe(true);
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThanOrEqual(1);
  });
});
