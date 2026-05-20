/**
 * Unit tests for PlanetMapCacheImpl — the per-planet request-once cache.
 *
 * Drives a minimal mock dispatcher: `send()` records the outbound
 * `GetMapLocationsMessage`, and a separate `deliver()` helper resolves the
 * matching `waitFor` waiter with a synthetic `GetMapLocationsResponseMessage`.
 */

import { describe, expect, it, vi } from 'vitest';

import { GetMapLocationsMessage } from '../messages/game/planet-map/get-map-locations-message.js';
import { GetMapLocationsResponseMessage } from '../messages/game/planet-map/get-map-locations-response-message.js';
import type { MapLocation } from '../messages/game/planet-map/map-location.js';
import type { GameNetworkMessage } from '../messages/interface.js';
import type { MessageDispatcher } from './dispatcher.js';
import { PlanetMapCacheImpl } from './planet-map-cache.js';

/** A registered waiter the mock dispatcher holds until `deliver()` fires. */
interface MockWaiter {
  typeCrc: number;
  predicate: (msg: GameNetworkMessage) => boolean;
  resolve: (msg: GameNetworkMessage) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Minimal `MessageDispatcher` stand-in — only `send` + `waitFor` are
 * exercised by the cache. `deliver()` resolves matching waiters.
 */
function createMockDispatcher(): {
  dispatcher: MessageDispatcher;
  sent: GameNetworkMessage[];
  deliver: (msg: GameNetworkMessage) => void;
  waiterCount: () => number;
} {
  const sent: GameNetworkMessage[] = [];
  const waiters: MockWaiter[] = [];
  const dispatcher = {
    send(msg: GameNetworkMessage): void {
      sent.push(msg);
    },
    waitFor<T extends GameNetworkMessage>(
      ctor: { messageName: string; typeCrc: number },
      opts: { timeoutMs?: number; predicate?: (msg: T) => boolean } = {},
    ): Promise<T> {
      const timeoutMs = opts.timeoutMs ?? 15_000;
      const predicate = (opts.predicate ?? (() => true)) as (m: GameNetworkMessage) => boolean;
      return new Promise<T>((resolve, reject) => {
        const w: MockWaiter = {
          typeCrc: ctor.typeCrc,
          predicate,
          resolve: resolve as (m: GameNetworkMessage) => void,
          reject,
          timer: setTimeout(() => {
            const idx = waiters.indexOf(w);
            if (idx >= 0) waiters.splice(idx, 1);
            reject(new Error(`Timed out after ${timeoutMs}ms waiting for ${ctor.messageName}`));
          }, timeoutMs),
        };
        w.timer.unref?.();
        waiters.push(w);
      });
    },
  } as unknown as MessageDispatcher;
  const deliver = (msg: GameNetworkMessage): void => {
    const crc = (msg.constructor as unknown as { typeCrc: number }).typeCrc;
    for (let i = waiters.length - 1; i >= 0; i--) {
      const w = waiters[i];
      if (w === undefined || w.typeCrc !== crc) continue;
      if (!w.predicate(msg)) continue;
      waiters.splice(i, 1);
      clearTimeout(w.timer);
      w.resolve(msg);
    }
  };
  return { dispatcher, sent, deliver, waiterCount: () => waiters.length };
}

/** Build a synthetic response with one static entry on `planet`. */
function makeResponse(
  planet: string,
  staticLocs: MapLocation[] = [],
): GetMapLocationsResponseMessage {
  return new GetMapLocationsResponseMessage(planet, staticLocs, [], [], 1, 2, 3);
}

const STARPORT: MapLocation = {
  locationId: 0xa1n,
  locationName: '@map:starport',
  x: 100,
  z: 200,
  category: 15,
  subCategory: 0,
  flags: 0x02,
};

describe('PlanetMapCacheImpl', () => {
  it('sends a GetMapLocationsMessage and resolves with the response data', async () => {
    const { dispatcher, sent, deliver } = createMockDispatcher();
    const cache = new PlanetMapCacheImpl(dispatcher, () => 'tatooine');

    const loadPromise = cache.load();
    expect(sent).toHaveLength(1);
    const req = sent[0];
    if (!(req instanceof GetMapLocationsMessage)) {
      throw new Error('expected a GetMapLocationsMessage to be sent');
    }
    expect(req.planetName).toBe('tatooine');
    // versions 0,0,0 force the full set.
    expect(req.cacheVersionStatic).toBe(0);
    expect(req.cacheVersionDynamic).toBe(0);
    expect(req.cacheVersionPersist).toBe(0);

    deliver(makeResponse('tatooine', [STARPORT]));
    const data = await loadPromise;
    expect(data.planet).toBe('tatooine');
    expect(data.locations).toEqual([STARPORT]);
    expect(data.staticLocations).toEqual([STARPORT]);
    expect(data.versionStatic).toBe(1);
  });

  it('merges the static + dynamic + persist arrays into locations', async () => {
    const { dispatcher, deliver } = createMockDispatcher();
    const cache = new PlanetMapCacheImpl(dispatcher, () => 'naboo');
    const a = { ...STARPORT, locationId: 1n };
    const b = { ...STARPORT, locationId: 2n, category: 3 };
    const c = { ...STARPORT, locationId: 3n, category: 17 };
    const loadPromise = cache.load();
    deliver(new GetMapLocationsResponseMessage('naboo', [a], [b], [c], 0, 0, 0));
    const data = await loadPromise;
    expect(data.locations).toEqual([a, b, c]);
    expect(data.dynamicLocations).toEqual([b]);
    expect(data.persistLocations).toEqual([c]);
  });

  it('returns the cached copy without re-sending on a second load', async () => {
    const { dispatcher, sent, deliver } = createMockDispatcher();
    const cache = new PlanetMapCacheImpl(dispatcher, () => 'tatooine');
    const first = cache.load();
    deliver(makeResponse('tatooine', [STARPORT]));
    await first;
    expect(sent).toHaveLength(1);

    const second = await cache.load();
    expect(sent).toHaveLength(1); // no second send
    expect(second.locations).toEqual([STARPORT]);
  });

  it('de-dupes concurrent loads for the same planet into one request', async () => {
    const { dispatcher, sent, deliver, waiterCount } = createMockDispatcher();
    const cache = new PlanetMapCacheImpl(dispatcher, () => 'tatooine');
    const p1 = cache.load();
    const p2 = cache.load();
    // Only one send + one waiter despite two concurrent load() calls.
    expect(sent).toHaveLength(1);
    expect(waiterCount()).toBe(1);

    deliver(makeResponse('tatooine', [STARPORT]));
    const [d1, d2] = await Promise.all([p1, p2]);
    expect(d1).toBe(d2); // same cached object
  });

  it('re-requests when a different planet is asked for', async () => {
    const { dispatcher, sent, deliver } = createMockDispatcher();
    let planet = 'tatooine';
    const cache = new PlanetMapCacheImpl(dispatcher, () => planet);

    const t = cache.load();
    deliver(makeResponse('tatooine', [STARPORT]));
    await t;
    expect(sent).toHaveLength(1);

    planet = 'naboo';
    const n = cache.load();
    expect(sent).toHaveLength(2);
    expect((sent[1] as GetMapLocationsMessage).planetName).toBe('naboo');
    deliver(makeResponse('naboo', []));
    const nData = await n;
    expect(nData.planet).toBe('naboo');
  });

  it('re-requests after invalidate()', async () => {
    const { dispatcher, sent, deliver } = createMockDispatcher();
    const cache = new PlanetMapCacheImpl(dispatcher, () => 'tatooine');
    const first = cache.load();
    deliver(makeResponse('tatooine', [STARPORT]));
    await first;
    expect(sent).toHaveLength(1);

    cache.invalidate('tatooine');
    const second = cache.load();
    expect(sent).toHaveLength(2); // re-sent after invalidation
    deliver(makeResponse('tatooine', []));
    await second;
  });

  it('re-requests when load({ force: true }) is passed', async () => {
    const { dispatcher, sent, deliver } = createMockDispatcher();
    const cache = new PlanetMapCacheImpl(dispatcher, () => 'tatooine');
    const first = cache.load();
    deliver(makeResponse('tatooine', [STARPORT]));
    await first;
    expect(sent).toHaveLength(1);

    const forced = cache.load({ force: true });
    expect(sent).toHaveLength(2);
    deliver(makeResponse('tatooine', []));
    await forced;
  });

  it('throws a clear error on timeout — never a silent empty result', async () => {
    vi.useFakeTimers();
    try {
      const { dispatcher } = createMockDispatcher();
      const cache = new PlanetMapCacheImpl(dispatcher, () => 'tatooine');
      const loadPromise = cache.load({ timeoutMs: 5_000 });
      // Attach the rejection assertion before advancing timers so the
      // rejection is never an unhandled promise.
      const assertion = expect(loadPromise).rejects.toThrow(
        /no GetMapLocationsResponseMessage for "tatooine"/,
      );
      await vi.advanceTimersByTimeAsync(5_001);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears in-flight tracking but keeps resolved cache on detach', async () => {
    const { dispatcher, sent, deliver } = createMockDispatcher();
    const cache = new PlanetMapCacheImpl(dispatcher, () => 'tatooine');
    const first = cache.load();
    deliver(makeResponse('tatooine', [STARPORT]));
    await first;
    cache.detach();
    // Resolved cache survives detach — no re-send.
    const second = await cache.load();
    expect(sent).toHaveLength(1);
    expect(second.locations).toEqual([STARPORT]);
  });

  it('throws when the current planet is empty (player not zoned in)', async () => {
    const { dispatcher } = createMockDispatcher();
    const cache = new PlanetMapCacheImpl(dispatcher, () => '');
    await expect(cache.load()).rejects.toThrow(/not zoned in/);
  });
});
