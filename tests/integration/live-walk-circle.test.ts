/**
 * Live integration test for the scripting engine.
 *
 * Runs a full lifecycle and executes a 3-second walk-circle scenario during
 * the dwell. Asserts the scenario sent a reasonable number of
 * UpdateTransformMessages and that the server tolerated the movement
 * (no ErrorMessage, clean logout).
 *
 * Gated on `LIVE=1`. Runs against the SWG server at 10.254.0.253.
 */
import { describe, expect, it } from 'vitest';

import { SwgClient } from '../../src/client/swg-client.js';
import { scenarios } from '../../src/scenarios/index.js';
import { liveCredentials, sessionSettle } from './helpers.js';

const LIVE = process.env.LIVE === '1';
const HOST = process.env.SWG_HOST ?? '10.254.0.253';
const PORT = Number(process.env.SWG_LOGIN_PORT ?? 44453);

describe.skipIf(!LIVE)('live walk-circle script', () => {
  it('runs a 3-second walk-circle then logs out cleanly', async () => {
    // Set CI_REUSE_ACCOUNT + CI_REUSE_CHARACTER to reuse instead of leaking.
    const { account, characterName } = await liveCredentials('wc');
    await sessionSettle();
    const client = new SwgClient({ loginServer: { host: HOST, port: PORT } });

    const script = scenarios['walk-circle']?.({
      radius: '8',
      durationMs: '3000',
      speed: '5',
    });
    if (script === undefined) throw new Error('walk-circle scenario missing');

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
    expect(result.baselineObjectCount).toBeGreaterThan(0);

    // Script ran and emitted ObjControllerMessage(CM_netUpdateTransform) sends.
    expect(result.scriptResult, 'scriptResult populated').toBeDefined();
    const sr = result.scriptResult;
    if (sr === undefined) throw new Error('unreachable');
    expect(sr.error, 'script did not throw').toBeUndefined();
    // 3000ms / 500ms default tick ≈ 6 transforms + 1 teleport-ack bootstrap.
    expect(sr.sendsCount, 'walk-circle sent ≥6 sends').toBeGreaterThanOrEqual(6);

    // Transcript confirms outbound ObjControllerMessage sends — at least one
    // teleport-ack and one or more transform broadcasts.
    const sentObjs = result.transcript.filter(
      (e) => e.direction === 'send' && e.messageName === 'ObjControllerMessage',
    );
    expect(sentObjs.length, 'transcript records ObjControllerMessage sends').toBeGreaterThanOrEqual(
      5,
    );

    // Server did not flag anything as an error.
    expect(result.receivedErrorMessage, 'no ErrorMessage during run').toBe(false);

    // Logout happened exactly once (we did NOT script ctx.logout, so the stage
    // does it for us).
    const sentLogouts = result.transcript.filter(
      (e) => e.direction === 'send' && e.messageName === 'LogoutMessage',
    );
    expect(sentLogouts.length).toBe(1);
  }, 60_000);
});
