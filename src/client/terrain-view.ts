/**
 * TerrainView — `ctx.terrain` on `ScriptContext`. A thin, stateless wrapper
 * that delegates to a shared `Knowledge.terrain` (the process-wide per-planet
 * `ProceduralTerrainAppearance` cache). The view's only job is to substitute
 * the current planet from `getCurrentPlanet()` when callers ask for "the
 * terrain right here"; everything else flows through the shared KB so a
 * 30-client Fleet on Naboo parses `naboo.trn` exactly once and shares one
 * `ProceduralTerrainAppearance` instance (and one chunk cache) across all
 * scripts.
 *
 * The underlying procedural generator is the bit-exact port of the C++
 * `sharedTerrain` + `sharedFractal` libraries at `src/terrain/sim/` — it
 * computes per-(x, z) heights with no live-server round-trip. See
 * `src/terrain/sim/index.ts` for the curated public surface; the C++
 * ground truth is
 * `~/code/swg-main/src/engine/shared/library/sharedTerrain/...`.
 *
 * The first call for a planet (across the entire process) pays the load cost
 * (file I/O + IFF parse + generator prepare — typically 50-200 ms depending
 * on planet complexity). Subsequent calls — from any script — return the
 * cached appearance instance. Failed loads are NOT cached, so a transient
 * asset-resolution failure won't poison the cache for retries.
 *
 * The view holds no dispatcher subscriptions and no per-instance state, so
 * there is no detach handle.
 */

import type { ProceduralTerrainAppearance } from '../terrain/sim/index.js';
import { type Knowledge, defaultKnowledge } from './knowledge.js';

/**
 * Live terrain view exposed on `ctx.terrain`. Provides offline per-coord
 * terrain heights backed by the procedural generator. All state lives on
 * the shared `Knowledge.terrain` KB.
 */
export interface TerrainView {
  /**
   * Procedural terrain appearance for the current planet (from
   * `ctx.location.planet`). Lazy-loaded on first call for that planet
   * (across the process); cached on the shared `Knowledge.terrain` KB.
   *
   * Throws if the planet's `.trn` can't be resolved (no asset on disk + no
   * TRE archive available). See `src/terrain/asset-loader.ts` for the
   * resolution order.
   */
  appearance(): Promise<ProceduralTerrainAppearance>;

  /**
   * Shortcut: terrain height in meters at world `(x, z)` on the current
   * planet. Lazy-loads the appearance on first call.
   *
   * Returns `NaN` if the cell sits on a baked road/river/ribbon — the
   * offline generator stamps `NaN` there because those affected cells use
   * mesh geometry that the height-only port deliberately doesn't load.
   * Treat `NaN` as "non-buildable" in flat-finder code.
   */
  getHeight(x: number, z: number): Promise<number>;

  /**
   * Load and return the appearance for an explicit planet (overrides the
   * current `ctx.location.planet`). Useful for cross-planet scenarios that
   * want to scout the destination's terrain before boarding the shuttle.
   */
  appearanceFor(planet: string): Promise<ProceduralTerrainAppearance>;
}

export interface TerrainViewOptions {
  /**
   * Shared knowledge base — provides the per-planet appearance cache.
   * Defaults to the process-wide `defaultKnowledge` so callers that don't
   * care about isolation (production / CLI / Fleet) can omit it. Tests
   * construct a fresh `new KnowledgeImpl({ terrain: { loadTemplate, ... } })`
   * and pass it explicitly to inject loader overrides.
   */
  knowledge?: Knowledge;
  /**
   * Function returning the current planet name (typically
   * `() => locationView.planet`). Re-evaluated on every call so that a
   * mid-script zone-in to a different planet picks up the new value
   * transparently.
   */
  getCurrentPlanet: () => string;
}

/**
 * Build a `TerrainView`. The view itself holds no state — all caching lives
 * on `opts.knowledge.terrain`. Multiple views sharing the same `Knowledge`
 * also share the appearance cache (and the chunk cache inside each
 * `ProceduralTerrainAppearance`).
 */
export function createTerrainView(opts: TerrainViewOptions): TerrainView {
  const knowledge = opts.knowledge ?? defaultKnowledge;
  return {
    appearance(): Promise<ProceduralTerrainAppearance> {
      return knowledge.terrain.appearanceFor(opts.getCurrentPlanet());
    },
    async getHeight(x: number, z: number): Promise<number> {
      const appearance = await knowledge.terrain.appearanceFor(opts.getCurrentPlanet());
      return appearance.getHeight(x, z);
    },
    appearanceFor(planet: string): Promise<ProceduralTerrainAppearance> {
      return knowledge.terrain.appearanceFor(planet);
    },
  };
}
