/**
 * Ports of `FilterFractal` (FFRA) and `FilterDirection` (FDIR) from
 * `sharedTerrain/.../Filter.cpp`.
 *
 * `FilterFractal`: samples a `MultiFractal` (resolved from the chunk's
 *   FractalGroup by `familyId`) at world (worldX, worldZ); passes if
 *   the noise value is in `[minValue, maxValue]`.
 *
 * `FilterDirection`: reads the normal at (x, z) and computes
 *   `atan2(normal.x, normal.z)` (slope aspect); passes if in
 *   `[minAngle, maxAngle]` modulo 2π.
 *
 * Feather semantics (matches the height-slope port for consistency —
 * see `featheredRange` below):
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
  Filter, FilterType, FFRA_TAG, FDIR_TAG, Feather, FeatherFunction,
  type IFractalGroup, type IMultiFractal,
  type GeneratorChunkData,
} from '../types.js';
import type { Iff } from '../../../iff/iff.js';

/**
 * Shared feathered-range evaluator — same shape as the helper in
 * `height-slope.ts`. Returns 0 outside the feathered envelope
 * `[min - featherDistance, max + featherDistance]`, 1 inside the core
 * `[min, max]`, and a `Feather.feather(...)`-ramped value in either feather
 * band.
 *
 * If `featherDistance <= 0` the bands collapse and the function reduces
 * to a hard `[min, max]` step (1 inside, 0 outside).
 */
function featheredRange(
  value: number,
  min: number,
  max: number,
  featherDistance: number,
  fn: FeatherFunction,
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
 * the bytes are on the wire, so we step the parser past them. Matches the
 * pattern used by `height-slope.ts::skipIhdr`.
 */
function skipIhdr(iff: Iff): void {
  iff.enterForm('IHDR');
  iff.exitForm('IHDR');
}

export class FilterFractal extends Filter {
  familyId = 0;
  minValue = 0;
  maxValue = 1;
  /** Resolved after load(); the MultiFractal lookup from FractalGroup. */
  cachedMultiFractal: IMultiFractal | null = null;

  constructor() {
    super(FFRA_TAG, FilterType.Fractal);
  }

  /**
   * Wire form (matches C++ `Filter.cpp:555-580 FilterFractal::load_0005`):
   *   `FFRA > 0005 > {IHDR, DATA(form) > PARM(chunk)}`
   * PARM chunk: `[i32 familyId][i32 featherFn][f32 featherDistance][f32 lowLimit][f32 highLimit][f32 scaleY]`.
   *
   * Earlier versions (0000-0004) used different shapes (inline DATA chunk
   * with a multi-fractal embed). The shipping Naboo / Tatooine .trn files
   * use v0005 exclusively — that's what we parse. The familyId-to-
   * MultiFractal lookup is deferred to the first `isWithin()` call.
   */
  load(iff: Iff): void {
    iff.enterForm('FFRA');
    const version = iff.getCurrentName();
    if (version !== '0005') {
      // Older versions embed a MultiFractal under the FFRA form that needs
      // a writable FractalGroup to register; the read-only IFractalGroup
      // can't accept new families, so we skip them. Walk past the form
      // body to keep the parent cursor aligned.
      iff.enterAnyForm();
      while (!iff.atEndOfForm()) {
        if (iff.isCurrentForm()) {
          const t = iff.enterAnyForm();
          while (!iff.atEndOfForm()) {
            iff.enterChunk();
            iff.exitChunk();
          }
          iff.exitForm(t);
        } else {
          iff.enterChunk();
          iff.exitChunk();
        }
      }
      iff.exitForm(version);
      iff.exitForm('FFRA');
      return;
    }
    iff.enterForm('0005');
    skipIhdr(iff);
    iff.enterForm('DATA');
    iff.enterChunk('PARM');
    this.familyId = iff.readI32();
    /* featherFunction */ this.featherFunction = iff.readI32() as FeatherFunction;
    const fd = iff.readF32();
    this.featherDistance = fd < 0 ? 0 : fd > 1 ? 1 : fd;
    this.minValue = iff.readF32(); // lowFractalLimit
    this.maxValue = iff.readF32(); // highFractalLimit
    /* scaleY (we ignore for the [min,max] gate) */ iff.readF32();
    iff.exitChunk('PARM');
    iff.exitForm('DATA');
    iff.exitForm('0005');
    iff.exitForm('FFRA');
  }

  /**
   * Older versions (C++ `load_0000` ... `load_0004`) needed the FractalGroup
   * at load time to register a freshly-decoded MultiFractal under a new
   * familyId. Our simplified port reads the same `[i32 familyId, f32 min,
   * f32 max]` payload, then eagerly resolves the cached MultiFractal so a
   * later `isWithin()` doesn't need to consult the chunk's group.
   */
  loadWithGroup(iff: Iff, fractalGroup: IFractalGroup): void {
    this.load(iff);
    this.cachedMultiFractal = fractalGroup.getFamilyMultiFractal(this.familyId);
  }

  isWithin(
    worldX: number, worldZ: number, x: number, z: number,
    chunkData: GeneratorChunkData,
  ): number {
    if (this.cachedMultiFractal === null) {
      this.cachedMultiFractal = chunkData.fractalGroup.getFamilyMultiFractal(this.familyId);
    }
    if (this.cachedMultiFractal === null) {
      return 0;
    }
    const v = this.cachedMultiFractal.getValueCache(worldX, worldZ, x, z);
    return featheredRange(v, this.minValue, this.maxValue, this.featherDistance, this.featherFunction);
  }
}

export class FilterDirection extends Filter {
  /** Min azimuth in radians (0 = east). */
  minAngle = 0;
  /** Max azimuth in radians. */
  maxAngle = 2 * Math.PI;

  constructor() {
    super(FDIR_TAG, FilterType.Direction);
  }

  /**
   * Wire form: `FDIR > 0000 > {IHDR, DATA[f32 minAngleDeg, f32 maxAngleDeg, i32 featherFn, f32 featherDistance]}`.
   * Cursor must be sitting on the FDIR FORM block.
   *
   * Per `Filter.cpp:864-908` the C++ supports only v0000 and:
   *   - reads angles in degrees, converts to radians on the fly
   *   - reads a feather function (`i32`) and feather distance (`f32`,
   *     clamped to [0,1])
   *
   * To stay backward-compatible with hand-crafted test fixtures that wrote
   * only `[f32 minRad, f32 maxRad]` (8 bytes, no feather), we detect the
   * legacy "raw radians" layout from the chunk length: if the DATA chunk
   * is shorter than the full 16-byte v0000 payload, we read the two floats
   * as-is and leave feather defaults intact. Real .trn data always uses
   * the full payload.
   */
  load(iff: Iff): void {
    iff.enterForm('FDIR');
    const version = iff.getCurrentName();
    if (version !== '0000') {
      throw new Error(`FilterDirection: unsupported version '${version}'`);
    }
    iff.enterForm('0000');
    skipIhdr(iff);
    iff.enterChunk('DATA');
    const DEG_TO_RAD = Math.PI / 180;
    const chunkLen = iff.getChunkLengthTotal();
    if (chunkLen >= 16) {
      const minDeg = iff.readF32();
      const maxDeg = iff.readF32();
      this.minAngle = minDeg * DEG_TO_RAD;
      this.maxAngle = maxDeg * DEG_TO_RAD;
      this.featherFunction = iff.readI32() as FeatherFunction;
      const fd = iff.readF32();
      this.featherDistance = fd < 0 ? 0 : fd > 1 ? 1 : fd;
    } else {
      // Legacy "two raw radians" fixture form — keep backward compat.
      this.minAngle = iff.readF32();
      this.maxAngle = iff.readF32();
    }
    iff.exitChunk('DATA');
    iff.exitForm('0000');
    iff.exitForm('FDIR');
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
    // Slope aspect (azimuth around the Y axis). atan2(x, z) is the C++
    // `Vector::theta()` convention — see Vector.h:208. The result lies in
    // (-π, π]; normalize into [0, 2π) so the range test can compare against
    // a positive [minAngle, maxAngle] window.
    let angle = Math.atan2(normal.x, normal.z);
    if (angle < 0) {
      angle += 2 * Math.PI;
    }
    return featheredRange(angle, this.minAngle, this.maxAngle, this.featherDistance, this.featherFunction);
  }

  override needsNormals(): boolean { return true; }
}
