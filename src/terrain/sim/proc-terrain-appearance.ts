/**
 * `ProceduralTerrainAppearance` port — the `getHeight(x, z)` entry point
 * plus a per-chunk LRU cache.
 *
 * Server-side flow we're mirroring (`ProceduralTerrainAppearance.cpp:714` →
 * `createChunk` → `TerrainGenerator::generateChunk`):
 *
 *   1. Convert world (x, z) → chunkX / chunkZ via floor(x / chunkWidth).
 *   2. Look up cached chunk; if missing, generate.
 *   3. Read the per-pole height samples and bilinearly interpolate to
 *      the exact (x, z). The C++ does this via triangle raycast on the
 *      derived vertex mesh — for height-only purposes, bilinear over
 *      the heightMap gives the same answer to within float32 precision.
 *
 * Chunks are `numberOfPoles × numberOfPoles` with `originOffset` padding
 * around the "real" interior. Per the C++ defaults: `numberOfPoles` =
 * `numberOfTilesPerChunk + 1` (with extra padding for normals computation).
 */

import { Array2d } from './array2d.js';
import type { GeneratorChunkData, Vector3 } from './types.js';
import type { ProceduralTerrainTemplate } from './proc-terrain-template.js';

/**
 * Tunable cache + chunk-shape parameters. Defaults match the SWG server
 * configuration for Naboo: 16-pole chunks (15 tiles) over a 16 m chunk
 * width, so 1 m between poles. Override for a faster coarse scan.
 */
export interface AppearanceOptions {
  /** Number of poles per chunk side, INCLUDING padding. Default 17 (1 m grid on 16 m chunks). */
  numberOfPoles?: number;
  /** Maximum chunks to keep cached. Default 256 (~ a 4 km × 4 km window). */
  cacheCapacity?: number;
}

interface CachedChunk {
  chunkX: number;
  chunkZ: number;
  heightMap: Array2d<number>;
  /** World-space corner of the chunk (chunkX * chunkWidth, _, chunkZ * chunkWidth). */
  start: Vector3;
}

export class ProceduralTerrainAppearance {
  readonly template: ProceduralTerrainTemplate;
  readonly numberOfPoles: number;
  readonly distanceBetweenPoles: number;
  readonly cacheCapacity: number;

  /** Insertion-ordered map → LRU eviction by deleting the oldest entry. */
  private readonly chunks = new Map<string, CachedChunk>();

  constructor(template: ProceduralTerrainTemplate, options: AppearanceOptions = {}) {
    this.template = template;
    this.numberOfPoles = options.numberOfPoles ?? 17;
    this.distanceBetweenPoles = template.chunkWidth / (this.numberOfPoles - 1);
    this.cacheCapacity = options.cacheCapacity ?? 256;

    // Pre-allocate each MultiFractal family's value cache to the per-chunk
    // grid (the C++ does this once per session in `TerrainGenerator::prepare`).
    template.terrainGenerator.prepare(this.numberOfPoles);
  }

  /**
   * Return terrain height at world (x, z) in meters. Triggers chunk
   * generation on cache miss.
   *
   * NaN in the cached heightMap (set by the MVP carving affectors) means
   * "this cell sits on a road/river/ribbon" — we propagate NaN out so the
   * flat-finder treats it as forbidden.
   */
  getHeight(x: number, z: number): number {
    // Bring (x, z) into [0, mapWidth) — the C++ does the same wrap via
    // chunk indexing; outside the map it would create boundary chunks
    // but we just clamp.
    const chunkWidth = this.template.chunkWidth;
    const chunkX = Math.floor(x / chunkWidth);
    const chunkZ = Math.floor(z / chunkWidth);
    const chunk = this.getOrCreateChunk(chunkX, chunkZ);

    // Bilinear interpolation over the 4 nearest poles.
    const localX = x - chunk.start.x;
    const localZ = z - chunk.start.z;
    const fX = localX / this.distanceBetweenPoles;
    const fZ = localZ / this.distanceBetweenPoles;

    const x0 = Math.max(0, Math.min(this.numberOfPoles - 2, Math.floor(fX)));
    const z0 = Math.max(0, Math.min(this.numberOfPoles - 2, Math.floor(fZ)));
    const x1 = x0 + 1;
    const z1 = z0 + 1;
    const tX = Math.max(0, Math.min(1, fX - x0));
    const tZ = Math.max(0, Math.min(1, fZ - z0));

    const h00 = chunk.heightMap.get(x0, z0);
    const h10 = chunk.heightMap.get(x1, z0);
    const h01 = chunk.heightMap.get(x0, z1);
    const h11 = chunk.heightMap.get(x1, z1);

    // Propagate NaN: any carving-affected pole on the way disqualifies
    // the interpolated value (matches the flat-finder's expectation).
    if (Number.isNaN(h00) || Number.isNaN(h10) || Number.isNaN(h01) || Number.isNaN(h11)) {
      return Number.NaN;
    }

    const h0 = h00 + (h10 - h00) * tX;
    const h1 = h01 + (h11 - h01) * tX;
    return h0 + (h1 - h0) * tZ;
  }

  /**
   * Compute terrain heights at every (x, z) point in the supplied grid,
   * returning a Float32Array of length `width * height`. Much faster than
   * calling `getHeight` per cell — reuses chunk cache hits and avoids
   * the per-cell function-call overhead.
   *
   * `originX` / `originZ` = world coord of cell (0, 0).
   */
  scanHeights(
    originX: number,
    originZ: number,
    width: number,
    height: number,
    cellSize: number,
  ): Float32Array {
    const out = new Float32Array(width * height);
    let i = 0;
    for (let zi = 0; zi < height; zi++) {
      const wz = originZ + zi * cellSize;
      for (let xi = 0; xi < width; xi++) {
        const wx = originX + xi * cellSize;
        out[i++] = this.getHeight(wx, wz);
      }
    }
    return out;
  }

  /** Number of chunks currently cached. */
  cacheSize(): number {
    return this.chunks.size;
  }

  /** Drop all cached chunks (forces regeneration on next getHeight). */
  clearCache(): void {
    this.chunks.clear();
  }

  // ─────────────────────────────────────────────────────────────────────
  // Internals
  // ─────────────────────────────────────────────────────────────────────

  private getOrCreateChunk(chunkX: number, chunkZ: number): CachedChunk {
    const key = `${chunkX},${chunkZ}`;
    const existing = this.chunks.get(key);
    if (existing !== undefined) {
      // Refresh LRU position: delete + re-set moves it to the end.
      this.chunks.delete(key);
      this.chunks.set(key, existing);
      return existing;
    }

    // Evict the oldest entry if at capacity (Map insertion-order iteration).
    if (this.chunks.size >= this.cacheCapacity) {
      const oldest = this.chunks.keys().next().value;
      if (oldest !== undefined) this.chunks.delete(oldest);
    }

    const chunk = this.generateChunk(chunkX, chunkZ);
    this.chunks.set(key, chunk);
    return chunk;
  }

  private generateChunk(chunkX: number, chunkZ: number): CachedChunk {
    const numPoles = this.numberOfPoles;
    const heightMap = new Array2d<number>(numPoles, numPoles, 0);

    // Padding scratch maps — we don't compute normals in the flat-finder
    // path, but Layer.affect may probe them via FilterSlope/Direction.
    // Allocate as null + lazily build inside Layer if needed.
    const excludeMap = new Array2d<boolean>(numPoles, numPoles, false);
    const passableMap = new Array2d<boolean>(numPoles, numPoles, true);

    const start: Vector3 = {
      x: chunkX * this.template.chunkWidth,
      y: 0,
      z: chunkZ * this.template.chunkWidth,
    };

    const chunkData: GeneratorChunkData = {
      originOffset: 0,
      numberOfPoles: numPoles,
      upperPad: 0,
      distanceBetweenPoles: this.distanceBetweenPoles,
      start,
      heightMap,
      vertexPositionMap: null,
      vertexNormalMap: null,
      excludeMap,
      passableMap,
      fractalGroup: this.template.terrainGenerator.fractalGroup,
      normalsDirty: false,
      chunkExtent: {
        x0: start.x,
        z0: start.z,
        x1: start.x + (numPoles - 1) * this.distanceBetweenPoles,
        z1: start.z + (numPoles - 1) * this.distanceBetweenPoles,
      },
    };

    this.template.terrainGenerator.generateChunk(chunkData);

    return { chunkX, chunkZ, heightMap, start };
  }
}
