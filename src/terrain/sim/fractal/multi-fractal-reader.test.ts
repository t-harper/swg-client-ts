/**
 * Tests for `readMultiFractal` — the IFF reader for `MFRC > 0000/0001 >
 * DATA` blocks (port of `MultiFractalReaderWriter.cpp`).
 *
 * Strategy: build a synthetic IFF buffer with `IffWriter` for each version
 * (0000 and 0001), feed it to `readMultiFractal`, and assert every field
 * round-trips through the appropriate setter on `MultiFractal`.
 */

import { describe, expect, it } from 'vitest';
import { Iff, IffWriter } from '../../../iff/iff.js';
import { CombinationRule } from '../types.js';
import { MultiFractal } from './multi-fractal.js';
import { readMultiFractal } from './multi-fractal-reader.js';

/** Field set used across both version tests. f32-friendly values (powers of two / common fractions). */
const FIELDS = {
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

/** Build an `MFRC > 0001 > DATA` IFF buffer with the canonical field set. */
function buildMfrc0001Bytes(): Uint8Array {
  return new IffWriter()
    .insertForm('MFRC')
    .insertForm('0001')
    .insertChunk('DATA')
    .writeU32(FIELDS.seed)
    .writeI32(FIELDS.useBias ? 1 : 0)
    .writeF32(FIELDS.bias)
    .writeI32(FIELDS.useGain ? 1 : 0)
    .writeF32(FIELDS.gain)
    .writeI32(FIELDS.numberOfOctaves)
    .writeF32(FIELDS.frequency)
    .writeF32(FIELDS.amplitude)
    .writeF32(FIELDS.scaleX)
    .writeF32(FIELDS.scaleY)
    .writeF32(FIELDS.offsetX)
    .writeF32(FIELDS.offsetY)
    .writeI32(FIELDS.combinationRule)
    .exitChunk()
    .exitForm() // 0001
    .exitForm() // MFRC
    .toBytes();
}

/** Build an `MFRC > 0000 > DATA` IFF buffer — same fields but no offsets. */
function buildMfrc0000Bytes(): Uint8Array {
  return new IffWriter()
    .insertForm('MFRC')
    .insertForm('0000')
    .insertChunk('DATA')
    .writeU32(FIELDS.seed)
    .writeI32(FIELDS.useBias ? 1 : 0)
    .writeF32(FIELDS.bias)
    .writeI32(FIELDS.useGain ? 1 : 0)
    .writeF32(FIELDS.gain)
    .writeI32(FIELDS.numberOfOctaves)
    .writeF32(FIELDS.frequency)
    .writeF32(FIELDS.amplitude)
    .writeF32(FIELDS.scaleX)
    .writeF32(FIELDS.scaleY)
    .writeI32(FIELDS.combinationRule)
    .exitChunk()
    .exitForm() // 0000
    .exitForm() // MFRC
    .toBytes();
}

describe('readMultiFractal', () => {
  it('round-trips every field from a synthetic MFRC > 0001 buffer', () => {
    const bytes = buildMfrc0001Bytes();
    const iff = Iff.fromBytes(bytes);
    const out = new MultiFractal();

    readMultiFractal(iff, out);

    expect(out.getSeed()).toBe(FIELDS.seed);
    expect(out.getUseBias()).toBe(FIELDS.useBias);
    expect(out.getBias()).toBe(FIELDS.bias);
    expect(out.getUseGain()).toBe(FIELDS.useGain);
    expect(out.getGain()).toBe(FIELDS.gain);
    expect(out.getNumberOfOctaves()).toBe(FIELDS.numberOfOctaves);
    expect(out.getFrequency()).toBe(FIELDS.frequency);
    expect(out.getAmplitude()).toBe(FIELDS.amplitude);
    expect(out.getScaleX()).toBe(FIELDS.scaleX);
    expect(out.getScaleY()).toBe(FIELDS.scaleY);
    expect(out.getOffsetX()).toBe(FIELDS.offsetX);
    expect(out.getOffsetY()).toBe(FIELDS.offsetY);
    expect(out.getCombinationRule()).toBe(FIELDS.combinationRule);
  });

  it('reads version 0000 (no offsets) and zeroes the offset fields', () => {
    const bytes = buildMfrc0000Bytes();
    const iff = Iff.fromBytes(bytes);
    const out = new MultiFractal();

    // Seed the target with nonzero offsets to prove the reader explicitly
    // zeroes them rather than leaving stale values behind.
    out.setOffset(123.0, 456.0);

    readMultiFractal(iff, out);

    expect(out.getSeed()).toBe(FIELDS.seed);
    expect(out.getUseBias()).toBe(FIELDS.useBias);
    expect(out.getBias()).toBe(FIELDS.bias);
    expect(out.getUseGain()).toBe(FIELDS.useGain);
    expect(out.getGain()).toBe(FIELDS.gain);
    expect(out.getNumberOfOctaves()).toBe(FIELDS.numberOfOctaves);
    expect(out.getFrequency()).toBe(FIELDS.frequency);
    expect(out.getAmplitude()).toBe(FIELDS.amplitude);
    expect(out.getScaleX()).toBe(FIELDS.scaleX);
    expect(out.getScaleY()).toBe(FIELDS.scaleY);
    expect(out.getOffsetX()).toBe(0);
    expect(out.getOffsetY()).toBe(0);
    expect(out.getCombinationRule()).toBe(FIELDS.combinationRule);
  });

  it('handles useBias=false / useGain=true (opposite of 0001 case)', () => {
    const bytes = new IffWriter()
      .insertForm('MFRC')
      .insertForm('0001')
      .insertChunk('DATA')
      .writeU32(7)
      .writeI32(0) // useBias = false
      .writeF32(0.25)
      .writeI32(1) // useGain = true
      .writeF32(0.75)
      .writeI32(3)
      .writeF32(1.5)
      .writeF32(0.5)
      .writeF32(0.01)
      .writeF32(0.02)
      .writeF32(0.0)
      .writeF32(0.0)
      .writeI32(CombinationRule.CrestClamp)
      .exitChunk()
      .exitForm()
      .exitForm()
      .toBytes();

    const iff = Iff.fromBytes(bytes);
    const out = new MultiFractal();
    readMultiFractal(iff, out);

    expect(out.getUseBias()).toBe(false);
    expect(out.getBias()).toBe(0.25);
    expect(out.getUseGain()).toBe(true);
    expect(out.getGain()).toBe(0.75);
    expect(out.getCombinationRule()).toBe(CombinationRule.CrestClamp);
  });

  it('throws on unknown MFRC version', () => {
    const bytes = new IffWriter()
      .insertForm('MFRC')
      .insertForm('9999')
      .insertChunk('DATA')
      .writeU32(0)
      .exitChunk()
      .exitForm()
      .exitForm()
      .toBytes();

    const iff = Iff.fromBytes(bytes);
    const out = new MultiFractal();
    expect(() => readMultiFractal(iff, out)).toThrow(/unknown MFRC version/);
  });
});
