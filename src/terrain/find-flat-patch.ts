/**
 * Concentric-ring grid search for flat / buildable patches.
 *
 * Given a center coord, a maximum search radius, and a target count N,
 * generates candidate (x, z) positions arranged in concentric rings,
 * probes each in radial order (innermost first), and returns the first N
 * that the live server reports as buildable.
 *
 * The probe itself (`probeBuildable`) is asynchronous and slow (~5 s each),
 * so the search runs probes sequentially against a single ScriptContext.
 * To parallelize across multiple admin accounts, see the orchestrator
 * pattern in `scripts/build-city/orchestrator.ts` — fan out N
 * `findFlatPatch` calls each owning a slice of the search rings, dedupe
 * the results at merge time. This module deliberately keeps the
 * single-context API simple; the orchestrator can compose it.
 *
 * Geometry:
 *
 *   For `rings = R`, `angularSteps = K`:
 *     - Ring index r in [1..R]: radius_r = maxRadius * r/R
 *     - Inside each ring, K candidates spaced uniformly by angle,
 *       starting at θ = 0 (east), going CCW.
 *     - Total candidate count = 1 + R*K (the +1 is the center itself).
 *
 * The first candidate is always the center coord (r=0). If the center
 * itself probes buildable we count it toward N.
 *
 * Min-spacing filter: returned spots are guaranteed to be at least
 * `minSpacing` meters apart in chord distance. Buildable candidates that
 * fall too close to an already-accepted spot are skipped. This keeps the
 * city plan from clustering all houses around one initially-flat ridge.
 */

import type { ScriptContext } from '../client/script/context.js';
import type { NetworkId } from '../types.js';
import type { BuildableProbeResult, ProbeOptions } from './probe.js';
import { probeBuildable } from './probe.js';

/** A 2D coordinate (Y is whatever the terrain dictates at that point). */
export interface FlatSpot {
  readonly x: number;
  readonly z: number;
}

/** Tuning knobs for `findFlatPatch`. */
export interface FindFlatPatchOptions {
  /** How many buildable spots to return. Search stops as soon as we have N. */
  count: number;
  /** Center X of the search. */
  centerX: number;
  /** Center Z of the search. */
  centerZ: number;
  /** Maximum radius (meters) to search from center. */
  maxRadius: number;
  /**
   * Minimum chord distance (meters) between any two returned spots.
   * Defaults to 30 m — enough for a small house's ~15 m × 15 m footprint
   * plus clearance. Raise this if you're surveying for medium / large
   * structures.
   */
  minSpacing?: number;
  /**
   * Number of concentric rings to generate candidates on. Default 6 (so
   * rings at r/6, 2r/6, ... r). Increase for finer-grained sweeps; decrease
   * for fast initial scoping.
   */
  rings?: number;
  /**
   * Number of angular samples per ring. Default 8 (every 45°). Total
   * candidate count is `1 + rings * angularSteps` (the +1 is the center).
   */
  angularSteps?: number;
  /** Forwarded to each `probeBuildable` call. */
  probeOptions?: ProbeOptions;
  /**
   * Optional per-candidate observer — called every time we probe, with the
   * candidate coord and the probe result. Useful for progress logging.
   */
  onProbe?: (
    candidate: FlatSpot,
    result: BuildableProbeResult,
    index: number,
    total: number,
  ) => void;
  /**
   * Allow injecting a different probe function — used by the unit tests to
   * avoid hitting the live server. Defaults to the real `probeBuildable`.
   * @internal
   */
  probeFn?: (
    ctx: ScriptContext,
    inventoryOid: NetworkId,
    x: number,
    z: number,
    opts?: ProbeOptions,
  ) => Promise<BuildableProbeResult>;
}

/**
 * Search for `count` buildable spots near `(centerX, centerZ)` within
 * `maxRadius`. Returns up to `count` spots (fewer if the search exhausts
 * its candidate grid before finding N).
 *
 * Probes run sequentially. Worst-case runtime is
 * `(1 + rings*angularSteps) * settleMs` ≈ 4-5 minutes for default
 * 6 rings × 8 steps × ~5 s settle.
 */
export async function findFlatPatch(
  ctx: ScriptContext,
  inventoryOid: NetworkId,
  opts: FindFlatPatchOptions,
): Promise<FlatSpot[]> {
  const {
    count,
    centerX,
    centerZ,
    maxRadius,
    minSpacing = 30,
    rings = 6,
    angularSteps = 8,
    probeOptions,
    onProbe,
    probeFn = probeBuildable,
  } = opts;

  if (count <= 0) return [];
  if (rings < 0 || angularSteps < 1) {
    throw new RangeError('findFlatPatch: rings must be >=0 and angularSteps >= 1');
  }
  if (maxRadius < 0) {
    throw new RangeError('findFlatPatch: maxRadius must be non-negative');
  }

  const candidates = generateCandidateGrid({
    centerX,
    centerZ,
    maxRadius,
    rings,
    angularSteps,
  });

  const accepted: FlatSpot[] = [];
  for (let i = 0; i < candidates.length; ++i) {
    if (accepted.length >= count) break;
    const cand = candidates[i];
    if (cand === undefined) continue;

    // Skip if too close to a previously-accepted spot — saves a probe.
    if (tooCloseToAny(cand, accepted, minSpacing)) continue;

    const result = await probeFn(ctx, inventoryOid, cand.x, cand.z, probeOptions);
    onProbe?.(cand, result, i, candidates.length);

    if (result.buildable) {
      accepted.push(cand);
    }
  }

  return accepted;
}

/**
 * Generate the candidate (x, z) grid in radial-search order:
 *   - center first
 *   - then ring 1 (closest), all angles
 *   - then ring 2, all angles
 *   - ...
 *   - then outermost ring
 *
 * Exposed for testability — callers normally don't need it.
 *
 * @internal
 */
export function generateCandidateGrid(opts: {
  centerX: number;
  centerZ: number;
  maxRadius: number;
  rings: number;
  angularSteps: number;
}): FlatSpot[] {
  const { centerX, centerZ, maxRadius, rings, angularSteps } = opts;
  const out: FlatSpot[] = [{ x: centerX, z: centerZ }];
  if (rings <= 0 || maxRadius <= 0) return out;

  for (let r = 1; r <= rings; ++r) {
    const radius = (maxRadius * r) / rings;
    for (let a = 0; a < angularSteps; ++a) {
      const theta = (2 * Math.PI * a) / angularSteps;
      const x = centerX + radius * Math.cos(theta);
      const z = centerZ + radius * Math.sin(theta);
      out.push({ x, z });
    }
  }
  return out;
}

/** Chord distance >= minSpacing for every existing spot? */
function tooCloseToAny(
  candidate: FlatSpot,
  existing: readonly FlatSpot[],
  minSpacing: number,
): boolean {
  if (minSpacing <= 0) return false;
  const minSq = minSpacing * minSpacing;
  for (const e of existing) {
    const dx = candidate.x - e.x;
    const dz = candidate.z - e.z;
    if (dx * dx + dz * dz < minSq) return true;
  }
  return false;
}
