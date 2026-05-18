/**
 * Tests for `BoundaryRectangle` — the rectangle boundary primitive used
 * by the terrain layer system.
 *
 * Covers:
 *   - `isWithin` returns 1.0 deep inside, 0.0 outside, intermediate in
 *     the feather band.
 *   - `getCenter` reports the rectangle midpoint.
 *   - `expand` grows an empty (or pre-seeded) extent to include the
 *     rectangle's bounds.
 *   - `intersects` does AABB-vs-AABB.
 *   - `load` round-trips each on-disk version (0000-0004) built with
 *     `IffWriter`.
 */

import { describe, expect, it } from 'vitest';
import { BoundaryRectangle } from './rectangle.js';
import { FeatherFunction } from '../types.js';
import { Iff, IffWriter } from '../../../iff/iff.js';

describe('BoundaryRectangle', () => {
  // ─────────────────────────────────────────────────────────────────────
  // Geometry primitives
  // ─────────────────────────────────────────────────────────────────────

  describe('isWithin', () => {
    const makeRect = (): BoundaryRectangle => {
      const b = new BoundaryRectangle();
      b.rectangle = { x0: -5, z0: -5, x1: 5, z1: 5 };
      b.featherDistance = 1; // 0.5 * min(10, 10) * 1 = 5 → entire rect feathers
      // recalculate via load contract — touch via the public load path isn't
      // needed; we mimic what `recalculate` does manually.
      b.innerRectangle = { x0: 0, z0: 0, x1: 0, z1: 0 };
      return b;
    };

    it('returns 1.0 deep inside the inner (un-feathered) rectangle', () => {
      const b = new BoundaryRectangle();
      b.rectangle = { x0: -5, z0: -5, x1: 5, z1: 5 };
      b.featherDistance = 0.2; // feather = 0.5 * 10 * 0.2 = 1
      b.innerRectangle = { x0: -4, z0: -4, x1: 4, z1: 4 };
      expect(b.isWithin(0, 0)).toBe(1);
    });

    it('returns 0.0 outside the outer rectangle', () => {
      const b = makeRect();
      expect(b.isWithin(6, 0)).toBe(0);
      expect(b.isWithin(0, 6)).toBe(0);
      expect(b.isWithin(-6, -6)).toBe(0);
      expect(b.isWithin(100, 100)).toBe(0);
    });

    it('returns a value strictly between 0 and 1 inside the feather band', () => {
      const b = new BoundaryRectangle();
      b.rectangle = { x0: -5, z0: -5, x1: 5, z1: 5 };
      b.featherDistance = 0.2; // feather = 1
      b.innerRectangle = { x0: -4, z0: -4, x1: 4, z1: 4 };
      b.featherFunction = FeatherFunction.Linear;
      const v = b.isWithin(4.5, 0);
      expect(v).toBeGreaterThan(0);
      expect(v).toBeLessThan(1);
      // distance-from-edge = 0.5, feather = 1 → t = 0.5
      expect(v).toBeCloseTo(0.5, 5);
    });

    it('returns 1.0 when featherDistance is zero and the point is inside', () => {
      const b = new BoundaryRectangle();
      b.rectangle = { x0: -5, z0: -5, x1: 5, z1: 5 };
      b.innerRectangle = { x0: -5, z0: -5, x1: 5, z1: 5 };
      b.featherDistance = 0;
      expect(b.isWithin(0, 0)).toBe(1);
      expect(b.isWithin(4.9, 4.9)).toBe(1);
    });

    it('honors rotation when useTransform is set', () => {
      // 10x10 axis-aligned rect at origin, rotated 45° in world space.
      // Point (3, 3) in world coords: rotated back by -45° → (3√2, 0)
      // which is ~4.24, comfortably inside the rect → expect > 0.
      const b = new BoundaryRectangle();
      b.rectangle = { x0: -5, z0: -5, x1: 5, z1: 5 };
      b.innerRectangle = { x0: -5, z0: -5, x1: 5, z1: 5 };
      b.featherDistance = 0;
      b.useTransform = true;
      b.rotationAngle = Math.PI / 4;
      // unrotated, (6, 0) lies outside the rect (x > 5); with rotation by
      // 45° the world point that maps to (6, 0) local is (6*cos45, 6*sin45)
      // ~ (4.24, 4.24). Test that the rotated-back inverse rejects (6, 6)
      // (which back-rotates to large x) yet accepts (0, 0).
      expect(b.isWithin(0, 0)).toBe(1);
      expect(b.isWithin(6, 6)).toBe(0); // back-rotates past the edge
    });
  });

  describe('getCenter', () => {
    it('reports the rectangle midpoint', () => {
      const b = new BoundaryRectangle();
      b.rectangle = { x0: -5, z0: -5, x1: 5, z1: 5 };
      expect(b.getCenter()).toEqual({ x: 0, z: 0 });
    });

    it('handles an off-origin rectangle', () => {
      const b = new BoundaryRectangle();
      b.rectangle = { x0: 10, z0: 20, x1: 30, z1: 50 };
      expect(b.getCenter()).toEqual({ x: 20, z: 35 });
    });
  });

  describe('expand', () => {
    it('widens an empty extent to (-5, -5, 5, 5)', () => {
      const b = new BoundaryRectangle();
      b.rectangle = { x0: -5, z0: -5, x1: 5, z1: 5 };
      const extent = { x0: Infinity, z0: Infinity, x1: -Infinity, z1: -Infinity };
      b.expand(extent);
      expect(extent).toEqual({ x0: -5, z0: -5, x1: 5, z1: 5 });
    });

    it('does not shrink an already-larger extent', () => {
      const b = new BoundaryRectangle();
      b.rectangle = { x0: -5, z0: -5, x1: 5, z1: 5 };
      const extent = { x0: -10, z0: -10, x1: 10, z1: 10 };
      b.expand(extent);
      expect(extent).toEqual({ x0: -10, z0: -10, x1: 10, z1: 10 });
    });
  });

  describe('intersects', () => {
    it('AABB overlap returns true', () => {
      const b = new BoundaryRectangle();
      b.rectangle = { x0: -5, z0: -5, x1: 5, z1: 5 };
      expect(b.intersects({ x0: 0, z0: 0, x1: 10, z1: 10 })).toBe(true);
      expect(b.intersects({ x0: -10, z0: -10, x1: 0, z1: 0 })).toBe(true);
    });

    it('disjoint AABBs return false', () => {
      const b = new BoundaryRectangle();
      b.rectangle = { x0: -5, z0: -5, x1: 5, z1: 5 };
      expect(b.intersects({ x0: 10, z0: 10, x1: 20, z1: 20 })).toBe(false);
      expect(b.intersects({ x0: -20, z0: 0, x1: -10, z1: 5 })).toBe(false);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // IFF round-trip — every load_000N
  // ─────────────────────────────────────────────────────────────────────

  /** Build the IHDR sub-form (version 0001 — name + active, no tool color). */
  function writeIhdr(w: IffWriter, name: string, active: boolean): void {
    w.insertForm('IHDR')
      .insertForm('0001')
        .insertChunk('DATA')
          .writeI32(active ? 1 : 0)
          .writeString(name)
        .exitChunk()
      .exitForm()
    .exitForm();
  }

  describe('load (IFF round-trip)', () => {
    it('reads version 0000 (rectangle bounds only)', () => {
      const w = new IffWriter()
        .insertForm('BREC')
          .insertForm('0000');
      writeIhdr(w, 'rect-v0', true);
      w.insertChunk('DATA')
        .writeF32(-3).writeF32(-4).writeF32(7).writeF32(8)
      .exitChunk();
      w.exitForm().exitForm();

      const iff = Iff.fromBytes(w.toBytes());
      const b = new BoundaryRectangle();
      b.load(iff);

      expect(b.name).toBe('rect-v0');
      expect(b.active).toBe(true);
      expect(b.rectangle).toEqual({ x0: -3, z0: -4, x1: 7, z1: 8 });
      // featherDistance defaults to 0 → inner == outer
      expect(b.innerRectangle).toEqual({ x0: -3, z0: -4, x1: 7, z1: 8 });
    });

    it('reads version 0001 (leading unused float + bounds)', () => {
      const w = new IffWriter()
        .insertForm('BREC')
          .insertForm('0001');
      writeIhdr(w, 'rect-v1', true);
      w.insertChunk('DATA')
        .writeF32(99) // unused
        .writeF32(-1).writeF32(-2).writeF32(3).writeF32(4)
      .exitChunk();
      w.exitForm().exitForm();

      const iff = Iff.fromBytes(w.toBytes());
      const b = new BoundaryRectangle();
      b.load(iff);

      expect(b.rectangle).toEqual({ x0: -1, z0: -2, x1: 3, z1: 4 });
    });

    it('reads version 0002 (bounds + feather function + distance)', () => {
      const w = new IffWriter()
        .insertForm('BREC')
          .insertForm('0002');
      writeIhdr(w, 'rect-v2', true);
      w.insertChunk('DATA')
        .writeF32(-5).writeF32(-5).writeF32(5).writeF32(5)
        .writeI32(FeatherFunction.EaseInOut)
        .writeF32(0.4)
      .exitChunk();
      w.exitForm().exitForm();

      const iff = Iff.fromBytes(w.toBytes());
      const b = new BoundaryRectangle();
      b.load(iff);

      expect(b.rectangle).toEqual({ x0: -5, z0: -5, x1: 5, z1: 5 });
      expect(b.featherFunction).toBe(FeatherFunction.EaseInOut);
      expect(b.featherDistance).toBeCloseTo(0.4, 5);
      // feather = 0.5 * 10 * 0.4 = 2 → inner = (-3, -3, 3, 3)
      expect(b.innerRectangle.x0).toBeCloseTo(-3, 5);
      expect(b.innerRectangle.x1).toBeCloseTo(3, 5);
    });

    it('reads version 0003 (adds local water table fields)', () => {
      const w = new IffWriter()
        .insertForm('BREC')
          .insertForm('0003');
      writeIhdr(w, 'rect-v3', true);
      w.insertChunk('DATA')
        .writeF32(-5).writeF32(-5).writeF32(5).writeF32(5)
        .writeI32(FeatherFunction.Linear)
        .writeF32(0.2)
        .writeI32(1) // localWaterTable
        .writeI32(0) // localGlobalWaterTable
        .writeF32(12.5) // height
        .writeF32(3.0)  // shader size
        .writeString('water/lake.sht')
      .exitChunk();
      w.exitForm().exitForm();

      const iff = Iff.fromBytes(w.toBytes());
      const b = new BoundaryRectangle();
      b.load(iff);

      expect(b.localWaterTable).toBe(true);
      expect(b.localGlobalWaterTable).toBe(false);
      expect(b.localWaterTableHeight).toBeCloseTo(12.5, 5);
      expect(b.localWaterTableShaderSize).toBeCloseTo(3.0, 5);
      expect(b.localWaterTableShaderTemplateName).toBe('water/lake.sht');
    });

    it('reads version 0004 (adds waterType)', () => {
      const w = new IffWriter()
        .insertForm('BREC')
          .insertForm('0004');
      writeIhdr(w, 'rect-v4', true);
      w.insertChunk('DATA')
        .writeF32(-5).writeF32(-5).writeF32(5).writeF32(5)
        .writeI32(FeatherFunction.Linear)
        .writeF32(0)
        .writeI32(1) // localWaterTable
        .writeI32(1) // localGlobalWaterTable
        .writeF32(0)
        .writeF32(2.5)
        .writeString('water/lava.sht')
        .writeI32(1) // TGWT_lava
      .exitChunk();
      w.exitForm().exitForm();

      const iff = Iff.fromBytes(w.toBytes());
      const b = new BoundaryRectangle();
      b.load(iff);

      expect(b.waterType).toBe(1);
      expect(b.localGlobalWaterTable).toBe(true);
    });

    it('normalizes a reversed rectangle (x0>x1) during load via recalculate', () => {
      const w = new IffWriter()
        .insertForm('BREC')
          .insertForm('0000');
      writeIhdr(w, 'reversed', true);
      w.insertChunk('DATA')
        .writeF32(5).writeF32(5).writeF32(-5).writeF32(-5)
      .exitChunk();
      w.exitForm().exitForm();

      const iff = Iff.fromBytes(w.toBytes());
      const b = new BoundaryRectangle();
      b.load(iff);

      expect(b.rectangle).toEqual({ x0: -5, z0: -5, x1: 5, z1: 5 });
    });

    it('clamps featherDistance to [0, 1]', () => {
      const w = new IffWriter()
        .insertForm('BREC')
          .insertForm('0002');
      writeIhdr(w, 'fd-clamp', true);
      w.insertChunk('DATA')
        .writeF32(-5).writeF32(-5).writeF32(5).writeF32(5)
        .writeI32(FeatherFunction.Linear)
        .writeF32(1.5) // > 1, must clamp
      .exitChunk();
      w.exitForm().exitForm();

      const iff = Iff.fromBytes(w.toBytes());
      const b = new BoundaryRectangle();
      b.load(iff);

      expect(b.featherDistance).toBe(1);
    });
  });
});
