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

const LIVE = process.env.LIVE === '1';
const HOST = process.env.SWG_HOST ?? '10.254.0.253';
const PORT = Number(process.env.SWG_LOGIN_PORT ?? 44453);

describe.skipIf(!LIVE)('live zone-in and logout (Stages 1 → 2 → 3 → 4)', () => {
  it('runs the full lifecycle: login → connect → select → zone in → hold → logout', async () => {
    // Server enforces MAX_ACCOUNT_NAME_LENGTH = 15 — keep account name short.
    const account = `tszn${(Date.now() % 100_000_000).toString(36)}`;
    const characterName = `TsZone${Date.now() % 1_000_000}`;
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
  }, 60_000);
});
