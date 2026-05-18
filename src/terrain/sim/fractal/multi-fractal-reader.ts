/**
 * Port of `MultiFractalReaderWriter` (`sharedFractal/.../MultiFractalReaderWriter.cpp`).
 *
 * Reads an `MFRC > 0000/0001 > DATA` IFF block and populates an existing
 * `MultiFractal` instance. Versions: 0000 (11 fields, no offsets), 0001
 * (13 fields including offsets).
 *
 * Wire format (DATA chunk, all LE):
 *   [u32 seed]
 *   [i32 useBias][f32 bias]
 *   [i32 useGain][f32 gain]
 *   [i32 numberOfOctaves]
 *   [f32 frequency]
 *   [f32 amplitude]
 *   [f32 scaleX][f32 scaleY]
 *   [f32 offsetX][f32 offsetY]   ← only in 0001
 *   [i32 combinationRule]
 *
 * Setters (not raw field writes) are used because the real C++ setters do
 * cache invalidation, recompute `m_ooTotalAmplitude`, and rebind the
 * combination function pointers — behavior `MultiFractal` (agent 2) must
 * preserve.
 */

import type { Iff } from '../../../iff/iff.js';
import { CombinationRule } from '../types.js';
import type { MultiFractal } from './multi-fractal.js';

/** Read an `MFRC > version > DATA` form into `out`. Cursor must be sitting on the MFRC FORM. */
export function readMultiFractal(iff: Iff, out: MultiFractal): void {
  iff.enterForm('MFRC');

  const version = iff.enterAnyForm();
  switch (version) {
    case '0000':
      loadV0000(iff, out);
      break;
    case '0001':
      loadV0001(iff, out);
      break;
    default:
      throw new Error(`readMultiFractal: unknown MFRC version '${version}'`);
  }
  iff.exitForm(version);

  iff.exitForm('MFRC');
}

function loadV0000(iff: Iff, out: MultiFractal): void {
  iff.enterChunk('DATA');

  out.setSeed(iff.readU32());

  const useBias = iff.readI32() !== 0;
  const bias = iff.readF32();
  out.setBias(useBias, bias);

  const useGain = iff.readI32() !== 0;
  const gain = iff.readF32();
  out.setGain(useGain, gain);

  out.setNumberOfOctaves(iff.readI32());
  out.setFrequency(iff.readF32());
  out.setAmplitude(iff.readF32());

  const scaleX = iff.readF32();
  const scaleY = iff.readF32();
  out.setScale(scaleX, scaleY);

  // Version 0000 has no offsets — explicitly zero them.
  out.setOffset(0, 0);

  out.setCombinationRule(iff.readI32() as CombinationRule);

  iff.exitChunk('DATA');
}

function loadV0001(iff: Iff, out: MultiFractal): void {
  iff.enterChunk('DATA');

  out.setSeed(iff.readU32());

  const useBias = iff.readI32() !== 0;
  const bias = iff.readF32();
  out.setBias(useBias, bias);

  const useGain = iff.readI32() !== 0;
  const gain = iff.readF32();
  out.setGain(useGain, gain);

  out.setNumberOfOctaves(iff.readI32());
  out.setFrequency(iff.readF32());
  out.setAmplitude(iff.readF32());

  const scaleX = iff.readF32();
  const scaleY = iff.readF32();
  out.setScale(scaleX, scaleY);

  const offsetX = iff.readF32();
  const offsetY = iff.readF32();
  out.setOffset(offsetX, offsetY);

  out.setCombinationRule(iff.readI32() as CombinationRule);

  iff.exitChunk('DATA');
}
