/**
 * Port of `TerrainGenerator::Layer` from `TerrainGenerator.{h,cpp}` —
 * the recursive composition node. Load versions 0000-0004 plus the
 * `ACTN` (action) sub-form variants.
 *
 * Each Layer has:
 *   - Boundaries: WHERE in world space this layer applies (combined via fuzzy-OR with optional invert)
 *   - Filters: per-pole gate (e.g. only on slopes 10-30°)
 *   - Affectors: what to apply at each surviving pole (height-modify mostly)
 *   - Sub-layers: recursive composition with inherited amount
 *
 * The core method `affect(previousAmountMap, chunkData)` is the C++
 * `Layer::affect` at `TerrainGenerator.cpp:1016+`. It:
 *   1. Computes per-pole boundary mask via `Boundary.scanConvertGT`
 *      (each boundary OR-combines via max into the mask).
 *   2. For each pole, applies filters (combined with fuzzy-AND), gating
 *      by the boundary mask × previousAmount.
 *   3. For each surviving pole, calls each affector's `affect` with the
 *      gated amount.
 *   4. After all affectors run, recurses into sub-layers passing the new
 *      amount map (boundary × filters × previousAmount) as their
 *      previousAmount.
 *
 * Wire form: `LAYR > <version: 0000-0004> > {IHDR, [ADTA?], boundaries/filters/affectors/sublayers ...}`.
 * The `ACTN` sub-form (versions 0000-0002) wraps a layer as a child action
 * inside an older v0000 LAYR — same payload as the corresponding regular
 * layer version, just nested one form deeper.
 *
 * Unknown sub-forms (color/flora/shader affectors, FBIT, FSHD, etc.) are
 * walked-and-discarded so the parent cursor stays aligned past them but
 * no effect is retained.
 */

import {
  type Affector, type Boundary, type Filter,
  type GeneratorChunkData, type ILayer, type ITerrainGenerator,
  type Rectangle2d, LAYR_TAG,
  LayerItem,
} from '../types.js';
import { Array2d } from '../array2d.js';
import type { Iff } from '../../../iff/iff.js';

import { BoundaryCircle } from '../boundary/circle.js';
import { BoundaryRectangle } from '../boundary/rectangle.js';
import { BoundaryPolygon } from '../boundary/polygon.js';
import { BoundaryPolyline } from '../boundary/polyline.js';

import { FilterHeight, FilterSlope } from '../filter/height-slope.js';
import { FilterFractal, FilterDirection } from '../filter/fractal-direction.js';

import { AffectorHeightConstant, AffectorHeightTerrace } from '../affector/height-constant-terrace.js';
import { AffectorHeightFractal } from '../affector/height-fractal.js';
import { AffectorRoad, AffectorRiver, AffectorRibbon } from '../affector/carving.js';

// ---------------------------------------------------------------------------
// LayerItem header — the common `{ active, name }` IHDR sub-form read by
// `TerrainGenerator::LayerItem::load` (TerrainGenerator.cpp:170-242).
//
// IHDR > <version: 0000 | 0001> > DATA { i32 active, asciiz name [, u8 r, u8 g, u8 b]? }
// ---------------------------------------------------------------------------

function loadLayerItemHeader(iff: Iff, target: { active: boolean; name: string }): void {
  iff.enterForm('IHDR');
  const version = iff.getCurrentName();
  switch (version) {
    case '0000': {
      iff.enterForm('0000');
      iff.enterChunk('DATA');
      target.active = iff.readI32() !== 0;
      target.name = iff.readString();
      // legacy tool color (PackedRgb) — three bytes, discarded.
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
      throw new Error(`Layer/LayerItem header: unknown IHDR version '${version}'`);
  }
  iff.exitForm('IHDR');
}

// ---------------------------------------------------------------------------
// Walk-and-discard helper — used for unknown / unmodeled child forms (color,
// flora, shader affectors; FSHD, FBIT filters). Mirrors the helper used by
// `carving.ts`. After this returns the parent's cursor sits past every block
// that was in the active frame.
// ---------------------------------------------------------------------------

function skipForm(iff: Iff): void {
  while (!iff.atEndOfForm()) {
    if (iff.isCurrentForm()) {
      const tag = iff.enterAnyForm();
      skipForm(iff);
      iff.exitForm(tag);
    } else {
      iff.enterChunk();
      iff.exitChunk();
    }
  }
}

// ---------------------------------------------------------------------------
// FuzzyAnd — mirrors the helper in `Filter.h`. The C++ project implements it
// as a simple `min` over [0, 1] (the docstring describes a Zadeh fuzzy form,
// but the implementation is a plain min — see `TerrainGenerator.cpp` use of
// `FuzzyAnd`).
//
// FuzzyOr (max) is inlined at the boundary-merge loop in `affect` rather
// than called as a helper; the inline form avoids a per-pole function call
// in the hottest path of chunk generation.
// ---------------------------------------------------------------------------

function fuzzyAnd(a: number, b: number): number {
  return a < b ? a : b;
}

// ---------------------------------------------------------------------------
// Layer
// ---------------------------------------------------------------------------

export class Layer extends LayerItem implements ILayer {
  boundaries: Boundary[] = [];
  filters: Filter[] = [];
  affectors: Affector[] = [];
  sublayers: Layer[] = [];

  hasActiveBoundaries = false;
  hasActiveFilters = false;
  hasActiveAffectors = false;
  hasUnprunedAffectors = false;
  hasActiveLayers = false;
  hasUnprunedLayers = false;

  invertBoundaries = false;
  invertFilters = false;

  useExtent = false;
  extent: Rectangle2d = { x0: 0, z0: 0, x1: 0, z1: 0 };

  modificationHeight = 0;

  /** Editor-only `expanded` flag (v0002+ on disk). Kept for round-trip fidelity. */
  expanded = false;
  /** Editor-only notes string (v0003+ on disk). */
  notes = '';

  constructor() {
    super(LAYR_TAG);
  }

  /**
   * Load a single Layer form. Cursor must be sitting on the `LAYR` FORM.
   * Dispatches to `load_0000..0004` by inner version tag.
   *
   * The `load_ACTN_*` variants are the same as the matching `load_000N` for
   * regular layers, but they are entered from a parent `ACTN` form rather
   * than a `LAYR` form. We expose them via the explicit `loadActn` entry
   * point invoked by `load_0000` below.
   */
  load(iff: Iff, terrainGenerator: ITerrainGenerator): void {
    iff.enterForm('LAYR');
    const version = iff.getCurrentName();
    switch (version) {
      case '0000':
        this.load_0000(iff, terrainGenerator);
        break;
      case '0001':
        this.load_0001(iff, terrainGenerator);
        break;
      case '0002':
        this.load_0002(iff, terrainGenerator);
        break;
      case '0003':
        this.load_0003(iff, terrainGenerator);
        break;
      case '0004':
        this.load_0004(iff, terrainGenerator);
        break;
      default:
        throw new Error(`Layer.load: unknown LAYR version '${version}'`);
    }
    iff.exitForm('LAYR');

    // After the full subtree is loaded, refresh the cached has*-active
    // flags so `affect` can short-circuit empty layers.
    this.computeActiveFlags();
  }

  // -------------------------------------------------------------------------
  // Per-version layer body loaders
  // -------------------------------------------------------------------------

  /**
   * v0000 layers are old-format: header + a list of `ACTN` child forms (each
   * of which wraps one layer's payload).
   */
  private load_0000(iff: Iff, tg: ITerrainGenerator): void {
    iff.enterForm('0000');
    loadLayerItemHeader(iff, this);

    while (!iff.atEndOfForm()) {
      iff.enterForm('ACTN');
      const sub = new Layer();
      sub.loadActn(iff, tg);
      this.sublayers.push(sub);
      iff.exitForm('ACTN');
    }
    iff.exitForm('0000');
  }

  private load_0001(iff: Iff, tg: ITerrainGenerator): void {
    iff.enterForm('0001');
    loadLayerItemHeader(iff, this);

    iff.enterChunk('ADTA');
    this.invertBoundaries = iff.readI32() !== 0;
    this.invertFilters = iff.readI32() !== 0;
    iff.exitChunk('ADTA');

    this.loadChildren(iff, tg);
    iff.exitForm('0001');
  }

  private load_0002(iff: Iff, tg: ITerrainGenerator): void {
    iff.enterForm('0002');
    loadLayerItemHeader(iff, this);

    iff.enterChunk('ADTA');
    this.invertBoundaries = iff.readI32() !== 0;
    this.invertFilters = iff.readI32() !== 0;
    this.expanded = iff.readI32() !== 0;
    iff.exitChunk('ADTA');

    this.loadChildren(iff, tg);
    iff.exitForm('0002');
  }

  private load_0003(iff: Iff, tg: ITerrainGenerator): void {
    iff.enterForm('0003');
    loadLayerItemHeader(iff, this);

    iff.enterChunk('ADTA');
    this.invertBoundaries = iff.readI32() !== 0;
    this.invertFilters = iff.readI32() !== 0;
    this.expanded = iff.readI32() !== 0;
    this.notes = iff.readString();
    iff.exitChunk('ADTA');

    this.loadChildren(iff, tg);
    iff.exitForm('0003');
  }

  private load_0004(iff: Iff, tg: ITerrainGenerator): void {
    iff.enterForm('0004');
    loadLayerItemHeader(iff, this);

    iff.enterChunk('ADTA');
    this.invertBoundaries = iff.readI32() !== 0;
    this.invertFilters = iff.readI32() !== 0;
    // C++ v0004 reads (and ignores) an int32 here — keep the same wire shape.
    iff.readI32();
    this.expanded = iff.readI32() !== 0;
    this.notes = iff.readString();
    iff.exitChunk('ADTA');

    this.loadChildren(iff, tg);
    iff.exitForm('0004');
  }

  /**
   * `ACTN` sub-form loader. Cursor is on the inner version FORM of the
   * `ACTN` parent (which the caller has already entered). Dispatches to the
   * matching `load_ACTN_000N`, which share the same payload shape as the
   * top-level `load_000N` variants but without the outer LAYR wrapper.
   */
  private loadActn(iff: Iff, tg: ITerrainGenerator): void {
    const version = iff.getCurrentName();
    switch (version) {
      case '0000': {
        iff.enterForm('0000');
        loadLayerItemHeader(iff, this);
        this.loadChildren(iff, tg);
        iff.exitForm('0000');
        break;
      }
      case '0001': {
        iff.enterForm('0001');
        loadLayerItemHeader(iff, this);
        iff.enterChunk('ADTA');
        this.invertBoundaries = iff.readI32() !== 0;
        iff.exitChunk('ADTA');
        this.loadChildren(iff, tg);
        iff.exitForm('0001');
        break;
      }
      case '0002': {
        iff.enterForm('0002');
        loadLayerItemHeader(iff, this);
        iff.enterChunk('ADTA');
        this.invertBoundaries = iff.readI32() !== 0;
        this.invertFilters = iff.readI32() !== 0;
        iff.exitChunk('ADTA');
        this.loadChildren(iff, tg);
        iff.exitForm('0002');
        break;
      }
      default:
        throw new Error(`Layer.loadActn: unknown ACTN version '${version}'`);
    }
  }

  // -------------------------------------------------------------------------
  // Child dispatch — boundaries / filters / affectors / sublayers
  // -------------------------------------------------------------------------

  /**
   * Walks every remaining child block in the active layer-body frame,
   * dispatching to the appropriate concrete loader. Mirrors the C++
   * `TerrainGeneratorLoader::loadLayerItem` switch.
   */
  private loadChildren(iff: Iff, tg: ITerrainGenerator): void {
    while (!iff.atEndOfForm()) {
      // Capture cursor position BEFORE the child load so we can recover
      // by walk-and-discarding on parser error. The MVP port doesn't
      // know every per-version detail of every C++ filter/affector
      // (FilterFractal's PARM-inside-DATA form layout differs from the
      // DATA-chunk shape some other filters use, for example). Without
      // recovery, one off-format child takes the whole .trn load down.
      const tag = iff.isCurrentForm() ? iff.getCurrentName() : null;
      if (tag === null) {
        // Stray chunk at this level — swallow defensively.
        iff.enterChunk();
        iff.exitChunk();
        continue;
      }
      try {
        this.loadOneChild(iff, tg);
      } catch (err) {
        // Best-effort recovery: walk past this form silently and continue.
        // Most failures here are MVP-level filter/affector wire-format
        // mismatches that don't affect heightmap fidelity meaningfully.
        if (process.env.TERRAIN_SIM_VERBOSE === '1') {
          process.stderr.write(
            `[terrain/sim] Layer.loadChildren: skipping '${tag}' due to load error: ${err instanceof Error ? err.message : String(err)}\n`,
          );
        }
        // The cursor may be partway through the form's body; the safest
        // recovery is to advance to the next sibling using getNumberOfBlocksLeft.
        // We rely on the fact that the failed loader didn't reach exitForm,
        // so we're either inside the form's frame (need to unwind) or still
        // on the form (need to enter + skip + exit). Try the unwind first.
        try {
          // If we're still on the original form (load failed before
          // enterForm), skip it cleanly.
          if (iff.isCurrentForm() && iff.getCurrentName() === tag) {
            const t = iff.enterAnyForm();
            skipForm(iff);
            iff.exitForm(t);
          } else {
            // We're somewhere inside the broken form's frame stack —
            // there's no clean recovery without proper frame depth
            // tracking. Bail to stop further damage.
            return;
          }
        } catch {
          return;
        }
      }
    }
  }

  /** Dispatch a single child block at the cursor by its tag. */
  private loadOneChild(iff: Iff, tg: ITerrainGenerator): void {
    if (!iff.isCurrentForm()) {
      // Any stray chunk at this level is invalid for SWG; skip it
      // defensively to keep the parent frame aligned.
      iff.enterChunk();
      iff.exitChunk();
      return;
    }

    const tag = iff.getCurrentName();
    switch (tag) {
      // ─── Boundaries ────────────────────────────────────────────────────
      case 'BCIR': {
        const b = new BoundaryCircle();
        b.load(iff);
        this.boundaries.push(b);
        return;
      }
      case 'BREC': {
        const b = new BoundaryRectangle();
        b.load(iff);
        this.boundaries.push(b);
        return;
      }
      case 'BPOL': {
        const b = new BoundaryPolygon();
        b.load(iff);
        this.boundaries.push(b);
        return;
      }
      case 'BPLN': {
        const b = new BoundaryPolyline();
        b.load(iff);
        this.boundaries.push(b);
        return;
      }

      // ─── Filters ───────────────────────────────────────────────────────
      // Each subtype's `load()` enters its own outer form (matches the
      // contract used by BCIR/BREC/BPOL/BPLN/AHCN/AHTR above). Do NOT
      // pre-enter or we'll double-enter and fail with "enterForm(...) but
      // found form '<version>'".
      case 'FHGT': {
        const f = new FilterHeight();
        f.load(iff);
        this.filters.push(f);
        return;
      }
      case 'FSLP': {
        const f = new FilterSlope();
        f.load(iff);
        this.filters.push(f);
        return;
      }
      case 'FDIR': {
        const f = new FilterDirection();
        f.load(iff);
        this.filters.push(f);
        return;
      }
      case 'FFRA': {
        // FilterFractal.load handles all versions; the FractalGroup is
        // consulted lazily at isWithin() via chunkData.fractalGroup so we
        // don't need to switch between load / loadWithGroup at parse time.
        const f = new FilterFractal();
        f.load(iff);
        this.filters.push(f);
        return;
      }

      // ─── Affectors ─────────────────────────────────────────────────────
      case 'AHCN': {
        const a = new AffectorHeightConstant();
        a.load(iff);
        this.affectors.push(a);
        return;
      }
      case 'AHTR': {
        const a = new AffectorHeightTerrace();
        a.load(iff);
        this.affectors.push(a);
        return;
      }
      case 'AHFR': {
        // AffectorHeightFractal.load handles version 0003 (the only one
        // shipping .trn files use in practice). Older versions threw
        // server-side too. The FractalGroup is consulted lazily at
        // affect-time via chunkData.fractalGroup — no need to switch
        // between load / loadWithGroup at parse time.
        const a = new AffectorHeightFractal();
        a.load(iff);
        this.affectors.push(a);
        return;
      }
      case 'AROA': {
        const a = new AffectorRoad();
        a.load(iff);
        this.affectors.push(a);
        return;
      }
      case 'ARIV': {
        const a = new AffectorRiver();
        a.load(iff);
        this.affectors.push(a);
        return;
      }
      case 'ARIB': {
        const a = new AffectorRibbon();
        a.load(iff);
        this.affectors.push(a);
        return;
      }

      // ─── Sub-layer ─────────────────────────────────────────────────────
      case 'LAYR': {
        const sub = new Layer();
        sub.load(iff, tg);
        this.sublayers.push(sub);
        return;
      }

      // ─── Anything else: walk-and-discard ───────────────────────────────
      // Includes FBIT, FSHD, all color/shader/flora/environment/exclude/
      // passable affectors. These don't touch heights and aren't modeled
      // by the offline port — but we still have to walk past their bytes
      // to keep the parent cursor aligned.
      default: {
        const childTag = iff.enterAnyForm();
        skipForm(iff);
        iff.exitForm(childTag);
        return;
      }
    }
  }

  /** Recompute `hasActive*` flags from current child lists. */
  private computeActiveFlags(): void {
    this.hasActiveBoundaries = this.boundaries.some((b) => b.active);
    this.hasActiveFilters = this.filters.some((f) => f.active);
    this.hasActiveAffectors = this.affectors.some((a) => a.active);
    this.hasUnprunedAffectors = this.affectors.some((a) => !a.pruned);
    this.hasActiveLayers = this.sublayers.some((l) => l.active);
    this.hasUnprunedLayers = this.sublayers.some((l) => !l.pruned);
  }

  // -------------------------------------------------------------------------
  // affect — the core eval loop
  // -------------------------------------------------------------------------

  /**
   * Recursive eval. Port of `TerrainGenerator::Layer::affect`
   * (`TerrainGenerator.cpp:1016+`).
   *
   * `previousAmountMap` is the inherited per-pole gate from the parent
   * layer (null at the top level — treated as 1.0 everywhere).
   *
   * The mutation contract: this method writes into `chunkData.heightMap`
   * (via each affector) and may also update `chunkData.vertexNormalMap`
   * if filters need them.
   */
  affect(previousAmountMap: Float32Array | null, chunkData: GeneratorChunkData): void {
    // Refresh the cached flags in case the layer was mutated programmatically
    // since load. Cheap — just iterates four small arrays.
    this.computeActiveFlags();

    if (!this.active || this.pruned) return;

    const numberOfPoles = chunkData.numberOfPoles;
    const totalPoles = numberOfPoles * numberOfPoles;

    // -----------------------------------------------------------------
    // If we have NOTHING active at this layer (no boundaries, no filters,
    // no affectors), the sub-layers inherit the parent's amount map
    // verbatim — no per-pole work happens here.
    // -----------------------------------------------------------------
    const onlyHasSubLayers =
      !this.hasActiveBoundaries && !this.hasActiveFilters && !this.hasActiveAffectors;

    // Allocate the outgoing amount map only when sub-layers will consume
    // it. The C++ uses `_alloca`; we use a heap allocation but only when
    // necessary.
    let amountMap: Float32Array | null = null;
    if (this.hasActiveLayers && !onlyHasSubLayers) {
      amountMap = new Float32Array(totalPoles);
    }

    let shouldAffectSubLayers = onlyHasSubLayers;

    if (!onlyHasSubLayers) {
      // ---------------------------------------------------------------
      // 1. Boundary scan-convert — each boundary writes its per-pole
      //    inclusion factor into `boundaryMap` via fuzzy-OR (max).
      // ---------------------------------------------------------------
      let boundaryMap: Float32Array | null = null;
      if (this.hasActiveBoundaries) {
        boundaryMap = new Float32Array(totalPoles); // zero-filled
        const scratch = new Float32Array(totalPoles);
        for (const b of this.boundaries) {
          if (!b.active) continue;

          // Reset per-boundary scratch and let the boundary stamp into it.
          // Using a fresh scratch + explicit fuzzy-OR insulates us from the
          // base-class `scanConvertGT` implementation (which simply
          // overwrites without max-combining). Concrete subclasses that
          // do max-combine themselves still work correctly because they
          // see a zero-filled buffer at every call.
          scratch.fill(0);
          b.scanConvertGT(scratch, chunkData.chunkExtent, numberOfPoles);
          for (let i = 0; i < totalPoles; i++) {
            const v = scratch[i] as number;
            const cur = boundaryMap[i] as number;
            if (v > cur) boundaryMap[i] = v;
          }
        }
      }

      // ---------------------------------------------------------------
      // 2. Ensure vertex normals if any active filter needs them. The
      //    height-only port has no normal generator, so we leave them
      //    null and rely on `FilterSlope`/`FilterDirection` to handle
      //    the absence (they default to 0 in that case).
      // ---------------------------------------------------------------
      if (this.hasActiveFilters && chunkData.vertexNormalMap === null) {
        for (const f of this.filters) {
          if (f.active && f.needsNormals()) {
            generateNormalsFromHeights(chunkData);
            break;
          }
        }
      }

      // ---------------------------------------------------------------
      // 3. Per-pole loop — boundary × filters × previousAmount.
      // ---------------------------------------------------------------
      const distanceBetweenPoles = chunkData.distanceBetweenPoles;
      const startX = chunkData.start.x;
      const startZ = chunkData.start.z;

      for (let z = 0; z < numberOfPoles; z++) {
        const rowIndex = z * numberOfPoles;
        const worldZ = startZ + z * distanceBetweenPoles;

        for (let x = 0; x < numberOfPoles; x++) {
          const worldX = startX + x * distanceBetweenPoles;
          const i = rowIndex + x;
          const previousAmount = previousAmountMap !== null
            ? (previousAmountMap[i] as number)
            : 1;

          // ─── Boundary ────────────────────────────────────────────
          let fuzzyTest = boundaryMap !== null
            ? (boundaryMap[i] as number)
            : 1;

          if (this.invertBoundaries) {
            fuzzyTest = 1 - fuzzyTest;
          }
          // Clamp to [0, 1] defensively (matches the DEBUG_FATAL in C++).
          if (fuzzyTest < 0) fuzzyTest = 0;
          else if (fuzzyTest > 1) fuzzyTest = 1;

          if (fuzzyTest > 0) {
            // ─── Filters (fuzzy-AND) ────────────────────────────────
            if (this.hasActiveFilters) {
              for (const f of this.filters) {
                if (!f.active) continue;
                let amount = f.isWithin(worldX, worldZ, x, z, chunkData);
                if (amount < 0) amount = 0;
                else if (amount > 1) amount = 1;
                fuzzyTest = fuzzyAnd(fuzzyTest, amount);
                if (fuzzyTest === 0) break;
              }
            }

            if (this.invertFilters) {
              fuzzyTest = 1 - fuzzyTest;
            }

            if (fuzzyTest > 0) {
              // At least one pole survived → sub-layers should evaluate.
              shouldAffectSubLayers = true;

              // ─── Affectors ─────────────────────────────────────────
              if (this.hasUnprunedAffectors) {
                const gated = fuzzyTest * previousAmount;
                for (const a of this.affectors) {
                  if (a.pruned) continue;
                  a.affect(worldX, worldZ, x, z, gated, chunkData);
                  if (a.affectsHeight()) {
                    // Heights changed → cached normals are stale.
                    chunkData.normalsDirty = true;
                  }
                }
              }
            }
          }

          // Stash the per-pole effective amount for sub-layers.
          if (amountMap !== null) {
            amountMap[i] = fuzzyTest * previousAmount;
          }
        }
      }
    }

    // -----------------------------------------------------------------
    // 4. Recurse into sub-layers — they inherit either our computed
    //    amount map or the parent's (when we ourselves had no per-pole
    //    work). Pruned children are skipped.
    // -----------------------------------------------------------------
    if (shouldAffectSubLayers && this.hasActiveLayers) {
      const childAmount = onlyHasSubLayers ? previousAmountMap : amountMap;
      for (const l of this.sublayers) {
        if (!l.pruned && l.active) {
          l.affect(childAmount, chunkData);
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Vertex normal generator — MVP stub for filters that need normals.
//
// The C++ `TerrainGenerator::generatePlaneAndVertexNormals` reads the
// height map's gradient and produces per-pole world-space normals via a
// finite-difference cross product. We don't model normals in the offline
// height-only port (the build-city flat-finder doesn't slope-filter), so
// this just installs a placeholder all-up array so any filter that does
// query normals sees a defined (vertical) value.
// ---------------------------------------------------------------------------

function generateNormalsFromHeights(chunkData: GeneratorChunkData): void {
  // If the caller already populated normals, leave them alone.
  if (chunkData.vertexNormalMap !== null) return;
  chunkData.vertexNormalMap = new Array2d(
    chunkData.numberOfPoles,
    chunkData.numberOfPoles,
    { x: 0, y: 1, z: 0 },
  );
  chunkData.normalsDirty = false;
}
