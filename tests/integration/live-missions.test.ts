/**
 * Live integration test for the mission system.
 *
 * Runs a full lifecycle, drops the player in Mos Eisley (plenty of mission
 * terminals nearby), and:
 *   1. Waits a moment for the baseline flood to settle.
 *   2. Scans the transcript for any inbound MissionObject SHARED baselines
 *      (objectTypeTag = MISO). A freshly-spawned character generally won't
 *      have any active missions, but server-side mission posters in range
 *      may push MissionObject baselines as the player's awareness window
 *      enters their cell — log either outcome.
 *   3. Confirms no `ErrorMessage` arrived (canary against drift in either
 *      the request subtype CRCs or the MISO baseline decoder).
 *
 * Gated on `LIVE=1`. Runs against the SWG server at 10.254.0.253.
 */
import { describe, expect, it } from 'vitest';

import { SwgClient } from '../../src/client/swg-client.js';
import {
  type BaselinesMessage,
  ObjectTypeTags,
  tagToString,
} from '../../src/messages/game/baselines/index.js';
import { liveCredentials, sessionSettle } from './helpers.js';

const LIVE = process.env.LIVE === '1';
const HOST = process.env.SWG_HOST ?? '10.254.0.253';
const PORT = Number(process.env.SWG_LOGIN_PORT ?? 44453);

describe.skipIf(!LIVE)('live mission system', () => {
  it('emits no ErrorMessage when scanning for mission baselines', async () => {
    const { account, characterName } = await liveCredentials('ms');
    await sessionSettle();
    const client = new SwgClient({ loginServer: { host: HOST, port: PORT } });

    const result = await client.fullLifecycle({
      account,
      characterName,
      planet: 'mos_eisley',
      holdZonedInMs: 0,
      script: async (ctx) => {
        // Give the baseline flood a beat to settle so we can scan the transcript
        // for any inbound MissionObject baselines around the player.
        await ctx.wait(2_000);
      },
    });

    expect(result.sceneStart, 'sceneStart present').toBeDefined();
    expect(result.zonedInAt, 'zonedInAt present').not.toBeNull();
    expect(result.receivedErrorMessage, 'no ErrorMessage during mission scan').toBe(false);

    // Walk the transcript for BaselinesMessage events with typeId === MISO.
    let misoBaselines = 0;
    let misoSharedDecoded = 0;
    for (const event of result.transcript) {
      if (event.direction !== 'recv' || event.messageName !== 'BaselinesMessage') continue;
      const decoded = event.decoded as BaselinesMessage | undefined;
      if (!decoded) continue;
      if (decoded.typeId !== ObjectTypeTags.MISO) continue;
      misoBaselines++;
      if (decoded.decodedBaseline?.kind === 'MissionObjectShared') {
        misoSharedDecoded++;
      }
    }

    // eslint-disable-next-line no-console
    console.log(
      `[live-missions] account=${account} char=${characterName}; transcript=${result.transcript.length}; MISO baselines=${misoBaselines}; decoded as MissionObjectShared=${misoSharedDecoded}; tagToString(MISO)='${tagToString(ObjectTypeTags.MISO)}'`,
    );

    // Soft assertion — a brand-new character at zone-in doesn't have
    // missions, but a populated cluster MAY surface neighbor mission posters.
    // Either outcome is fine; the hard requirement is "no errors".
    if (misoBaselines > 0) {
      // We currently decode only MISO p3 (SHARED). Mission posters around
      // the player can include other packages (p6 SHARED_NP, p1 CLIENT_SERVER)
      // we don't yet model — those legitimately stay opaque. Assert at least
      // ONE MISO baseline decoded so we know the registry is wired; partial
      // coverage of variants is expected.
      expect(misoSharedDecoded, 'at least one MISO baseline decoded cleanly').toBeGreaterThan(0);
    }
  }, 60_000);
});
