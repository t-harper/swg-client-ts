/**
 * Tests for `FractalGroup.load` / `prepare` — the IFF reader for
 * `MGRP > 0000 > MFAM* > {DATA(id, name), MFRC > 0001 > DATA}` blocks
 * (port of `FractalGroup.cpp:load` + `load_0000`).
 *
 * Strategy: build a synthetic MGRP buffer with `IffWriter` containing one
 * or two families, each wrapping a full MFRC payload (so the embedded
 * `readMultiFractal` call gets a real block to consume). Then load via
 * `FractalGroup.load` and assert the family registry round-trips, and
 * `prepare(cx, cy)` does not throw.
 *
 * Note: `MultiFractal`'s ctor instantiates a `NoiseGenerator(0)` whose
 * `init` is implemented (agent 1 finished). Even so, the embedded MFRC
 * reader will call `setSeed` (which re-inits the noise generator) and a
 * handful of other setters — all valid on the implemented `MultiFractal`.
 */

import { describe, expect, it } from 'vitest';
import { Iff, IffWriter } from '../../../iff/iff.js';
import { CombinationRule } from '../types.js';
import { FractalGroup } from './fractal-group.js';

/** Canonical MFRC field set — same shape as multi-fractal-reader.test.ts. */
const MFRC_FIELDS = {
  seed: 0xdeadbeef,
  useBias: true,
  bias: 0.625,
  useGain: false,
  gain: 0.875,
  numberOfOctaves: 5,
  frequency: 2.5,
  amplitude: 0.5,
  scaleX: 0.015625,
  scaleY: 0.03125,
  offsetX: 128.0,
  offsetY: -64.0,
  combinationRule: CombinationRule.Turbulence, // 3
} as const;

/**
 * Append an `MFRC > 0001 > DATA` block to an open form using the canonical
 * field set above. Caller must already be inside the form that should
 * contain the MFRC (e.g. an `MFAM` form).
 */
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

/** Build an `MGRP > 0000 > MFAM(DATA(id, name), MFRC)` buffer for one family. */
function buildSingleFamilyBytes(id: number, name: string): Uint8Array {
  const w = new IffWriter()
    .insertForm('MGRP')
    .insertForm('0000')
    .insertForm('MFAM')
    .insertChunk('DATA')
    .writeI32(id)
    .writeString(name)
    .exitChunk();
  writeMfrc(w);
  return w
    .exitForm() // MFAM
    .exitForm() // 0000
    .exitForm() // MGRP
    .toBytes();
}

describe('FractalGroup', () => {
  it('loads a single-family MGRP buffer and registers the family', () => {
    const bytes = buildSingleFamilyBytes(1, 'test');
    const iff = Iff.fromBytes(bytes);
    const group = new FractalGroup();

    group.load(iff);

    expect(group.getNumberOfFamilies()).toBe(1);
    expect(group.getFamilyId(0)).toBe(1);
    expect(group.getFamilyName(1)).toBe('test');
    expect(group.hasFamily(1)).toBe(true);
    expect(group.hasFamily(2)).toBe(false);

    const mf = group.getFamilyMultiFractal(1);
    expect(mf).not.toBeNull();
    // Spot-check a few fields routed through the embedded MFRC reader to
    // confirm `readMultiFractal` actually fired against the loaded family.
    expect(mf!.getSeed()).toBe(MFRC_FIELDS.seed);
    expect(mf!.getNumberOfOctaves()).toBe(MFRC_FIELDS.numberOfOctaves);
    expect(mf!.getCombinationRule()).toBe(MFRC_FIELDS.combinationRule);
    expect(mf!.getOffsetX()).toBe(MFRC_FIELDS.offsetX);
    expect(mf!.getOffsetY()).toBe(MFRC_FIELDS.offsetY);
  });

  it('returns null for unknown family lookups', () => {
    const bytes = buildSingleFamilyBytes(1, 'test');
    const iff = Iff.fromBytes(bytes);
    const group = new FractalGroup();
    group.load(iff);

    expect(group.getFamilyMultiFractal(99)).toBeNull();
    expect(group.getFamilyName(99)).toBeNull();
  });

  it('loads multiple families in insertion order', () => {
    const w = new IffWriter().insertForm('MGRP').insertForm('0000');
    // family 1
    w.insertForm('MFAM')
      .insertChunk('DATA')
      .writeI32(1)
      .writeString('alpha')
      .exitChunk();
    writeMfrc(w);
    w.exitForm(); // MFAM 1
    // family 2
    w.insertForm('MFAM')
      .insertChunk('DATA')
      .writeI32(7)
      .writeString('bravo')
      .exitChunk();
    writeMfrc(w);
    w.exitForm(); // MFAM 2
    const bytes = w.exitForm().exitForm().toBytes();

    const iff = Iff.fromBytes(bytes);
    const group = new FractalGroup();
    group.load(iff);

    expect(group.getNumberOfFamilies()).toBe(2);
    expect(group.getFamilyId(0)).toBe(1);
    expect(group.getFamilyId(1)).toBe(7);
    expect(group.getFamilyName(1)).toBe('alpha');
    expect(group.getFamilyName(7)).toBe('bravo');
  });

  it('handles an empty MGRP > 0000 with no families', () => {
    const bytes = new IffWriter()
      .insertForm('MGRP')
      .insertForm('0000')
      .exitForm()
      .exitForm()
      .toBytes();

    const iff = Iff.fromBytes(bytes);
    const group = new FractalGroup();
    group.load(iff);

    expect(group.getNumberOfFamilies()).toBe(0);
    expect(group.hasFamily(1)).toBe(false);
  });

  it('clears existing families on reload', () => {
    const group = new FractalGroup();
    group.load(Iff.fromBytes(buildSingleFamilyBytes(1, 'first')));
    expect(group.getNumberOfFamilies()).toBe(1);

    // Reload with a different family — the first one should be gone.
    group.load(Iff.fromBytes(buildSingleFamilyBytes(2, 'second')));
    expect(group.getNumberOfFamilies()).toBe(1);
    expect(group.hasFamily(1)).toBe(false);
    expect(group.hasFamily(2)).toBe(true);
    expect(group.getFamilyName(2)).toBe('second');
  });

  it('throws on unknown MGRP version', () => {
    const bytes = new IffWriter()
      .insertForm('MGRP')
      .insertForm('9999')
      .exitForm()
      .exitForm()
      .toBytes();

    const iff = Iff.fromBytes(bytes);
    const group = new FractalGroup();
    expect(() => group.load(iff)).toThrow(/unknown MGRP version/);
  });

  it('prepare(cx, cy) does not throw and runs against every family', () => {
    const bytes = buildSingleFamilyBytes(1, 'test');
    const iff = Iff.fromBytes(bytes);
    const group = new FractalGroup();
    group.load(iff);

    expect(() => group.prepare(64, 64)).not.toThrow();
    // Empty-family prepare is a trivial no-op but should also not throw.
    const empty = new FractalGroup();
    expect(() => empty.prepare(64, 64)).not.toThrow();
  });
});
