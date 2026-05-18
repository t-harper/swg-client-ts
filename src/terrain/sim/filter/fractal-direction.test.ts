/**
 * Tests for `FilterFractal` (FFRA) and `FilterDirection` (FDIR).
 *
 * Strategy mirrors `height-slope.test.ts`:
 *   - Synthesize a minimal `GeneratorChunkData` (1×1 maps) and pass it
 *     through `isWithin`. For FilterFractal we hand the chunk a stub
 *     `IFractalGroup` whose `getFamilyMultiFractal` returns a stub
 *     `IMultiFractal` with a fixed `getValueCache` result. For
 *     FilterDirection we populate the normalMap with the test normal.
 *   - For `load`, build the IFF buffer with `IffWriter` and feed it to
 *     `Filter*.load(Iff)`.
 *   - Featherer fields (featherFunction/featherDistance) are set
 *     directly on the instance; the load path does not populate them
 *     in this simplified port (matches the height-slope convention).
 */

import { describe, expect, it } from 'vitest';
import { Iff, IffWriter } from '../../../iff/iff.js';
import { Array2d } from '../array2d.js';
import {
  CombinationRule,
  FeatherFunction,
  type GeneratorChunkData,
  type IFractalGroup,
  type IMultiFractal,
  type Rectangle2d,
  type Vector3,
} from '../types.js';
import { FilterDirection, FilterFractal } from './fractal-direction.js';

// ──────────────────────────────────────────────────────────────────────────
// Test doubles
// ──────────────────────────────────────────────────────────────────────────

const STUB_EXTENT: Rectangle2d = { x0: 0, z0: 0, x1: 1, z1: 1 };

/**
 * Stub MultiFractal whose `getValueCache` always returns the configured
 * `value`. Other methods are no-ops (the filter only consults
 * `getValueCache`).
 */
function makeStubMultiFractal(value: number): IMultiFractal {
  return {
    allocateCache: () => {},
    getValue1: () => value,
    getValue2: () => value,
    getValueCache: () => value,
    getSeed: () => 0,
    getScaleX: () => 1,
    getScaleY: () => 1,
    getOffsetX: () => 0,
    getOffsetY: () => 0,
    getNumberOfOctaves: () => 1,
    getFrequency: () => 1,
    getAmplitude: () => 1,
    getCombinationRule: () => CombinationRule.Add,
    getUseBias: () => false,
    getBias: () => 0.5,
    getUseGain: () => false,
    getGain: () => 0.5,
    getUseSin: () => false,
    setSeed: () => {},
    setScale: () => {},
    setOffset: () => {},
    setNumberOfOctaves: () => {},
    setFrequency: () => {},
    setAmplitude: () => {},
    setCombinationRule: () => {},
    setBias: () => {},
    setGain: () => {},
    setUseSin: () => {},
  };
}

/**
 * Stub IFractalGroup with a single family registered under `familyId`.
 * `getFamilyMultiFractal` returns the supplied stub for that id and `null`
 * for everything else.
 */
function makeStubFractalGroup(familyId: number, mf: IMultiFractal | null): IFractalGroup {
  return {
    getFamilyMultiFractal: (id: number) => (id === familyId ? mf : null),
    getFamilyName: (id: number) => (id === familyId ? `family-${id}` : null),
    getNumberOfFamilies: () => (mf === null ? 0 : 1),
    getFamilyId: () => familyId,
    hasFamily: (id: number) => id === familyId,
  };
}

const NULL_FRACTAL_GROUP: IFractalGroup = {
  getFamilyMultiFractal: () => null,
  getFamilyName: () => null,
  getNumberOfFamilies: () => 0,
  getFamilyId: () => 0,
  hasFamily: () => false,
};

/**
 * Build a 1×1 chunkData parameterized by fractalGroup + optional normal.
 * The heightMap cell is set to 0; the normalMap is only allocated when
 * `normal` is supplied (matches the height-only-port convention).
 */
function makeChunkData(fractalGroup: IFractalGroup, normal?: Vector3): GeneratorChunkData {
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
    heightMap: new Array2d<number>(1, 1, 0),
    vertexPositionMap: null,
    vertexNormalMap,
    excludeMap: new Array2d<boolean>(1, 1, false),
    passableMap: new Array2d<boolean>(1, 1, true),
    fractalGroup,
    normalsDirty: false,
    chunkExtent: STUB_EXTENT,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// FilterFractal
// ──────────────────────────────────────────────────────────────────────────

describe('FilterFractal', () => {
  describe('isWithin', () => {
    function makeFilter(familyId: number, min: number, max: number, feather = 0): FilterFractal {
      const f = new FilterFractal();
      f.familyId = familyId;
      f.minValue = min;
      f.maxValue = max;
      f.featherDistance = feather;
      f.featherFunction = FeatherFunction.Linear;
      return f;
    }

    it('returns 1 when sample (0.5) lies inside [0.3, 0.7]', () => {
      const f = makeFilter(0, 0.3, 0.7);
      const group = makeStubFractalGroup(0, makeStubMultiFractal(0.5));
      const chunk = makeChunkData(group);
      expect(f.isWithin(0, 0, 0, 0, chunk)).toBe(1);
    });

    it('returns 0 when sample (0.5) lies outside [0.0, 0.4] with no feather', () => {
      const f = makeFilter(0, 0.0, 0.4);
      const group = makeStubFractalGroup(0, makeStubMultiFractal(0.5));
      const chunk = makeChunkData(group);
      expect(f.isWithin(0, 0, 0, 0, chunk)).toBe(0);
    });

    it('caches the MultiFractal lookup on the first call', () => {
      let lookups = 0;
      const mf = makeStubMultiFractal(0.5);
      const trackingGroup: IFractalGroup = {
        getFamilyMultiFractal: (id) => {
          if (id === 7) { lookups += 1; return mf; }
          return null;
        },
        getFamilyName: () => null,
        getNumberOfFamilies: () => 1,
        getFamilyId: () => 7,
        hasFamily: (id) => id === 7,
      };
      const f = makeFilter(7, 0.3, 0.7);
      const chunk = makeChunkData(trackingGroup);
      f.isWithin(0, 0, 0, 0, chunk);
      f.isWithin(0, 0, 0, 0, chunk);
      f.isWithin(0, 0, 0, 0, chunk);
      expect(lookups).toBe(1);
      expect(f.cachedMultiFractal).toBe(mf);
    });

    it('returns 0 defensively when the family cannot be resolved', () => {
      const f = makeFilter(99, 0.0, 1.0);
      const chunk = makeChunkData(NULL_FRACTAL_GROUP);
      expect(f.isWithin(0, 0, 0, 0, chunk)).toBe(0);
    });

    it('passes the world + grid coordinates through to getValueCache', () => {
      const captured: Array<[number, number, number, number]> = [];
      const mf: IMultiFractal = {
        ...makeStubMultiFractal(0.5),
        getValueCache: (x, y, cx, cy) => { captured.push([x, y, cx, cy]); return 0.5; },
      };
      const group = makeStubFractalGroup(0, mf);
      const f = makeFilter(0, 0.3, 0.7);
      const chunk = makeChunkData(group);
      f.isWithin(123, 456, 7, 8, chunk);
      expect(captured).toEqual([[123, 456, 7, 8]]);
    });

    it('ramps via the feather band when sample sits just past the upper edge', () => {
      // sample = 0.55, max = 0.5, feather = 0.1.  t = (0.5 + 0.1 - 0.55) / 0.1 = 0.5
      const f = makeFilter(0, 0.0, 0.5, 0.1);
      const group = makeStubFractalGroup(0, makeStubMultiFractal(0.55));
      const chunk = makeChunkData(group);
      const v = f.isWithin(0, 0, 0, 0, chunk);
      expect(v).toBeCloseTo(0.5, 6);
    });
  });

  describe('needsNormals', () => {
    it('returns false (fractal filter does not consult normals)', () => {
      expect(new FilterFractal().needsNormals()).toBe(false);
    });
  });

  describe('load', () => {
    /**
     * Build a minimal `FFRA > 0005 > {IHDR > 0001 > DATA(active+name),
     * DATA(form) > PARM(chunk: familyId, featherFn, featherDist, low, high, scaleY)}` buffer —
     * matches the shipping v0005 wire format in `Filter.cpp:555+`.
     */
    function buildFfraBytes(familyId: number, min: number, max: number): Uint8Array {
      return new IffWriter()
        .insertForm('FFRA')
        .insertForm('0005')
        .insertForm('IHDR')
        .insertForm('0001')
        .insertChunk('DATA')
        .writeI32(1) // active
        .writeString('test-fractal-filter')
        .exitChunk()
        .exitForm() // 0001
        .exitForm() // IHDR
        .insertForm('DATA')
        .insertChunk('PARM')
        .writeI32(familyId)
        .writeI32(0) // featherFunction = Linear
        .writeF32(0) // featherDistance
        .writeF32(min) // lowFractalLimit
        .writeF32(max) // highFractalLimit
        .writeF32(1.0) // scaleY (unused by our gate)
        .exitChunk()
        .exitForm() // DATA
        .exitForm() // 0005
        .exitForm() // FFRA
        .toBytes();
    }

    it('reads familyId, minValue, and maxValue from the DATA chunk', () => {
      const bytes = buildFfraBytes(3, 0.25, 0.875);
      const iff = Iff.fromBytes(bytes);
      const f = new FilterFractal();
      f.load(iff);
      expect(f.familyId).toBe(3);
      expect(f.minValue).toBeCloseTo(0.25, 5);
      expect(f.maxValue).toBeCloseTo(0.875, 5);
      // cachedMultiFractal stays null until isWithin or loadWithGroup resolves it.
      expect(f.cachedMultiFractal).toBeNull();
    });

    it('loadWithGroup resolves the cachedMultiFractal immediately', () => {
      const bytes = buildFfraBytes(5, 0.1, 0.9);
      const iff = Iff.fromBytes(bytes);
      const mf = makeStubMultiFractal(0.5);
      const group = makeStubFractalGroup(5, mf);
      const f = new FilterFractal();
      f.loadWithGroup(iff, group);
      expect(f.familyId).toBe(5);
      expect(f.cachedMultiFractal).toBe(mf);
    });
  });
});

// ──────────────────────────────────────────────────────────────────────────
// FilterDirection
// ──────────────────────────────────────────────────────────────────────────

describe('FilterDirection', () => {
  describe('isWithin', () => {
    function makeFilter(minRad: number, maxRad: number, feather = 0): FilterDirection {
      const f = new FilterDirection();
      f.minAngle = minRad;
      f.maxAngle = maxRad;
      f.featherDistance = feather;
      f.featherFunction = FeatherFunction.Linear;
      return f;
    }

    it('returns 1 for a normal pointing north (x=0, z=1) when range covers 0', () => {
      // atan2(0, 1) = 0; angle in [-π/4, π/4] → 1.
      const f = makeFilter(-Math.PI / 4, Math.PI / 4);
      const chunk = makeChunkData(NULL_FRACTAL_GROUP, { x: 0, y: 0, z: 1 });
      expect(f.isWithin(0, 0, 0, 0, chunk)).toBe(1);
    });

    it('returns 0 for a normal pointing east when the range excludes π/2', () => {
      // atan2(1, 0) = π/2 ≈ 1.5708; range [0, π/4] excludes it.
      const f = makeFilter(0, Math.PI / 4);
      const chunk = makeChunkData(NULL_FRACTAL_GROUP, { x: 1, y: 0, z: 0 });
      expect(f.isWithin(0, 0, 0, 0, chunk)).toBe(0);
    });

    it('normalizes negative atan2 results into [0, 2π) before range testing', () => {
      // atan2(-1, 0) = -π/2 → normalized to 3π/2 ≈ 4.712.
      // A range that straddles 3π/2 should pass.
      const f = makeFilter(Math.PI, 2 * Math.PI);
      const chunk = makeChunkData(NULL_FRACTAL_GROUP, { x: -1, y: 0, z: 0 });
      expect(f.isWithin(0, 0, 0, 0, chunk)).toBe(1);
    });

    it('returns 0 (defensively) when vertexNormalMap is null', () => {
      const f = makeFilter(-Math.PI / 4, Math.PI / 4);
      const chunk = makeChunkData(NULL_FRACTAL_GROUP); // no normal map
      expect(f.isWithin(0, 0, 0, 0, chunk)).toBe(0);
    });

    it('feathers across the upper edge of the angle range', () => {
      // angle = π/4 + 0.05; min = -π/4; max = π/4; feather = 0.1.
      // value sits 0.05 past max → t = (max + feather - value) / feather = 0.5.
      const f = makeFilter(-Math.PI / 4, Math.PI / 4, 0.1);
      const beyond = Math.PI / 4 + 0.05;
      // Build a normal whose atan2(x, z) = `beyond` (so x = sin(beyond), z = cos(beyond))
      const chunk = makeChunkData(NULL_FRACTAL_GROUP, {
        x: Math.sin(beyond), y: 0, z: Math.cos(beyond),
      });
      const v = f.isWithin(0, 0, 0, 0, chunk);
      expect(v).toBeCloseTo(0.5, 5);
    });
  });

  describe('needsNormals', () => {
    it('returns true (direction filter requires the vertex normal map)', () => {
      expect(new FilterDirection().needsNormals()).toBe(true);
    });
  });

  describe('load', () => {
    /**
     * Build a minimal `FDIR > 0000 > {IHDR > 0001 > DATA(active+name),
     * DATA(minAngle, maxAngle)}` buffer (radians).
     */
    function buildFdirBytes(minRad: number, maxRad: number): Uint8Array {
      return new IffWriter()
        .insertForm('FDIR')
        .insertForm('0000')
        .insertForm('IHDR')
        .insertForm('0001')
        .insertChunk('DATA')
        .writeI32(1) // active
        .writeString('test-direction-filter')
        .exitChunk()
        .exitForm() // 0001
        .exitForm() // IHDR
        .insertChunk('DATA')
        .writeF32(minRad)
        .writeF32(maxRad)
        .exitChunk()
        .exitForm() // 0000
        .exitForm() // FDIR
        .toBytes();
    }

    it('reads minAngle and maxAngle from the DATA chunk (radians)', () => {
      const bytes = buildFdirBytes(-Math.PI / 4, Math.PI / 4);
      const iff = Iff.fromBytes(bytes);
      const f = new FilterDirection();
      f.load(iff);
      expect(f.minAngle).toBeCloseTo(-Math.PI / 4, 5);
      expect(f.maxAngle).toBeCloseTo(Math.PI / 4, 5);
    });
  });
});
