/**
 * Port of `BoundaryPolyline` from `sharedTerrain/.../Boundary.{h,cpp}`
 * and the shared `BoundaryPoly` base it inherits from.
 *
 * Load versions: 0000-0003. Wire form (per C++ `load_000N`):
 *
 *   BPLN > version > {
 *     IHDR > 0000|0001 > DATA { i32 active, asciiz name [, u8 r, u8 g, u8 b]? },
 *     DATA {
 *       0000: i32 featherFunction, f32 featherDistance, f32 width, [Vector2d ...]
 *       0001: i32 nPoints, [Vector2d ...], i32 featherFunction, f32 featherDistance, f32 width
 *       0002: i32 nPoints, [Vector2d ...], i32 nOldHeights, [f32 ...], i32 featherFunction,
 *             f32 featherDistance, f32 width, i32 oldHasWidths
 *       0003: same as 0001
 *     }
 *   }
 *
 * The extent is the AABB of the points expanded by `m_width / 2` on each
 * axis (the stroked path's bounding box).
 *
 * `isWithin(x, z)` treats the polyline as a stroked path of half-width
 * `m_width / 2`. Distance to the closest segment is computed via clamped
 * projection. Points within `width/2` of any segment return 1.0; points
 * beyond `width/2 + featherDistance` return 0.0; in between, the value is
 * `Feather.feather(featherFunction, t)` where `t` ramps from 0 at the
 * outer feather edge to 1 at the inner stroke edge.
 */

import {
  Boundary, BoundaryType, BPLN_TAG, FeatherFunction, Feather,
  type Rectangle2d, type Vector2d,
} from '../types.js';
import type { Iff } from '../../../iff/iff.js';

export class BoundaryPolyline extends Boundary {
  pointList: Vector2d[] = [];
  extent: Rectangle2d = { x0: 0, z0: 0, x1: 0, z1: 0 };
  width = 0;

  constructor() {
    super(BPLN_TAG, BoundaryType.Polyline);
  }

  load(iff: Iff): void {
    // Cursor sits at the BPLN form. Enter and dispatch by version tag.
    iff.enterForm('BPLN');
    try {
      const version = iff.getCurrentName();
      switch (version) {
        case '0000':
          this.loadVersion0000(iff);
          break;
        case '0001':
          this.loadVersion0001(iff);
          break;
        case '0002':
          this.loadVersion0002(iff);
          break;
        case '0003':
          this.loadVersion0003(iff);
          break;
        default:
          throw new Error(`BoundaryPolyline.load: unknown version '${version}'`);
      }
    } finally {
      iff.exitForm('BPLN');
    }
    // Match C++ recalculate(): refresh the AABB after loading points.
    this.recalculate();
  }

  isWithin(worldX: number, worldZ: number): number {
    if (this.pointList.length === 0) return 0;

    const halfWidth = this.width / 2;
    const feather = this.featherDistance;
    const outerEdge = halfWidth + feather;

    // Early-out: quick AABB rejection. The extent only covers the half-
    // width stroke, so widen by the feather distance to keep feathered
    // points inside the bounding box.
    if (
      worldX < this.extent.x0 - feather || worldX > this.extent.x1 + feather ||
      worldZ < this.extent.z0 - feather || worldZ > this.extent.z1 + feather
    ) {
      return 0;
    }

    let minDist = Number.POSITIVE_INFINITY;

    if (this.pointList.length === 1) {
      // Degenerate: distance from the single point.
      const p = this.pointList[0]!;
      const dx = worldX - p.x;
      const dz = worldZ - p.z;
      minDist = Math.sqrt(dx * dx + dz * dz);
    } else {
      for (let i = 0; i < this.pointList.length - 1; ++i) {
        const a = this.pointList[i]!;
        const b = this.pointList[i + 1]!;
        const dist = distanceToSegment(worldX, worldZ, a.x, a.z, b.x, b.z);
        if (dist < minDist) minDist = dist;
      }
    }

    if (minDist <= halfWidth) return 1;
    if (feather <= 0 || minDist >= outerEdge) return 0;

    // Feathered band: t = 1 at the inner edge (width/2), 0 at the outer
    // edge (width/2 + featherDistance).
    const t = (outerEdge - minDist) / feather;
    return Feather.feather(this.featherFunction, t);
  }

  expand(extent: Rectangle2d): void {
    if (this.pointList.length === 0) return;
    if (extent.x0 > this.extent.x0) extent.x0 = this.extent.x0;
    if (extent.z0 > this.extent.z0) extent.z0 = this.extent.z0;
    if (extent.x1 < this.extent.x1) extent.x1 = this.extent.x1;
    if (extent.z1 < this.extent.z1) extent.z1 = this.extent.z1;
  }

  intersects(other: Rectangle2d): boolean {
    return (
      this.extent.x0 <= other.x1 &&
      this.extent.x1 >= other.x0 &&
      this.extent.z0 <= other.z1 &&
      this.extent.z1 >= other.z0
    );
  }

  override getCenter(): Vector2d {
    return {
      x: (this.extent.x0 + this.extent.x1) * 0.5,
      z: (this.extent.z0 + this.extent.z1) * 0.5,
    };
  }

  // -----------------------------------------------------------------------
  // Internals
  // -----------------------------------------------------------------------

  /** Recompute `extent` from `pointList`, expanded by `width / 2` on every axis. */
  private recalculate(): void {
    if (this.pointList.length === 0) {
      this.extent = { x0: 0, z0: 0, x1: 0, z1: 0 };
      return;
    }
    let x0 = Number.POSITIVE_INFINITY;
    let z0 = Number.POSITIVE_INFINITY;
    let x1 = Number.NEGATIVE_INFINITY;
    let z1 = Number.NEGATIVE_INFINITY;
    for (const p of this.pointList) {
      if (p.x < x0) x0 = p.x;
      if (p.z < z0) z0 = p.z;
      if (p.x > x1) x1 = p.x;
      if (p.z > z1) z1 = p.z;
    }
    const half = this.width / 2;
    this.extent = { x0: x0 - half, z0: z0 - half, x1: x1 + half, z1: z1 + half };
  }

  /**
   * Read the IHDR sub-form (LayerItem::load) — sets `active` and `name` on
   * `this`. Matches `TerrainGenerator::LayerItem::load` (TerrainGenerator.cpp:170).
   */
  private loadHeader(iff: Iff): void {
    iff.enterForm('IHDR');
    try {
      const v = iff.getCurrentName();
      iff.enterForm(v);
      try {
        iff.enterChunk('DATA');
        try {
          this.active = iff.readI32() !== 0;
          this.name = iff.readString();
          if (v === '0000') {
            // Three unused PackedRgb bytes.
            iff.readU8();
            iff.readU8();
            iff.readU8();
          }
        } finally {
          iff.exitChunk('DATA');
        }
      } finally {
        iff.exitForm(v);
      }
    } finally {
      iff.exitForm('IHDR');
    }
  }

  private loadVersion0000(iff: Iff): void {
    iff.enterForm('0000');
    try {
      this.loadHeader(iff);
      iff.enterChunk('DATA');
      try {
        this.featherFunction = iff.readI32() as FeatherFunction;
        this.featherDistance = iff.readF32();
        this.width = iff.readF32();
        // Remaining bytes are an array of Vector2d (2 × f32 each).
        while (iff.getChunkLengthLeft() >= 8) {
          const x = iff.readF32();
          const z = iff.readF32();
          this.pointList.push({ x, z });
        }
      } finally {
        iff.exitChunk('DATA');
      }
    } finally {
      iff.exitForm('0000');
    }
  }

  private loadVersion0001(iff: Iff): void {
    iff.enterForm('0001');
    try {
      this.loadHeader(iff);
      iff.enterChunk('DATA');
      try {
        const n = iff.readI32();
        for (let i = 0; i < n; ++i) {
          const x = iff.readF32();
          const z = iff.readF32();
          this.pointList.push({ x, z });
        }
        this.featherFunction = iff.readI32() as FeatherFunction;
        this.featherDistance = iff.readF32();
        this.width = iff.readF32();
      } finally {
        iff.exitChunk('DATA');
      }
    } finally {
      iff.exitForm('0001');
    }
  }

  private loadVersion0002(iff: Iff): void {
    iff.enterForm('0002');
    try {
      this.loadHeader(iff);
      iff.enterChunk('DATA');
      try {
        const n = iff.readI32();
        for (let i = 0; i < n; ++i) {
          const x = iff.readF32();
          const z = iff.readF32();
          this.pointList.push({ x, z });
        }
        // Legacy per-point height list — discarded by the C++ as well.
        const m = iff.readI32();
        for (let i = 0; i < m; ++i) iff.readF32();
        this.featherFunction = iff.readI32() as FeatherFunction;
        this.featherDistance = iff.readF32();
        this.width = iff.readF32();
        iff.readI32(); // old "hasWidths" flag, ignored
      } finally {
        iff.exitChunk('DATA');
      }
    } finally {
      iff.exitForm('0002');
    }
  }

  private loadVersion0003(iff: Iff): void {
    iff.enterForm('0003');
    try {
      this.loadHeader(iff);
      iff.enterChunk('DATA');
      try {
        const n = iff.readI32();
        for (let i = 0; i < n; ++i) {
          const x = iff.readF32();
          const z = iff.readF32();
          this.pointList.push({ x, z });
        }
        this.featherFunction = iff.readI32() as FeatherFunction;
        this.featherDistance = iff.readF32();
        this.width = iff.readF32();
      } finally {
        iff.exitChunk('DATA');
      }
    } finally {
      iff.exitForm('0003');
    }
  }
}

/**
 * Shortest distance from (px, pz) to the segment (ax, az)-(bx, bz).
 * Uses the standard clamped-projection algorithm.
 */
function distanceToSegment(
  px: number, pz: number,
  ax: number, az: number,
  bx: number, bz: number,
): number {
  const dx = bx - ax;
  const dz = bz - az;
  const lenSq = dx * dx + dz * dz;
  let t: number;
  if (lenSq === 0) {
    // Degenerate segment — distance to the point.
    t = 0;
  } else {
    t = ((px - ax) * dx + (pz - az) * dz) / lenSq;
    if (t < 0) t = 0;
    else if (t > 1) t = 1;
  }
  const cx = ax + t * dx;
  const cz = az + t * dz;
  const ex = px - cx;
  const ez = pz - cz;
  return Math.sqrt(ex * ex + ez * ez);
}
