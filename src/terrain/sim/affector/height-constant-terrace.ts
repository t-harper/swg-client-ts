/**
 * Ports of `AffectorHeightConstant` (load 0000; 2 fields: op + height)
 * and `AffectorHeightTerrace` (load 0000-0004; 2 fields: fraction + height)
 * from `sharedTerrain/.../AffectorHeight.cpp`.
 *
 * Constant: apply a flat `height` via `Operation`.
 * Terrace: snap current height into the nearest `height`-tall terrace step
 * — creates stepped terraces.
 */

import {
  Affector, AffectorType, AHCN_TAG, AHTR_TAG, TGM,
  Operation, type GeneratorChunkData,
} from '../types.js';
import type { Iff } from '../../../iff/iff.js';

// ---------------------------------------------------------------------------
// LayerItem IHDR (common header) — `TerrainGenerator::LayerItem::load`
// ---------------------------------------------------------------------------
//
// Every Affector / Boundary / Filter starts with an `IHDR` form that holds
// `active` + `name` (and in v0000 also a defunct PackedRgb "tool color").
// We don't have a shared helper yet, so inline the read here.

/**
 * Recursively walk every form/chunk under the cursor, discarding contents,
 * and exit. Mirrors the helper in `carving.ts::walkAndDiscard`. Used when
 * we need to step past an embedded block we don't model (e.g. AHTR v0003's
 * MultiFractal).
 */
function walkAndDiscard(iff: Iff): void {
  while (!iff.atEndOfForm()) {
    if (iff.isCurrentForm()) {
      const tag = iff.enterAnyForm();
      walkAndDiscard(iff);
      iff.exitForm(tag);
    } else {
      iff.enterChunk();
      iff.exitChunk();
    }
  }
}

/** Walk past the next FORM at the cursor, discarding all its bytes. */
function skipNextForm(iff: Iff): void {
  if (!iff.isCurrentForm()) {
    throw new Error('skipNextForm: cursor is not on a FORM');
  }
  const tag = iff.enterAnyForm();
  walkAndDiscard(iff);
  iff.exitForm(tag);
}

function loadLayerItemHeader(iff: Iff, target: { active: boolean; name: string }): void {
  iff.enterForm('IHDR');
  const version = iff.getCurrentName();
  switch (version) {
    case '0000': {
      iff.enterForm('0000');
      iff.enterChunk('DATA');
      target.active = iff.readI32() !== 0;
      target.name = iff.readString();
      // PackedRgb (tool color, unused) — three u8.
      iff.readU8();
      iff.readU8();
      iff.readU8();
      iff.exitChunk('DATA');
      iff.exitForm('0000');
      break;
    }
    case '0001': {
      iff.enterForm('0001');
      iff.enterChunk('DATA');
      target.active = iff.readI32() !== 0;
      target.name = iff.readString();
      iff.exitChunk('DATA');
      iff.exitForm('0001');
      break;
    }
    default:
      throw new Error(`LayerItem IHDR: unknown version '${version}'`);
  }
  iff.exitForm('IHDR');
}

// ---------------------------------------------------------------------------
// AffectorHeightConstant — TAG_AHCN, port of AffectorHeight.cpp:22-167
// ---------------------------------------------------------------------------

export class AffectorHeightConstant extends Affector {
  operation: Operation = Operation.Replace;
  height = 0;

  constructor() {
    super(AHCN_TAG, AffectorType.HeightConstant);
  }

  load(iff: Iff): void {
    // Cursor is on the AHCN FORM; enter it, then dispatch the version form.
    iff.enterForm('AHCN');
    const version = iff.getCurrentName();
    if (version !== '0000') {
      throw new Error(`AffectorHeightConstant: unsupported version '${version}'`);
    }
    iff.enterForm('0000');
    // Base LayerItem fields (active, name).
    loadLayerItemHeader(iff, this);
    iff.enterChunk('DATA');
    const newOperation = iff.readI32();
    if (newOperation < 0 || newOperation > Operation.Multiply) {
      throw new Error(`AffectorHeightConstant '${this.name}': operation out of bounds (${newOperation})`);
    }
    this.operation = newOperation as Operation;
    this.height = iff.readF32();
    iff.exitChunk('DATA');
    iff.exitForm('0000');
    iff.exitForm('AHCN');
  }

  affect(
    _worldX: number, _worldZ: number, x: number, z: number,
    amount: number, chunkData: GeneratorChunkData,
  ): void {
    if (!(amount > 0)) return;

    let newHeight = 0;
    switch (this.operation) {
      case Operation.Add:
        newHeight = chunkData.heightMap.get(x, z) + amount * this.height;
        break;
      case Operation.Subtract:
        newHeight = chunkData.heightMap.get(x, z) - amount * this.height;
        break;
      case Operation.Multiply: {
        const oldHeight = chunkData.heightMap.get(x, z);
        const desiredHeight = oldHeight * this.height;
        // linearInterpolate(start, end, t) = start + (end - start) * t
        newHeight = oldHeight + (desiredHeight - oldHeight) * amount;
        break;
      }
      case Operation.Replace:
      default:
        newHeight = amount * this.height + (1 - amount) * chunkData.heightMap.get(x, z);
        break;
    }

    chunkData.heightMap.set(x, z, newHeight);
  }

  override affectsHeight(): boolean { return true; }
  getAffectedMaps(): number { return TGM.Height; }
}

// ---------------------------------------------------------------------------
// AffectorHeightTerrace — TAG_AHTR, port of AffectorHeight.cpp:498-714
// ---------------------------------------------------------------------------

export class AffectorHeightTerrace extends Affector {
  // Defaults from the C++ ctor.
  height = 20;
  fraction = 0.25;

  constructor() {
    super(AHTR_TAG, AffectorType.HeightTerrace);
  }

  load(iff: Iff): void {
    iff.enterForm('AHTR');
    const version = iff.getCurrentName();
    // Versions 0000-0004 share the same `[f32 fraction][f32 height]` data;
    // versions 0000/0001/0002/0004 store it directly in a DATA chunk, while
    // version 0003 wraps a MultiFractal embed (we walk and discard) plus a
    // PARM chunk that holds the two floats + one unused int. Matches
    // `AffectorHeight.cpp:556-696` (load_0000 .. load_0004).
    switch (version) {
      case '0000':
      case '0001':
      case '0002':
      case '0004': {
        iff.enterForm(version);
        loadLayerItemHeader(iff, this);
        iff.enterChunk('DATA');
        this.fraction = iff.readF32();
        this.height = iff.readF32();
        iff.exitChunk('DATA');
        iff.exitForm(version);
        break;
      }
      case '0003': {
        iff.enterForm('0003');
        loadLayerItemHeader(iff, this);
        // v0003 wraps a `DATA(form) > { MultiFractal block, PARM(chunk) }`.
        iff.enterForm('DATA');
        // Walk past the embedded MultiFractal — we don't actually wire it
        // up to the terrace eval (the C++ ctor reads it into a local and
        // throws it away too, see AffectorHeight.cpp:660-663). The only
        // surviving fields are fraction + height, read from the PARM chunk.
        skipNextForm(iff);
        iff.enterChunk('PARM');
        this.fraction = iff.readF32();
        this.height = iff.readF32();
        /* unused */ iff.readI32();
        iff.exitChunk('PARM');
        iff.exitForm('DATA');
        iff.exitForm('0003');
        break;
      }
      default:
        throw new Error(`AffectorHeightTerrace: unsupported version '${version}'`);
    }
    iff.exitForm('AHTR');
  }

  affect(
    _worldX: number, _worldZ: number, x: number, z: number,
    amount: number, chunkData: GeneratorChunkData,
  ): void {
    if (!(amount > 0) || !(this.height > 0)) return;

    const terraceHeight = this.height;
    if (!(terraceHeight > 0)) return;

    const originalHeight = chunkData.heightMap.get(x, z);
    // Snap down to the bottom of the terrace step containing originalHeight.
    // For negative originals, mirror the C++ adjustment so the step boundary
    // stays at `k * terraceHeight` for every integer k.
    const fmod = originalHeight - Math.trunc(originalHeight / terraceHeight) * terraceHeight;
    const lowHeight = originalHeight - (originalHeight < 0
      ? terraceHeight + fmod
      : fmod);
    const midHeight = lowHeight + terraceHeight * this.fraction;
    const highHeight = lowHeight + terraceHeight;

    let newHeight = lowHeight;
    if (originalHeight > midHeight) {
      const t = (originalHeight - midHeight) / (highHeight - midHeight);
      // linearInterpolate(low, high, t)
      newHeight = lowHeight + (highHeight - lowHeight) * t;
    }

    // Blend the snapped value back with the original by `amount`.
    chunkData.heightMap.set(x, z, originalHeight + (newHeight - originalHeight) * amount);
  }

  override affectsHeight(): boolean { return true; }
  getAffectedMaps(): number { return TGM.Height; }
}
