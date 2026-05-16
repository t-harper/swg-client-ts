/**
 * Live integration test for Stage 1 (LoginServer).
 *
 * Gated on `LIVE=1` — runs only when explicitly opted-in. Targets the
 * running SWG server at 10.254.0.253:44453.
 *
 * Asserts:
 *   - SessionResponse received
 *   - ServerNowEpochTime arrives within 60s of `Date.now()/1000`
 *   - LoginEnumCluster contains exactly one cluster named "swg"
 *   - LoginClusterStatus row for it has address=10.254.0.253, port=44463, status=Up
 *   - LoginClientToken.username matches the user we sent
 */
import { describe, expect, it } from 'vitest';

import { runLoginStage } from '../../src/client/login-stage.js';
import { ClusterStatus } from '../../src/types.js';
import { liveAccount } from './helpers.js';

const LIVE = process.env.LIVE === '1';
const HOST = process.env.SWG_HOST ?? '10.254.0.253';
const PORT = Number(process.env.SWG_LOGIN_PORT ?? 44453);

describe.skipIf(!LIVE)('live login (Stage 1)', () => {
  it('connects, authenticates, enumerates clusters, and disconnects cleanly', async () => {
    // Server enforces MAX_ACCOUNT_NAME_LENGTH = 15 — keep it short.
    const username = liveAccount('tslv');
    const result = await runLoginStage({
      endpoint: { host: HOST, port: PORT },
      username,
      timeoutMs: 15_000,
    });

    // Token round-trip
    expect(result.token.username).toBe(username);
    expect(result.token.stationId).toBeGreaterThan(0);
    expect(result.token.bytes.byteLength).toBeGreaterThan(0);

    // Server-clock sanity (within 60s of our clock)
    const skewSec = Math.abs(result.serverNow.getTime() / 1000 - Date.now() / 1000);
    expect(skewSec).toBeLessThan(60);

    // Exactly one cluster named "swg"
    const swgClusters = result.clusters.filter((c) => c.name === 'swg');
    expect(swgClusters.length).toBe(1);
    const swg = swgClusters[0];
    if (swg === undefined) throw new Error('unreachable');

    // LoginClusterStatus row for "swg"
    expect(swg.connectionServerAddress).toBe(HOST);
    expect(swg.connectionServerPort).toBe(44463);
    expect(swg.status).toBe(ClusterStatus.Up);

    // Transcript should show the inbound flood
    const recvNames = result.transcript
      .filter((e) => e.direction === 'recv')
      .map((e) => e.messageName);
    expect(recvNames).toContain('LoginClientToken');
    expect(recvNames).toContain('LoginEnumCluster');
    expect(recvNames).toContain('LoginClusterStatus');
    expect(recvNames).toContain('ServerNowEpochTime');

    // No ErrorMessage should have arrived
    expect(recvNames).not.toContain('LoginIncorrectClientId');
  }, 30_000);
});
