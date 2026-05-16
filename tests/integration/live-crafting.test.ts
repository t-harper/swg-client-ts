/**
 * Live integration test for the crafting wire path.
 *
 * Runs a full lifecycle, then during the dwell sends a `beginCrafting(0n, 0)`
 * — i.e. requests a crafting session against tool NetworkId `0n` (which
 * doesn't exist in the player's inventory). The server is expected to reply
 * with **either**:
 *
 *   - an `ErrorMessage` rejecting the command, OR
 *   - a `CM_craftingResult` (ObjControllerMessage subtype
 *     `CraftingResult`) carrying `response = 0` (failure).
 *
 * This is purely a wire-send test — we don't expect actual crafting to
 * succeed without a tool in the player's inventory. The assertion is that
 * the client packs the bytes correctly and the server doesn't drop the
 * connection or crash.
 *
 * Gated on `LIVE=1`. Runs against the SWG server at 10.254.0.253.
 */
import { describe, expect, it } from 'vitest';

import type { ScenarioFn } from '../../src/client/script/context.js';
import { SwgClient } from '../../src/client/swg-client.js';
import { liveCredentials, sessionSettle } from './helpers.js';

const LIVE = process.env.LIVE === '1';
const HOST = process.env.SWG_HOST ?? '10.254.0.253';
const PORT = Number(process.env.SWG_LOGIN_PORT ?? 44453);

describe.skipIf(!LIVE)('live crafting wire test', () => {
  it('sends beginCrafting against a non-existent tool and survives the round-trip', async () => {
    const { account, characterName } = liveCredentials('cr');
    await sessionSettle();
    const client = new SwgClient({ loginServer: { host: HOST, port: PORT } });

    const script: ScenarioFn = async (ctx) => {
      // 1s settle, then attempt the crafting session against an invalid tool.
      await ctx.wait(1000);
      ctx.beginCrafting(0n, 0);
      // Give the server time to reject / reply.
      await ctx.wait(2000);
    };

    const result = await client.fullLifecycle({
      account,
      characterName,
      planet: 'mos_eisley',
      holdZonedInMs: 0, // script provides its own duration
      script,
    });

    // Zone-in succeeded.
    expect(result.sceneStart, 'sceneStart present').toBeDefined();
    expect(result.zonedInAt, 'zonedInAt present').not.toBeNull();
    expect(result.logoutAt, 'logoutAt present').not.toBeNull();

    // Script emitted exactly one ObjControllerMessage (the requestCraftingSession via command queue).
    const sr = result.scriptResult;
    if (sr === undefined) throw new Error('scriptResult missing');
    expect(sr.error, 'script did not throw').toBeUndefined();
    expect(sr.sendsCount, 'script issued the crafting begin').toBeGreaterThanOrEqual(1);

    // Find the outbound ObjControllerMessage in the transcript — should be
    // exactly one with messageName=ObjControllerMessage carrying our request.
    const sentObjs = result.transcript.filter(
      (e) => e.direction === 'send' && e.messageName === 'ObjControllerMessage',
    );
    expect(sentObjs.length, 'outbound ObjControllerMessage present').toBeGreaterThanOrEqual(1);

    // The server may reply with an ErrorMessage OR push a CraftingResult /
    // some other indication. Either is fine; we're testing the wire SEND.
    const recvErrors = result.transcript.filter(
      (e) => e.direction === 'recv' && e.messageName === 'ErrorMessage',
    );
    const recvObjs = result.transcript.filter(
      (e) => e.direction === 'recv' && e.messageName === 'ObjControllerMessage',
    );

    // Soft expectation: SOMETHING came back from the server (could be many
    // background ObjControllerMessages, plus possibly an ErrorMessage).
    expect(
      recvErrors.length + recvObjs.length,
      'server responded to the crafting begin (errors or ObjControllerMessages)',
    ).toBeGreaterThan(0);

    // Log diagnostic: what came back?
    // eslint-disable-next-line no-console
    console.log(
      `[live-crafting] sent ${sentObjs.length} ObjControllerMessages; ` +
        `received ${recvErrors.length} ErrorMessages, ${recvObjs.length} ObjControllerMessages`,
    );
  }, 60_000);
});
