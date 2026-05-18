/**
 * Unit tests for `NoiseGenerator` — the Perlin gradient noise core
 * (`MultiFractal::NoiseGenerator` from
 * `~/code/swg-main/.../sharedFractal/.../MultiFractal.cpp`).
 *
 * The numeric values below are the **regression anchors** captured against
 * this implementation on first commit. Any change to the seeding sequence
 * (e.g. swapping in a non-bit-exact `RandomGenerator`, reordering the
 * `m_random.random()` calls in `init`, or losing `Math.fround` at a float
 * boundary) will shift these values and the test will fail — which is the
 * point: heights diverge from the live server unless our sequence stays
 * byte-identical.
 *
 * Where a value is checked against an exact float literal, the literal is
 * the **bit-exact** result of the current implementation; do NOT round or
 * "tidy" — replace only after re-validating against the C++ source.
 */

import { describe, expect, it } from 'vitest';
import { RandomGenerator } from '../random.js';
import { NoiseGenerator } from './noise-generator.js';

describe('NoiseGenerator', () => {
  describe('seeding & determinism', () => {
    it('produces the regression-anchor values for seed=0', () => {
      const ng = new NoiseGenerator(0);

      // getValue1(0): rx0=0 → u=0; rx1=-1 → v = -g1[m_p[1]]. sx=scurve(0)=0.
      // lerp(0, u, v) = u = 0. Holds for any seed where g1 has finite values.
      expect(ng.getValue1(0)).toBe(0);

      // Anchor values — bit-exact captures from the first passing run.
      // If these change, the seed sequence drifted (likely a regression).
      expect(ng.getValue1(1.5)).toBe(-0.05078125);
      expect(ng.getValue1(3.14)).toBe(0.09912605583667755);

      // getValue2(0, 0) → same "all-zero rx/ry" degeneracy as 1D.
      expect(ng.getValue2(0, 0)).toBe(0);
      expect(ng.getValue2(1.5, 2.5)).toBe(0.48490452766418457);
      expect(ng.getValue2(3.14, 2.71)).toBe(0.14783817529678345);
    });

    it('is deterministic for the same seed', () => {
      const a = new NoiseGenerator(0);
      const b = new NoiseGenerator(0);

      // Probe a handful of non-degenerate points (0,0 is degenerate — see above).
      const probes: ReadonlyArray<readonly [number, number]> = [
        [1.5, 2.5],
        [-0.7, 0.3],
        [3.14, 2.71],
        [100.5, -42.25],
        [0.0001, -0.0001],
      ];
      for (const [x, y] of probes) {
        expect(a.getValue1(x)).toBe(b.getValue1(x));
        expect(a.getValue2(x, y)).toBe(b.getValue2(x, y));
      }
    });

    it('different seeds produce different output sequences', () => {
      const a = new NoiseGenerator(0);
      const b = new NoiseGenerator(42);

      // At (0, 0) both return 0 by construction — pick non-degenerate probes.
      expect(a.getValue1(1.5)).not.toBe(b.getValue1(1.5));
      expect(a.getValue2(3.14, 2.71)).not.toBe(b.getValue2(3.14, 2.71));
    });

    it('re-seeding via init() resets the tables', () => {
      const a = new NoiseGenerator(123);
      const v1 = a.getValue2(7.5, -3.25);

      a.init(0); // re-seed in place
      const b = new NoiseGenerator(0);
      // After re-init with seed=0, output must match a fresh NoiseGenerator(0).
      expect(a.getValue2(7.5, -3.25)).toBe(b.getValue2(7.5, -3.25));

      a.init(123); // back to original
      expect(a.getValue2(7.5, -3.25)).toBe(v1);
    });
  });

  describe('seed-sequence parity with RandomGenerator', () => {
    /**
     * The C++ `init` does, per i in [0, B):
     *   m_p[i]    = i
     *   m_g1[i]   = ((rng.random() % 512) - 256) / 256
     *   m_g2[i].x = ((rng.random() % 512) - 256) / 256
     *   m_g2[i].y = ((rng.random() % 512) - 256) / 256
     *   PERLIN_normalize2(m_g2[i])
     *
     * So a freshly-seeded RNG drained for 768 calls (256 × 3) yields
     * the exact same `m_g1` values (which are NOT touched by normalize2).
     */
    it('m_g1 matches a manual RandomGenerator drain bit-for-bit', () => {
      const B = 256;
      const ng = new NoiseGenerator(0);

      const rng = new RandomGenerator(0);
      for (let i = 0; i < B; i++) {
        const expectedG1 = Math.fround(((rng.random() % (B + B)) - B) / B);
        expect(ng.m_g1[i]).toBe(expectedG1);
        // Drain the two g2 components so the sequence stays aligned.
        rng.random();
        rng.random();
      }
    });

    it('m_p[0..B-1] is a permutation of [0..B-1]', () => {
      const B = 256;
      const ng = new NoiseGenerator(0);
      const seen = new Set<number>();
      for (let i = 0; i < B; i++) seen.add(ng.m_p[i] as number);
      expect(seen.size).toBe(B);
      for (let i = 0; i < B; i++) expect(seen.has(i)).toBe(true);
    });

    it('m_g2 vectors are unit-length within float-precision', () => {
      const B = 256;
      const ng = new NoiseGenerator(0);
      for (let i = 0; i < B; i++) {
        const x = ng.m_g2[i * 2] as number;
        const y = ng.m_g2[i * 2 + 1] as number;
        const mag = Math.sqrt(x * x + y * y);
        expect(mag).toBeGreaterThan(0.999);
        expect(mag).toBeLessThan(1.001);
      }
    });

    it('wrap-around extension mirrors the base table', () => {
      const B = 256;
      const ng = new NoiseGenerator(0);
      for (let i = 0; i < B + 2; i++) {
        expect(ng.m_p[B + i]).toBe(ng.m_p[i] as number);
        expect(ng.m_g1[B + i]).toBe(ng.m_g1[i] as number);
        expect(ng.m_g2[(B + i) * 2]).toBe(ng.m_g2[i * 2] as number);
        expect(ng.m_g2[(B + i) * 2 + 1]).toBe(ng.m_g2[i * 2 + 1] as number);
      }
    });
  });

  describe('output range', () => {
    it('getValue2 stays inside [-1, 1] across 100 random sample points', () => {
      const ng = new NoiseGenerator(7);
      // Use the same RNG as the C++ ground truth so this test itself is
      // deterministic — Math.random() would be flaky across runs.
      const rng = new RandomGenerator(98765);
      for (let i = 0; i < 100; i++) {
        const x = rng.randomRealLowHigh(-1000, 1000);
        const y = rng.randomRealLowHigh(-1000, 1000);
        const v = ng.getValue2(x, y);
        expect(v).toBeGreaterThanOrEqual(-1);
        expect(v).toBeLessThanOrEqual(1);
      }
    });

    it('getValue1 stays inside [-1, 1] across 100 random sample points', () => {
      const ng = new NoiseGenerator(7);
      const rng = new RandomGenerator(11111);
      for (let i = 0; i < 100; i++) {
        const x = rng.randomRealLowHigh(-1000, 1000);
        const v = ng.getValue1(x);
        expect(v).toBeGreaterThanOrEqual(-1);
        expect(v).toBeLessThanOrEqual(1);
      }
    });
  });
});
