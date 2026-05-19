/**
 * TerrainView — `ctx.terrain` on `ScriptContext`. Lazy-loads the procedural
 * terrain template for the current planet (or any planet you ask for) and
 * caches the resulting `ProceduralTerrainAppearance` keyed by planet name
 * for the lifetime of the script context.
 *
 * The underlying procedural generator is the bit-exact port of the C++
 * `sharedTerrain` + `sharedFractal` libraries at `src/terrain/sim/` — it
 * computes per-(x, z) heights with no live-server round-trip. See
 * `src/terrain/sim/index.ts` for the curated public surface; the C++
 * ground truth is
 * `~/code/swg-main/src/engine/shared/library/sharedTerrain/...`.
 *
 * The first call for a planet pays the load cost (file I/O + IFF parse +
 * generator prepare — typically 50-200 ms depending on planet complexity).
 * Subsequent calls return the cached appearance instance. Failed loads are
 * NOT cached, so a transient asset-resolution failure (e.g. a planet whose
 * `.trn` isn't extracted yet) won't poison the cache for retries.
 *
 * The view holds no dispatcher subscriptions, so it has no detach handle —
 * its only state is the appearance cache, which is garbage-collected with
 * the ScriptContext.
 */

import {
  ProceduralTerrainAppearance,
  type ProceduralTerrainTemplate,
  loadPlanetTrnTemplate,
} from '../terrain/sim/index.js';

/**
 * Live terrain view exposed on `ctx.terrain`. Provides offline per-coord
 * terrain heights backed by the procedural generator.
 */
export interface TerrainView {
  /**
   * Procedural terrain appearance for the current planet (from
   * `ctx.location.planet`). Lazy-loaded on first call; cached per planet
   * for the lifetime of the script context.
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
   * Function returning the current planet name (typically
   * `() => locationView.planet`). Re-evaluated on every call so that a
   * mid-script zone-in to a different planet picks up the new value
   * transparently.
   */
  getCurrentPlanet: () => string;
  /**
   * Loader override for tests. Defaults to `loadPlanetTrnTemplate` from
   * `src/terrain/sim/proc-terrain-template.ts`.
   */
  loadTemplate?: (planet: string) => Promise<ProceduralTerrainTemplate>;
  /**
   * Appearance constructor override for tests. Defaults to
   * `new ProceduralTerrainAppearance(template)`.
   */
  buildAppearance?: (template: ProceduralTerrainTemplate) => ProceduralTerrainAppearance;
}

/**
 * Build a `TerrainView`. The cache is per-instance (one per script context).
 * Concurrent calls for the same planet share the in-flight load promise.
 */
export function createTerrainView(opts: TerrainViewOptions): TerrainView {
  const cache = new Map<string, Promise<ProceduralTerrainAppearance>>();
  const loadTemplate = opts.loadTemplate ?? loadPlanetTrnTemplate;
  const buildAppearance =
    opts.buildAppearance ?? ((template) => new ProceduralTerrainAppearance(template));

  function appearanceFor(planet: string): Promise<ProceduralTerrainAppearance> {
    const existing = cache.get(planet);
    if (existing !== undefined) return existing;
    const pending = loadTemplate(planet).then(buildAppearance);
    // Don't cache failures — a transient missing-asset error shouldn't
    // poison every subsequent call. The unhandled-rejection branch here is
    // a no-op rethrow; callers still see the original rejection.
    pending.catch(() => {
      cache.delete(planet);
    });
    cache.set(planet, pending);
    return pending;
  }

  return {
    appearance(): Promise<ProceduralTerrainAppearance> {
      return appearanceFor(opts.getCurrentPlanet());
    },
    async getHeight(x: number, z: number): Promise<number> {
      const appearance = await appearanceFor(opts.getCurrentPlanet());
      return appearance.getHeight(x, z);
    },
    appearanceFor,
  };
}
