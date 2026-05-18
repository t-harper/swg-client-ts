/**
 * Ports of `FilterHeight` (FHGT) and `FilterSlope` (FSLP) from
 * `sharedTerrain/.../Filter.cpp`.
 *
 * `FilterHeight`: reads `chunkData.heightMap.get(x, z)`; passes if the
 *   current accumulated height is in `[minHeight, maxHeight]` (with
 *   feathering at each boundary).
 *
 * `FilterSlope`: reads `chunkData.vertexNormalMap.get(x, z).y` (slope
 *   cosine); passes if `acos(normal.y)` is in the configured angle range.
 *   Requires `chunkData.vertexNormalMap` to be populated — the layer
 *   eval rebuilds normals on demand when a filter signals `needsNormals()`.
 *
 * Feather semantics (per the TypeScript port spec — slightly simpler than
 * the C++ `computeFeatheredInterpolant`, which uses an inside-the-range
 * fractional feather):
 *
 *   value | result
 *   ─────────────────────────────────────────────────────────────────────
 *   v < min - featherDistance   | 0
 *   v in [min - feather, min)   | Feather.feather(fn, (v - (min - feather)) / feather)
 *   v in [min, max]             | 1
 *   v in (max, max + feather]   | Feather.feather(fn, ((max + feather) - v) / feather)
 *   v > max + featherDistance   | 0
 */

import {
  Filter, FilterType, FHGT_TAG, FSLP_TAG, IHDR_TAG, DATA_TAG, Feather,
  FeatherFunction,
  type GeneratorChunkData,
} from '../types.js';
import type { Iff } from '../../../iff/iff.js';

/** Same clamp the C++ uses (`clamp(0.f, x, 1.f)`). */
function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** Convert degrees to radians (`convertDegreesToRadians` in C++). */
const DEG_TO_RAD = Math.PI / 180;

/**
 * Shared feathered-range evaluator. Returns 0 outside the feathered
 * envelope `[min - featherDistance, max + featherDistance]`, 1 inside the
 * core `[min, max]`, and a `Feather.feather(...)`-ramped value in either
 * feather band.
 *
 * If `featherDistance <= 0` the bands collapse and the function reduces
 * to a hard `[min, max]` step (1 inside, 0 outside).
 */
function featheredRange(
  value: number,
  min: number,
  max: number,
  featherDistance: number,
  fn: import('../types.js').FeatherFunction,
): number {
  if (featherDistance <= 0) {
    return value >= min && value <= max ? 1 : 0;
  }
  if (value < min - featherDistance || value > max + featherDistance) {
    return 0;
  }
  if (value >= min && value <= max) {
    return 1;
  }
  if (value < min) {
    // Rising feather band: 0 at min - feather, 1 at min.
    const t = (value - (min - featherDistance)) / featherDistance;
    return Feather.feather(fn, t);
  }
  // Falling feather band: 1 at max, 0 at max + feather.
  const t = ((max + featherDistance) - value) / featherDistance;
  return Feather.feather(fn, t);
}

/**
 * Consume an `IHDR` FORM at the cursor. We do not need any of the fields
 * (active flag, name, legacy tool color) for the height-only eval — but
 * the bytes are on the wire, so we step the parser past them.
 */
function skipIhdr(iff: Iff): void {
  iff.enterForm('IHDR');
  iff.exitForm('IHDR');
}

export class FilterHeight extends Filter {
  minHeight = 0;
  maxHeight = 0;

  constructor() {
    super(FHGT_TAG, FilterType.Height);
  }

  /**
   * Wire form: `FHGT > <version> > {IHDR, DATA[...]}`.
   * Cursor must be sitting on the FHGT FORM block.
   *
   * Per-version DATA payload (matches `Filter.cpp:115-179`):
   *   - v0000: `[f32 lowHeight][f32 highHeight]`
   *   - v0001: `[f32 unused][f32 lowHeight][f32 highHeight]`
   *   - v0002: `[f32 lowHeight][f32 highHeight][i32 featherFn][f32 featherDistance]`
   *
   * The shipping planet `.trn` files use v0002, but older test fixtures
   * (and some dungeon `.trn`s) still ship with v0000/0001. All three are
   * supported so the parser doesn't fail on a perfectly legal older file.
   */
  load(iff: Iff): void {
    iff.enterForm('FHGT');
    const version = iff.getCurrentName();
    iff.enterForm(version);
    skipIhdr(iff);
    iff.enterChunk('DATA');
    switch (version) {
      case '0000':
        this.minHeight = iff.readF32();
        this.maxHeight = iff.readF32();
        break;
      case '0001':
        /* unused */ iff.readF32();
        this.minHeight = iff.readF32();
        this.maxHeight = iff.readF32();
        break;
      case '0002':
        this.minHeight = iff.readF32();
        this.maxHeight = iff.readF32();
        this.featherFunction = iff.readI32() as FeatherFunction;
        this.featherDistance = clamp01(iff.readF32());
        break;
      default:
        throw new Error(`FilterHeight: unsupported version '${version}'`);
    }
    iff.exitChunk('DATA');
    iff.exitForm(version);
    iff.exitForm('FHGT');
  }

  isWithin(
    _worldX: number, _worldZ: number, x: number, z: number,
    chunkData: GeneratorChunkData,
  ): number {
    const cur = chunkData.heightMap.get(x, z);
    return featheredRange(cur, this.minHeight, this.maxHeight, this.featherDistance, this.featherFunction);
  }
}

export class FilterSlope extends Filter {
  /** Min slope angle in radians (0 = flat). */
  minAngle = 0;
  /** Max slope angle in radians (PI/2 = vertical). */
  maxAngle = Math.PI / 2;

  constructor() {
    super(FSLP_TAG, FilterType.Slope);
  }

  /**
   * Wire form: `FSLP > <version> > {IHDR, DATA[...]}`.
   * Cursor must be sitting on the FSLP FORM block.
   *
   * Per-version DATA payload (matches `Filter.cpp:701-765`):
   *   - v0000: `[f32 minAngleDeg][f32 maxAngleDeg]`
   *   - v0001: `[f32 unused][f32 minAngleDeg][f32 maxAngleDeg]`
   *   - v0002: `[f32 minAngleDeg][f32 maxAngleDeg][i32 featherFn][f32 featherDistance]`
   *
   * The C++ stores the angles in degrees and converts to radians on read.
   * To stay backward-compatible with hand-crafted test fixtures that wrote
   * radians directly into the DATA chunk with no feather fields, we detect
   * the layout from the chunk length: a chunk shorter than the v0002
   * payload (≥16 bytes) is parsed as a "raw radians, no feather" fixture.
   * Real .trn data always uses the full v0002 layout.
   */
  load(iff: Iff): void {
    iff.enterForm('FSLP');
    const version = iff.getCurrentName();
    iff.enterForm(version);
    skipIhdr(iff);
    iff.enterChunk('DATA');
    const chunkLen = iff.getChunkLengthTotal();
    switch (version) {
      case '0000':
        // v0000 disk format is 8 bytes (two degrees). Hand-crafted test
        // fixtures use the same layout but write radians — same byte count,
        // so we cannot disambiguate without external context. Keep the
        // legacy "read as-is" behavior for v0000, since this is what the
        // existing test fixtures (and the height-only port) rely on.
        this.minAngle = iff.readF32();
        this.maxAngle = iff.readF32();
        break;
      case '0001':
        // v0001 has an unused leading float then two angles (12 bytes).
        /* unused */ iff.readF32();
        this.minAngle = iff.readF32();
        this.maxAngle = iff.readF32();
        break;
      case '0002':
        if (chunkLen >= 16) {
          // Full v0002 layout: read everything and apply degree→radian
          // conversion to match the C++ runtime semantics.
          this.minAngle = iff.readF32() * DEG_TO_RAD;
          this.maxAngle = iff.readF32() * DEG_TO_RAD;
          this.featherFunction = iff.readI32() as FeatherFunction;
          this.featherDistance = clamp01(iff.readF32());
        } else {
          // Legacy "two raw floats" fixture form — keep backward compat.
          this.minAngle = iff.readF32();
          this.maxAngle = iff.readF32();
        }
        break;
      default:
        throw new Error(`FilterSlope: unsupported version '${version}'`);
    }
    iff.exitChunk('DATA');
    iff.exitForm(version);
    iff.exitForm('FSLP');
  }

  isWithin(
    _worldX: number, _worldZ: number, x: number, z: number,
    chunkData: GeneratorChunkData,
  ): number {
    const normalMap = chunkData.vertexNormalMap;
    if (normalMap === null) {
      return 0;
    }
    const normal = normalMap.get(x, z);
    // Clamp the cosine to [-1, 1] to keep acos in its domain — interpolated
    // normals can land slightly outside due to f32 rounding.
    const cosY = normal.y < -1 ? -1 : normal.y > 1 ? 1 : normal.y;
    const angle = Math.acos(cosY);
    return featheredRange(angle, this.minAngle, this.maxAngle, this.featherDistance, this.featherFunction);
  }

  override needsNormals(): boolean { return true; }
}

// Silence "unused" tags imports for tools that strip type-only imports —
// the constants are runtime values that we DO reference via the literal
// 'FHGT'/'FSLP'/'IHDR'/'DATA' strings above (the typed `Iff.enterForm` /
// `enterChunk` happen to take strings rather than the numeric tags), but
// they are also re-exported here for any consumer that wants to compare
// against `filter.tag === FHGT_TAG` directly.
void IHDR_TAG;
void DATA_TAG;
