/**
 * Live integration test for the bazaar / commodities wire path.
 *
 * Gated on `LIVE=1`. Runs the full Stage 1 → 4 lifecycle on `mos_eisley`,
 * scans the baseline flood for a bazaar terminal, then drives
 * `ctx.browseBazaar(terminalId)` against the real `CommoditiesServer` and
 * asserts the round-trip parses cleanly.
 *
 * Bazaar terminals come in two functional flavors (the third match,
 * `floor_bazaar_01`, is a decorative static and NOT interactable):
 *
 *   - object/tangible/terminal/(shared_)?terminal_bazaar.iff           (crc 0x8c525205 / 0xd87199ab)
 *   - object/tangible/terminal/(shared_)?portable_bazaar_terminal.iff  (crc 0xb8940a40 / 0xe2b7e554)
 *
 * Confirmed against `~/code/swg-main/dsrc/sku.0/sys.server/built/game/misc/
 * object_template_crc_string_table.tab` — every interactable bazaar matches
 * `/tangible/terminal/.*bazaar/`. Mos Eisley's `tatooine_2_1_ws.tab`
 * buildout contains at least two `terminal_bazaar.iff` instances near the
 * cantina/spaceport, so a baseline-flood hit is expected for a default
 * spawn — but if the spawn drifts (or only ByCrc creates arrive) the test
 * skips cleanly rather than failing CI.
 *
 * What we verify if a terminal is found:
 *   1. `ctx.browseBazaar(terminalId, { timeoutMs })` resolves within timeout.
 *   2. Returns an `AuctionListing[]` (empty array is acceptable — server
 *      with no live listings is a valid round-trip).
 *   3. `AuctionQueryHeadersResponseMessage` appears in the transcript,
 *      proving the server actually replied (not a default).
 *
 * If NO bazaar terminal arrives in the flood, log + soft-skip. Don't fail.
 */
import { describe, expect, it } from 'vitest';

import type { TranscriptEvent } from '../../src/client/dispatcher.js';
import { SwgClient } from '../../src/client/swg-client.js';
import { SceneCreateObjectByCrc } from '../../src/messages/game/scene-create-object-by-crc.js';
import { SceneCreateObjectByName } from '../../src/messages/game/scene-create-object-by-name.js';
import type { NetworkId } from '../../src/types.js';
import { liveCredentials, sessionSettle } from './helpers.js';

const LIVE = process.env.LIVE === '1';
const HOST = process.env.SWG_HOST ?? '10.254.0.253';
const PORT = Number(process.env.SWG_LOGIN_PORT ?? 44453);

/**
 * Match interactable bazaar terminals only (terminal_bazaar +
 * portable_bazaar_terminal, plus their shared_ variants). Specifically
 * rejects `floor_bazaar_01` which is a decorative static under
 * `object/static/worldbuilding/terminal/` — not under `tangible/terminal/`.
 */
const BAZAAR_TERMINAL_TEMPLATE_PATTERN =
  /^object\/tangible\/terminal\/(shared_)?(terminal_bazaar|portable_bazaar_terminal)\.iff$/;

/** CRCs from `object_template_crc_string_table.tab` matching the pattern above. */
const BAZAAR_TERMINAL_TEMPLATE_CRCS: ReadonlySet<number> = new Set([
  0x8c525205, // object/tangible/terminal/terminal_bazaar.iff
  0xd87199ab, // object/tangible/terminal/shared_terminal_bazaar.iff
  0xb8940a40, // object/tangible/terminal/portable_bazaar_terminal.iff
  0xe2b7e554, // object/tangible/terminal/shared_portable_bazaar_terminal.iff
]);

interface FoundTerminal {
  networkId: NetworkId;
  source: 'byName' | 'byCrc';
  template: string;
}

function findBazaarTerminal(transcript: readonly TranscriptEvent[]): FoundTerminal | null {
  for (const event of transcript) {
    if (event.direction !== 'recv') continue;
    if (event.decoded === null) continue;
    if (event.decoded instanceof SceneCreateObjectByName) {
      if (BAZAAR_TERMINAL_TEMPLATE_PATTERN.test(event.decoded.templateName)) {
        return {
          networkId: event.decoded.networkId,
          source: 'byName',
          template: event.decoded.templateName,
        };
      }
    } else if (event.decoded instanceof SceneCreateObjectByCrc) {
      if (BAZAAR_TERMINAL_TEMPLATE_CRCS.has(event.decoded.templateCrc)) {
        return {
          networkId: event.decoded.networkId,
          source: 'byCrc',
          template: `0x${event.decoded.templateCrc.toString(16).padStart(8, '0')}`,
        };
      }
    }
  }
  return null;
}

describe.skipIf(!LIVE)('live bazaar browse (Stages 1 → 2 → 3 → 4)', () => {
  it('round-trips ctx.browseBazaar() against a real bazaar terminal', async () => {
    const { account, characterName } = liveCredentials('bz');
    await sessionSettle();
    const client = new SwgClient({ loginServer: { host: HOST, port: PORT } });

    let terminal: FoundTerminal | null = null;
    let browseError: string | null = null;
    let listingsCount = -1;

    const result = await client.fullLifecycle({
      account,
      characterName,
      planet: 'mos_eisley',
      holdZonedInMs: 0,
      script: async (ctx) => {
        // Give the server a moment after zone-in to finish flooding nearby
        // SceneCreateObject events before we scan.
        await ctx.wait(1_500);

        terminal = findBazaarTerminal(ctx.dispatcher.transcript);
        if (terminal === null) return;

        try {
          const listings = await ctx.browseBazaar(terminal.networkId, { timeoutMs: 8_000 });
          listingsCount = listings.length;
          if (listings.length > 0) {
            const first = listings[0];
            if (first !== undefined) {
              // Light shape check on the depalettized listing — proves the
              // palette-resolution round-trip produced the expected types,
              // even if the listing values are server-specific.
              expect(typeof first.itemName).toBe('string');
              expect(typeof first.itemId).toBe('bigint');
              expect(typeof first.highBid).toBe('number');
              expect(typeof first.buyNowPrice).toBe('number');
              expect(typeof first.location).toBe('string');
              expect(typeof first.ownerName).toBe('string');
            }
          }
        } catch (err) {
          browseError = err instanceof Error ? err.message : String(err);
        }
      },
    });

    expect(result.zonedInAt, 'zonedInAt present').not.toBeNull();
    expect(result.logoutAt, 'logoutAt present').not.toBeNull();
    expect(result.scriptResult?.error, 'script did not throw').toBeUndefined();

    if (terminal === null) {
      console.warn(
        `[live-bazaar] no bazaar terminal found in baseline flood for ${characterName} on mos_eisley — spawn may be too far from any terminal_bazaar.iff. Saw ${result.baselineObjectCount} baseline object(s); skipping assertions.`,
      );
      return;
    }

    const found: FoundTerminal = terminal;
    console.log(
      `[live-bazaar] found bazaar terminal: id=${found.networkId.toString()} ` +
        `source=${found.source} template=${found.template}`,
    );

    expect(browseError, 'browseBazaar() did not throw / timeout').toBeNull();

    expect(
      listingsCount,
      'browseBazaar() returned an array (size may be 0)',
    ).toBeGreaterThanOrEqual(0);

    // The server actually replied — find the AuctionQueryHeadersResponseMessage.
    const recvNames = result.transcript
      .filter((e) => e.direction === 'recv')
      .map((e) => e.messageName);
    expect(
      recvNames,
      'AuctionQueryHeadersResponseMessage came back from the CommoditiesServer',
    ).toContain('AuctionQueryHeadersResponseMessage');

    // And we sent the matching query.
    const sentNames = result.transcript
      .filter((e) => e.direction === 'send')
      .map((e) => e.messageName);
    expect(sentNames, 'AuctionQueryHeadersMessage was sent by browseBazaar()').toContain(
      'AuctionQueryHeadersMessage',
    );

    expect(result.receivedErrorMessage, 'no ErrorMessage during bazaar browse').toBe(false);

    console.log(
      `[live-bazaar] browseBazaar() returned ${listingsCount} listing(s) ` +
        `from terminal ${found.networkId.toString()}`,
    );
  }, 60_000);
});
