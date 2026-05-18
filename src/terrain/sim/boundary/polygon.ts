/**
 * Port of `BoundaryPolygon` from `sharedTerrain/.../Boundary.{h,cpp}` and
 * the shared `BoundaryPoly` base it inherits from. Load versions:
 * 0000-0007. Wire form: `BPOL > version > {IHDR, DATA, POIN+}` (or all
 * point data inlined in `DATA`, depending on version).
 *
 * Point-in-polygon test + edge feathering — the user-spec variant feathers
 * the OUTSIDE edge of the polygon (distance < featherDistance from any
 * edge segment fades 1→0 as you walk away). This differs from the C++
 * implementation which feathers the INSIDE edge; we keep the user spec
 * because the offline flat-finder consumes this with a "soft-edge"
 * interpretation.
 */

import {
  Boundary, BoundaryType, BPOL_TAG,
  type Rectangle2d, type Vector2d,
  Feather, FeatherFunction,
} from '../types.js';
import type { Iff } from '../../../iff/iff.js';

export class BoundaryPolygon extends Boundary {
  pointList: Vector2d[] = [];
  extent: Rectangle2d = { x0: 0, z0: 0, x1: 0, z1: 0 };

  localWaterTable = false;
  localWaterTableHeight = 0;

  constructor() {
    super(BPOL_TAG, BoundaryType.Polygon);
  }

  // ─────────────────────────────────────────────────────────────────────
  // IFF load — dispatch by version
  // ─────────────────────────────────────────────────────────────────────

  load(iff: Iff): void {
    iff.enterForm('BPOL');

    const version = iff.getCurrentName();
    switch (version) {
      case '0000': this.load_0000(iff); break;
      case '0001': this.load_0001(iff); break;
      case '0002': this.load_0002(iff); break;
      case '0003': this.load_0003(iff); break;
      case '0004': this.load_0004(iff); break;
      case '0005': this.load_0005(iff); break;
      case '0006': this.load_0006(iff); break;
      case '0007': this.load_0007(iff); break;
      default:
        throw new Error(`BoundaryPolygon.load: unknown version '${version}'`);
    }

    iff.exitForm('BPOL');

    // Recompute extent from the loaded point list.
    this.recalculate();
  }

  /** LayerItem common header (active + name). Versions 0000/0001 supported. */
  private loadLayerItemHeader(iff: Iff): void {
    iff.enterForm('IHDR');
    const hdrVersion = iff.getCurrentName();
    iff.enterForm(hdrVersion);
    iff.enterChunk('DATA');
    this.active = iff.readI32() !== 0;
    this.name = iff.readString();
    if (hdrVersion === '0000') {
      // discard packed RGB tool-color (3 bytes); other versions don't carry it
      iff.readU8(); iff.readU8(); iff.readU8();
    }
    iff.exitChunk('DATA');
    iff.exitForm(hdrVersion);
    iff.exitForm('IHDR');
  }

  /** Read N points (each `[f32 x][f32 z]`) until the chunk's end. */
  private readPointsUntilEnd(iff: Iff): void {
    // Each Vector2d on the wire is 8 bytes (two f32 LE values).
    const remaining = iff.getChunkLengthLeft();
    const n = Math.floor(remaining / 8);
    for (let i = 0; i < n; i++) {
      const x = iff.readF32();
      const z = iff.readF32();
      this.pointList.push({ x, z });
    }
  }

  /** Read N points where N is supplied as an int32 prefix. */
  private readPointsCounted(iff: Iff, n: number): void {
    for (let i = 0; i < n; i++) {
      const x = iff.readF32();
      const z = iff.readF32();
      this.pointList.push({ x, z });
    }
  }

  private load_0000(iff: Iff): void {
    iff.enterForm('0000');
    this.loadLayerItemHeader(iff);
    iff.enterChunk('DATA');
    this.readPointsUntilEnd(iff);
    iff.exitChunk('DATA');
    iff.exitForm('0000');
  }

  private load_0001(iff: Iff): void {
    iff.enterForm('0001');
    this.loadLayerItemHeader(iff);
    iff.enterChunk('DATA');
    // Leading float is unused in C++ (probably old featherDistance).
    iff.readF32();
    this.readPointsUntilEnd(iff);
    iff.exitChunk('DATA');
    iff.exitForm('0001');
  }

  private load_0002(iff: Iff): void {
    iff.enterForm('0002');
    this.loadLayerItemHeader(iff);
    iff.enterChunk('DATA');
    this.featherFunction = iff.readI32() as FeatherFunction;
    this.featherDistance = iff.readF32();
    this.readPointsUntilEnd(iff);
    iff.exitChunk('DATA');
    iff.exitForm('0002');
  }

  private load_0003(iff: Iff): void {
    iff.enterForm('0003');
    this.loadLayerItemHeader(iff);
    iff.enterChunk('DATA');
    this.featherFunction = iff.readI32() as FeatherFunction;
    this.featherDistance = iff.readF32();
    this.localWaterTable = iff.readI32() !== 0;
    this.localWaterTableHeight = iff.readF32();
    /* localWaterTableShaderTemplateName */ iff.readString();
    this.readPointsUntilEnd(iff);
    iff.exitChunk('DATA');
    iff.exitForm('0003');
  }

  private load_0004(iff: Iff): void {
    iff.enterForm('0004');
    this.loadLayerItemHeader(iff);
    iff.enterChunk('DATA');
    this.featherFunction = iff.readI32() as FeatherFunction;
    this.featherDistance = iff.readF32();
    this.localWaterTable = iff.readI32() !== 0;
    this.localWaterTableHeight = iff.readF32();
    /* localWaterTableShaderSize */ iff.readF32();
    /* localWaterTableShaderTemplateName */ iff.readString();
    this.readPointsUntilEnd(iff);
    iff.exitChunk('DATA');
    iff.exitForm('0004');
  }

  private load_0005(iff: Iff): void {
    iff.enterForm('0005');
    this.loadLayerItemHeader(iff);
    iff.enterChunk('DATA');
    const n = iff.readI32();
    this.readPointsCounted(iff, n);
    this.featherFunction = iff.readI32() as FeatherFunction;
    this.featherDistance = iff.readF32();
    this.localWaterTable = iff.readI32() !== 0;
    this.localWaterTableHeight = iff.readF32();
    /* localWaterTableShaderSize */ iff.readF32();
    /* localWaterTableShaderTemplateName */ iff.readString();
    iff.exitChunk('DATA');
    iff.exitForm('0005');
  }

  private load_0006(iff: Iff): void {
    iff.enterForm('0006');
    this.loadLayerItemHeader(iff);
    iff.enterChunk('DATA');
    const n = iff.readI32();
    this.readPointsCounted(iff, n);
    this.featherFunction = iff.readI32() as FeatherFunction;
    this.featherDistance = iff.readF32();
    this.localWaterTable = iff.readI32() !== 0;
    this.localWaterTableHeight = iff.readF32();
    /* localWaterTableShaderSize */ iff.readF32();
    /* unused int32 (old waterType slot) */ iff.readI32();
    /* localWaterTableShaderTemplateName */ iff.readString();
    iff.exitChunk('DATA');
    iff.exitForm('0006');
  }

  private load_0007(iff: Iff): void {
    iff.enterForm('0007');
    this.loadLayerItemHeader(iff);
    iff.enterChunk('DATA');
    const n = iff.readI32();
    this.readPointsCounted(iff, n);
    this.featherFunction = iff.readI32() as FeatherFunction;
    this.featherDistance = iff.readF32();
    this.localWaterTable = iff.readI32() !== 0;
    this.localWaterTableHeight = iff.readF32();
    /* localWaterTableShaderSize */ iff.readF32();
    /* waterType — ignored for offline height port */ iff.readI32();
    /* localWaterTableShaderTemplateName */ iff.readString();
    iff.exitChunk('DATA');
    iff.exitForm('0007');
  }

  /** Recompute `extent` from the current `pointList`. */
  private recalculate(): void {
    if (this.pointList.length === 0) {
      this.extent = { x0: 0, z0: 0, x1: 0, z1: 0 };
      return;
    }
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (const p of this.pointList) {
      if (p.x < x0) x0 = p.x;
      if (p.x > x1) x1 = p.x;
      if (p.z < z0) z0 = p.z;
      if (p.z > z1) z1 = p.z;
    }
    this.extent = { x0, z0, x1, z1 };
  }

  // ─────────────────────────────────────────────────────────────────────
  // Geometry
  // ─────────────────────────────────────────────────────────────────────

  /**
   * Point-in-polygon + outside-edge feather.
   *
   * Returns:
   *   - 1.0 if `(worldX, worldZ)` lies inside the polygon.
   *   - `1 - Feather.feather(featherFunction, distance/featherDistance)` if
   *     outside but within `featherDistance` of any edge segment.
   *   - 0.0 otherwise.
   */
  isWithin(worldX: number, worldZ: number): number {
    const n = this.pointList.length;
    if (n < 3) return 0;

    // Standard ray-casting point-in-polygon (matches the C++ inner loop).
    let inside = false;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const pi = this.pointList[i]!;
      const pj = this.pointList[j]!;
      if (
        ((pi.z <= worldZ) && (worldZ < pj.z)) ||
        ((pj.z <= worldZ) && (worldZ < pi.z))
      ) {
        const xIntersect =
          (pj.x - pi.x) * (worldZ - pi.z) / (pj.z - pi.z) + pi.x;
        if (worldX < xIntersect) inside = !inside;
      }
    }

    if (inside) return 1;

    // Outside the polygon — feather if we're close to any edge.
    if (this.featherDistance <= 0) return 0;

    const distance = this.distanceToBoundary(worldX, worldZ);
    if (distance >= this.featherDistance) return 0;

    const t = distance / this.featherDistance;
    return 1 - Feather.feather(this.featherFunction, t);
  }

  /**
   * Minimum distance from `(worldX, worldZ)` to any edge segment of the
   * polygon. Considers both vertex distances and perpendicular drops onto
   * each edge, returning whichever is smaller.
   */
  private distanceToBoundary(worldX: number, worldZ: number): number {
    const n = this.pointList.length;
    let minSquared = Infinity;

    // Vertex distances.
    for (let i = 0; i < n; i++) {
      const p = this.pointList[i]!;
      const dx = worldX - p.x;
      const dz = worldZ - p.z;
      const d2 = dx * dx + dz * dz;
      if (d2 < minSquared) minSquared = d2;
    }

    // Edge perpendicular drops.
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const a = this.pointList[j]!;
      const b = this.pointList[i]!;
      const ex = b.x - a.x;
      const ez = b.z - a.z;
      const lenSquared = ex * ex + ez * ez;
      if (lenSquared <= 0) continue;
      const u = ((worldX - a.x) * ex + (worldZ - a.z) * ez) / lenSquared;
      if (u < 0 || u > 1) continue; // outside the segment — already handled by vertex test
      const px = a.x + u * ex;
      const pz = a.z + u * ez;
      const dx = worldX - px;
      const dz = worldZ - pz;
      const d2 = dx * dx + dz * dz;
      if (d2 < minSquared) minSquared = d2;
    }

    return Math.sqrt(minSquared);
  }

  expand(extent: Rectangle2d): void {
    if (this.pointList.length === 0) return;
    if (this.extent.x0 < extent.x0) extent.x0 = this.extent.x0;
    if (this.extent.z0 < extent.z0) extent.z0 = this.extent.z0;
    if (this.extent.x1 > extent.x1) extent.x1 = this.extent.x1;
    if (this.extent.z1 > extent.z1) extent.z1 = this.extent.z1;
  }

  /** Conservative AABB-vs-AABB intersection — matches `BoundaryPoly::intersects` in C++. */
  intersects(other: Rectangle2d): boolean {
    return !(
      other.x1 < this.extent.x0 ||
      other.x0 > this.extent.x1 ||
      other.z1 < this.extent.z0 ||
      other.z0 > this.extent.z1
    );
  }

  getCenter(): Vector2d {
    return {
      x: (this.extent.x0 + this.extent.x1) * 0.5,
      z: (this.extent.z0 + this.extent.z1) * 0.5,
    };
  }
}
