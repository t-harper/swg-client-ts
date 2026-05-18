/**
 * Port of `BoundaryCircle` from `sharedTerrain/.../Boundary.{h,cpp}`.
 *
 * Load versions: 0000, 0001, 0002. Wire form: `BCIR > version > {IHDR, DATA}`.
 *
 * `DATA` chunk layout per version:
 *   0000: `[f32 centerX][f32 centerZ][f32 radius]`
 *   0001: `[f32 unused][f32 centerX][f32 centerZ][f32 radius]`
 *   0002: `[f32 centerX][f32 centerZ][f32 radius][i32 featherFunction][f32 featherDistance]`
 */

import {
  Boundary, BoundaryType, BCIR_TAG, FeatherFunction,
  type Rectangle2d, type Vector2d,
} from '../types.js';
import { Feather } from '../feather.js';
import { Iff } from '../../../iff/iff.js';

export class BoundaryCircle extends Boundary {
  centerX = 0;
  centerZ = 0;
  radius = 0;
  radiusSquared = 0;

  constructor() {
    super(BCIR_TAG, BoundaryType.Circle);
  }

  load(iff: Iff): void {
    iff.enterForm('BCIR');

    const version = iff.getCurrentName();
    switch (version) {
      case '0000':
        this.load_0000(iff);
        break;
      case '0001':
        this.load_0001(iff);
        break;
      case '0002':
        this.load_0002(iff);
        break;
      default:
        throw new Error(`BoundaryCircle.load: unknown version '${version}'`);
    }

    iff.exitForm('BCIR');
  }

  private load_0000(iff: Iff): void {
    iff.enterForm('0000');

    this.loadLayerItemBase(iff);

    iff.enterChunk('DATA');
    this.centerX = iff.readF32();
    this.centerZ = iff.readF32();
    this.radius = Math.abs(iff.readF32());
    this.radiusSquared = this.radius * this.radius;
    iff.exitChunk('DATA');

    iff.exitForm('0000');
  }

  private load_0001(iff: Iff): void {
    iff.enterForm('0001');

    this.loadLayerItemBase(iff);

    iff.enterChunk('DATA');
    // load_0001 has a leading unused float (mirrors C++ Boundary.cpp:239)
    iff.readF32();
    this.centerX = iff.readF32();
    this.centerZ = iff.readF32();
    this.radius = Math.abs(iff.readF32());
    this.radiusSquared = this.radius * this.radius;
    iff.exitChunk('DATA');

    iff.exitForm('0001');
  }

  private load_0002(iff: Iff): void {
    iff.enterForm('0002');

    this.loadLayerItemBase(iff);

    iff.enterChunk('DATA');
    this.centerX = iff.readF32();
    this.centerZ = iff.readF32();
    this.radius = Math.abs(iff.readF32());
    this.radiusSquared = this.radius * this.radius;

    const fn = iff.readI32();
    this.featherFunction = fn as FeatherFunction;
    const raw = iff.readF32();
    // C++ clamps to [0, 1] — matches Boundary.cpp:270.
    this.featherDistance = raw < 0 ? 0 : raw > 1 ? 1 : raw;
    iff.exitChunk('DATA');

    iff.exitForm('0002');
  }

  /**
   * Port of `TerrainGenerator::LayerItem::load` — reads the IHDR sub-form.
   * Supports both load_0000 (active/name + 3-byte legacy toolColor) and
   * load_0001 (active/name only).
   */
  private loadLayerItemBase(iff: Iff): void {
    iff.enterForm('IHDR');

    const innerVersion = iff.getCurrentName();
    switch (innerVersion) {
      case '0000':
        iff.enterForm('0000');
        iff.enterChunk('DATA');
        this.active = iff.readI32() !== 0;
        this.name = iff.readString();
        // legacy toolColor (PackedRgb) — discarded.
        iff.readU8();
        iff.readU8();
        iff.readU8();
        iff.exitChunk('DATA');
        iff.exitForm('0000');
        break;
      case '0001':
        iff.enterForm('0001');
        iff.enterChunk('DATA');
        this.active = iff.readI32() !== 0;
        this.name = iff.readString();
        iff.exitChunk('DATA');
        iff.exitForm('0001');
        break;
      default:
        throw new Error(`BoundaryCircle: unknown IHDR version '${innerVersion}'`);
    }

    iff.exitForm('IHDR');
  }

  isWithin(worldX: number, worldZ: number): number {
    const dx = worldX - this.centerX;
    const dz = worldZ - this.centerZ;
    const distSquared = dx * dx + dz * dz;

    // Outside the boundary entirely.
    if (distSquared >= this.radiusSquared) {
      return 0;
    }

    // featherDistance is treated as an ABSOLUTE distance in world units (per
    // the task spec). When 0, the full radius is the unfeathered core and the
    // first early-out below catches everything inside.
    const innerRadius = this.radius - this.featherDistance;
    if (innerRadius > 0) {
      const innerRadiusSquared = innerRadius * innerRadius;
      if (distSquared <= innerRadiusSquared) {
        return 1;
      }
    } else if (this.featherDistance <= 0) {
      // No feather band → step function: anything inside the radius is fully in.
      return 1;
    }

    // Feathered band: map the radial distance into [0, 1], where 0 is the
    // outer edge and 1 is the inner-radius edge, then run through the feather
    // curve. `featherDistance` is guaranteed > 0 here (else we would have
    // returned above).
    const t = (this.radius - Math.sqrt(distSquared)) / this.featherDistance;
    const clamped = t < 0 ? 0 : t > 1 ? 1 : t;
    return Feather.feather(this.featherFunction, clamped);
  }

  expand(extent: Rectangle2d): void {
    const minX = this.centerX - this.radius;
    const maxX = this.centerX + this.radius;
    const minZ = this.centerZ - this.radius;
    const maxZ = this.centerZ + this.radius;
    if (minX < extent.x0) extent.x0 = minX;
    if (maxX > extent.x1) extent.x1 = maxX;
    if (minZ < extent.z0) extent.z0 = minZ;
    if (maxZ > extent.z1) extent.z1 = maxZ;
  }

  intersects(other: Rectangle2d): boolean {
    // Closest point on `other` to the circle center.
    const cx = this.centerX < other.x0 ? other.x0 : this.centerX > other.x1 ? other.x1 : this.centerX;
    const cz = this.centerZ < other.z0 ? other.z0 : this.centerZ > other.z1 ? other.z1 : this.centerZ;
    const dx = this.centerX - cx;
    const dz = this.centerZ - cz;
    return dx * dx + dz * dz <= this.radiusSquared;
  }

  getCenter(): Vector2d {
    return { x: this.centerX, z: this.centerZ };
  }
}
