/**
 * Live integration test for the bazaar / commodities wire path.
 *
 * Admin-spawns a bazaar terminal at the player's position via `/object
 * create`, then drives `ctx.browseBazaar(terminalId)` against the real
 * `CommoditiesServer`. Asserts the round-trip wire shape (the actual
 * listing count is server-dependent; empty is fine).
 *
 * Why admin-spawn (vs walk to a buildout bazaar): the default `mos_eisley`
 * spawn at (3528, -4804) lands in the `server_halloween_mos_eisley`
 * buildout area which doesn't include bazaar terminals; the closest
 * compiled bazaar is on the other side of the planet. Admin-spawning a
 * fresh terminal next to the player makes the test self-contained.
 *
 * Gated on `LIVE=1`. Account must be in `dsrc/.../stella_admin.tab` to
 * pass `isGod()`. Defaults to `swg`/`Artisan73741` via `CI_REUSE_ACCOUNT`
 * + `CI_REUSE_CHARACTER`.
 */
import { describe, expect, it } from 'vitest';

import { SwgClient } from '../../src/client/swg-client.js';
import { ConGenericMessage } from '../../src/messages/game/con-generic-message.js';
import type { NetworkId } from '../../src/types.js';
import { liveCredentials, sessionSettle } from './helpers.js';

const LIVE = process.env.LIVE === '1';
const HOST = process.env.SWG_HOST ?? '10.254.0.253';
const PORT = Number(process.env.SWG_LOGIN_PORT ?? 44453);

/** Server template for a bazaar terminal. */
const BAZAAR_TEMPLATE = 'object/tangible/terminal/terminal_bazaar.iff';

describe.skipIf(!LIVE)('live bazaar browse (admin-spawn terminal → browseBazaar)', () => {
  it('round-trips ctx.browseBazaar() against an admin-spawned terminal', async () => {
    const { account, characterName } = await liveCredentials('bz');
    await sessionSettle();
    const client = new SwgClient({ loginServer: { host: HOST, port: PORT } });

    const observed = {
      terminalId: null as NetworkId | null,
      listingsCount: -1,
      browseError: null as string | null,
    };

    const result = await client.fullLifecycle({
      account,
      characterName,
      planet: 'mos_eisley',
      holdZonedInMs: 0,
      script: async (ctx) => {
        await ctx.wait(2_000);

        // Enable god mode (required for /object commands server-side).
        ctx.useAbility('setGodMode', 0n, '1');
        await ctx.wait(1_500);

        const responses: string[] = [];
        const unsub = ctx.dispatcher.onMessage(ConGenericMessage, (m) => {
          responses.push(m.msg);
        });

        const pos = ctx.position();
        const cmd = `object create ${BAZAAR_TEMPLATE} ${(pos.x + 2).toFixed(2)} ${pos.y.toFixed(2)} ${pos.z.toFixed(2)}`;
        ctx.send(new ConGenericMessage(cmd, 100));
        await ctx.wait(2_500);
        unsub();

        const idMatch = responses.find((r) => /NetworkId:\s*\d+/.test(r));
        if (idMatch === undefined) {
          console.warn(
            `[live-bazaar] /object create did not return a NetworkId. Responses: ${JSON.stringify(responses)}`,
          );
          return;
        }
        const idStr = idMatch.match(/NetworkId:\s*(\d+)/)![1]!;
        observed.terminalId = BigInt(idStr) as NetworkId;
        console.warn(`[live-bazaar] admin-spawned bazaar id=${observed.terminalId.toString()}`);

        // Settle so the new object is registered with the commodities server
        // and visible to subsequent browse queries.
        await ctx.wait(2_000);

        try {
          const listings = await ctx.browseBazaar(observed.terminalId, { timeoutMs: 10_000 });
          observed.listingsCount = listings.length;
          if (listings.length > 0) {
            const first = listings[0];
            if (first !== undefined) {
              expect(typeof first.itemName).toBe('string');
              expect(typeof first.itemId).toBe('bigint');
              expect(typeof first.highBid).toBe('number');
              expect(typeof first.buyNowPrice).toBe('number');
              expect(typeof first.location).toBe('string');
              expect(typeof first.ownerName).toBe('string');
            }
          }
        } catch (err) {
          observed.browseError = err instanceof Error ? err.message : String(err);
        }

        // Cleanup: destroy the admin-spawned terminal.
        ctx.send(
          new ConGenericMessage(`object destroy ${observed.terminalId.toString()}`, 101),
        );
        await ctx.wait(500);
      },
    });

    expect(result.zonedInAt, 'zonedInAt present').not.toBeNull();
    expect(result.scriptResult?.error, 'script did not throw').toBeUndefined();
    expect(observed.terminalId, 'admin-spawn returned a NetworkId').not.toBeNull();
    expect(observed.browseError, 'browseBazaar did not throw / timeout').toBeNull();
    expect(observed.listingsCount, 'browseBazaar returned an array').toBeGreaterThanOrEqual(0);

    // Wire-level proof of the round-trip.
    const recvNames = result.transcript
      .filter((e) => e.direction === 'recv')
      .map((e) => e.messageName);
    expect(
      recvNames,
      'AuctionQueryHeadersResponseMessage came back from CommoditiesServer',
    ).toContain('AuctionQueryHeadersResponseMessage');

    const sentNames = result.transcript
      .filter((e) => e.direction === 'send')
      .map((e) => e.messageName);
    expect(sentNames, 'AuctionQueryHeadersMessage was sent by browseBazaar()').toContain(
      'AuctionQueryHeadersMessage',
    );

    expect(result.receivedErrorMessage, 'no ErrorMessage during bazaar browse').toBe(false);

    console.log(
      `[live-bazaar] browseBazaar returned ${observed.listingsCount} listing(s) ` +
        `from admin-spawned terminal ${observed.terminalId?.toString()}`,
    );
  }, 60_000);
});
