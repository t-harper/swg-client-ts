/**
 * Tests for `FilterHeight` (FHGT) and `FilterSlope` (FSLP).
 *
 * Strategy:
 *   - Synthesize a minimal `GeneratorChunkData` with hand-set heightMap
 *     and (for slope) vertexNormalMap cells. Other fields are stubbed
 *     with the cheapest possible types because `isWithin` only reads
 *     the maps it actually needs.
 *   - For `load`, build the IFF buffer with `IffWriter` and feed it to
 *     `Filter*.load(Iff)`.
 *   - For `isWithin`, set the filter's bounds + featherDistance directly
 *     (the load path with feathering is not exercised — the task spec
 *     leaves featherFunction/featherDistance as instance fields that
 *     callers configure separately, matching how the C++ generator
 *     evaluates feathering at runtime).
 */

import { describe, expect, it } from 'vitest';
import { Iff, IffWriter } from '../../../iff/iff.js';
import { Array2d } from '../array2d.js';
import {
  FeatherFunction,
  type GeneratorChunkData,
  type IFractalGroup,
  type Rectangle2d,
  type Vector3,
} from '../types.js';
import { FilterHeight, FilterSlope } from './height-slope.js';

// ──────────────────────────────────────────────────────────────────────────
// Test doubles
// ──────────────────────────────────────────────────────────────────────────

/** Cheap stand-in — neither filter ever calls into the fractal group. */
const STUB_FRACTAL_GROUP: IFractalGroup = {
  getFamilyMultiFractal: () => null,
  getFamilyName: () => null,
  getNumberOfFamilies: () => 0,
  getFamilyId: () => 0,
  hasFamily: () => false,
};

const STUB_EXTENT: Rectangle2d = { x0: 0, z0: 0, x1: 1, z1: 1 };

/**
 * Build a 1×1 chunkData whose single heightMap cell is `height` and whose
 * single normal cell is `normal` (omit `normal` to leave the normalMap null,
 * which is the realistic state for a height-only chunk before normal regen).
 */
function makeChunkData(height: number, normal?: Vector3): GeneratorChunkData {
  const heightMap = new Array2d<number>(1, 1, 0);
  heightMap.set(0, 0, height);

  let vertexNormalMap: Array2d<Vector3> | null = null;
  if (normal !== undefined) {
    vertexNormalMap = new Array2d<Vector3>(1, 1, { x: 0, y: 1, z: 0 });
    vertexNormalMap.set(0, 0, normal);
  }

  return {
    originOffset: 0,
    numberOfPoles: 1,
    upperPad: 0,
    distanceBetweenPoles: 1,
    start: { x: 0, y: 0, z: 0 },
    heightMap,
    vertexPositionMap: null,
    vertexNormalMap,
    excludeMap: new Array2d<boolean>(1, 1, false),
    passableMap: new Array2d<boolean>(1, 1, true),
    fractalGroup: STUB_FRACTAL_GROUP,
    normalsDirty: false,
    chunkExtent: STUB_EXTENT,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// FilterHeight
// ──────────────────────────────────────────────────────────────────────────

describe('FilterHeight', () => {
  describe('isWithin', () => {
    function makeFilter(min: number, max: number, feather: number): FilterHeight {
      const f = new FilterHeight();
      f.minHeight = min;
      f.maxHeight = max;
      f.featherDistance = feather;
      f.featherFunction = FeatherFunction.Linear;
      return f;
    }

    it('returns 1 inside the core range [min, max]', () => {
      const f = makeFilter(10, 20, 2);
      const chunk = makeChunkData(15);
      expect(f.isWithin(0, 0, 0, 0, chunk)).toBe(1);
    });

    it('returns 1 at the exact min and max boundaries', () => {
      const f = makeFilter(10, 20, 2);
      expect(f.isWithin(0, 0, 0, 0, makeChunkData(10))).toBe(1);
      expect(f.isWithin(0, 0, 0, 0, makeChunkData(20))).toBe(1);
    });

    it('returns a value strictly between 0 and 1 in the upper feather band', () => {
      const f = makeFilter(10, 20, 2);
      const v = f.isWithin(0, 0, 0, 0, makeChunkData(21));
      expect(v).toBeGreaterThan(0);
      expect(v).toBeLessThan(1);
      // Linear ramp: (max + feather - value) / feather = (22 - 21) / 2 = 0.5
      expect(v).toBeCloseTo(0.5, 6);
    });

    it('returns 0 outside the feather envelope', () => {
      const f = makeFilter(10, 20, 2);
      expect(f.isWithin(0, 0, 0, 0, makeChunkData(25))).toBe(0);
      expect(f.isWithin(0, 0, 0, 0, makeChunkData(7))).toBe(0);
    });

    it('ramps from 0 to 1 across the lower feather band', () => {
      const f = makeFilter(10, 20, 2);
      // value 9 sits 1m below min, 1m above (min - feather=8). Linear t = 0.5.
      expect(f.isWithin(0, 0, 0, 0, makeChunkData(9))).toBeCloseTo(0.5, 6);
      // Right at the very edge of the feather band → 0.
      expect(f.isWithin(0, 0, 0, 0, makeChunkData(8))).toBe(0);
    });

    it('collapses to a hard step when featherDistance is 0', () => {
      const f = makeFilter(10, 20, 0);
      expect(f.isWithin(0, 0, 0, 0, makeChunkData(15))).toBe(1);
      expect(f.isWithin(0, 0, 0, 0, makeChunkData(10))).toBe(1);
      expect(f.isWithin(0, 0, 0, 0, makeChunkData(20))).toBe(1);
      expect(f.isWithin(0, 0, 0, 0, makeChunkData(20.0001))).toBe(0);
      expect(f.isWithin(0, 0, 0, 0, makeChunkData(9.9999))).toBe(0);
    });
  });

  describe('needsNormals', () => {
    it('returns false (height filter only consults the heightMap)', () => {
      expect(new FilterHeight().needsNormals()).toBe(false);
    });
  });

  describe('load', () => {
    /** Build a minimal `FHGT > 0000 > {IHDR > 0001 > DATA(active+name), DATA(min,max)}` buffer. */
    function buildFhgtBytes(min: number, max: number): Uint8Array {
      return new IffWriter()
        .insertForm('FHGT')
        .insertForm('0000')
        .insertForm('IHDR')
        .insertForm('0001')
        .insertChunk('DATA')
        .writeI32(1) // active
        .writeString('test-height-filter')
        .exitChunk()
        .exitForm() // 0001
        .exitForm() // IHDR
        .insertChunk('DATA')
        .writeF32(min)
        .writeF32(max)
        .exitChunk()
        .exitForm() // 0000
        .exitForm() // FHGT
        .toBytes();
    }

    it('reads minHeight and maxHeight from the DATA chunk', () => {
      const bytes = buildFhgtBytes(12.5, 84.25);
      const iff = Iff.fromBytes(bytes);
      const f = new FilterHeight();
      f.load(iff);
      expect(f.minHeight).toBeCloseTo(12.5, 5);
      expect(f.maxHeight).toBeCloseTo(84.25, 5);
    });
  });
});

// ──────────────────────────────────────────────────────────────────────────
// FilterSlope
// ──────────────────────────────────────────────────────────────────────────

describe('FilterSlope', () => {
  describe('isWithin', () => {
    function makeFilter(minRad: number, maxRad: number, feather = 0): FilterSlope {
      const f = new FilterSlope();
      f.minAngle = minRad;
      f.maxAngle = maxRad;
      f.featherDistance = feather;
      f.featherFunction = FeatherFunction.Linear;
      return f;
    }

    it('returns 1 for a flat surface (normal = +Y, angle = 0)', () => {
      const f = makeFilter(0, Math.PI / 4);
      const chunk = makeChunkData(0, { x: 0, y: 1, z: 0 });
      expect(f.isWithin(0, 0, 0, 0, chunk)).toBe(1);
    });

    it('returns 0 for a vertical surface (normal = +X, angle = PI/2)', () => {
      const f = makeFilter(0, Math.PI / 4);
      const chunk = makeChunkData(0, { x: 1, y: 0, z: 0 });
      expect(f.isWithin(0, 0, 0, 0, chunk)).toBe(0);
    });

    it('returns 0 (defensively) when vertexNormalMap is null', () => {
      const f = makeFilter(0, Math.PI / 4);
      const chunk = makeChunkData(0); // no normal map
      expect(f.isWithin(0, 0, 0, 0, chunk)).toBe(0);
    });

    it('passes a 30° slope when range is [0, PI/4] (≈45°)', () => {
      const f = makeFilter(0, Math.PI / 4);
      // 30° tilt: normal.y = cos(30°) ≈ 0.866
      const cos30 = Math.cos(Math.PI / 6);
      const sin30 = Math.sin(Math.PI / 6);
      const chunk = makeChunkData(0, { x: sin30, y: cos30, z: 0 });
      expect(f.isWithin(0, 0, 0, 0, chunk)).toBe(1);
    });
  });

  describe('needsNormals', () => {
    it('returns true (slope filter requires the vertex normal map)', () => {
      expect(new FilterSlope().needsNormals()).toBe(true);
    });
  });

  describe('load', () => {
    /** Build a minimal `FSLP > 0000 > {IHDR > 0001 > DATA(active+name), DATA(min,max)}` buffer (angles in radians). */
    function buildFslpBytes(minRad: number, maxRad: number): Uint8Array {
      return new IffWriter()
        .insertForm('FSLP')
        .insertForm('0000')
        .insertForm('IHDR')
        .insertForm('0001')
        .insertChunk('DATA')
        .writeI32(1) // active
        .writeString('test-slope-filter')
        .exitChunk()
        .exitForm() // 0001
        .exitForm() // IHDR
        .insertChunk('DATA')
        .writeF32(minRad)
        .writeF32(maxRad)
        .exitChunk()
        .exitForm() // 0000
        .exitForm() // FSLP
        .toBytes();
    }

    it('reads minAngle and maxAngle from the DATA chunk (radians)', () => {
      const bytes = buildFslpBytes(0, Math.PI / 4);
      const iff = Iff.fromBytes(bytes);
      const f = new FilterSlope();
      f.load(iff);
      expect(f.minAngle).toBeCloseTo(0, 5);
      expect(f.maxAngle).toBeCloseTo(Math.PI / 4, 5);
    });
  });
});
