/**
 * Port of `TerrainGenerator` from `sharedTerrain/.../TerrainGenerator.{h,cpp}`.
 *
 * The root coordinator: owns the FractalGroup + top-level Layer list,
 * loads the `TGEN` IFF form, and drives chunk generation via
 * `generateChunk(GeneratorChunkData)`.
 *
 * IFF form: `TGEN > 0000 > {SGRP, FGRP, RGRP, EGRP, MGRP, LYRS}` where
 * SGRP/FGRP/RGRP/EGRP/BGRP are SKIPPED for the height-only port. Only MGRP
 * (FractalGroup) and LYRS (layer list) are decoded.
 *
 * `generateChunk` initializes maps (heights = 0), then calls `affect` which
 * walks every top-level layer and invokes `Layer.affect(null, chunkData)`.
 * Each layer mutates `chunkData.heightMap` in place via its affectors. The
 * `null` previousAmountMap is our convention for "treat every pole as 1.0";
 * in the C++ source an explicit float array of 1.0f is passed.
 */

import type { GeneratorChunkData, ITerrainGenerator } from '../types.js';
import { Iff } from '../../../iff/iff.js';
import { FractalGroup } from './fractal-group.js';
import { Layer } from './layer.js';
import { TGEN_TAG, MGRP_TAG, LYRS_TAG, LAYR_TAG } from '../types.js';

// Convert the imported tag ints to their 4-character string form once so we
// can compare them against `Iff.getCurrentName()` (which returns a string)
// without re-decoding per child block. Suppresses "imported but unused"
// warnings while keeping the spec's import contract.
const TGEN_NAME = decodeTag(TGEN_TAG);
const MGRP_NAME = decodeTag(MGRP_TAG);
const LYRS_NAME = decodeTag(LYRS_TAG);
const LAYR_NAME = decodeTag(LAYR_TAG);

function decodeTag(tagInt: number): string {
  // Mirror of `iff-tag.ts::tagToString` — inlined locally to avoid importing
  // outside the helper set the task spec specifies. All four bytes of the
  // input are printable ASCII for these tag constants, so we skip the
  // non-printable substitution the public helper does.
  const a = String.fromCharCode((tagInt >>> 24) & 0xff);
  const b = String.fromCharCode((tagInt >>> 16) & 0xff);
  const c = String.fromCharCode((tagInt >>> 8) & 0xff);
  const d = String.fromCharCode(tagInt & 0xff);
  return `${a}${b}${c}${d}`;
}

/**
 * Walk past any FORM/chunk at the cursor without interpreting its contents.
 * Used for the SGRP/FGRP/RGRP/EGRP/BGRP groups that the height-only port
 * skips wholesale.
 *
 * Recurses into nested FORMs so we exit at exactly the right depth — the
 * shipping .trn files have multi-level group containers (e.g.
 * `SGRP > 0000 > SFAM*` with `SFAM` themselves being forms).
 */
function walkAndDiscard(iff: Iff): void {
  while (!iff.atEndOfForm()) {
    if (iff.isCurrentForm()) {
      const tag = iff.enterAnyForm();
      walkAndDiscard(iff);
      iff.exitForm(tag);
    } else {
      // Chunk: enter, read nothing, exit. The cursor advances past the
      // chunk's body via the exitChunk back-patch.
      iff.enterChunk();
      iff.exitChunk();
    }
  }
}

export class TerrainGenerator implements ITerrainGenerator {
  fractalGroup: FractalGroup = new FractalGroup();
  layers: Layer[] = [];

  /**
   * Load a TGEN form. Cursor must be sitting on the TGEN FORM.
   *
   * Port of `TerrainGenerator::load` (TerrainGenerator.cpp:2136) +
   * `load_0000` (TerrainGenerator.cpp:2174). Only `MGRP` (FractalGroup)
   * and `LYRS` (top-level layer list) are interpreted; everything else
   * (SGRP/FGRP/RGRP/EGRP/BGRP shader/flora/radial/environment/bitmap
   * groups) is walked-and-discarded because the height-only port has no
   * use for them.
   */
  load(iff: Iff): void {
    iff.enterForm(TGEN_NAME);

    // The cpp dispatches on the inner version tag; only TAG_0000 is known.
    const version = iff.enterAnyForm();
    if (version !== '0000') {
      throw new Error(`TerrainGenerator.load: unknown TGEN version '${version}'`);
    }

    // Walk children: pick up MGRP + LYRS; skip everything else.
    while (!iff.atEndOfForm()) {
      // Every immediate child of `TGEN > 0000` is a FORM in the shipping
      // .trn files (each is a *group* container). If a chunk somehow
      // appears here we still want to discard it cleanly.
      if (!iff.isCurrentForm()) {
        iff.enterChunk();
        iff.exitChunk();
        continue;
      }

      const name = iff.getCurrentName();
      if (name === MGRP_NAME) {
        // Some shipping .trn files (e.g. Naboo) contain TWO MGRP forms at
        // the TGEN/0000 level — the first holds the real fractal-family
        // registry (~39 families on Naboo); the second is an empty
        // placeholder that, if we ran `fractalGroup.load(iff)` on it, would
        // reset our families list back to empty. So only load the first
        // MGRP we see; walk-and-discard any subsequent ones.
        if (this.fractalGroup.getNumberOfFamilies() === 0) {
          this.fractalGroup.load(iff);
        } else {
          const skipTag = iff.enterAnyForm();
          walkAndDiscard(iff);
          iff.exitForm(skipTag);
        }
      } else if (name === LYRS_NAME) {
        iff.enterForm(LYRS_NAME);
        // Each child of LYRS is a LAYR form. We loop on `atEndOfForm`
        // rather than `getNumberOfBlocksLeft` to mirror the FractalGroup
        // load loop and stay robust to padding / unknown sibling blocks.
        while (!iff.atEndOfForm()) {
          // Per the C++ source the layer load expects to be sitting on the
          // LAYR form when `Layer.load` is called. The current-name check
          // is defensive — flag any non-LAYR child loudly.
          const childName = iff.getCurrentName();
          if (childName !== LAYR_NAME) {
            throw new Error(
              `TerrainGenerator.load: expected LAYR inside LYRS but found '${childName}'`,
            );
          }
          const layer = new Layer();
          layer.load(iff, this);
          this.layers.push(layer);
        }
        iff.exitForm(LYRS_NAME);
      } else {
        // Unknown / skipped group (SGRP/FGRP/RGRP/EGRP/BGRP or anything
        // else). Enter, walk-and-discard the body, then exit. The form's
        // inner type tag is captured by `enterAnyForm` so the exit gets
        // the right argument.
        const skippedTag = iff.enterAnyForm();
        walkAndDiscard(iff);
        iff.exitForm(skippedTag);
      }
    }

    iff.exitForm('0000');
    iff.exitForm(TGEN_NAME);
  }

  /**
   * Pre-allocate FractalGroup caches sized to the per-chunk pole grid.
   *
   * Port of the per-family cache prepare loop in
   * `TerrainGenerator::generateChunk` (TerrainGenerator.cpp:1920-1927).
   * The C++ source defers this to first-chunk-generation behind a
   * `m_groupsPrepared` latch; we expose it as a direct method so callers
   * can warm caches up front.
   */
  prepare(numberOfPoles: number): void {
    this.fractalGroup.prepare(numberOfPoles, numberOfPoles);
  }

  /**
   * Fill `chunkData.heightMap` (and optionally normal/vertex maps) by
   * walking every layer in `this.layers` and calling `Layer.affect`.
   *
   * Port of `TerrainGenerator::generateChunk` (TerrainGenerator.cpp:1920)
   * + `TerrainGenerator::affect` (TerrainGenerator.cpp:1820). The
   * shader/flora/color/environment paths are dropped because we do not
   * model those maps; what remains is:
   *
   *   1. Zero the height map.
   *   2. Compute the chunk's world-space bounding rectangle.
   *   3. Replace whatever fractal group reference is on chunkData with our
   *      loaded one (so layer affectors / fractal filters resolve families
   *      against the correct registry).
   *   4. Walk every layer and call `affect(null, chunkData)` — `null` is
   *      our convention for "previous amount is 1.0 at every pole", which
   *      matches the all-ones amount map the C++ source allocs on the
   *      stack before the first layer iteration.
   */
  generateChunk(chunkData: GeneratorChunkData): void {
    // Clear the height map first. Other maps (color/shader/flora/...) are
    // intentionally not touched — they are `null` in our subset.
    chunkData.heightMap.fill(0);

    // The C++ source dirty-flags both normal and shader maps before
    // affectors run. We only track `normalsDirty` because the shader path
    // is excised from this port.
    chunkData.normalsDirty = true;

    // Wire the chunk to the generator's fractal group. Fractal affectors /
    // filters look up families via `chunkData.fractalGroup`; for chunks
    // created by callers (who may stub an empty group), we replace it with
    // our loaded one.
    chunkData.fractalGroup = this.fractalGroup;

    // Compute world-space extents from the chunk origin + pole spacing.
    // `numberOfPoles - 1` because there are N-1 gaps between N poles.
    const span = (chunkData.numberOfPoles - 1) * chunkData.distanceBetweenPoles;
    chunkData.chunkExtent = {
      x0: chunkData.start.x,
      z0: chunkData.start.z,
      x1: chunkData.start.x + span,
      z1: chunkData.start.z + span,
    };

    // Run each top-level layer. The previousAmountMap is `null` here —
    // see the class-level doc comment for why.
    for (const layer of this.layers) {
      layer.affect(null, chunkData);
    }
  }
}
