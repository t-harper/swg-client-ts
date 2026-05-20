/**
 * Live integration test for `ctx.map` — the planetary-map-locations
 * resolver — against the live `swg-server` at 10.254.0.253.
 *
 * Flow:
 *   1. Zone in at Mos Eisley.
 *   2. `ctx.map.list('starport')` — assert at least one starport on the
 *      planet (Tatooine always has Mos Eisley + Bestine + … starports).
 *   3. `ctx.map.nearest('cantina')` — assert it resolves to a place with a
 *      finite `distanceM` (the Mos Eisley cantina is a registered cantina).
 *   4. `ctx.map.list()` (no category) — assert the merged planet-wide set
 *      is non-empty.
 *   5. Assert the transcript shows the `GetMapLocationsMessage` send and
 *      the `GetMapLocationsResponseMessage` recv — proves the wire path.
 *   6. Logout.
 *
 * Gated on `LIVE=1`. Uses a `tslive*` admin-pool account (no admin
 * privilege is actually needed — the planet-map request is un-gated
 * post-zone-in — but the pool guarantees char-creation works).
 *
 * Per the repo rule: the ONLY allowed skip is the outer
 * `describe.skipIf(!LIVE)`. Every in-body failure path is a hard `throw`
 * (or a failed assertion) — never a silent return / console.warn.
 */
import { describe, expect, it } from 'vitest';

import { SwgClient } from '../../src/client/swg-client.js';
import type { ScenarioFn } from '../../src/index.js';
import { liveCredentials, sessionSettle } from './helpers.js';

const LIVE = process.env.LIVE === '1';
const HOST = process.env.SWG_HOST ?? '10.254.0.253';
const PORT = Number(process.env.SWG_LOGIN_PORT ?? 44453);

describe.skipIf(!LIVE)('live ctx.map (planetary-map locations)', () => {
  it('zone-in → list starports → nearest cantina → assert wire path', async () => {
    const { account, characterName } = await liveCredentials('map');
    await sessionSettle();
    const client = new SwgClient({ loginServer: { host: HOST, port: PORT } });

    const observed = {
      planet: null as string | null,
      starportCount: 0,
      starportSample: [] as { x: number; z: number; distanceM: number; name: string }[],
      nearestCantina: null as { x: number; z: number; distanceM: number; name: string } | null,
      totalLocations: 0,
      categoryHistogram: {} as Record<string, number>,
      error: null as string | null,
    };

    const scenario: ScenarioFn = async (ctx) => {
      // Settle so the zone-in completes before we request the planet map.
      await ctx.wait(4_000);
      observed.planet = ctx.location.planet;

      try {
        const starports = await ctx.map.list('starport', { timeoutMs: 20_000 });
        observed.starportCount = starports.length;
        observed.starportSample = starports.slice(0, 5).map((p) => ({
          x: Math.round(p.x),
          z: Math.round(p.z),
          distanceM: Math.round(p.distanceM),
          name: p.name,
        }));

        const cantina = await ctx.map.nearest('cantina', { timeoutMs: 20_000 });
        if (cantina !== undefined) {
          observed.nearestCantina = {
            x: Math.round(cantina.x),
            z: Math.round(cantina.z),
            distanceM: Math.round(cantina.distanceM),
            name: cantina.name,
          };
        }

        const all = await ctx.map.list(undefined, { timeoutMs: 20_000 });
        observed.totalLocations = all.length;
        for (const p of all) {
          observed.categoryHistogram[p.category] =
            (observed.categoryHistogram[p.category] ?? 0) + 1;
        }
      } catch (err) {
        observed.error = err instanceof Error ? err.message : String(err);
      }

      await ctx.logout();
    };

    const result = await client.fullLifecycle({
      account,
      characterName,
      planet: 'mos_eisley',
      holdZonedInMs: 1_000,
      script: scenario,
    });

    // Wire-path assertions — find the GetMapLocations send + response recv
    // in the transcript.
    const sentGetMap = result.transcript.filter(
      (e) => e.direction === 'send' && e.messageName === 'GetMapLocationsMessage',
    );
    const recvGetMapResponse = result.transcript.filter(
      (e) => e.direction === 'recv' && e.messageName === 'GetMapLocationsResponseMessage',
    );

    // eslint-disable-next-line no-console
    console.log(
      `[live-planet-map] account=${account} character=${characterName}\n` +
        `  planet: ${observed.planet ?? 'null'}\n` +
        `  starports (${observed.starportCount}): ` +
        `${observed.starportSample.map((s) => `(${s.x},${s.z} d=${s.distanceM}m "${s.name}")`).join(' ')}\n` +
        `  nearest cantina: ${observed.nearestCantina ? JSON.stringify(observed.nearestCantina) : 'null'}\n` +
        `  total locations: ${observed.totalLocations}\n` +
        `  category histogram: ${JSON.stringify(observed.categoryHistogram)}\n` +
        `  wire: GetMapLocations sends=${sentGetMap.length} responses=${recvGetMapResponse.length}\n` +
        `  error: ${observed.error ?? 'null'}`,
    );

    expect(result.zonedInAt, 'zone-in must succeed').not.toBeNull();
    expect(observed.error, 'ctx.map.* must not throw against the live server').toBeNull();

    // The wire request + response must both have happened.
    expect(sentGetMap.length, 'GetMapLocationsMessage must have been sent').toBeGreaterThanOrEqual(
      1,
    );
    expect(
      recvGetMapResponse.length,
      'GetMapLocationsResponseMessage must have been received',
    ).toBeGreaterThanOrEqual(1);

    // Tatooine has multiple starports; at least one must come back.
    expect(
      observed.starportCount,
      'ctx.map.list("starport") must return at least one starport on Tatooine',
    ).toBeGreaterThanOrEqual(1);
    // Each resolved place must have a finite, non-negative distance.
    for (const s of observed.starportSample) {
      expect(Number.isFinite(s.distanceM), 'starport distanceM must be finite').toBe(true);
      expect(s.distanceM).toBeGreaterThanOrEqual(0);
    }

    // The Mos Eisley cantina is a registered cantina — nearest('cantina')
    // must resolve.
    expect(observed.nearestCantina, 'ctx.map.nearest("cantina") must resolve').not.toBeNull();
    expect(
      Number.isFinite(observed.nearestCantina?.distanceM ?? Number.NaN),
      'nearest cantina distanceM must be finite',
    ).toBe(true);

    // The merged planet-wide set must be non-empty and at least as large as
    // the starport-only subset.
    expect(observed.totalLocations, 'planet-wide location set must be non-empty').toBeGreaterThan(
      0,
    );
    expect(observed.totalLocations).toBeGreaterThanOrEqual(observed.starportCount);
  }, 180_000);
});
