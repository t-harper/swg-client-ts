/**
 * MVP ports of the three path-carving affectors:
 *   - `AffectorRoad`   (`AffectorRoad.cpp`)   — TAG_AROA
 *   - `AffectorRiver`  (`AffectorRiver.cpp`)  — TAG_ARIV (trench depth)
 *   - `AffectorRibbon` (`AffectorRibbon.cpp`) — TAG_ARIB (waterway)
 *
 * ─────────────────────────────────────────────────────────────────────────
 * MVP SHORTCUT — read before iterating:
 *
 * The real C++ implementations carve heights along a polyline (with
 * width, feather, optional fixed-height list, trench depth, etc.). For
 * our flat-finder use case we don't need bit-exact carving — we need to
 * mark the cells these path-based layers touch as "non-buildable" so
 * the 750×750 sliding window finder rejects them.
 *
 * So this MVP does TWO things only:
 *
 *  1. `load(iff)` — walks the entire AROA / ARIV / ARIB form tree and
 *     discards every byte. The point is to leave the parent IFF cursor
 *     correctly positioned past the form so subsequent reads remain
 *     aligned. No carving parameters are remembered.
 *
 *  2. `affect(...)` — writes `Number.NaN` into `chunkData.heightMap` at
 *     (x, z) whenever `amount > 0`. The flat-finder already treats NaN
 *     cells as forbidden, so any candidate window overlapping a path
 *     will be rejected.
 *
 * Why this is safe for the flat-finder: false positives (cells flagged
 * as non-buildable when the real carving wouldn't actually touch them)
 * only shrink the recommended buildable area. They never cause us to
 * recommend a bad spot. Worst case: we miss valid spots that are slightly
 * near a road / river / ribbon — but those are usually inside NPC city
 * exclusion zones anyway.
 *
 * Future iteration: replace this with the full polyline-distance +
 * height-list math from the C++ sources referenced above.
 * ─────────────────────────────────────────────────────────────────────────
 */

import {
  Affector, AffectorType, AROA_TAG, ARIV_TAG, ARIB_TAG, TGM,
  type GeneratorChunkData,
} from '../types.js';
import type { Iff } from '../../../iff/iff.js';

/**
 * Recursively enter every form / chunk under the cursor, discarding all
 * contents, and exit. After this returns, the parent cursor sits past
 * every block that was in the active frame.
 *
 * The `Iff` API has `enterAnyForm()` for forms but no `enterAnyChunk()`
 * — chunks are entered via `enterChunk()` with no expected tag, which
 * accepts any chunk tag.
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

export class AffectorRoad extends Affector {
  heightList: number[] = [];
  fixedHeights: boolean = false;
  /** MVP sentinel — set true after `load()` consumes the form. */
  _loaded: boolean = false;

  constructor() {
    super(AROA_TAG, AffectorType.Road);
  }

  /**
   * MVP load — descend into the AROA form, walk every child block
   * discarding bytes, and exit. The carving parameters (point list,
   * width, feather, height list, fixed heights flag) are not retained.
   *
   * Contract matches `AffectorHeightConstant.load` in this module: the
   * caller leaves the cursor on the AROA FORM; we enter it ourselves.
   *
   * Wire shape (per AffectorRoad::load_NNNN in C++):
   *   AROA > <version> > { IHDR, DATA(form) > { <heightData stuff>, DATA(chunk) } }
   */
  load(iff: Iff): void {
    iff.enterForm('AROA');
    walkAndDiscard(iff);
    iff.exitForm('AROA');
    this._loaded = true;
  }

  /**
   * MVP affect — mark the cell as carved (NaN) whenever the layer is
   * applying. The real C++ would compute distance-to-polyline + feather
   * + height interpolation; we just stamp the cell unbuildable.
   */
  affect(
    _worldX: number, _worldZ: number, x: number, z: number,
    amount: number, chunkData: GeneratorChunkData,
  ): void {
    if (amount > 0) {
      chunkData.heightMap.set(x, z, Number.NaN);
    }
  }

  override affectsHeight(): boolean { return true; }
  getAffectedMaps(): number { return TGM.Height; }
}

export class AffectorRiver extends Affector {
  trenchDepth: number = 0;
  heightList: number[] = [];
  /** MVP sentinel — set true after `load()` consumes the form. */
  _loaded: boolean = false;

  constructor() {
    super(ARIV_TAG, AffectorType.River);
  }

  /**
   * MVP load — see AffectorRoad.load above. Wire shape per AffectorRiver
   * versions 0000–0006: ARIV > <version> > { IHDR, DATA(form) }.
   */
  load(iff: Iff): void {
    iff.enterForm('ARIV');
    walkAndDiscard(iff);
    iff.exitForm('ARIV');
    this._loaded = true;
  }

  affect(
    _worldX: number, _worldZ: number, x: number, z: number,
    amount: number, chunkData: GeneratorChunkData,
  ): void {
    if (amount > 0) {
      chunkData.heightMap.set(x, z, Number.NaN);
    }
  }

  override affectsHeight(): boolean { return true; }
  getAffectedMaps(): number { return TGM.Height; }
}

export class AffectorRibbon extends Affector {
  heightList: number[] = [];
  /** MVP sentinel — set true after `load()` consumes the form. */
  _loaded: boolean = false;

  constructor() {
    super(ARIB_TAG, AffectorType.Ribbon);
  }

  /**
   * MVP load — see AffectorRoad.load above. Wire shape per AffectorRibbon
   * versions 0000–0005: ARIB > <version> > { IHDR, DATA(form) }.
   */
  load(iff: Iff): void {
    iff.enterForm('ARIB');
    walkAndDiscard(iff);
    iff.exitForm('ARIB');
    this._loaded = true;
  }

  /**
   * MVP affect — note that the real C++ `AffectorRibbon::affectsHeight()`
   * returns false (ribbons paint shaders, not heights). We deliberately
   * treat them as height-carving for the flat-finder: ribbons are
   * waterways, and we don't want to recommend a build site over one.
   */
  affect(
    _worldX: number, _worldZ: number, x: number, z: number,
    amount: number, chunkData: GeneratorChunkData,
  ): void {
    if (amount > 0) {
      chunkData.heightMap.set(x, z, Number.NaN);
    }
  }

  override affectsHeight(): boolean { return true; }
  getAffectedMaps(): number { return TGM.Height; }
}
