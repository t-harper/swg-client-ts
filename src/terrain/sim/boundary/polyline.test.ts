/**
 * Tests for `BoundaryPolyline`.
 *
 * Covers:
 *   - Direct construction → `isWithin` (the stroked-path + feather band).
 *   - `expand` / `intersects` / `getCenter` on a known extent.
 *   - IFF round-trip for the load-0003 wire form (the version `save()`
 *     writes in C++, so the most representative on-disk format).
 */

import { describe, expect, it } from 'vitest';
import { IffWriter, Iff } from '../../../iff/iff.js';
import { FeatherFunction } from '../types.js';
import { BoundaryPolyline } from './polyline.js';

/** Build a polyline directly (skipping IFF) for the geometric tests. */
function makePolyline(opts: {
  points: { x: number; z: number }[];
  width: number;
  featherDistance: number;
  featherFunction?: FeatherFunction;
}): BoundaryPolyline {
  const p = new BoundaryPolyline();
  p.pointList = [...opts.points];
  p.width = opts.width;
  p.featherDistance = opts.featherDistance;
  p.featherFunction = opts.featherFunction ?? FeatherFunction.Linear;
  // Mirror the post-load `recalculate()` step that load() performs.
  // We can't call the private method, so re-run the same logic here:
  if (p.pointList.length === 0) {
    p.extent = { x0: 0, z0: 0, x1: 0, z1: 0 };
  } else {
    let x0 = Number.POSITIVE_INFINITY;
    let z0 = Number.POSITIVE_INFINITY;
    let x1 = Number.NEGATIVE_INFINITY;
    let z1 = Number.NEGATIVE_INFINITY;
    for (const pt of p.pointList) {
      if (pt.x < x0) x0 = pt.x;
      if (pt.z < z0) z0 = pt.z;
      if (pt.x > x1) x1 = pt.x;
      if (pt.z > z1) z1 = pt.z;
    }
    const half = p.width / 2;
    p.extent = { x0: x0 - half, z0: z0 - half, x1: x1 + half, z1: z1 + half };
  }
  return p;
}

describe('BoundaryPolyline.isWithin (straight horizontal line)', () => {
  // points = [(0, 0), (10, 0)], width = 2 → half-width = 1, feather band = 1.
  const line = () =>
    makePolyline({
      points: [{ x: 0, z: 0 }, { x: 10, z: 0 }],
      width: 2,
      featherDistance: 1,
    });

  it('returns 1.0 directly on the line', () => {
    expect(line().isWithin(5, 0)).toBe(1);
  });

  it('returns 1.0 inside the half-width', () => {
    expect(line().isWithin(5, 0.5)).toBe(1);
  });

  it('returns a value strictly between 0 and 1 inside the feather band', () => {
    const v = line().isWithin(5, 1.5);
    expect(v).toBeGreaterThan(0);
    expect(v).toBeLessThan(1);
    // Linear feather: t = (halfWidth + feather - dist) / feather = (1 + 1 - 1.5) / 1 = 0.5.
    expect(v).toBeCloseTo(0.5, 6);
  });

  it('returns 0.0 beyond the feather band', () => {
    expect(line().isWithin(5, 3)).toBe(0);
  });

  it('returns 1.0 exactly at the half-width edge', () => {
    expect(line().isWithin(5, 1)).toBe(1);
  });

  it('returns 0.0 exactly at the outer feather edge', () => {
    expect(line().isWithin(5, 2)).toBe(0);
  });
});

describe('BoundaryPolyline.isWithin (L-shape, 3 points)', () => {
  // Points form an L: (0,0) → (10,0) → (10,10). Width 2, no feather band.
  const ell = () =>
    makePolyline({
      points: [
        { x: 0, z: 0 },
        { x: 10, z: 0 },
        { x: 10, z: 10 },
      ],
      width: 2,
      featherDistance: 0,
    });

  it('is inside on the horizontal leg', () => {
    expect(ell().isWithin(5, 0.5)).toBe(1);
  });

  it('is inside on the vertical leg', () => {
    expect(ell().isWithin(10.5, 5)).toBe(1);
  });

  it('is inside at the corner', () => {
    expect(ell().isWithin(10, 0)).toBe(1);
  });

  it('is outside far from both legs', () => {
    expect(ell().isWithin(0, 10)).toBe(0);
    expect(ell().isWithin(20, 20)).toBe(0);
  });

  it('is outside the half-width on either leg', () => {
    expect(ell().isWithin(5, 1.5)).toBe(0); // 0.5 beyond half-width on horiz leg
    expect(ell().isWithin(11.5, 5)).toBe(0);
  });
});

describe('BoundaryPolyline.isWithin (feather function)', () => {
  it('respects easeIn vs linear at the midpoint of the feather band', () => {
    const linear = makePolyline({
      points: [{ x: 0, z: 0 }, { x: 10, z: 0 }],
      width: 0, // zero half-width — pure feather band on either side
      featherDistance: 1,
      featherFunction: FeatherFunction.Linear,
    });
    const easeIn = makePolyline({
      points: [{ x: 0, z: 0 }, { x: 10, z: 0 }],
      width: 0,
      featherDistance: 1,
      featherFunction: FeatherFunction.EaseIn,
    });
    // At dist 0.5, t = (0 + 1 - 0.5) / 1 = 0.5.
    // Linear → 0.5, easeIn (t²) → 0.25.
    expect(linear.isWithin(5, 0.5)).toBeCloseTo(0.5, 6);
    expect(easeIn.isWithin(5, 0.5)).toBeCloseTo(0.25, 6);
  });
});

describe('BoundaryPolyline extent helpers', () => {
  it('computes a half-width-expanded extent', () => {
    const p = makePolyline({
      points: [{ x: 0, z: 0 }, { x: 10, z: 4 }],
      width: 2,
      featherDistance: 0,
    });
    expect(p.extent).toEqual({ x0: -1, z0: -1, x1: 11, z1: 5 });
  });

  it('expand() grows a parent extent to enclose ours', () => {
    const p = makePolyline({
      points: [{ x: 0, z: 0 }, { x: 10, z: 0 }],
      width: 2,
      featherDistance: 0,
    });
    const parent = { x0: 100, z0: 100, x1: 200, z1: 200 };
    p.expand(parent);
    expect(parent).toEqual({ x0: -1, z0: -1, x1: 200, z1: 200 });
  });

  it('intersects() against an overlapping rectangle', () => {
    const p = makePolyline({
      points: [{ x: 0, z: 0 }, { x: 10, z: 0 }],
      width: 2,
      featherDistance: 0,
    });
    expect(p.intersects({ x0: 5, z0: -5, x1: 15, z1: 5 })).toBe(true);
    expect(p.intersects({ x0: 100, z0: 100, x1: 200, z1: 200 })).toBe(false);
    // Touching edge — counts as intersecting.
    expect(p.intersects({ x0: 11, z0: -1, x1: 20, z1: 1 })).toBe(true);
  });

  it('getCenter() returns the extent midpoint', () => {
    const p = makePolyline({
      points: [{ x: 0, z: 0 }, { x: 10, z: 4 }],
      width: 2,
      featherDistance: 0,
    });
    // Extent {-1,-1,11,5} → center {5, 2}.
    expect(p.getCenter()).toEqual({ x: 5, z: 2 });
  });
});

describe('BoundaryPolyline.load (IFF round-trip, version 0003)', () => {
  /** Build a minimal BPLN > 0003 IFF that matches the C++ save() format. */
  function build0003(opts: {
    active: boolean;
    name: string;
    points: { x: number; z: number }[];
    featherFunction: FeatherFunction;
    featherDistance: number;
    width: number;
  }): Uint8Array {
    return new IffWriter()
      .insertForm('BPLN')
        .insertForm('0003')
          // IHDR — LayerItem::save writes version 0001 (no PackedRgb bytes).
          .insertForm('IHDR')
            .insertForm('0001')
              .insertChunk('DATA')
                .writeI32(opts.active ? 1 : 0)
                .writeString(opts.name)
              .exitChunk()
            .exitForm()
          .exitForm()
          // DATA — polyline-specific payload.
          .insertChunk('DATA')
            .writeI32(opts.points.length)
            // Each Vector2d = 2 × f32.
            .writeBytes(serializePoints(opts.points))
            .writeI32(opts.featherFunction)
            .writeF32(opts.featherDistance)
            .writeF32(opts.width)
          .exitChunk()
        .exitForm()
      .exitForm()
      .toBytes();
  }

  function serializePoints(points: { x: number; z: number }[]): Uint8Array {
    const buf = new Uint8Array(points.length * 8);
    const view = new DataView(buf.buffer);
    let off = 0;
    for (const p of points) {
      view.setFloat32(off, p.x, true); off += 4;
      view.setFloat32(off, p.z, true); off += 4;
    }
    return buf;
  }

  it('parses a 0003 BPLN end-to-end', () => {
    const bytes = build0003({
      active: true,
      name: 'test-line',
      points: [{ x: 0, z: 0 }, { x: 10, z: 0 }, { x: 10, z: 10 }],
      featherFunction: FeatherFunction.EaseInOut,
      featherDistance: 1.5,
      width: 4,
    });
    const iff = Iff.fromBytes(bytes);
    const p = new BoundaryPolyline();
    p.load(iff);

    expect(p.active).toBe(true);
    expect(p.name).toBe('test-line');
    expect(p.pointList).toEqual([
      { x: 0, z: 0 },
      { x: 10, z: 0 },
      { x: 10, z: 10 },
    ]);
    expect(p.featherFunction).toBe(FeatherFunction.EaseInOut);
    expect(p.featherDistance).toBeCloseTo(1.5, 6);
    expect(p.width).toBe(4);
    // Extent: x ∈ [0, 10], z ∈ [0, 10], expanded by width/2 = 2.
    expect(p.extent).toEqual({ x0: -2, z0: -2, x1: 12, z1: 12 });
  });

  it('runs isWithin correctly after load', () => {
    const bytes = build0003({
      active: true,
      name: 'roadbed',
      points: [{ x: 0, z: 0 }, { x: 10, z: 0 }],
      featherFunction: FeatherFunction.Linear,
      featherDistance: 1,
      width: 2,
    });
    const iff = Iff.fromBytes(bytes);
    const p = new BoundaryPolyline();
    p.load(iff);

    expect(p.isWithin(5, 0)).toBe(1);
    expect(p.isWithin(5, 0.5)).toBe(1);
    expect(p.isWithin(5, 1.5)).toBeCloseTo(0.5, 6);
    expect(p.isWithin(5, 3)).toBe(0);
  });
});
