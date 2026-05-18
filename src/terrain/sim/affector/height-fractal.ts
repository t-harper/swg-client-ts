/**
 * Port of `AffectorHeightFractal` from `sharedTerrain/.../AffectorHeight.cpp:218+`.
 *
 * Load versions:
 *   - 0000/0001/0002 — the affector embedded the MultiFractal inline and
 *     registered it into the owning FractalGroup via `createFamily`. Our
 *     `IFractalGroup` interface is read-only (no `createFamily`), so those
 *     versions are not supported in this offline port — they throw on load
 *     with a clear "unsupported version" error.
 *   - 0003 — only stores `[familyId, operation, scaleY]` and looks up the
 *     fractal in the FractalGroup at affect-time. Wire form:
 *     `AHFR > 0003 > {IHDR (LayerItem common), DATA(form) > PARM(chunk)}`.
 *
 * Eval: `m_multiFractal.getValueCache(worldX, worldZ, x, z) * m_scaleY`,
 * applied to the chunk's height map via `m_operation`.
 *
 * Float-pipeline note: the C++ runs on x86 native `float` (32-bit) end to
 * end — noise sample, scaleY multiply, and the per-op blend are all single
 * precision. We `Math.fround` around the multiply and the operation result
 * so the chunk heights match the C++ output bit-for-bit.
 */

import {
  Affector, AffectorType, AHFR_TAG, TGM,
  type IFractalGroup, type IMultiFractal,
  Operation, type GeneratorChunkData,
} from '../types.js';
import type { Iff } from '../../../iff/iff.js';

export class AffectorHeightFractal extends Affector {
  m_familyId = 0;
  m_scaleY = 1;
  m_operation: Operation = Operation.Add;
  /** Resolved at load time when a FractalGroup is provided, or lazily on first affect(). */
  m_multiFractal: IMultiFractal | null = null;
  m_cachedFamilyId = -1;

  constructor() {
    super(AHFR_TAG, AffectorType.HeightFractal);
  }

  /**
   * Load without a FractalGroup — only the modern version 0003 is supported
   * because older versions need to register a freshly-decoded fractal into
   * the group via `createFamily`, which the read-only `IFractalGroup` does
   * not expose. The multiFractal stays `null` here; resolution happens
   * lazily on the first `affect()` call using `chunkData.fractalGroup`.
   *
   * Cursor expectation: positioned on the `AHFR` FORM.
   */
  load(iff: Iff): void {
    iff.enterForm('AHFR');
    const version = iff.getCurrentName();
    switch (version) {
      case '0003':
        this.load_0003(iff);
        break;
      case '0000':
      case '0001':
      case '0002':
        throw new Error(
          `AffectorHeightFractal.load: version '${version}' requires a FractalGroup (use loadWithGroup)`,
        );
      default:
        throw new Error(`AffectorHeightFractal.load: unknown version '${version}'`);
    }
    iff.exitForm('AHFR');
  }

  /**
   * Load with a FractalGroup, dispatching across all known versions. The
   * group is consulted after `m_familyId` is decoded so that
   * `this.m_multiFractal` is populated immediately (and the affect-time
   * lookup short-circuits). Throws if the family isn't registered.
   *
   * For versions 0000/0001/0002 the on-disk format embeds an inline
   * MultiFractal that the C++ registers as a brand-new family. The
   * read-only `IFractalGroup` interface does not support new-family
   * registration, so those versions are explicitly rejected here too.
   *
   * Cursor expectation: positioned on the `AHFR` FORM.
   */
  loadWithGroup(iff: Iff, fractalGroup: IFractalGroup): void {
    iff.enterForm('AHFR');
    const version = iff.getCurrentName();
    switch (version) {
      case '0003':
        this.load_0003(iff);
        break;
      case '0000':
      case '0001':
      case '0002':
        throw new Error(
          `AffectorHeightFractal.loadWithGroup: version '${version}' embeds an inline MultiFractal ` +
            'that requires IFractalGroup.createFamily, which the offline port does not expose',
        );
      default:
        throw new Error(`AffectorHeightFractal.loadWithGroup: unknown version '${version}'`);
    }
    iff.exitForm('AHFR');

    // Resolve the multiFractal now that the wire data is loaded.
    const mf = fractalGroup.getFamilyMultiFractal(this.m_familyId);
    if (mf === null) {
      throw new Error(
        `AffectorHeightFractal.loadWithGroup: familyId ${this.m_familyId} not found in FractalGroup`,
      );
    }
    this.m_multiFractal = mf;
    this.m_cachedFamilyId = this.m_familyId;
  }

  /**
   * Port of `AffectorHeightFractal::load_0003` (AffectorHeight.cpp:441-467).
   *
   * Wire: `0003 > IHDR + DATA(form) > PARM(chunk)`.
   * PARM chunk reads: `[i32 familyId][i32 operation][f32 scaleY]` (matches
   * the C++ `setFamilyId / setOperation / setScaleY` call order).
   */
  private load_0003(iff: Iff): void {
    iff.enterForm('0003');
    this.loadIhdr(iff);
    iff.enterForm('DATA');
    iff.enterChunk('PARM');
    this.m_familyId = iff.readI32();
    const newOperation = iff.readI32();
    if (newOperation < 0 || newOperation > Operation.Multiply) {
      throw new Error(
        `AffectorHeightFractal.load_0003: operation out of bounds (${newOperation})`,
      );
    }
    this.m_operation = newOperation as Operation;
    this.m_scaleY = iff.readF32();
    iff.exitChunk('PARM');
    iff.exitForm('DATA');
    iff.exitForm('0003');
  }

  /**
   * Mirror of `TerrainGenerator::LayerItem::load` — reads the common IHDR
   * form (active + name + optional legacy tool color in v0000).
   */
  private loadIhdr(iff: Iff): void {
    iff.enterForm('IHDR');
    const version = iff.getCurrentName();
    iff.enterForm(version);
    iff.enterChunk('DATA');
    this.active = iff.readI32() !== 0;
    this.name = iff.readString();
    if (version === '0000') {
      // legacy tool color (rgb) — three bytes, discarded
      iff.readU8();
      iff.readU8();
      iff.readU8();
    } else if (version !== '0001') {
      throw new Error(`AffectorHeightFractal.loadIhdr: unknown IHDR version '${version}'`);
    }
    iff.exitChunk('DATA');
    iff.exitForm(version);
    iff.exitForm('IHDR');
  }

  /**
   * Port of `AffectorHeightFractal::affect` (AffectorHeight.cpp:218-265).
   *
   * Sampling: `m_multiFractal.getValueCache(worldX, worldZ, x, z)` returns
   * a value in [0, 1]. We multiply by `m_scaleY` to get the per-pole
   * fractal contribution, then blend against `chunkData.heightMap[x, z]`
   * according to `m_operation`:
   *
   *   - Replace:  newHeight = lerp(old, fractal, amount)
   *   - Add:      newHeight = old + amount * fractal
   *   - Subtract: newHeight = old - amount * fractal
   *   - Multiply: newHeight = lerp(old, old * fractal, amount)
   *
   * All multiplies + the final operation result are wrapped in `Math.fround`
   * to mirror the C++ x86 float32 pipeline.
   */
  affect(
    worldX: number, worldZ: number, x: number, z: number,
    amount: number, chunkData: GeneratorChunkData,
  ): void {
    if (amount <= 0) return;

    // Lazy-resolve / re-resolve the multiFractal if the cached familyId
    // doesn't match (mirrors C++ `m_cachedFamilyId != m_familyId` check on
    // every call — cheap, and required since the family can be reassigned).
    if (this.m_cachedFamilyId !== this.m_familyId) {
      this.m_cachedFamilyId = this.m_familyId;
      this.m_multiFractal = chunkData.fractalGroup.getFamilyMultiFractal(this.m_familyId);
    }
    if (this.m_multiFractal === null) {
      throw new Error(
        `AffectorHeightFractal.affect: familyId ${this.m_familyId} not found in FractalGroup`,
      );
    }

    const noise = this.m_multiFractal.getValueCache(worldX, worldZ, x, z);
    const fractalHeight = Math.fround(noise * this.m_scaleY);
    const oldHeight = chunkData.heightMap.get(x, z);

    let newHeight = oldHeight;
    switch (this.m_operation) {
      case Operation.Add:
        newHeight = Math.fround(oldHeight + Math.fround(amount * fractalHeight));
        break;
      case Operation.Subtract:
        newHeight = Math.fround(oldHeight - Math.fround(amount * fractalHeight));
        break;
      case Operation.Multiply: {
        const desiredHeight = Math.fround(oldHeight * fractalHeight);
        // linearInterpolate(start, end, t) = (end - start) * t + start
        newHeight = Math.fround(Math.fround(desiredHeight - oldHeight) * amount + oldHeight);
        break;
      }
      case Operation.Replace:
      default:
        newHeight = Math.fround(Math.fround(fractalHeight - oldHeight) * amount + oldHeight);
        break;
    }

    chunkData.heightMap.set(x, z, newHeight);
  }

  override affectsHeight(): boolean { return true; }
  getAffectedMaps(): number { return TGM.Height; }
}
