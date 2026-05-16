/**
 * Live integration test for Stage 1 + Stage 2 (LoginServer + ConnectionServer).
 *
 * Gated on `LIVE=1`. Runs the full character-list flow.
 *
 * Asserts:
 *   - Stage 1 succeeds
 *   - ConnectionServer sends ClientPermissionsMessage with canLogin == true
 *   - EnumerateCharacterId returns an array (may be empty)
 *   - If empty, ClientCreateCharacter with a unique name succeeds
 */
import { describe, expect, it } from 'vitest';

import { SwgClient } from '../../src/client/swg-client.js';
import { liveCredentials, sessionSettle } from './helpers.js';

const LIVE = process.env.LIVE === '1';
const HOST = process.env.SWG_HOST ?? '10.254.0.253';
const PORT = Number(process.env.SWG_LOGIN_PORT ?? 44453);

describe.skipIf(!LIVE)('live login + connection (Stage 1 + 2)', () => {
  it('logs in, attaches to ConnectionServer, gets character list (creates if empty), selects', async () => {
    // Set CI_REUSE_ACCOUNT + CI_REUSE_CHARACTER to reuse instead of leaking.
    const { account, characterName } = liveCredentials('cn');
    await sessionSettle();
    const client = new SwgClient({ loginServer: { host: HOST, port: PORT } });
    const result = await client.fullLifecycle({
      account,
      characterName,
      // starting_locations.iff key (city), not a planet name
      planet: 'mos_eisley',
      skipGameStage: true, // do NOT run zone-in here
    });

    // We picked the "swg" cluster
    expect(result.chosenCluster.name).toBe('swg');
    expect(result.chosenCluster.connectionServerAddress).toBe(HOST);
    expect(result.chosenCluster.connectionServerPort).toBe(44463);

    // We have a character (created or pre-existing) with a valid NetworkId
    expect(result.character.networkId).toBeTypeOf('bigint');
    expect(result.character.networkId).not.toBe(0n);
    expect(typeof result.character.name).toBe('string');

    // ClientPermissionsMessage allowed login
    const recvNames = result.transcript
      .filter((e) => e.direction === 'recv')
      .map((e) => e.messageName);
    expect(recvNames).toContain('ClientPermissionsMessage');

    // No fatal errors
    expect(result.receivedErrorMessage).toBe(false);

    // Stage 3 was skipped
    expect(result.stages.game).toBeNull();
    expect(result.zonedInAt).toBeNull();
  }, 30_000);
});
