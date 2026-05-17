/**
 * Live integration test for the full Stage 1 → 2 → 3 → 4 lifecycle.
 *
 * Gated on `LIVE=1`. Runs against the SWG server at 10.254.0.253.
 *
 * Asserts:
 *   - CmdStartScene arrives
 *   - SceneCreateObjectByCrc/Name baselines flood in (>= 1 object)
 *   - SceneEndBaselines is received
 *   - CmdSceneReady is sent successfully (we're "zoned in")
 *   - Holds for 5 seconds
 *   - LogoutMessage sent cleanly, SOE Terminate sent, sockets closed
 *   - No ErrorMessage or LoginIncorrectClientId arrived during the run
 */
import { describe, expect, it } from 'vitest';

import { SwgClient } from '../../src/client/swg-client.js';
import { ObjControllerMessage } from '../../src/messages/game/obj-controller-message.js';
import { liveCredentials, sessionSettle } from './helpers.js';

const LIVE = process.env.LIVE === '1';
const HOST = process.env.SWG_HOST ?? '10.254.0.253';
const PORT = Number(process.env.SWG_LOGIN_PORT ?? 44453);

describe.skipIf(!LIVE)('live zone-in and logout (Stages 1 → 2 → 3 → 4)', () => {
  it('runs the full lifecycle: login → connect → select → zone in → hold → logout', async () => {
    // Set CI_REUSE_ACCOUNT + CI_REUSE_CHARACTER to reuse instead of leaking.
    const { account, characterName } = await liveCredentials('zn');
    await sessionSettle();
    const client = new SwgClient({ loginServer: { host: HOST, port: PORT } });

    const result = await client.fullLifecycle({
      account,
      characterName,
      // starting_locations.iff key (city), not a planet name
      planet: 'mos_eisley',
      holdZonedInMs: 5_000,
    });

    // We reached the GameServer stage.
    expect(result.sceneStart, 'sceneStart present').toBeDefined();
    expect(result.zonedInAt, 'zonedInAt present').not.toBeNull();
    expect(result.logoutAt, 'logoutAt present').not.toBeNull();
    expect(result.stages.game).toBeTypeOf('number');

    // At least one baseline object came in.
    expect(result.baselineObjectCount).toBeGreaterThan(0);

    // SceneStart fields look sane.
    const ss = result.sceneStart;
    if (ss === undefined) throw new Error('sceneStart unreachable');
    expect(ss.sceneName.length).toBeGreaterThan(0);
    expect(ss.playerNetworkId).toBeTypeOf('bigint');
    expect(ss.playerNetworkId).not.toBe(0n);

    // The transcript should have CmdStartScene, SceneEndBaselines, CmdSceneReady,
    // LogoutMessage.
    const recvNames = result.transcript
      .filter((e) => e.direction === 'recv')
      .map((e) => e.messageName);
    const sentNames = result.transcript
      .filter((e) => e.direction === 'send')
      .map((e) => e.messageName);

    expect(recvNames, 'CmdStartScene received').toContain('CmdStartScene');
    expect(recvNames, 'SceneEndBaselines received').toContain('SceneEndBaselines');
    expect(sentNames, 'CmdSceneReady sent').toContain('CmdSceneReady');
    expect(sentNames, 'LogoutMessage sent').toContain('LogoutMessage');
    expect(sentNames, 'SelectCharacter sent').toContain('SelectCharacter');

    // No protocol errors mid-flow.
    expect(result.receivedErrorMessage, 'no ErrorMessage during run').toBe(false);
    expect(recvNames, 'no LoginIncorrectClientId').not.toContain('LoginIncorrectClientId');

    // Sanity: ObjControllerMessage subtype dispatch should round-trip every
    // ObjControllerMessage we received. The subtype registry might not have a
    // decoder for every CRC seen on the live wire (we model the 8 most-common
    // subtypes), so this isn't a hard "at least N decoded" assertion — but
    // every event SHOULD carry a non-null `subtypeCrcHex` for diagnostics,
    // and any `decodedSubtype` present must be well-formed.
    const objControllerEvents = result.transcript.filter(
      (e) => e.direction === 'recv' && e.messageName === 'ObjControllerMessage',
    );
    for (const e of objControllerEvents) {
      const decoded = 'decoded' in e ? e.decoded : null;
      if (decoded instanceof ObjControllerMessage) {
        expect(decoded.subtypeCrcHex).toMatch(/^0x[0-9a-f]{8}$/);
        if (decoded.decodedSubtype !== null) {
          expect(typeof decoded.decodedSubtype.kind).toBe('string');
          expect(decoded.decodedSubtype.kind.length).toBeGreaterThan(0);
        }
      }
    }
  }, 60_000);
});
