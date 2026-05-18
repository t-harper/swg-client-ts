/**
 * Tests for the MVP path-carving affectors (`AffectorRoad`,
 * `AffectorRiver`, `AffectorRibbon`).
 *
 * The MVP doesn't model the real carving math — it just stamps NaN into
 * the heightMap when `amount > 0` so the flat-finder rejects the cell.
 * These tests verify exactly that behavior plus the always-true
 * `affectsHeight()` flag.
 *
 * `load()` is intentionally NOT covered here — the MVP just walks-and-
 * discards the form, and there's nothing observable about that pass
 * besides "subsequent IFF reads stay aligned", which only matters once
 * the layer-loader exercises it end-to-end. See the top-of-file comment
 * in `carving.ts` for the MVP rationale.
 */

import { describe, expect, it } from 'vitest';
import { Array2d, TGM, type GeneratorChunkData, type IFractalGroup } from '../types.js';
import { AffectorRoad, AffectorRiver, AffectorRibbon } from './carving.js';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

/**
 * Tiny stub FractalGroup — the carving affectors never read from it, but
 * the GeneratorChunkData interface requires the field to be non-null.
 */
const STUB_FRACTAL_GROUP: IFractalGroup = {
  getFamilyMultiFractal: () => null,
  getFamilyName: () => null,
  getNumberOfFamilies: () => 0,
  getFamilyId: () => 0,
  hasFamily: () => false,
};

/** Build a minimal 4×4 GeneratorChunkData with heights filled to 0. */
function buildChunkData(): GeneratorChunkData {
  const size = 4;
  return {
    originOffset: 0,
    numberOfPoles: size,
    upperPad: 0,
    distanceBetweenPoles: 1,
    start: { x: 0, y: 0, z: 0 },
    heightMap: new Array2d<number>(size, size, 0),
    vertexPositionMap: null,
    vertexNormalMap: null,
    excludeMap: new Array2d<boolean>(size, size, false),
    passableMap: new Array2d<boolean>(size, size, true),
    fractalGroup: STUB_FRACTAL_GROUP,
    normalsDirty: false,
    chunkExtent: { x0: 0, z0: 0, x1: size, z1: size },
  };
}

// ---------------------------------------------------------------------------
// affect()
// ---------------------------------------------------------------------------

describe('AffectorRoad', () => {
  it('affect() with amount > 0 stamps NaN into the heightMap', () => {
    const affector = new AffectorRoad();
    const chunk = buildChunkData();
    affector.affect(0, 0, 2, 1, 0.5, chunk);
    expect(Number.isNaN(chunk.heightMap.get(2, 1))).toBe(true);
  });

  it('affect() with amount === 0 leaves the heightMap unchanged', () => {
    const affector = new AffectorRoad();
    const chunk = buildChunkData();
    affector.affect(0, 0, 2, 1, 0, chunk);
    expect(chunk.heightMap.get(2, 1)).toBe(0);
  });

  it('affectsHeight() === true', () => {
    expect(new AffectorRoad().affectsHeight()).toBe(true);
  });

  it('getAffectedMaps() === TGM.Height', () => {
    expect(new AffectorRoad().getAffectedMaps()).toBe(TGM.Height);
  });
});

describe('AffectorRiver', () => {
  it('affect() with amount > 0 stamps NaN into the heightMap', () => {
    const affector = new AffectorRiver();
    const chunk = buildChunkData();
    affector.affect(0, 0, 0, 3, 0.75, chunk);
    expect(Number.isNaN(chunk.heightMap.get(0, 3))).toBe(true);
  });

  it('affect() with amount === 0 leaves the heightMap unchanged', () => {
    const affector = new AffectorRiver();
    const chunk = buildChunkData();
    affector.affect(0, 0, 0, 3, 0, chunk);
    expect(chunk.heightMap.get(0, 3)).toBe(0);
  });

  it('affectsHeight() === true', () => {
    expect(new AffectorRiver().affectsHeight()).toBe(true);
  });

  it('getAffectedMaps() === TGM.Height', () => {
    expect(new AffectorRiver().getAffectedMaps()).toBe(TGM.Height);
  });
});

describe('AffectorRibbon', () => {
  it('affect() with amount > 0 stamps NaN into the heightMap', () => {
    const affector = new AffectorRibbon();
    const chunk = buildChunkData();
    affector.affect(0, 0, 3, 3, 1, chunk);
    expect(Number.isNaN(chunk.heightMap.get(3, 3))).toBe(true);
  });

  it('affect() with amount === 0 leaves the heightMap unchanged', () => {
    const affector = new AffectorRibbon();
    const chunk = buildChunkData();
    affector.affect(0, 0, 3, 3, 0, chunk);
    expect(chunk.heightMap.get(3, 3)).toBe(0);
  });

  it('affectsHeight() === true (MVP — real C++ ribbon returns false)', () => {
    expect(new AffectorRibbon().affectsHeight()).toBe(true);
  });

  it('getAffectedMaps() === TGM.Height', () => {
    expect(new AffectorRibbon().getAffectedMaps()).toBe(TGM.Height);
  });
});

// ---------------------------------------------------------------------------
// Cross-cutting safety: untouched cells stay zero.
// ---------------------------------------------------------------------------

describe('carving affectors do not bleed into other cells', () => {
  it('AffectorRoad only writes the targeted (x, z)', () => {
    const affector = new AffectorRoad();
    const chunk = buildChunkData();
    affector.affect(0, 0, 1, 1, 1, chunk);
    let nanCount = 0;
    for (let z = 0; z < 4; z++) {
      for (let x = 0; x < 4; x++) {
        if (Number.isNaN(chunk.heightMap.get(x, z))) nanCount++;
      }
    }
    expect(nanCount).toBe(1);
    expect(Number.isNaN(chunk.heightMap.get(1, 1))).toBe(true);
  });
});
