/**
 * Tests for `AffectorHeightFractal` — wire-load + height-eval.
 *
 * The fractal sampler is mocked (object-literal `IMultiFractal` returning a
 * fixed value from `getValueCache`) so we can assert exact arithmetic on
 * the chunk height map without depending on the real Perlin generator.
 */

import { describe, expect, it } from 'vitest';
import { Iff, IffWriter } from '../../../iff/iff.js';
import {
  Array2d,
  CombinationRule,
  type GeneratorChunkData,
  type IFractalGroup,
  type IMultiFractal,
  Operation,
  type Rectangle2d,
  type Vector3,
} from '../types.js';
import { AffectorHeightFractal } from './height-fractal.js';

// ─────────────────────────────────────────────────────────────────────────
// Mocks
// ─────────────────────────────────────────────────────────────────────────

/**
 * Build a minimal `IMultiFractal` stub whose `getValueCache` always returns
 * the fixed `noiseValue`. Only the methods the affector touches are useful;
 * everything else just satisfies the interface.
 */
function makeMockMultiFractal(noiseValue: number): IMultiFractal {
  return {
    allocateCache: () => {},
    getValue1: () => noiseValue,
    getValue2: () => noiseValue,
    getValueCache: () => noiseValue,
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
    getBias: () => 0,
    getUseGain: () => false,
    getGain: () => 0,
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

/** FractalGroup stub: returns `mf` for `familyId`, `null` for everything else. */
function makeMockGroup(familyId: number, mf: IMultiFractal | null): IFractalGroup {
  return {
    getFamilyMultiFractal: (id: number) => (id === familyId ? mf : null),
    getFamilyName: (id: number) => (id === familyId ? 'mock-family' : null),
    getNumberOfFamilies: () => (mf !== null ? 1 : 0),
    getFamilyId: () => familyId,
    hasFamily: (id: number) => id === familyId && mf !== null,
  };
}

/**
 * Build a 1×1 `GeneratorChunkData` with the given group and an initial
 * height of `initialHeight` at (0, 0). The optional `*Map` fields not
 * relevant to height affectors are filled with the smallest valid stub
 * value (or `null` where the type allows).
 */
function makeChunkData(group: IFractalGroup, initialHeight = 0): GeneratorChunkData {
  const origin: Vector3 = { x: 0, y: 0, z: 0 };
  const extent: Rectangle2d = { x0: 0, z0: 0, x1: 1, z1: 1 };
  const heightMap = new Array2d<number>(1, 1, initialHeight);
  const excludeMap = new Array2d<boolean>(1, 1, false);
  const passableMap = new Array2d<boolean>(1, 1, true);
  return {
    originOffset: 0,
    numberOfPoles: 1,
    upperPad: 0,
    distanceBetweenPoles: 1,
    start: origin,
    heightMap,
    vertexPositionMap: null,
    vertexNormalMap: null,
    excludeMap,
    passableMap,
    fractalGroup: group,
    normalsDirty: false,
    chunkExtent: extent,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────

describe('AffectorHeightFractal', () => {
  it('reports affectsHeight() and the right map mask', () => {
    const a = new AffectorHeightFractal();
    expect(a.affectsHeight()).toBe(true);
    expect(a.getAffectedMaps()).toBe(1 << 0); // TGM.Height
  });

  it('affect(): Add operation with amount=1 writes noise * scaleY into the cell', () => {
    const noise = 0.5;
    const scaleY = 100;
    const familyId = 1;
    const mf = makeMockMultiFractal(noise);
    const group = makeMockGroup(familyId, mf);

    // Set affector fields directly (skip load) and pre-cache the multiFractal.
    const a = new AffectorHeightFractal();
    a.m_familyId = familyId;
    a.m_scaleY = scaleY;
    a.m_operation = Operation.Add;
    a.m_multiFractal = mf;
    a.m_cachedFamilyId = familyId;

    const chunkData = makeChunkData(group, 0);
    a.affect(0, 0, 0, 0, 1.0, chunkData);

    // Starting from 0 with Add: newHeight = 0 + 1.0 * (noise * scaleY) = 50.
    expect(chunkData.heightMap.get(0, 0)).toBe(Math.fround(noise * scaleY));
  });

  it('affect(): Add operation respects existing height (oldHeight + amount * fractalHeight)', () => {
    const noise = 0.25;
    const scaleY = 80;
    const familyId = 7;
    const mf = makeMockMultiFractal(noise);
    const group = makeMockGroup(familyId, mf);

    const a = new AffectorHeightFractal();
    a.m_familyId = familyId;
    a.m_scaleY = scaleY;
    a.m_operation = Operation.Add;
    a.m_multiFractal = mf;
    a.m_cachedFamilyId = familyId;

    const chunkData = makeChunkData(group, 10);
    a.affect(0, 0, 0, 0, 0.5, chunkData);

    // 10 + 0.5 * (0.25 * 80) = 10 + 10 = 20.
    const expected = Math.fround(10 + Math.fround(0.5 * Math.fround(0.25 * 80)));
    expect(chunkData.heightMap.get(0, 0)).toBe(expected);
  });

  it('affect(): Subtract operation', () => {
    const noise = 0.4;
    const scaleY = 50;
    const familyId = 2;
    const mf = makeMockMultiFractal(noise);
    const group = makeMockGroup(familyId, mf);

    const a = new AffectorHeightFractal();
    a.m_familyId = familyId;
    a.m_scaleY = scaleY;
    a.m_operation = Operation.Subtract;
    a.m_multiFractal = mf;
    a.m_cachedFamilyId = familyId;

    const chunkData = makeChunkData(group, 30);
    a.affect(0, 0, 0, 0, 1.0, chunkData);

    // 30 - 1.0 * (0.4 * 50) = 30 - 20 = 10.
    const expected = Math.fround(30 - Math.fround(1.0 * Math.fround(0.4 * 50)));
    expect(chunkData.heightMap.get(0, 0)).toBe(expected);
  });

  it('affect(): Replace operation lerps between old and fractal by amount', () => {
    const noise = 0.5;
    const scaleY = 100;
    const familyId = 3;
    const mf = makeMockMultiFractal(noise);
    const group = makeMockGroup(familyId, mf);

    const a = new AffectorHeightFractal();
    a.m_familyId = familyId;
    a.m_scaleY = scaleY;
    a.m_operation = Operation.Replace;
    a.m_multiFractal = mf;
    a.m_cachedFamilyId = familyId;

    const chunkData = makeChunkData(group, 0);
    a.affect(0, 0, 0, 0, 0.5, chunkData);

    // lerp(0, 50, 0.5) = 25
    const fractalHeight = Math.fround(noise * scaleY);
    const expected = Math.fround(Math.fround(fractalHeight - 0) * 0.5 + 0);
    expect(chunkData.heightMap.get(0, 0)).toBe(expected);
  });

  it('affect(): Multiply operation lerps between old and old*fractal by amount', () => {
    const noise = 0.5;
    const scaleY = 100;
    const familyId = 4;
    const mf = makeMockMultiFractal(noise);
    const group = makeMockGroup(familyId, mf);

    const a = new AffectorHeightFractal();
    a.m_familyId = familyId;
    a.m_scaleY = scaleY;
    a.m_operation = Operation.Multiply;
    a.m_multiFractal = mf;
    a.m_cachedFamilyId = familyId;

    const chunkData = makeChunkData(group, 4);
    a.affect(0, 0, 0, 0, 1.0, chunkData);

    // amount=1 → newHeight = desired = old * fractal = 4 * 50 = 200
    const fractalHeight = Math.fround(noise * scaleY);
    const desired = Math.fround(4 * fractalHeight);
    const expected = Math.fround(Math.fround(desired - 4) * 1.0 + 4);
    expect(chunkData.heightMap.get(0, 0)).toBe(expected);
  });

  it('affect(): early-out when amount <= 0 leaves height unchanged', () => {
    const noise = 0.5;
    const familyId = 5;
    const mf = makeMockMultiFractal(noise);
    const group = makeMockGroup(familyId, mf);

    const a = new AffectorHeightFractal();
    a.m_familyId = familyId;
    a.m_scaleY = 1000;
    a.m_operation = Operation.Add;
    a.m_multiFractal = mf;
    a.m_cachedFamilyId = familyId;

    const chunkData = makeChunkData(group, 42);
    a.affect(0, 0, 0, 0, 0, chunkData);

    expect(chunkData.heightMap.get(0, 0)).toBe(42);
  });

  it('affect(): lazy-resolves multiFractal from chunkData.fractalGroup when not cached', () => {
    const noise = 0.5;
    const scaleY = 100;
    const familyId = 6;
    const mf = makeMockMultiFractal(noise);
    const group = makeMockGroup(familyId, mf);

    // Skip loadWithGroup — leave m_multiFractal=null so the affect() path
    // exercises the lazy lookup against chunkData.fractalGroup.
    const a = new AffectorHeightFractal();
    a.m_familyId = familyId;
    a.m_scaleY = scaleY;
    a.m_operation = Operation.Add;
    // m_multiFractal remains null; m_cachedFamilyId remains -1.

    const chunkData = makeChunkData(group, 0);
    a.affect(0, 0, 0, 0, 1.0, chunkData);

    expect(chunkData.heightMap.get(0, 0)).toBe(Math.fround(noise * scaleY));
    expect(a.m_multiFractal).toBe(mf);
    expect(a.m_cachedFamilyId).toBe(familyId);
  });

  it('affect(): throws when the fractalGroup has no matching family', () => {
    const a = new AffectorHeightFractal();
    a.m_familyId = 999; // unknown
    a.m_scaleY = 100;
    a.m_operation = Operation.Add;

    const group = makeMockGroup(1, makeMockMultiFractal(0.5));
    const chunkData = makeChunkData(group, 0);

    expect(() => a.affect(0, 0, 0, 0, 1.0, chunkData)).toThrow(/familyId 999 not found/);
  });

  // ───────────────────────────────────────────────────────────────────────
  // Load tests — version 0003 (the only supported version)
  // ───────────────────────────────────────────────────────────────────────

  /**
   * Build a synthetic `AHFR > 0003 > {IHDR, DATA > PARM}` IFF buffer with
   * the given fields. PARM chunk order matches the C++ wire:
   * `[i32 familyId][i32 operation][f32 scaleY]`.
   */
  function buildAhfr0003Bytes(familyId: number, operation: Operation, scaleY: number): Uint8Array {
    return new IffWriter()
      .insertForm('AHFR')
      .insertForm('0003')
      // IHDR > 0001 > DATA(active + name) — matches LayerItem v0001
      .insertForm('IHDR')
      .insertForm('0001')
      .insertChunk('DATA')
      .writeI32(1) // active
      .writeString('test-fractal')
      .exitChunk()
      .exitForm() // 0001
      .exitForm() // IHDR
      // DATA(form) > PARM(chunk)
      .insertForm('DATA')
      .insertChunk('PARM')
      .writeI32(familyId)
      .writeI32(operation)
      .writeF32(scaleY)
      .exitChunk()
      .exitForm() // DATA
      .exitForm() // 0003
      .exitForm() // AHFR
      .toBytes();
  }

  it('load(): parses version 0003 fields out of a synthetic buffer', () => {
    const bytes = buildAhfr0003Bytes(42, Operation.Subtract, 256.5);
    const iff = Iff.fromBytes(bytes);
    const a = new AffectorHeightFractal();
    a.load(iff);

    expect(a.m_familyId).toBe(42);
    expect(a.m_operation).toBe(Operation.Subtract);
    expect(a.m_scaleY).toBe(Math.fround(256.5));
    expect(a.name).toBe('test-fractal');
    expect(a.active).toBe(true);
    // load() does NOT resolve the multiFractal.
    expect(a.m_multiFractal).toBeNull();
  });

  it('loadWithGroup(): version 0003 + resolves multiFractal from the group', () => {
    const familyId = 7;
    const mf = makeMockMultiFractal(0.25);
    const group = makeMockGroup(familyId, mf);

    const bytes = buildAhfr0003Bytes(familyId, Operation.Add, 64);
    const iff = Iff.fromBytes(bytes);
    const a = new AffectorHeightFractal();
    a.loadWithGroup(iff, group);

    expect(a.m_familyId).toBe(familyId);
    expect(a.m_operation).toBe(Operation.Add);
    expect(a.m_scaleY).toBe(64);
    expect(a.m_multiFractal).toBe(mf);
    expect(a.m_cachedFamilyId).toBe(familyId);
  });

  it('loadWithGroup(): throws when family is not in the group', () => {
    const bytes = buildAhfr0003Bytes(99, Operation.Add, 1);
    const iff = Iff.fromBytes(bytes);
    const group = makeMockGroup(1, makeMockMultiFractal(0.5));
    const a = new AffectorHeightFractal();
    expect(() => a.loadWithGroup(iff, group)).toThrow(/familyId 99 not found/);
  });

  it('load(): rejects older versions that need a FractalGroup', () => {
    const bytes = new IffWriter()
      .insertForm('AHFR')
      .insertForm('0002')
      .insertChunk('DATA')
      .exitChunk()
      .exitForm()
      .exitForm()
      .toBytes();
    const iff = Iff.fromBytes(bytes);
    const a = new AffectorHeightFractal();
    expect(() => a.load(iff)).toThrow(/'0002' requires a FractalGroup/);
  });

  it('load(): rejects unknown version', () => {
    const bytes = new IffWriter()
      .insertForm('AHFR')
      .insertForm('9999')
      .insertChunk('DATA')
      .exitChunk()
      .exitForm()
      .exitForm()
      .toBytes();
    const iff = Iff.fromBytes(bytes);
    const a = new AffectorHeightFractal();
    expect(() => a.load(iff)).toThrow(/unknown version '9999'/);
  });

  it('load(): rejects out-of-range operation', () => {
    const bytes = new IffWriter()
      .insertForm('AHFR')
      .insertForm('0003')
      .insertForm('IHDR')
      .insertForm('0001')
      .insertChunk('DATA')
      .writeI32(1)
      .writeString('bad')
      .exitChunk()
      .exitForm()
      .exitForm()
      .insertForm('DATA')
      .insertChunk('PARM')
      .writeI32(0)
      .writeI32(99) // out of range
      .writeF32(1)
      .exitChunk()
      .exitForm()
      .exitForm()
      .exitForm()
      .toBytes();
    const iff = Iff.fromBytes(bytes);
    const a = new AffectorHeightFractal();
    expect(() => a.load(iff)).toThrow(/operation out of bounds/);
  });
});
