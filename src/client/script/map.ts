/**
 * `ctx.map` — resolve and navigate to the nearest named planetary
 * location (starport, cantina, bank, …).
 *
 * Backed by SWG's server-side planetary-map-locations system: the
 * `PlanetMapCache` requests every registered location on the current
 * planet once (`GetMapLocationsMessage` → `GetMapLocationsResponseMessage`),
 * then `ctx.map` filters by category and picks the nearest by 2D distance
 * from the player.
 *
 * Scope note: this is **planet-wide** — unlike `ctx.world` (whose
 * awareness range is limited to objects the server has streamed to the
 * client), `ctx.map` sees every starport / cantina / bank on the planet
 * regardless of distance.
 *
 * The category model is a hardcoded friendly-name → uint8 map mirroring
 * `dsrc/sku.0/sys.shared/compiled/game/datatables/player/planet_map_cat.tab`
 * (the same precedent as `missions-cache.ts`'s `MISSION_TYPE_NAMES` and
 * `RadialMenuTypes`). A golden unit test pins every index so a server
 * datatable bump fails CI.
 */

import type { MapLocation } from '../../messages/game/planet-map/index.js';
import { MapLocationFlags } from '../../messages/game/planet-map/map-location.js';
import type { NetworkId, Vector3 } from '../../types.js';
import type { NavigateOptions, OutdoorTarget } from '../navigate.js';
import type { PlanetMapCacheView, PlanetMapData } from '../planet-map-cache.js';

/**
 * Friendly category name → `planet_map_cat.tab` uint8 index.
 *
 * Verified against `planet_map_cat.tab` (the `name`/`index` columns) in
 * `~/code/swg-main/dsrc/sku.0/sys.shared/compiled/game/datatables/player/`.
 * Only the top-level category rows scripts realistically navigate to are
 * included. `garage` appears twice in the table (index 6 and index 55) —
 * index 6 is the one used here. `theater` / `cityhall` exist in the table
 * but are flagged neither category nor sub-category, so they are excluded.
 */
export const MAP_CATEGORY_INDEX: Readonly<Record<string, number>> = {
  bank: 2,
  cantina: 3,
  capitol: 4,
  cloningfacility: 5,
  garage: 6,
  guild: 7,
  hotel: 12,
  medicalcenter: 13,
  shuttleport: 14,
  starport: 15,
  themepark: 16,
  city: 17,
};

/**
 * Convenience aliases — common alternate spellings that resolve to one of
 * the canonical {@link MAP_CATEGORY_INDEX} keys.
 */
export const MAP_CATEGORY_ALIASES: Readonly<Record<string, string>> = {
  hospital: 'medicalcenter',
  medcenter: 'medicalcenter',
  spaceport: 'starport',
  shuttle: 'shuttleport',
  cloning: 'cloningfacility',
};

/** Reverse map (index → canonical name) for rendering `MapPlace.category`. */
const INDEX_TO_CATEGORY: ReadonlyMap<number, string> = new Map(
  Object.entries(MAP_CATEGORY_INDEX).map(([name, index]) => [index, name]),
);

/**
 * Resolve a friendly category string (or alias) to its uint8 index.
 * Throws (programmer error) with the list of valid names when unknown.
 */
export function resolveCategory(category: string): number {
  const key = category.trim().toLowerCase();
  const aliased = MAP_CATEGORY_ALIASES[key] ?? key;
  const index = MAP_CATEGORY_INDEX[aliased];
  if (index === undefined) {
    const valid = Object.keys(MAP_CATEGORY_INDEX).sort().join(', ');
    const aliases = Object.keys(MAP_CATEGORY_ALIASES).sort().join(', ');
    throw new Error(
      `ctx.map: unknown category "${category}". Valid categories: ${valid}. Aliases: ${aliases}.`,
    );
  }
  return index;
}

/** Render a category byte as a friendly name, or `"0x<hex>"` if unknown. */
function categoryName(category: number): string {
  return INDEX_TO_CATEGORY.get(category) ?? `0x${category.toString(16).padStart(2, '0')}`;
}

/**
 * One resolved planetary-map location, with the 2D distance from the
 * player computed at query time.
 */
export interface MapPlace {
  /**
   * Raw location name from the server. Frequently `''` or an `@file:key`
   * StringId — the planet-map system leaves STF resolution to the UI, so
   * scripts should filter on `category` / `distanceM`, not `name`.
   */
  name: string;
  /** World X coordinate. */
  x: number;
  /** World Z coordinate (the wire's `Vector2d.y`). */
  z: number;
  /** Friendly category name, or `"0x<hex>"` for an unmapped category byte. */
  category: string;
  /** NetworkId of the location object. */
  locationId: NetworkId;
  /** 2D distance (m) from the player at the time of the query. */
  distanceM: number;
  /** `true` unless the location's `F_inactive` (0x01) flag is set. */
  active: boolean;
}

/** Options for {@link MapView.nearest} / {@link MapView.list}. */
export interface MapNearestOptions {
  /**
   * Planet to query. Defaults to the planet the player is zoned in on.
   * The server only answers for the current planet — passing any other
   * value will make the underlying request time out.
   */
  planet?: string;
  /**
   * Only consider locations within this 2D radius (m) of the player.
   * Default: unlimited.
   */
  maxRadiusM?: number;
  /**
   * Include inactive locations (those with the `F_inactive` flag). Default
   * `false` — inactive locations are filtered out.
   */
  includeInactive?: boolean;
  /** ms to wait for the planet-map server response. Default 15000. */
  timeoutMs?: number;
}

/**
 * The `ctx.map` namespace — query + navigate to named planetary locations.
 *
 * `nearest` / `list` resolve a category over the server's planet-wide
 * data; `goTo` additionally walks the player there via `ctx.navigate`.
 */
export interface MapView {
  /**
   * Resolve the nearest location of `category` to the player. Returns
   * `undefined` when the planet has no such location (or none within
   * `maxRadiusM`). Throws if `category` is not a known category name.
   *
   * Planet-wide: sees every matching location on the planet, not just
   * those streamed into `ctx.world`.
   *
   *   const sp = await ctx.map.nearest('starport');
   *   const bank = await ctx.map.nearest('bank', { maxRadiusM: 500 });
   */
  nearest(category: string, opts?: MapNearestOptions): Promise<MapPlace | undefined>;
  /**
   * List planetary-map locations, nearest-first. With a `category`,
   * only that category; without one, every location on the planet.
   * Throws if `category` is given but not a known category name.
   *
   *   const banks = await ctx.map.list('bank');     // every bank, closest first
   *   const all = await ctx.map.list();             // everything on the planet
   */
  list(category?: string, opts?: MapNearestOptions): Promise<MapPlace[]>;
  /**
   * Resolve the nearest location of `category` and navigate the player to
   * it via `ctx.navigate`. Returns the resolved {@link MapPlace}. Throws
   * if the category is unknown or no matching location exists on the
   * planet.
   *
   * `navigate` auto-mounts for far targets (default threshold 50m); pass
   * `useMount: 'never'` to force walking the whole way.
   *
   *   await ctx.map.goTo('cantina');
   *   await ctx.map.goTo('starport', { useMount: 'never' });
   */
  goTo(category: string, opts?: MapNearestOptions & NavigateOptions): Promise<MapPlace>;
}

/** Minimum host surface the `ctx.map` helpers need. */
export interface MapHostContext {
  /** Per-planet planetary-map cache (request-once). */
  readonly mapCache: PlanetMapCacheView;
  /** Live player position cursor. */
  position(): Readonly<Vector3>;
  /** The multi-segment "go there" primitive. */
  navigate(target: OutdoorTarget, opts?: NavigateOptions): Promise<void>;
}

/**
 * Project a `MapLocation` to a {@link MapPlace}, computing 2D distance
 * from `here`.
 */
function toPlace(loc: MapLocation, here: Readonly<Vector3>): MapPlace {
  const dx = loc.x - here.x;
  const dz = loc.z - here.z;
  return {
    name: loc.locationName,
    x: loc.x,
    z: loc.z,
    category: categoryName(loc.category),
    locationId: loc.locationId,
    distanceM: Math.sqrt(dx * dx + dz * dz),
    active: (loc.flags & MapLocationFlags.Inactive) === 0,
  };
}

/**
 * Filter `data` by an optional category index + the options, then return
 * the matching {@link MapPlace}s sorted nearest-first.
 */
function resolvePlaces(
  data: PlanetMapData,
  here: Readonly<Vector3>,
  categoryIndex: number | undefined,
  opts: MapNearestOptions,
): MapPlace[] {
  const includeInactive = opts.includeInactive ?? false;
  const maxRadiusM = opts.maxRadiusM;
  const places: MapPlace[] = [];
  for (const loc of data.locations) {
    if (categoryIndex !== undefined && loc.category !== categoryIndex) continue;
    const place = toPlace(loc, here);
    if (!includeInactive && !place.active) continue;
    if (maxRadiusM !== undefined && place.distanceM > maxRadiusM) continue;
    places.push(place);
  }
  places.sort((a, b) => a.distanceM - b.distanceM);
  return places;
}

/** Build the `ctx.map` view. Stateless wrapper over the planet-map cache. */
export function createMapView(host: MapHostContext): MapView {
  async function resolveList(
    category: string | undefined,
    opts: MapNearestOptions,
  ): Promise<MapPlace[]> {
    const categoryIndex = category === undefined ? undefined : resolveCategory(category);
    const data = await host.mapCache.load({
      ...(opts.planet !== undefined ? { planet: opts.planet } : {}),
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    });
    return resolvePlaces(data, host.position(), categoryIndex, opts);
  }

  return {
    async nearest(category, opts = {}): Promise<MapPlace | undefined> {
      const places = await resolveList(category, opts);
      return places[0];
    },
    async list(category, opts = {}): Promise<MapPlace[]> {
      return resolveList(category, opts);
    },
    async goTo(category, opts = {}): Promise<MapPlace> {
      const place = await resolveList(category, opts).then((places) => places[0]);
      if (place === undefined) {
        const within = opts.maxRadiusM !== undefined ? ` within ${opts.maxRadiusM}m` : '';
        throw new Error(`ctx.map.goTo: no "${category}" location found on the planet${within}`);
      }
      const navOpts: NavigateOptions = {};
      if (opts.useMount !== undefined) navOpts.useMount = opts.useMount;
      if (opts.mountThresholdM !== undefined) navOpts.mountThresholdM = opts.mountThresholdM;
      if (opts.dismountDistanceM !== undefined) navOpts.dismountDistanceM = opts.dismountDistanceM;
      if (opts.verifyCellEntryTimeoutMs !== undefined) {
        navOpts.verifyCellEntryTimeoutMs = opts.verifyCellEntryTimeoutMs;
      }
      await host.navigate({ x: place.x, z: place.z }, navOpts);
      return place;
    },
  };
}
