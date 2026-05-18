/**
 * Tests for `TerrainGenerator.load` / `prepare` / `generateChunk` — the
 * `TGEN` IFF root form reader plus per-chunk generation driver. Port of
 * `TerrainGenerator::load` (TerrainGenerator.cpp:2136), `load_0000`
 * (cpp:2174), `generateChunk` (cpp:1920), and `affect` (cpp:1820).
 *
 * Strategy:
 *
 *   1. Build a minimal `TGEN > 0000 > {SGRP?, FGRP?, RGRP?, EGRP?, MGRP,
 *      BGRP?, LYRS}` buffer with `IffWriter`. The SGRP/FGRP/RGRP/EGRP/BGRP
 *      groups (when present) carry one nested form + chunk apiece so the
 *      walk-and-discard helper has something non-trivial to skip past.
 *      MGRP contains one `MFAM` with a full MFRC payload — that exercises
 *      `FractalGroup.load` end-to-end. LYRS contains one `LAYR` v0003 with
 *      one `AffectorHeightConstant` v0000 embedded inside — the simplest
 *      shape that the production `Layer.load` accepts.
 *
 *   2. Load via `TerrainGenerator.load`. Assert that the FractalGroup got
 *      its family and that exactly one layer landed in `layers`.
 *
 *   3. Build a `GeneratorChunkData` with `numberOfPoles=3` and a non-zero
 *      `Array2d<number>` height map. Call `generateChunk` and assert
 *      every cell equals the constant — proving the layer's affector
 *      ran on every pole and that the `fill(0)` reset actually happened.
 *
 *   4. Separately, verify the LYRS-less load path doesn't trip on
 *      walk-and-discard, and that `prepare(n)` forwards through to
 *      `FractalGroup.prepare(n, n)`.
 */

import { describe, expect, it } from 'vitest';
import { Iff, IffWriter } from '../../../iff/iff.js';
import {
  Array2d,
  CombinationRule,
  Operation,
  type GeneratorChunkData,
  type IFractalGroup,
} from '../types.js';
import { AffectorHeightConstant } from '../affector/height-constant-terrace.js';
import { FractalGroup } from './fractal-group.js';
import { TerrainGenerator } from './terrain-generator.js';

// ─────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────

const MFRC_FIELDS = {
  seed: 0x12345678,
  useBias: false,
  bias: 0.5,
  useGain: false,
  gain: 0.7,
  numberOfOctaves: 2,
  frequency: 2.0,
  amplitude: 0.5,
  scaleX: 0.01,
  scaleY: 0.01,
  offsetX: 0.0,
  offsetY: 0.0,
  combinationRule: CombinationRule.Add,
} as const;

/** Append an `MFRC > 0001 > DATA` block to an open form. */
function writeMfrc(w: IffWriter): void {
  w.insertForm('MFRC')
    .insertForm('0001')
    .insertChunk('DATA')
    .writeU32(MFRC_FIELDS.seed)
    .writeI32(MFRC_FIELDS.useBias ? 1 : 0)
    .writeF32(MFRC_FIELDS.bias)
    .writeI32(MFRC_FIELDS.useGain ? 1 : 0)
    .writeF32(MFRC_FIELDS.gain)
    .writeI32(MFRC_FIELDS.numberOfOctaves)
    .writeF32(MFRC_FIELDS.frequency)
    .writeF32(MFRC_FIELDS.amplitude)
    .writeF32(MFRC_FIELDS.scaleX)
    .writeF32(MFRC_FIELDS.scaleY)
    .writeF32(MFRC_FIELDS.offsetX)
    .writeF32(MFRC_FIELDS.offsetY)
    .writeI32(MFRC_FIELDS.combinationRule)
    .exitChunk()
    .exitForm() // 0001
    .exitForm(); // MFRC
}

/**
 * Append a non-trivial group container to skip past. Emits a single
 * versioned form with a DATA chunk inside — enough to make sure the
 * walk-and-discard helper recurses one level into nested forms AND
 * advances past chunk bodies (the two failure modes I'd expect from a
 * naive implementation).
 */
function writeSkipGroup(w: IffWriter, tag: string): void {
  w.insertForm(tag)
    .insertForm('0000')
    .insertChunk('DATA')
    .writeI32(0xdeadbeef | 0)
    .exitChunk()
    .exitForm() // 0000
    .exitForm(); // <tag>
}

/** Append an `AHCN > 0000 > {IHDR > 0001 > DATA, DATA}` form for a flat-height affector. */
function writeAhcn(w: IffWriter, height: number, op: Operation): void {
  w.insertForm('AHCN')
    .insertForm('0000')
    // IHDR (LayerItem common header).
    .insertForm('IHDR')
    .insertForm('0001')
    .insertChunk('DATA')
    .writeI32(1) // active
    .writeString('test-constant')
    .exitChunk()
    .exitForm() // 0001
    .exitForm() // IHDR
    // The affector's own DATA chunk: [i32 operation][f32 height].
    .insertChunk('DATA')
    .writeI32(op)
    .writeF32(height)
    .exitChunk()
    .exitForm() // 0000
    .exitForm(); // AHCN
}

/**
 * Append a single `LAYR > 0003 > {IHDR, ADTA, AHCN}` form holding one
 * constant affector. v0003 is chosen because it carries the full set of
 * editor flags (invertBoundaries / invertFilters / expanded / notes) —
 * a good cross-section for confirming the Layer reader can land at
 * non-trivial offsets and still hand its child form back aligned.
 */
function writeLayrWithConstantAffector(
  w: IffWriter,
  height: number,
  op: Operation = Operation.Replace,
): void {
  w.insertForm('LAYR')
    .insertForm('0003')
    // IHDR (LayerItem common header for the layer itself).
    .insertForm('IHDR')
    .insertForm('0001')
    .insertChunk('DATA')
    .writeI32(1) // active
    .writeString('test-layer')
    .exitChunk()
    .exitForm() // 0001
    .exitForm() // IHDR
    // ADTA chunk for v0003: invertBoundaries, invertFilters, expanded, notes.
    .insertChunk('ADTA')
    .writeI32(0) // invertBoundaries
    .writeI32(0) // invertFilters
    .writeI32(0) // expanded
    .writeString('')
    .exitChunk();
  writeAhcn(w, height, op);
  w.exitForm() // 0003
    .exitForm(); // LAYR
}

/** Build a full TGEN buffer with the requested layer height (omit for no LYRS). */
function buildTgenBytes(opts: {
  withSkipGroups?: boolean;
  layerHeight?: number;
}): Uint8Array {
  const w = new IffWriter().insertForm('TGEN').insertForm('0000');

  if (opts.withSkipGroups) {
    writeSkipGroup(w, 'SGRP');
    writeSkipGroup(w, 'FGRP');
    writeSkipGroup(w, 'RGRP');
    writeSkipGroup(w, 'EGRP');
  }

  // MGRP with one family (always present).
  w.insertForm('MGRP')
    .insertForm('0000')
    .insertForm('MFAM')
    .insertChunk('DATA')
    .writeI32(1)
    .writeString('test-family')
    .exitChunk();
  writeMfrc(w);
  w.exitForm(); // MFAM
  w.exitForm(); // 0000
  w.exitForm(); // MGRP

  if (opts.withSkipGroups) {
    writeSkipGroup(w, 'BGRP');
  }

  // LYRS with one layer (optional).
  if (opts.layerHeight !== undefined) {
    w.insertForm('LYRS');
    writeLayrWithConstantAffector(w, opts.layerHeight);
    w.exitForm(); // LYRS
  }

  return w.exitForm().exitForm().toBytes(); // 0000, TGEN
}

/**
 * Build a `GeneratorChunkData` shaped to satisfy the height-only port's
 * needs. The `fractalGroup` field is replaced inside `generateChunk` with
 * whichever group the loader ended up with — we pass an empty stub here.
 */
function makeChunkData(numberOfPoles: number, distanceBetweenPoles: number): GeneratorChunkData {
  const emptyGroup: IFractalGroup = {
    getFamilyMultiFractal: () => null,
    getFamilyName: () => null,
    getNumberOfFamilies: () => 0,
    getFamilyId: () => 0,
    hasFamily: () => false,
  };
  return {
    originOffset: 0,
    numberOfPoles,
    upperPad: 0,
    distanceBetweenPoles,
    start: { x: 0, y: 0, z: 0 },
    heightMap: new Array2d<number>(numberOfPoles, numberOfPoles, 0),
    vertexPositionMap: null,
    vertexNormalMap: null,
    excludeMap: new Array2d<boolean>(numberOfPoles, numberOfPoles, false),
    passableMap: new Array2d<boolean>(numberOfPoles, numberOfPoles, true),
    fractalGroup: emptyGroup,
    normalsDirty: false,
    chunkExtent: { x0: 0, z0: 0, x1: 0, z1: 0 },
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────

describe('TerrainGenerator', () => {
  it('loads TGEN with MGRP + LYRS containing one constant-height layer', () => {
    const bytes = buildTgenBytes({ layerHeight: 42.5 });
    const iff = Iff.fromBytes(bytes);
    const gen = new TerrainGenerator();

    gen.load(iff);

    expect(gen.layers.length).toBe(1);
    expect(gen.fractalGroup.getNumberOfFamilies()).toBe(1);
    expect(gen.fractalGroup.getFamilyName(1)).toBe('test-family');
    // The layer should have absorbed exactly one AffectorHeightConstant.
    const layer = gen.layers[0];
    expect(layer).toBeDefined();
    expect(layer!.affectors.length).toBe(1);
    expect(layer!.affectors[0]).toBeInstanceOf(AffectorHeightConstant);
    expect((layer!.affectors[0] as AffectorHeightConstant).height).toBeCloseTo(42.5, 5);
  });

  it('loads TGEN with SGRP/FGRP/RGRP/EGRP/BGRP groups walked-and-discarded', () => {
    // No LYRS — only the SKIP groups + MGRP. This isolates the
    // walk-and-discard helper from the LYRS path.
    const bytes = buildTgenBytes({ withSkipGroups: true });
    const iff = Iff.fromBytes(bytes);
    const gen = new TerrainGenerator();

    gen.load(iff);

    expect(gen.fractalGroup.getNumberOfFamilies()).toBe(1);
    expect(gen.layers.length).toBe(0);
  });

  it('rejects unknown TGEN version tags', () => {
    const bytes = new IffWriter()
      .insertForm('TGEN')
      .insertForm('9999')
      .exitForm()
      .exitForm()
      .toBytes();
    const iff = Iff.fromBytes(bytes);
    const gen = new TerrainGenerator();

    expect(() => gen.load(iff)).toThrow(/unknown TGEN version/);
  });

  it('prepare(n) forwards to FractalGroup.prepare(n, n)', () => {
    const gen = new TerrainGenerator();
    let observedCx: number | undefined;
    let observedCy: number | undefined;
    const original = FractalGroup.prototype.prepare;
    FractalGroup.prototype.prepare = function (cx: number, cy: number) {
      observedCx = cx;
      observedCy = cy;
      return original.call(this, cx, cy);
    };
    try {
      gen.prepare(33);
    } finally {
      FractalGroup.prototype.prepare = original;
    }
    expect(observedCx).toBe(33);
    expect(observedCy).toBe(33);
  });

  it('generateChunk produces a uniform height map equal to the constant', () => {
    const constantHeight = 7.5;
    const bytes = buildTgenBytes({ layerHeight: constantHeight });
    const iff = Iff.fromBytes(bytes);
    const gen = new TerrainGenerator();
    gen.load(iff);

    const chunk = makeChunkData(3, 4);
    // Seed the height map with non-zero values to verify the initial
    // `fill(0)` actually runs.
    chunk.heightMap.fill(99);
    chunk.start.x = 100;
    chunk.start.z = 200;

    gen.generateChunk(chunk);

    // Every cell should equal the constant height.
    for (let z = 0; z < 3; z++) {
      for (let x = 0; x < 3; x++) {
        expect(chunk.heightMap.get(x, z)).toBeCloseTo(constantHeight, 5);
      }
    }
    // chunkExtent should reflect start + (numberOfPoles - 1) * distanceBetweenPoles.
    expect(chunk.chunkExtent.x0).toBeCloseTo(100, 5);
    expect(chunk.chunkExtent.z0).toBeCloseTo(200, 5);
    expect(chunk.chunkExtent.x1).toBeCloseTo(100 + 2 * 4, 5);
    expect(chunk.chunkExtent.z1).toBeCloseTo(200 + 2 * 4, 5);
    // fractalGroup should now be the generator's own.
    expect(chunk.fractalGroup).toBe(gen.fractalGroup);
    // Dirty flag should be set so a downstream normal-rebuild pass would
    // trigger.
    expect(chunk.normalsDirty).toBe(true);
  });

  it('generateChunk on an empty TerrainGenerator zeroes the height map and updates extent', () => {
    const gen = new TerrainGenerator();
    const chunk = makeChunkData(3, 4);
    chunk.heightMap.fill(99);
    chunk.start.x = 10;
    chunk.start.z = 20;

    gen.generateChunk(chunk);

    for (let z = 0; z < 3; z++) {
      for (let x = 0; x < 3; x++) {
        expect(chunk.heightMap.get(x, z)).toBe(0);
      }
    }
    expect(chunk.chunkExtent.x0).toBe(10);
    expect(chunk.chunkExtent.z0).toBe(20);
    expect(chunk.chunkExtent.x1).toBe(10 + 2 * 4);
    expect(chunk.chunkExtent.z1).toBe(20 + 2 * 4);
    expect(chunk.fractalGroup).toBe(gen.fractalGroup);
  });
});
