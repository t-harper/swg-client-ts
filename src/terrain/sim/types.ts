/**
 * Shared types and abstract base classes for the SWG procedural terrain
 * port (offline TypeScript implementation of ~/code/swg-main/src/engine/shared/library/sharedTerrain).
 *
 * Every implementation file under `src/terrain/sim/{boundary,filter,affector,fractal,generator}/`
 * imports from this file. **Exported signatures here are frozen** — agents
 * fill in concrete subclasses but do not modify these interfaces.
 *
 * C++ ground truth: `TerrainGenerator.h` (lines 39-573), `TerrainGeneratorType.def`.
 */

// ─────────────────────────────────────────────────────────────────────────
// Enums — verbatim from TerrainGeneratorType.def
// ─────────────────────────────────────────────────────────────────────────

/** Boundary subtype tag — `TGBT_*` in C++. */
export enum BoundaryType {
  Circle = 0,
  Rectangle = 1,
  Polygon = 2,
  Polyline = 3,
}

/** Filter subtype tag — `TGFT_*` in C++. */
export enum FilterType {
  Height = 0,
  Fractal = 1,
  Slope = 2,
  Direction = 3,
  Shader = 4,
  Bitmap = 5,
}

/** Affector subtype tag — `TGAT_*` in C++. */
export enum AffectorType {
  HeightTerrace = 0,
  HeightConstant = 1,
  HeightFractal = 2,
  ColorConstant = 3,
  ColorRampHeight = 4,
  ColorRampFractal = 5,
  ShaderConstant = 6,
  ShaderReplace = 7,
  FloraStaticCollidableConstant = 8,
  FloraStaticNonCollidableConstant = 9,
  FloraDynamicNearConstant = 10,
  FloraDynamicFarConstant = 11,
  Exclude = 12,
  Passable = 13,
  Road = 14,
  River = 15,
  Environment = 16,
  Ribbon = 17,
}

/** Operation applied by an affector against the current cell value — `TGO_*`. */
export enum Operation {
  Replace = 0,
  Add = 1,
  Subtract = 2,
  Multiply = 3,
}

/** Feather function selector — `TGFF_*`. */
export enum FeatherFunction {
  Linear = 0,
  EaseIn = 1,
  EaseOut = 2,
  EaseInOut = 3,
}

/** Water-type tag inside a Boundary's local water table — `TGWT_*`. */
export enum WaterType {
  Invalid = -1,
  Water = 0,
  Lava = 1,
}

/** MultiFractal octave-combination rule — matches `MultiFractal::CombinationRule` in C++. */
export enum CombinationRule {
  Add = 0,
  Multiply = 1,
  Crest = 2,
  Turbulence = 3,
  CrestClamp = 4,
  TurbulenceClamp = 5,
}

/** Bit flags identifying which chunk maps an affector touches — `TGM_*`. */
export const TGM = {
  Height: 1 << 0,
  Color: 1 << 1,
  Shader: 1 << 2,
  FloraStaticCollidable: 1 << 3,
  FloraStaticNonCollidable: 1 << 4,
  FloraDynamicNear: 1 << 5,
  FloraDynamicFar: 1 << 6,
  Environment: 1 << 7,
  VertexPosition: 1 << 8,
  VertexNormal: 1 << 9,
  Exclude: 1 << 10,
  Passable: 1 << 11,
  All: 0xffffffff,
} as const;

// ─────────────────────────────────────────────────────────────────────────
// Math types — minimal float32-style structures (use Math.fround at boundaries
// when bit-exact match to the C++ float pipeline matters).
// ─────────────────────────────────────────────────────────────────────────

/** Mutable 3D vector — matches C++ `Vector` (x, y, z all float32). */
export interface Vector3 {
  x: number;
  y: number;
  z: number;
}

/** Immutable 2D point — matches C++ `Vector2d`. */
export interface Vector2d {
  x: number;
  z: number;
}

/** Axis-aligned 2D rectangle in world space — matches C++ `Rectangle2d`. */
export interface Rectangle2d {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
}

/** Packed RGB color (one byte per channel) — matches C++ `PackedRgb`. */
export interface PackedRgb {
  r: number;
  g: number;
  b: number;
}

// ─────────────────────────────────────────────────────────────────────────
// Foundation classes the agents may use directly.
// ─────────────────────────────────────────────────────────────────────────

export { Array2d } from './array2d.js';
export { Feather } from './feather.js';
export { RandomGenerator } from './random.js';
export {
  TAG, TGEN_TAG, MGRP_TAG, MFRC_TAG, MFAM_TAG, LYRS_TAG, LAYR_TAG,
  ACTN_TAG, ADTA_TAG, IHDR_TAG, DATA_TAG,
  BCIR_TAG, BREC_TAG, BPOL_TAG, BPLN_TAG,
  AHCN_TAG, AHFR_TAG, AHTR_TAG,
  AROA_TAG, ARIV_TAG, ARIB_TAG,
  FHGT_TAG, FFRA_TAG, FSLP_TAG, FDIR_TAG,
  FSHD_TAG, FBIT_TAG,
  SGRP_TAG, FGRP_TAG, RGRP_TAG, EGRP_TAG, BGRP_TAG,
} from './iff-helpers.js';

// ─────────────────────────────────────────────────────────────────────────
// Cross-module interfaces — what each agent's outputs LOOK LIKE to others.
// Implementations live in their own files; consumers only import the interface.
// ─────────────────────────────────────────────────────────────────────────

/**
 * The Perlin gradient noise core (port of `MultiFractal::NoiseGenerator`,
 * see `sharedFractal/.../MultiFractal.h:149-184`). Returns values in
 * [-1, 1].
 */
export interface INoiseGenerator {
  /** Re-seed the permutation + gradient tables from `seed`. */
  init(seed: number): void;
  /** 1D noise, returns [-1, 1]. */
  getValue1(x: number): number;
  /** 2D noise, returns [-1, 1]. */
  getValue2(x: number, y: number): number;
}

/**
 * MultiFractal — wraps a NoiseGenerator with octave + bias/gain composition.
 * Always returns [0, 1] for the public getValue paths.
 *
 * Port of `MultiFractal` (`sharedFractal/.../MultiFractal.h`).
 */
export interface IMultiFractal {
  /** Pre-allocate the value-cache grid (cx × cy entries). Idempotent. */
  allocateCache(cx: number, cy: number): void;

  /** 1D evaluation, returns [0, 1]. */
  getValue1(x: number): number;
  /** 2D evaluation, returns [0, 1]. */
  getValue2(x: number, y: number): number;
  /**
   * Cached 2D evaluation — same numeric result as `getValue2` but consults
   * a pre-allocated grid (`allocateCache(cx, cy)`) keyed by `(cx, cy)`.
   */
  getValueCache(x: number, y: number, cx: number, cy: number): number;

  getSeed(): number;
  getScaleX(): number;
  getScaleY(): number;
  getOffsetX(): number;
  getOffsetY(): number;
  getNumberOfOctaves(): number;
  getFrequency(): number;
  getAmplitude(): number;
  getCombinationRule(): CombinationRule;
  getUseBias(): boolean;
  getBias(): number;
  getUseGain(): boolean;
  getGain(): number;
  getUseSin(): boolean;

  setSeed(seed: number): void;
  setScale(x: number, y: number): void;
  setOffset(x: number, y: number): void;
  setNumberOfOctaves(n: number): void;
  setFrequency(f: number): void;
  setAmplitude(a: number): void;
  setCombinationRule(r: CombinationRule): void;
  setBias(useBias: boolean, bias: number): void;
  setGain(useGain: boolean, gain: number): void;
  setUseSin(use: boolean): void;
}

/**
 * Named-family registry of MultiFractals — port of `FractalGroup`
 * (`sharedTerrain/.../FractalGroup.h`).
 *
 * Loaded from `MGRP > 0000 > MFAM* > {DATA(id, name), MFRC}`.
 */
export interface IFractalGroup {
  getFamilyMultiFractal(familyId: number): IMultiFractal | null;
  getFamilyName(familyId: number): string | null;
  getNumberOfFamilies(): number;
  getFamilyId(index: number): number;
  hasFamily(id: number): boolean;
}

// ─────────────────────────────────────────────────────────────────────────
// GeneratorChunkData — the per-chunk input/output bundle passed through the
// layer graph. Port of `TerrainGenerator::GeneratorChunkData`
// (`TerrainGenerator.h:47-125`).
//
// For the height-only port we omit the color/shader/flora/environment maps
// at runtime — they are present as `null` fields so the C++ structure
// matches, but no affector touches them in our subset.
// ─────────────────────────────────────────────────────────────────────────

import type { Array2d } from './array2d.js';

export interface GeneratorChunkData {
  /** Offset (in poles) of the chunk's "real" area within the maps; padding rows/cols sit before it. */
  originOffset: number;
  /** Total number of poles per side (including padding). Maps are `numberOfPoles × numberOfPoles`. */
  numberOfPoles: number;
  /** Pole-count padding past the chunk's right/bottom edge. */
  upperPad: number;
  /** World-space distance between adjacent poles (meters). */
  distanceBetweenPoles: number;

  /** World-space corner of the chunk (top-left, including padding zone). */
  start: Vector3;

  /** Height in meters at each pole. The eval mutates this in-place. */
  heightMap: Array2d<number>;

  /** Optional: per-pole world-space position (built after heights via `_generateVertexPositions`). */
  vertexPositionMap: Array2d<Vector3> | null;
  /** Optional: per-pole normal vector (built from heights for slope/direction filters). */
  vertexNormalMap: Array2d<Vector3> | null;

  /** Pre-built per-pole exclude mask (true = skip this pole). For the height-only port we set everything false. */
  excludeMap: Array2d<boolean>;
  /** Pre-built per-pole passable mask. Height-only port: all true. */
  passableMap: Array2d<boolean>;

  /** Named-family fractal registry — used by every fractal affector/filter. */
  fractalGroup: IFractalGroup;

  /** Internal: set true when any affector touches heights and normals need regenerating. */
  normalsDirty: boolean;
  /** Internal: bounding rectangle of this chunk in world coords. */
  chunkExtent: Rectangle2d;
}

// ─────────────────────────────────────────────────────────────────────────
// Abstract base classes — match the C++ `LayerItem` hierarchy.
// Concrete subclasses in their own files implement load/affect/isWithin.
// ─────────────────────────────────────────────────────────────────────────

/**
 * Common base for Boundary, Filter, Affector, Layer.
 * Port of `TerrainGenerator::LayerItem` (`TerrainGenerator.h:168-207`).
 */
export abstract class LayerItem {
  /** Four-byte big-endian tag identifying this item's concrete subtype on the wire. */
  readonly tag: number;
  active: boolean = true;
  pruned: boolean = false;
  name: string = '';

  constructor(tag: number) {
    this.tag = tag;
  }

  /** Optional pre-eval hook (default no-op). */
  prepare(): void {}

  /**
   * Concrete subclasses override to deserialize from IFF.
   *
   * The optional `loadContext` is the owning `TerrainGenerator` — only
   * `Layer.load` needs it (it has to register sub-layer affectors against
   * the FractalGroup at load time, and older AffectorHeightFractal
   * versions need the group too). Other LayerItems ignore it.
   */
  abstract load(iff: import('../../iff/iff.js').Iff, loadContext?: unknown): void;
}

/**
 * Boundary base — defines WHERE in world space a layer applies.
 * Port of `TerrainGenerator::Boundary` (`TerrainGenerator.h:216-258`).
 */
export abstract class Boundary extends LayerItem {
  readonly type: BoundaryType;
  featherFunction: FeatherFunction = FeatherFunction.Linear;
  featherDistance: number = 0;

  constructor(tag: number, type: BoundaryType) {
    super(tag);
    this.type = type;
  }

  /** Return [0, 1] inclusion factor at world (x, z). 0 = outside, 1 = fully inside. */
  abstract isWithin(worldX: number, worldZ: number): number;

  /** Expand `extent` to include this boundary's bounding rectangle. */
  abstract expand(extent: Rectangle2d): void;

  /** Quick bounding-box intersection test (for prune phase). */
  abstract intersects(other: Rectangle2d): boolean;

  /** Geometric center for tools/UI (not used by height eval). */
  abstract getCenter(): Vector2d;

  /**
   * Fill `outMap` (size `numberOfPoles × numberOfPoles`) with the boundary's
   * per-pole [0,1] inclusion factor. Default implementation iterates calling
   * `isWithin` per pole; concrete subtypes can override for speed.
   *
   * Port of `Boundary::scanConvertGT` (`TerrainGenerator.cpp:413+`).
   */
  scanConvertGT(outMap: Float32Array, scanArea: Rectangle2d, numberOfPoles: number): void {
    const dx = (scanArea.x1 - scanArea.x0) / (numberOfPoles - 1);
    const dz = (scanArea.z1 - scanArea.z0) / (numberOfPoles - 1);
    let i = 0;
    for (let zi = 0; zi < numberOfPoles; zi++) {
      const wz = scanArea.z0 + zi * dz;
      for (let xi = 0; xi < numberOfPoles; xi++) {
        const wx = scanArea.x0 + xi * dx;
        outMap[i++] = this.isWithin(wx, wz);
      }
    }
  }
}

/**
 * Filter base — gates whether a layer applies at a specific (x, z) point.
 * Port of `TerrainGenerator::Filter` (`TerrainGenerator.h:262-294`).
 */
export abstract class Filter extends LayerItem {
  readonly type: FilterType;
  featherFunction: FeatherFunction = FeatherFunction.Linear;
  featherDistance: number = 0;

  constructor(tag: number, type: FilterType) {
    super(tag);
    this.type = type;
  }

  /**
   * Return [0, 1] inclusion factor at world (worldX, worldZ) / grid (x, z).
   * For height-relevant filters this reads from `chunkData.heightMap` or
   * `chunkData.vertexNormalMap`.
   */
  abstract isWithin(
    worldX: number,
    worldZ: number,
    x: number,
    z: number,
    chunkData: GeneratorChunkData,
  ): number;

  /** True if this filter needs vertex normals computed before it can evaluate. */
  needsNormals(): boolean {
    return false;
  }

  /** True if this filter needs shaders synchronized. Height-only port: always false. */
  needsShaders(): boolean {
    return false;
  }
}

/**
 * Affector base — mutates the chunk maps at a specific (x, z) point.
 * Port of `TerrainGenerator::Affector` (`TerrainGenerator.h:298-323`).
 */
export abstract class Affector extends LayerItem {
  readonly type: AffectorType;

  constructor(tag: number, type: AffectorType) {
    super(tag);
    this.type = type;
  }

  /**
   * Apply this affector at world (worldX, worldZ) / grid (x, z) with strength
   * `amount` ∈ [0, 1]. Concrete subclasses mutate `chunkData.heightMap`
   * (and/or other maps for non-height affectors which we don't model).
   */
  abstract affect(
    worldX: number,
    worldZ: number,
    x: number,
    z: number,
    amount: number,
    chunkData: GeneratorChunkData,
  ): void;

  /** True if this affector writes to the heightMap. Most overrides return true. */
  affectsHeight(): boolean {
    return false;
  }

  /** True if this affector writes to the shaderMap. Height-only port: always false. */
  affectsShader(): boolean {
    return false;
  }

  /** Bit mask of `TGM.*` flags identifying which maps this affector touches. */
  abstract getAffectedMaps(): number;
}

/**
 * Layer — recursive composition node. Defined in `generator/layer.ts`
 * (agent 14). Forward-declared here as an interface so other modules can
 * reference the type without depending on the concrete class.
 */
export interface ILayer {
  readonly tag: number;
  active: boolean;
  pruned: boolean;
  name: string;
  readonly boundaries: readonly Boundary[];
  readonly filters: readonly Filter[];
  readonly affectors: readonly Affector[];
  readonly sublayers: readonly ILayer[];

  invertBoundaries: boolean;
  invertFilters: boolean;
  useExtent: boolean;
  readonly extent: Rectangle2d;

  load(iff: import('../../iff/iff.js').Iff, terrainGenerator: ITerrainGenerator): void;
  affect(previousAmountMap: Float32Array | null, chunkData: GeneratorChunkData): void;
}

/**
 * TerrainGenerator — owns the FractalGroup and the top-level layer list.
 * Defined in `generator/terrain-generator.ts` (agent 15). Forward-declared
 * here so `ILayer.load` can take it without importing it directly.
 */
export interface ITerrainGenerator {
  readonly fractalGroup: IFractalGroup;
  readonly layers: readonly ILayer[];
  generateChunk(chunkData: GeneratorChunkData): void;
}

/**
 * `MessageQueueGenericValueType<float>`-style holder for height + slope
 * results from chunk evaluation — used only for chunk caching in the
 * appearance layer (not by the agents). Provides a single height + a 2D
 * gradient unit normal.
 */
export interface HeightSample {
  height: number;
  normal: Vector3;
}
