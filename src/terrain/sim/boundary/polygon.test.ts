/**
 * Tests for `BoundaryPolygon` — the port of `BoundaryPolygon` from
 * `sharedTerrain/.../Boundary.{h,cpp}`.
 *
 * Coverage:
 *   - Point-in-polygon (square + triangle).
 *   - Outside-edge feathering (a 1-unit feather band yields a 0.5 reading
 *     at 0.5 units from the edge, per the user-spec formula
 *     `1 - Feather.feather(linear, distance/featherDistance)`).
 *   - `getCenter`, `expand`, `intersects` against the recomputed extent.
 *   - IFF round-trip via `IffWriter` for the latest format version (0007)
 *     and one of the older inlined-points formats (0002) to exercise the
 *     two distinct point-encoding shapes.
 */

import { describe, expect, it } from 'vitest';
import { Iff, IffWriter } from '../../../iff/iff.js';
import { BoundaryPolygon } from './polygon.js';
import { FeatherFunction, type Rectangle2d } from '../types.js';

/** Build a BoundaryPolygon directly (skipping the IFF load path) for geometry-only tests. */
function makePolygon(
  points: Array<[number, number]>,
  featherDistance = 0,
  featherFunction: FeatherFunction = FeatherFunction.Linear,
): BoundaryPolygon {
  const b = new BoundaryPolygon();
  for (const [x, z] of points) b.pointList.push({ x, z });
  b.featherDistance = featherDistance;
  b.featherFunction = featherFunction;
  // BoundaryPolygon.recalculate is private; re-derive extent here in the
  // same way the public `load` path would.
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (const p of b.pointList) {
    if (p.x < x0) x0 = p.x;
    if (p.x > x1) x1 = p.x;
    if (p.z < z0) z0 = p.z;
    if (p.z > z1) z1 = p.z;
  }
  b.extent = { x0, z0, x1, z1 };
  return b;
}

describe('BoundaryPolygon — geometry', () => {
  describe('square polygon [(-5,-5), (5,-5), (5,5), (-5,5)] with featherDistance=1', () => {
    const square = makePolygon([[-5, -5], [5, -5], [5, 5], [-5, 5]], 1);

    it('returns 1.0 at the center', () => {
      expect(square.isWithin(0, 0)).toBe(1);
    });

    it('returns 1.0 well inside the polygon', () => {
      expect(square.isWithin(2.5, -3)).toBe(1);
      expect(square.isWithin(-4, 4)).toBe(1);
    });

    it('returns 0.0 well outside the feather band', () => {
      expect(square.isWithin(10, 0)).toBe(0);
      expect(square.isWithin(0, 100)).toBe(0);
      expect(square.isWithin(-50, -50)).toBe(0);
    });

    it('returns a feathered value (0 < result < 1) inside the outside band', () => {
      // 0.5 units outside the right edge → 1 - 0.5/1 = 0.5.
      const v = square.isWithin(5.5, 0);
      expect(v).toBeGreaterThan(0);
      expect(v).toBeLessThan(1);
      expect(v).toBeCloseTo(0.5, 6);
    });

    it('returns ~1.0 right at the edge (distance 0)', () => {
      // Exactly on the boundary — outside per ray-cast (the < check excludes
      // the right edge), distance is 0 → 1 - 0/1 = 1.
      expect(square.isWithin(5, 0)).toBeCloseTo(1, 6);
    });

    it('returns ~0.0 right at the outer feather edge (distance = featherDistance)', () => {
      // 1.0 units past the right edge → 1 - 1/1 = 0.
      expect(square.isWithin(6, 0)).toBeCloseTo(0, 6);
    });

    it('feathers around a vertex, not just an edge perpendicular', () => {
      // Diagonally past the corner — closest point is the vertex (5,5).
      // Distance = sqrt(2)/2 ≈ 0.707; expected = 1 - 0.707 ≈ 0.293.
      const v = square.isWithin(5.5, 5.5);
      const expected = 1 - Math.SQRT2 / 2;
      expect(v).toBeCloseTo(expected, 4);
    });
  });

  describe('triangle polygon [(0,0), (10,0), (5,8)] (no feather)', () => {
    const tri = makePolygon([[0, 0], [10, 0], [5, 8]], 0);

    it('returns 1.0 at the centroid', () => {
      expect(tri.isWithin(5, 3)).toBe(1);
    });

    it('returns 0.0 outside (no feather → hard edge)', () => {
      expect(tri.isWithin(-1, 0)).toBe(0);
      expect(tri.isWithin(15, 0)).toBe(0);
      expect(tri.isWithin(5, 10)).toBe(0);
    });

    it('returns 0.0 below the base edge', () => {
      expect(tri.isWithin(5, -0.1)).toBe(0);
    });

    it('correctly classifies points near the slanted edges', () => {
      // Point just inside the left slant (slope from (0,0)→(5,8) is z=1.6x).
      // At x=2, the slant is at z=3.2; (2, 2) should be inside, (2, 4) outside.
      expect(tri.isWithin(2, 2)).toBe(1);
      expect(tri.isWithin(2, 4)).toBe(0);
    });
  });

  describe('degenerate cases', () => {
    it('returns 0 for an empty polygon', () => {
      const empty = new BoundaryPolygon();
      expect(empty.isWithin(0, 0)).toBe(0);
    });

    it('returns 0 for a polygon with fewer than 3 points', () => {
      const line = makePolygon([[0, 0], [10, 10]], 0);
      expect(line.isWithin(5, 5)).toBe(0);
    });
  });
});

describe('BoundaryPolygon — bounding box and helpers', () => {
  const square = makePolygon([[-5, -5], [5, -5], [5, 5], [-5, 5]], 0);

  it('getCenter returns mid-extent', () => {
    const c = square.getCenter();
    expect(c.x).toBe(0);
    expect(c.z).toBe(0);
  });

  it('getCenter for an asymmetric polygon equals the AABB center, not the centroid', () => {
    const tri = makePolygon([[0, 0], [10, 0], [5, 8]], 0);
    const c = tri.getCenter();
    expect(c.x).toBe(5);   // (0 + 10) / 2
    expect(c.z).toBe(4);   // (0 + 8)  / 2
  });

  it('expand grows the input rectangle to contain the polygon extent', () => {
    const ext: Rectangle2d = { x0: -1, z0: -1, x1: 1, z1: 1 };
    square.expand(ext);
    expect(ext.x0).toBe(-5);
    expect(ext.z0).toBe(-5);
    expect(ext.x1).toBe(5);
    expect(ext.z1).toBe(5);
  });

  it("expand leaves the input alone if it's already larger", () => {
    const ext: Rectangle2d = { x0: -100, z0: -100, x1: 100, z1: 100 };
    square.expand(ext);
    expect(ext).toEqual({ x0: -100, z0: -100, x1: 100, z1: 100 });
  });

  it('intersects returns true for an overlapping AABB', () => {
    expect(square.intersects({ x0: 0, z0: 0, x1: 100, z1: 100 })).toBe(true);
    expect(square.intersects({ x0: -10, z0: -10, x1: 10, z1: 10 })).toBe(true);
  });

  it('intersects returns false for a clearly disjoint AABB', () => {
    expect(square.intersects({ x0: 10, z0: 10, x1: 20, z1: 20 })).toBe(false);
    expect(square.intersects({ x0: -100, z0: -100, x1: -50, z1: -50 })).toBe(false);
  });
});

describe('BoundaryPolygon — IFF load', () => {
  it('loads a synthetic BPOL > 0007 buffer (counted points + feather + water)', () => {
    const bytes = new IffWriter()
      .insertForm('BPOL')
      .insertForm('0007')
      // IHDR > 0001 > DATA: active (i32) + name (string)
      .insertForm('IHDR')
      .insertForm('0001')
      .insertChunk('DATA')
      .writeI32(1)
      .writeString('test-poly')
      .exitChunk()
      .exitForm() // 0001
      .exitForm() // IHDR
      .insertChunk('DATA')
      // 4 points
      .writeI32(4)
      .writeF32(-5).writeF32(-5)
      .writeF32(5).writeF32(-5)
      .writeF32(5).writeF32(5)
      .writeF32(-5).writeF32(5)
      // feather function + distance
      .writeI32(FeatherFunction.EaseInOut)
      .writeF32(2.5)
      // localWaterTable + height + shader size + water type + shader name
      .writeI32(1)
      .writeF32(12.5)
      .writeF32(2.0)
      .writeI32(0) // water type
      .writeString('shader/water.sht')
      .exitChunk()
      .exitForm() // 0007
      .exitForm() // BPOL
      .toBytes();

    const iff = Iff.fromBytes(bytes);
    const poly = new BoundaryPolygon();
    poly.load(iff);

    expect(poly.pointList).toHaveLength(4);
    expect(poly.pointList[0]).toEqual({ x: -5, z: -5 });
    expect(poly.pointList[1]).toEqual({ x: 5, z: -5 });
    expect(poly.pointList[2]).toEqual({ x: 5, z: 5 });
    expect(poly.pointList[3]).toEqual({ x: -5, z: 5 });

    expect(poly.featherFunction).toBe(FeatherFunction.EaseInOut);
    expect(poly.featherDistance).toBeCloseTo(2.5, 6);

    expect(poly.localWaterTable).toBe(true);
    expect(poly.localWaterTableHeight).toBeCloseTo(12.5, 6);

    expect(poly.active).toBe(true);
    expect(poly.name).toBe('test-poly');

    // Extent recomputed from points.
    expect(poly.extent).toEqual({ x0: -5, z0: -5, x1: 5, z1: 5 });

    // The loaded polygon is geometrically usable.
    expect(poly.isWithin(0, 0)).toBe(1);
    expect(poly.isWithin(100, 100)).toBe(0);
  });

  it('loads a synthetic BPOL > 0002 buffer (inlined points until end of chunk)', () => {
    const bytes = new IffWriter()
      .insertForm('BPOL')
      .insertForm('0002')
      .insertForm('IHDR')
      .insertForm('0001')
      .insertChunk('DATA')
      .writeI32(1)
      .writeString('inlined')
      .exitChunk()
      .exitForm()
      .exitForm()
      .insertChunk('DATA')
      .writeI32(FeatherFunction.Linear)
      .writeF32(0)
      // 3 points inlined to end-of-chunk; reader infers count from
      // remaining bytes (8 bytes per point).
      .writeF32(0).writeF32(0)
      .writeF32(10).writeF32(0)
      .writeF32(5).writeF32(8)
      .exitChunk()
      .exitForm() // 0002
      .exitForm() // BPOL
      .toBytes();

    const iff = Iff.fromBytes(bytes);
    const poly = new BoundaryPolygon();
    poly.load(iff);

    expect(poly.pointList).toHaveLength(3);
    expect(poly.pointList[2]).toEqual({ x: 5, z: 8 });
    expect(poly.featherFunction).toBe(FeatherFunction.Linear);
    expect(poly.featherDistance).toBe(0);
    expect(poly.extent).toEqual({ x0: 0, z0: 0, x1: 10, z1: 8 });
    expect(poly.name).toBe('inlined');
  });

  it('throws on an unknown BPOL version', () => {
    const bytes = new IffWriter()
      .insertForm('BPOL')
      .insertForm('9999')
      .insertChunk('DATA')
      .writeI32(0)
      .exitChunk()
      .exitForm()
      .exitForm()
      .toBytes();

    const iff = Iff.fromBytes(bytes);
    const poly = new BoundaryPolygon();
    expect(() => poly.load(iff)).toThrow(/unknown version/);
  });
});
