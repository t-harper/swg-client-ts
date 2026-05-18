/**
 * Port of `BoundaryRectangle` from `sharedTerrain/.../Boundary.{h,cpp}`.
 *
 * Load versions: 0000-0004. Wire form: `BREC > version > {IHDR, DATA}`.
 * Supports optional rotation (`m_useTransform`) and optional local water
 * table (we capture the fields for completeness but the offline height
 * port doesn't apply water; rivers/lakes already-baked into the terrain
 * via AffectorRiver/Ribbon are out-of-scope for the flat-finder).
 *
 * On-disk versions 0000-0004 never serialize `m_useTransform` / rotation /
 * translation — those are editor-only mutations applied via `setCenter` /
 * `setRotation`. The `isWithin` path still honors rotation if some future
 * caller (or test) flips `useTransform = true` and sets `rotationAngle`.
 */

import {
  Boundary, BoundaryType, BREC_TAG, FeatherFunction,
  type Rectangle2d, type Vector2d,
} from '../types.js';
import { Feather } from '../feather.js';
import type { Iff } from '../../../iff/iff.js';

export class BoundaryRectangle extends Boundary {
  rectangle: Rectangle2d = { x0: 0, z0: 0, x1: 0, z1: 0 };
  innerRectangle: Rectangle2d = { x0: 0, z0: 0, x1: 0, z1: 0 };

  useTransform = false;
  /** rotation angle in radians; only used when `useTransform` is true. */
  rotationAngle = 0;

  localWaterTable = false;
  localGlobalWaterTable = false;
  localWaterTableHeight = 0;
  localWaterTableShaderSize = 2;
  localWaterTableShaderTemplateName = '';
  /** TGWT_water=0, TGWT_lava=1; default water. */
  waterType = 0;

  constructor() {
    super(BREC_TAG, BoundaryType.Rectangle);
  }

  load(iff: Iff): void {
    iff.enterForm('BREC');
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
      case '0003':
        this.load_0003(iff);
        break;
      case '0004':
        this.load_0004(iff);
        break;
      default:
        throw new Error(`BoundaryRectangle.load: unknown version '${version}'`);
    }
    this.recalculate();
    iff.exitForm('BREC');
  }

  private load_0000(iff: Iff): void {
    iff.enterForm('0000');
    this.loadIhdr(iff);
    iff.enterChunk('DATA');
    this.rectangle.x0 = iff.readF32();
    this.rectangle.z0 = iff.readF32();
    this.rectangle.x1 = iff.readF32();
    this.rectangle.z1 = iff.readF32();
    iff.exitChunk('DATA');
    iff.exitForm('0000');
  }

  private load_0001(iff: Iff): void {
    iff.enterForm('0001');
    this.loadIhdr(iff);
    iff.enterChunk('DATA');
    iff.readF32(); // unused leading float
    this.rectangle.x0 = iff.readF32();
    this.rectangle.z0 = iff.readF32();
    this.rectangle.x1 = iff.readF32();
    this.rectangle.z1 = iff.readF32();
    iff.exitChunk('DATA');
    iff.exitForm('0001');
  }

  private load_0002(iff: Iff): void {
    iff.enterForm('0002');
    this.loadIhdr(iff);
    iff.enterChunk('DATA');
    this.rectangle.x0 = iff.readF32();
    this.rectangle.z0 = iff.readF32();
    this.rectangle.x1 = iff.readF32();
    this.rectangle.z1 = iff.readF32();
    this.featherFunction = iff.readI32() as FeatherFunction;
    this.featherDistance = clamp01(iff.readF32());
    iff.exitChunk('DATA');
    iff.exitForm('0002');
  }

  private load_0003(iff: Iff): void {
    iff.enterForm('0003');
    this.loadIhdr(iff);
    iff.enterChunk('DATA');
    this.rectangle.x0 = iff.readF32();
    this.rectangle.z0 = iff.readF32();
    this.rectangle.x1 = iff.readF32();
    this.rectangle.z1 = iff.readF32();
    this.featherFunction = iff.readI32() as FeatherFunction;
    this.featherDistance = clamp01(iff.readF32());
    this.localWaterTable = iff.readI32() !== 0;
    this.localGlobalWaterTable = iff.readI32() !== 0;
    this.localWaterTableHeight = iff.readF32();
    this.localWaterTableShaderSize = iff.readF32();
    this.localWaterTableShaderTemplateName = iff.readString();
    iff.exitChunk('DATA');
    iff.exitForm('0003');
  }

  private load_0004(iff: Iff): void {
    iff.enterForm('0004');
    this.loadIhdr(iff);
    iff.enterChunk('DATA');
    this.rectangle.x0 = iff.readF32();
    this.rectangle.z0 = iff.readF32();
    this.rectangle.x1 = iff.readF32();
    this.rectangle.z1 = iff.readF32();
    this.featherFunction = iff.readI32() as FeatherFunction;
    this.featherDistance = clamp01(iff.readF32());
    this.localWaterTable = iff.readI32() !== 0;
    this.localGlobalWaterTable = iff.readI32() !== 0;
    this.localWaterTableHeight = iff.readF32();
    this.localWaterTableShaderSize = iff.readF32();
    this.localWaterTableShaderTemplateName = iff.readString();
    this.waterType = iff.readI32();
    iff.exitChunk('DATA');
    iff.exitForm('0004');
  }

  /**
   * Mirror of `TerrainGenerator::LayerItem::load` — reads the common IHDR
   * form (active + name + optional legacy tool color).
   */
  private loadIhdr(iff: Iff): void {
    iff.enterForm('IHDR');
    const version = iff.getCurrentName();
    iff.enterForm(version);
    iff.enterChunk('DATA');
    this.active = iff.readI32() !== 0;
    this.name = iff.readString();
    if (version === '0000') {
      // legacy tool color (rgb) — three bytes, discarded
      iff.readU8();
      iff.readU8();
      iff.readU8();
    } else if (version !== '0001') {
      throw new Error(`BoundaryRectangle.loadIhdr: unknown IHDR version '${version}'`);
    }
    iff.exitChunk('DATA');
    iff.exitForm(version);
    iff.exitForm('IHDR');
  }

  /**
   * Normalize the rectangle (swap if reversed), then derive the inner
   * un-feathered rectangle. Mirrors C++ `BoundaryRectangle::recalculate`.
   */
  private recalculate(): void {
    if (this.rectangle.x0 > this.rectangle.x1) {
      const t = this.rectangle.x0;
      this.rectangle.x0 = this.rectangle.x1;
      this.rectangle.x1 = t;
    }
    if (this.rectangle.z0 > this.rectangle.z1) {
      const t = this.rectangle.z0;
      this.rectangle.z0 = this.rectangle.z1;
      this.rectangle.z1 = t;
    }
    const width = this.rectangle.x1 - this.rectangle.x0;
    const height = this.rectangle.z1 - this.rectangle.z0;
    const feather = 0.5 * Math.min(width, height) * this.featherDistance;
    this.innerRectangle = {
      x0: this.rectangle.x0 + feather,
      z0: this.rectangle.z0 + feather,
      x1: this.rectangle.x1 - feather,
      z1: this.rectangle.z1 - feather,
    };
  }

  isWithin(worldX: number, worldZ: number): number {
    let x = worldX;
    let z = worldZ;
    if (this.useTransform) {
      // rotateTranslate_p2l: parent-to-local rotation by -rotationAngle
      // around the rectangle's center.
      const cx = (this.rectangle.x0 + this.rectangle.x1) * 0.5;
      const cz = (this.rectangle.z0 + this.rectangle.z1) * 0.5;
      const dx = worldX - cx;
      const dz = worldZ - cz;
      const ca = Math.cos(-this.rotationAngle);
      const sa = Math.sin(-this.rotationAngle);
      x = dx * ca - dz * sa + cx;
      z = dx * sa + dz * ca + cz;
    }

    // outside outer rectangle → 0
    if (x < this.rectangle.x0 || x > this.rectangle.x1 ||
        z < this.rectangle.z0 || z > this.rectangle.z1) {
      return 0;
    }

    if (this.featherDistance === 0) {
      return 1;
    }

    // inside inner (un-feathered) rectangle → 1
    if (x >= this.innerRectangle.x0 && x <= this.innerRectangle.x1 &&
        z >= this.innerRectangle.z0 && z <= this.innerRectangle.z1) {
      return 1;
    }

    const left = x - this.rectangle.x0;
    const right = this.rectangle.x1 - x;
    const top = z - this.rectangle.z0;
    const bottom = this.rectangle.z1 - z;

    const width = this.rectangle.x1 - this.rectangle.x0;
    const height = this.rectangle.z1 - this.rectangle.z0;
    const feather = 0.5 * Math.min(width, height) * this.featherDistance;

    let distance = feather;
    if (left < distance) distance = left;
    if (right < distance) distance = right;
    if (top < distance) distance = top;
    if (bottom < distance) distance = bottom;

    const t = distance / feather;
    return Feather.feather(this.featherFunction, t);
  }

  expand(extent: Rectangle2d): void {
    if (this.useTransform) {
      // rotated AABB → include the 4 rotated corners
      const cx = (this.rectangle.x0 + this.rectangle.x1) * 0.5;
      const cz = (this.rectangle.z0 + this.rectangle.z1) * 0.5;
      const ca = Math.cos(this.rotationAngle);
      const sa = Math.sin(this.rotationAngle);
      const corners: ReadonlyArray<readonly [number, number]> = [
        [this.rectangle.x0, this.rectangle.z0],
        [this.rectangle.x1, this.rectangle.z0],
        [this.rectangle.x0, this.rectangle.z1],
        [this.rectangle.x1, this.rectangle.z1],
      ];
      for (const corner of corners) {
        const [px, pz] = corner;
        const dx = px - cx;
        const dz = pz - cz;
        const rx = dx * ca - dz * sa + cx;
        const rz = dx * sa + dz * ca + cz;
        if (rx < extent.x0) extent.x0 = rx;
        if (rx > extent.x1) extent.x1 = rx;
        if (rz < extent.z0) extent.z0 = rz;
        if (rz > extent.z1) extent.z1 = rz;
      }
    } else {
      if (this.rectangle.x0 < extent.x0) extent.x0 = this.rectangle.x0;
      if (this.rectangle.x1 > extent.x1) extent.x1 = this.rectangle.x1;
      if (this.rectangle.z0 < extent.z0) extent.z0 = this.rectangle.z0;
      if (this.rectangle.z1 > extent.z1) extent.z1 = this.rectangle.z1;
    }
  }

  intersects(other: Rectangle2d): boolean {
    // conservative AABB-vs-AABB even when useTransform is set
    return !(other.x1 < this.rectangle.x0 ||
             other.x0 > this.rectangle.x1 ||
             other.z1 < this.rectangle.z0 ||
             other.z0 > this.rectangle.z1);
  }

  getCenter(): Vector2d {
    return {
      x: (this.rectangle.x0 + this.rectangle.x1) * 0.5,
      z: (this.rectangle.z0 + this.rectangle.z1) * 0.5,
    };
  }
}

function clamp01(v: number): number {
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}
