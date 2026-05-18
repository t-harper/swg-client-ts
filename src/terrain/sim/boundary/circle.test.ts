/**
 * Unit tests for `BoundaryCircle` — covers isWithin, expand, intersects, and
 * IFF round-trip via IffWriter for all three load versions (0000/0001/0002).
 */

import { describe, expect, it } from 'vitest';
import { Iff, IffWriter } from '../../../iff/iff.js';
import { FeatherFunction, type Rectangle2d } from '../types.js';
import { BoundaryCircle } from './circle.js';

describe('BoundaryCircle', () => {
  describe('isWithin', () => {
    function makeCircle(): BoundaryCircle {
      const b = new BoundaryCircle();
      b.centerX = 0;
      b.centerZ = 0;
      b.radius = 10;
      b.radiusSquared = 100;
      b.featherDistance = 2;
      b.featherFunction = FeatherFunction.Linear;
      return b;
    }

    it('returns 1.0 at the center', () => {
      expect(makeCircle().isWithin(0, 0)).toBe(1);
    });

    it('returns 0.0 well outside the radius', () => {
      expect(makeCircle().isWithin(20, 0)).toBe(0);
    });

    it('returns 0.0 right at the edge (distance == radius)', () => {
      // distSquared == radiusSquared → outside (exclusive bound).
      expect(makeCircle().isWithin(10, 0)).toBe(0);
    });

    it('returns 1.0 inside the unfeathered core', () => {
      // inner radius = 10 - 2 = 8; (8, 0) is on the boundary of the core,
      // so distSquared == innerRadiusSquared → still fully inside.
      expect(makeCircle().isWithin(8, 0)).toBe(1);
      expect(makeCircle().isWithin(7.9, 0)).toBe(1);
    });

    it('returns a feathered value strictly between 0 and 1 in the feather band', () => {
      const v = makeCircle().isWithin(9, 0);
      expect(v).toBeGreaterThan(0);
      expect(v).toBeLessThan(1);
      // Linear feather: t = (10 - 9) / 2 = 0.5 → expect ≈ 0.5.
      expect(v).toBeCloseTo(0.5, 6);
    });

    it('respects the diagonal — distance, not coordinate, matters', () => {
      // Point at (9/√2, 9/√2) has distance 9, same as (9, 0).
      const d = 9 / Math.SQRT2;
      expect(makeCircle().isWithin(d, d)).toBeCloseTo(0.5, 6);
    });

    it('returns 1.0 everywhere inside when featherDistance is 0 (step function)', () => {
      const b = new BoundaryCircle();
      b.centerX = 0;
      b.centerZ = 0;
      b.radius = 10;
      b.radiusSquared = 100;
      b.featherDistance = 0;
      expect(b.isWithin(0, 0)).toBe(1);
      expect(b.isWithin(9.9, 0)).toBe(1);
      expect(b.isWithin(10, 0)).toBe(0);
      expect(b.isWithin(11, 0)).toBe(0);
    });

    it('runs the feather curve through Feather.feather()', () => {
      const b = new BoundaryCircle();
      b.centerX = 0;
      b.centerZ = 0;
      b.radius = 10;
      b.radiusSquared = 100;
      b.featherDistance = 2;
      b.featherFunction = FeatherFunction.EaseIn; // t² → 0.5² = 0.25 at t=0.5
      const v = b.isWithin(9, 0);
      expect(v).toBeCloseTo(0.25, 6);
    });

    it('handles featherDistance >= radius without producing NaN', () => {
      // Inner radius would be <= 0; the entire interior is feather band.
      const b = new BoundaryCircle();
      b.centerX = 0;
      b.centerZ = 0;
      b.radius = 10;
      b.radiusSquared = 100;
      b.featherDistance = 10;
      // At center: t = (10 - 0) / 10 = 1 → fully inside.
      expect(b.isWithin(0, 0)).toBe(1);
      // At halfway: t = (10 - 5) / 10 = 0.5.
      expect(b.isWithin(5, 0)).toBeCloseTo(0.5, 6);
      // Outside: still 0.
      expect(b.isWithin(11, 0)).toBe(0);
    });
  });

  describe('expand', () => {
    it('enlarges the extent to include the circle bounding box', () => {
      const b = new BoundaryCircle();
      b.centerX = 0;
      b.centerZ = 0;
      b.radius = 10;
      b.radiusSquared = 100;
      const extent: Rectangle2d = { x0: 5, z0: 5, x1: 6, z1: 6 };
      b.expand(extent);
      expect(extent.x0).toBe(-10);
      expect(extent.x1).toBe(10);
      expect(extent.z0).toBe(-10);
      expect(extent.z1).toBe(10);
    });

    it('leaves the extent alone when it already contains the bbox', () => {
      const b = new BoundaryCircle();
      b.centerX = 0;
      b.centerZ = 0;
      b.radius = 1;
      b.radiusSquared = 1;
      const extent: Rectangle2d = { x0: -100, z0: -100, x1: 100, z1: 100 };
      b.expand(extent);
      expect(extent).toEqual({ x0: -100, z0: -100, x1: 100, z1: 100 });
    });

    it('partially enlarges when only one side falls outside', () => {
      const b = new BoundaryCircle();
      b.centerX = 50;
      b.centerZ = 0;
      b.radius = 10;
      b.radiusSquared = 100;
      const extent: Rectangle2d = { x0: 0, z0: -5, x1: 55, z1: 5 };
      b.expand(extent);
      expect(extent.x0).toBe(0); // unchanged (0 < 40)
      expect(extent.x1).toBe(60); // grown to 50+10
      expect(extent.z0).toBe(-10);
      expect(extent.z1).toBe(10);
    });
  });

  describe('intersects', () => {
    function makeCircle(): BoundaryCircle {
      const b = new BoundaryCircle();
      b.centerX = 0;
      b.centerZ = 0;
      b.radius = 10;
      b.radiusSquared = 100;
      return b;
    }

    it('returns true when the rectangle overlaps the circle bounds', () => {
      expect(makeCircle().intersects({ x0: 5, z0: 0, x1: 15, z1: 5 })).toBe(true);
    });

    it('returns false for a rectangle far outside the circle', () => {
      expect(makeCircle().intersects({ x0: 50, z0: 50, x1: 60, z1: 60 })).toBe(false);
    });

    it('returns true when the rectangle wholly contains the circle', () => {
      expect(makeCircle().intersects({ x0: -100, z0: -100, x1: 100, z1: 100 })).toBe(true);
    });

    it('returns true when the circle wholly contains the rectangle', () => {
      expect(makeCircle().intersects({ x0: -1, z0: -1, x1: 1, z1: 1 })).toBe(true);
    });

    it('uses true circle-vs-rect (not bbox-vs-rect) for diagonal misses', () => {
      // The corner-touching diagonal rectangle is outside the radius even
      // though it overlaps the circle's AABB.
      const b = makeCircle();
      // Bounding box [-10, 10] × [-10, 10]. Rect at corner (8, 8) to (12, 12).
      // Closest point on rect to center is (8, 8); dist² = 128 > 100 → no hit.
      expect(b.intersects({ x0: 8, z0: 8, x1: 12, z1: 12 })).toBe(false);
      // Whereas a closer rect at (5, 5) to (12, 12): closest point (5, 5),
      // dist² = 50 < 100 → hit.
      expect(b.intersects({ x0: 5, z0: 5, x1: 12, z1: 12 })).toBe(true);
    });
  });

  describe('getCenter', () => {
    it('returns the centerX/centerZ as a Vector2d', () => {
      const b = new BoundaryCircle();
      b.centerX = 17;
      b.centerZ = -3;
      expect(b.getCenter()).toEqual({ x: 17, z: -3 });
    });
  });

  describe('load — IFF round-trip', () => {
    /**
     * Build a synthetic BCIR form at version `ver`. The DATA payload differs
     * per version (see the C++ Boundary.cpp load_000N functions).
     */
    function buildBcirBytes(
      ver: '0000' | '0001' | '0002',
      ihdrVer: '0000' | '0001',
      params: {
        active: boolean;
        name: string;
        centerX: number;
        centerZ: number;
        radius: number;
        featherFunction?: FeatherFunction;
        featherDistance?: number;
      },
    ): Uint8Array {
      const w = new IffWriter();
      w.insertForm('BCIR').insertForm(ver);

      // IHDR (LayerItem base).
      w.insertForm('IHDR').insertForm(ihdrVer).insertChunk('DATA');
      w.writeI32(params.active ? 1 : 0);
      w.writeString(params.name);
      if (ihdrVer === '0000') {
        // legacy toolColor (PackedRgb)
        w.writeU8(0xff);
        w.writeU8(0x80);
        w.writeU8(0x00);
      }
      w.exitChunk().exitForm().exitForm();

      // DATA (boundary-specific).
      w.insertChunk('DATA');
      if (ver === '0001') {
        // load_0001 prepends an unused float.
        w.writeF32(0);
      }
      w.writeF32(params.centerX);
      w.writeF32(params.centerZ);
      w.writeF32(params.radius);
      if (ver === '0002') {
        w.writeI32(params.featherFunction ?? FeatherFunction.Linear);
        w.writeF32(params.featherDistance ?? 0);
      }
      w.exitChunk();

      w.exitForm().exitForm();
      return w.toBytes();
    }

    it('loads version 0000 with IHDR 0001', () => {
      const bytes = buildBcirBytes('0000', '0001', {
        active: true,
        name: 'inner ring',
        centerX: 100,
        centerZ: -50,
        radius: 25,
      });
      const iff = Iff.fromBytes(bytes);
      const b = new BoundaryCircle();
      b.load(iff);
      expect(b.active).toBe(true);
      expect(b.name).toBe('inner ring');
      expect(b.centerX).toBe(100);
      expect(b.centerZ).toBe(-50);
      expect(b.radius).toBe(25);
      expect(b.radiusSquared).toBe(625);
      // Defaults unchanged for v0000.
      expect(b.featherFunction).toBe(FeatherFunction.Linear);
      expect(b.featherDistance).toBe(0);
    });

    it('loads version 0001 with IHDR 0000 (legacy with toolColor)', () => {
      const bytes = buildBcirBytes('0001', '0000', {
        active: false,
        name: 'old ring',
        centerX: 0,
        centerZ: 0,
        radius: 7,
      });
      const iff = Iff.fromBytes(bytes);
      const b = new BoundaryCircle();
      b.load(iff);
      expect(b.active).toBe(false);
      expect(b.name).toBe('old ring');
      expect(b.centerX).toBe(0);
      expect(b.centerZ).toBe(0);
      expect(b.radius).toBe(7);
      expect(b.radiusSquared).toBe(49);
    });

    it('loads version 0002 with feather params', () => {
      const bytes = buildBcirBytes('0002', '0001', {
        active: true,
        name: 'feathered ring',
        centerX: 12,
        centerZ: 34,
        radius: 8,
        featherFunction: FeatherFunction.EaseInOut,
        featherDistance: 0.25,
      });
      const iff = Iff.fromBytes(bytes);
      const b = new BoundaryCircle();
      b.load(iff);
      expect(b.name).toBe('feathered ring');
      expect(b.centerX).toBe(12);
      expect(b.centerZ).toBe(34);
      expect(b.radius).toBe(8);
      expect(b.radiusSquared).toBe(64);
      expect(b.featherFunction).toBe(FeatherFunction.EaseInOut);
      expect(b.featherDistance).toBe(0.25);
    });

    it('clamps featherDistance to [0, 1] on load', () => {
      const bytes = buildBcirBytes('0002', '0001', {
        active: true,
        name: 'x',
        centerX: 0,
        centerZ: 0,
        radius: 1,
        featherFunction: FeatherFunction.Linear,
        featherDistance: 5, // out of range
      });
      const iff = Iff.fromBytes(bytes);
      const b = new BoundaryCircle();
      b.load(iff);
      expect(b.featherDistance).toBe(1);
    });

    it('takes the absolute value of a negative radius', () => {
      const bytes = buildBcirBytes('0000', '0001', {
        active: true,
        name: 'neg',
        centerX: 0,
        centerZ: 0,
        radius: -4,
      });
      const iff = Iff.fromBytes(bytes);
      const b = new BoundaryCircle();
      b.load(iff);
      expect(b.radius).toBe(4);
      expect(b.radiusSquared).toBe(16);
    });

    it('throws on an unknown BCIR version', () => {
      const w = new IffWriter()
        .insertForm('BCIR')
        .insertForm('0099')
        .insertChunk('DATA')
        .exitChunk()
        .exitForm()
        .exitForm();
      const iff = Iff.fromBytes(w.toBytes());
      const b = new BoundaryCircle();
      expect(() => b.load(iff)).toThrow(/unknown version/);
    });
  });
});
