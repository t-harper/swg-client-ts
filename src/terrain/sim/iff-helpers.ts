/**
 * IFF helpers for TRN-file reading — tag constants and a few small
 * conveniences on top of `src/iff/iff.ts`.
 *
 * Every tag below is from `sharedTerrain/.../TerrainGeneratorType.h:18-69`
 * or the relevant XGROUP / sharedFractal headers.
 */

import { tag as iffTag } from '../../iff/iff-tag.js';

/** Convenience: build a 4-char tag like the C++ `TAG(A,B,C,D)` macro. */
export function TAG(a: string): number {
  return iffTag(a);
}

// ─────────────────────────────────────────────────────────────────────────
// Container tags
// ─────────────────────────────────────────────────────────────────────────

export const TGEN_TAG = TAG('TGEN'); // TerrainGenerator root form
export const MGRP_TAG = TAG('MGRP'); // FractalGroup
export const MFRC_TAG = TAG('MFRC'); // MultiFractal
export const MFAM_TAG = TAG('MFAM'); // FractalGroup family
export const LYRS_TAG = TAG('LYRS'); // TerrainGenerator layer list
export const LAYR_TAG = TAG('LAYR'); // Single layer
export const ACTN_TAG = TAG('ACTN'); // Action (sub-form of LAYR for compound load paths)
export const ADTA_TAG = TAG('ADTA'); // Action data chunk
export const IHDR_TAG = TAG('IHDR'); // Item header (LayerItem common fields)
export const DATA_TAG = TAG('DATA'); // Generic data chunk

// ─────────────────────────────────────────────────────────────────────────
// Boundary tags
// ─────────────────────────────────────────────────────────────────────────

export const BCIR_TAG = TAG('BCIR'); // BoundaryCircle
export const BREC_TAG = TAG('BREC'); // BoundaryRectangle
export const BPOL_TAG = TAG('BPOL'); // BoundaryPolygon
export const BPLN_TAG = TAG('BPLN'); // BoundaryPolyline

// ─────────────────────────────────────────────────────────────────────────
// Affector tags — height-relevant subset (full list in TerrainGeneratorType.h)
// ─────────────────────────────────────────────────────────────────────────

export const AHCN_TAG = TAG('AHCN'); // AffectorHeightConstant
export const AHFR_TAG = TAG('AHFR'); // AffectorHeightFractal
export const AHTR_TAG = TAG('AHTR'); // AffectorHeightTerrace
export const AROA_TAG = TAG('AROA'); // AffectorRoad (carves height)
export const ARIV_TAG = TAG('ARIV'); // AffectorRiver (carves height)
export const ARIB_TAG = TAG('ARIB'); // AffectorRibbon (carves height)

// ─────────────────────────────────────────────────────────────────────────
// Filter tags — height-relevant subset
// ─────────────────────────────────────────────────────────────────────────

export const FHGT_TAG = TAG('FHGT'); // FilterHeight
export const FFRA_TAG = TAG('FFRA'); // FilterFractal
export const FSLP_TAG = TAG('FSLP'); // FilterSlope
export const FDIR_TAG = TAG('FDIR'); // FilterDirection
export const FSHD_TAG = TAG('FSHD'); // FilterShader (not height-relevant; tag present for skip logic)
export const FBIT_TAG = TAG('FBIT'); // FilterBitmap   (not height-relevant; tag present for skip logic)

// ─────────────────────────────────────────────────────────────────────────
// Group container tags — only MGRP matters for height; rest are skipped over.
// ─────────────────────────────────────────────────────────────────────────

export const SGRP_TAG = TAG('SGRP'); // ShaderGroup (skip)
export const FGRP_TAG = TAG('FGRP'); // FloraGroup (skip)
export const RGRP_TAG = TAG('RGRP'); // RadialGroup (skip)
export const EGRP_TAG = TAG('EGRP'); // EnvironmentGroup (skip)
export const BGRP_TAG = TAG('BGRP'); // BitmapGroup (skip for now; only needed if FBIT filter is referenced)
