/**
 * PlanetMapCache — per-planet cache of the server's planetary-map
 * locations (starports, cantinas, banks, …).
 *
 * Unlike `survey-cache` / `missions-cache` (purely reactive — they only
 * subscribe and filter), this cache is *request-driven*: `load()` sends a
 * `GetMapLocationsMessage` and awaits the matching
 * `GetMapLocationsResponseMessage` via `dispatcher.waitFor` — the same
 * request → response pattern `ctx.travel`'s helpers use.
 *
 * The result is cached per planet, because a player can shuttle to a
 * different planet mid-session. A second `load()` for an already-cached
 * planet returns the cached copy without re-sending; concurrent `load()`
 * calls for the same planet share a single in-flight promise.
 *
 * A request that times out throws a clear error — never a silent empty
 * result. The most common cause is asking for a planet the player is not
 * actually zoned in on (the server only answers for the current planet).
 *
 * Wire flow (verified against `~/code/swg-main`):
 *   1. `GetMapLocationsMessage(planet, 0, 0, 0)` (client → server) —
 *      versions `0,0,0` force the server to return the full set.
 *   2. `GetMapLocationsResponseMessage` (server → client) — three
 *      `AutoArray<MapLocation>` arrays (static / dynamic / persist) plus
 *      three cache-version ints.
 *
 * Source:
 *   ~/code/swg-main/src/engine/shared/library/sharedNetworkMessages/src/
 *     shared/clientGameServer/GetMapLocations{,Response}Message.cpp
 */

import {
  GetMapLocationsMessage,
  GetMapLocationsResponseMessage,
  type MapLocation,
} from '../messages/game/planet-map/index.js';
import type { MessageDispatcher } from './dispatcher.js';

/** Default ms to wait for the server's `GetMapLocationsResponseMessage`. */
const DEFAULT_LOAD_TIMEOUT_MS = 15_000;

/** Options for {@link PlanetMapCacheImpl.load}. */
export interface PlanetMapLoadOptions {
  /**
   * Planet to load. Defaults to the cache's current planet (the one the
   * player is zoned in on). The server only answers for the current
   * planet — passing any other value will time out.
   */
  planet?: string;
  /** ms to wait for the server response. Default 15000. */
  timeoutMs?: number;
  /**
   * If true, ignore any cached copy and re-request from the server.
   * Equivalent to calling `invalidate(planet)` then `load(planet)`.
   */
  force?: boolean;
}

/**
 * The merged result for one planet. The server splits its locations into
 * three arrays by lifetime (static / dynamic / persist); `locations`
 * concatenates all three. The `category` byte on each entry disambiguates
 * regardless of which array it arrived in.
 */
export interface PlanetMapData {
  /** Planet stem this data is for (e.g. `"tatooine"`). */
  planet: string;
  /** Every registered location on the planet — static + dynamic + persist. */
  locations: MapLocation[];
  /** Fixed-fixture locations (starports / cantinas / banks live here). */
  staticLocations: MapLocation[];
  /** Short-lived runtime locations. */
  dynamicLocations: MapLocation[];
  /** Player-created persistent locations (player cities, …). */
  persistLocations: MapLocation[];
  /** Server's `versionStatic` — echo back on a later request to skip a re-send. */
  versionStatic: number;
  /** Server's `versionDynamic`. */
  versionDynamic: number;
  /** Server's `versionPersist`. */
  versionPersist: number;
}

/** Public surface exposed to the `ctx.map` view + tests. */
export interface PlanetMapCacheView {
  /**
   * Return the planet's map locations — cached when available, otherwise
   * sends a `GetMapLocationsMessage` and awaits the response. Throws on
   * timeout (never resolves to an empty set silently).
   */
  load(opts?: PlanetMapLoadOptions): Promise<PlanetMapData>;
  /** Drop the cached copy for `planet` (or every planet if omitted). */
  invalidate(planet?: string): void;
}

/**
 * Implementation. Constructed in `createScriptContext`; `detach()` is
 * called at `runScript` teardown — mirrors the other live caches'
 * lifecycle convention even though there is no subscription to release.
 */
export class PlanetMapCacheImpl implements PlanetMapCacheView {
  /** Resolved per-planet data. */
  private readonly cache = new Map<string, PlanetMapData>();
  /** In-flight `load()` promises, keyed by planet — de-dupes concurrent calls. */
  private readonly inFlight = new Map<string, Promise<PlanetMapData>>();

  /**
   * @param dispatcher      message dispatcher for send + waitFor.
   * @param currentPlanet   getter for the planet the player is zoned in on.
   *                        Read live so a mid-session re-zone is handled.
   */
  constructor(
    private readonly dispatcher: MessageDispatcher,
    private readonly currentPlanet: () => string,
  ) {}

  /** Request-driven cache — nothing to subscribe to. Here for lifecycle symmetry. */
  attach(): void {
    // No-op — the cache only ever sends a request inside `load()`.
  }

  /** Drop any in-flight tracking. Resolved cache entries are kept (cheap). */
  detach(): void {
    this.inFlight.clear();
  }

  invalidate(planet?: string): void {
    if (planet === undefined) {
      this.cache.clear();
      this.inFlight.clear();
      return;
    }
    this.cache.delete(planet);
    this.inFlight.delete(planet);
  }

  async load(opts: PlanetMapLoadOptions = {}): Promise<PlanetMapData> {
    const planet = opts.planet ?? this.currentPlanet();
    if (planet === '') {
      throw new Error(
        'PlanetMapCache.load: no planet to request — the player is not zoned in (sceneName empty)',
      );
    }
    if (opts.force === true) {
      this.invalidate(planet);
    }
    const cached = this.cache.get(planet);
    if (cached !== undefined) {
      return cached;
    }
    const pending = this.inFlight.get(planet);
    if (pending !== undefined) {
      return pending;
    }
    const promise = this.request(planet, opts.timeoutMs ?? DEFAULT_LOAD_TIMEOUT_MS);
    this.inFlight.set(planet, promise);
    try {
      const data = await promise;
      this.cache.set(planet, data);
      return data;
    } finally {
      this.inFlight.delete(planet);
    }
  }

  /**
   * Send `GetMapLocationsMessage(planet, 0,0,0)` and await the matching
   * `GetMapLocationsResponseMessage`. The wait predicate matches on
   * `planetName` so a stray response for another planet isn't consumed.
   */
  private async request(planet: string, timeoutMs: number): Promise<PlanetMapData> {
    const wait = this.dispatcher.waitFor(GetMapLocationsResponseMessage, {
      timeoutMs,
      predicate: (m) => m.planetName === planet,
    });
    this.dispatcher.send(new GetMapLocationsMessage(planet, 0, 0, 0));
    let resp: GetMapLocationsResponseMessage;
    try {
      resp = await wait;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(
        `PlanetMapCache.load: no GetMapLocationsResponseMessage for "${planet}" ` +
          `within ${timeoutMs}ms — is the player zoned in on that planet? (${reason})`,
      );
    }
    return {
      planet: resp.planetName,
      locations: [
        ...resp.mapLocationsStatic,
        ...resp.mapLocationsDynamic,
        ...resp.mapLocationsPersist,
      ],
      staticLocations: resp.mapLocationsStatic,
      dynamicLocations: resp.mapLocationsDynamic,
      persistLocations: resp.mapLocationsPersist,
      versionStatic: resp.versionStatic,
      versionDynamic: resp.versionDynamic,
      versionPersist: resp.versionPersist,
    };
  }
}
