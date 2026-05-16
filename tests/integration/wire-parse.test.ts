/**
 * Wire-parse integration — END-TO-END test of the full receive pipeline.
 *
 * This test exercises everything from raw UDP bytes through:
 *   - SoeConnection's decrypt (XOR + UserSupplied zlib)
 *   - CRC verification
 *   - Reliable channel 0 sequencing
 *   - Multi / Group unwrap
 *   - GameNetworkMessage header parsing (varCount + CRC)
 *   - Registry-based dispatch to the typed decoder
 *
 * We replay the captured fixtures (real packets from a live SwgClient login
 * against this host's swg-server) and assert we can extract the expected
 * cluster info: name="swg", address="10.254.0.253", port=44463,
 * branch="swg-main", networkVersion="20100225-17:43".
 *
 * This is the TRUE end-to-end test of the wire pipeline. Stream A's
 * `src/soe/connection.test.ts` checks that decrypted payloads CONTAIN the
 * ground-truth strings as bytes; this test goes further and proves we
 * decode them into typed message objects.
 */

import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { parseHeader } from '../../src/messages/base.js';
// Side-effect import: registers every login-stage GameNetworkMessage decoder
// with the singleton MessageRegistry before we try to dispatch on CRC.
import '../../src/messages/login/index.js';

import { LoginClusterStatusEx } from '../../src/messages/login/login-cluster-status-ex.js';
import { LoginClusterStatus } from '../../src/messages/login/login-cluster-status.js';
import { LoginEnumCluster } from '../../src/messages/login/login-enum-cluster.js';
import { messageRegistry } from '../../src/messages/registry.js';
import { SoeConnection } from '../../src/soe/connection.js';
import type { EncryptionParams } from '../../src/types.js';
import { EncryptMethod } from '../../src/types.js';

function loadHexFixture(relPath: string): Uint8Array {
  const url = new URL(`../fixtures/${relPath}`, import.meta.url);
  const text = readFileSync(fileURLToPath(url), 'utf8');
  const cleaned = text
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .join(' ')
    .replace(/\s+/g, '');
  if (cleaned.length % 2 !== 0) {
    throw new Error(`bad hex: odd length ${cleaned.length} in ${relPath}`);
  }
  const out = new Uint8Array(cleaned.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(cleaned.substr(i * 2, 2), 16);
  }
  return out;
}

const SESSION_RESPONSE = loadHexFixture('session-response-17b.hex');
const LOGIN_ENUM_CLUSTER_PACKET = loadHexFixture('login-enum-cluster-223b.hex');

describe('wire-parse integration: captured fixture → decoded GameNetworkMessages', () => {
  it('decodes LoginEnumCluster + LoginClusterStatus from the captured packet', async () => {
    // Same connection params the capture used (see session-request-14b.hex).
    const conn = new SoeConnection({
      endpoint: { host: '127.0.0.1', port: 1 }, // dummy — we never actually send
      connectionCode: 0x00294823,
      onAppMessage: (payload) => {
        appPayloads.push(payload);
      },
    });
    // Swallow any AckAll the connection wants to send back through the
    // (non-existent) socket.
    conn.testSendOverride = () => {
      /* no-op */
    };

    const appPayloads: Uint8Array[] = [];

    // 1. Negotiate session synchronously from the captured SessionResponse.
    const params: EncryptionParams = conn.testInjectSessionResponse(SESSION_RESPONSE);
    expect(params.encryptCode).toBe(0xfe7b4873);
    expect(params.crcBytes).toBe(2);
    expect(params.encryptMethods).toEqual([EncryptMethod.UserSupplied, EncryptMethod.Xor]);

    // 2. The captured packet's reliable seq is 1 (we never captured seq 0).
    //    Advance our expected counter forward so the receive pipeline
    //    accepts the captured seq in-order.
    conn.testForceIncomingExpectedId(1);

    // 3. Feed the 223-byte encrypted packet into the receive pipeline.
    conn.testInjectDatagram(LOGIN_ENUM_CLUSTER_PACKET);

    // 4. The packet was a Group inside Reliable1, containing multiple
    //    GameNetworkMessages. We expect at least the inbound login flood:
    //    ServerNowEpochTime, LoginClientToken, LoginEnumCluster,
    //    CharacterCreationDisabled, LoginClusterStatus, LoginClusterStatusEx.
    expect(appPayloads.length).toBeGreaterThan(0);

    // 5. Walk every sub-payload, parse its header, dispatch via the
    //    registry, and collect the typed instances we care about.
    const enumClusters: LoginEnumCluster[] = [];
    const clusterStatuses: LoginClusterStatus[] = [];
    const clusterStatusExes: LoginClusterStatusEx[] = [];
    const unknownCrcs: number[] = [];

    for (const payload of appPayloads) {
      const { typeCrc, payload: payloadIter } = parseHeader(payload);
      const decoder = messageRegistry.getByCrc(typeCrc);
      if (!decoder) {
        unknownCrcs.push(typeCrc);
        continue;
      }
      const decoded = decoder.decodePayload(payloadIter);
      if (decoded instanceof LoginEnumCluster) {
        enumClusters.push(decoded);
      } else if (decoded instanceof LoginClusterStatus) {
        clusterStatuses.push(decoded);
      } else if (decoded instanceof LoginClusterStatusEx) {
        clusterStatusExes.push(decoded);
      }
    }

    // 6. Should have decoded the cluster trio. The known-but-not-yet-decoded
    //    messages (ServerNowEpochTime, LoginClientToken, CharacterCreationDisabled)
    //    decode silently via the registry, so we just check the ones we care about.
    //    Every message in the captured packet should be registered (no unknownCrcs).
    expect(unknownCrcs, 'every captured message should be registered').toEqual([]);
    expect(enumClusters.length).toBeGreaterThanOrEqual(1);
    expect(clusterStatuses.length).toBeGreaterThanOrEqual(1);
    expect(clusterStatusExes.length).toBeGreaterThanOrEqual(1);

    // 7. Find the "swg" cluster in LoginEnumCluster.
    const enumMsg = enumClusters[0];
    if (enumMsg === undefined) throw new Error('no LoginEnumCluster decoded');
    const swgCluster = enumMsg.clusters.find((c) => c.name === 'swg');
    expect(swgCluster, 'cluster named "swg" should appear in LoginEnumCluster').toBeDefined();
    if (swgCluster === undefined) throw new Error('swg cluster not found in enum');

    // 8. LoginClusterStatus carries the connection address+port for that cluster.
    //    Same clusterId is used to correlate the enum + status records.
    const statusMsg = clusterStatuses[0];
    if (statusMsg === undefined) throw new Error('no LoginClusterStatus decoded');
    const swgStatus = statusMsg.clusters.find((c) => c.clusterId === swgCluster.clusterId);
    expect(swgStatus, 'LoginClusterStatus row for the "swg" cluster').toBeDefined();
    if (swgStatus === undefined) throw new Error('swg status not found');
    expect(swgStatus.connectionServerAddress).toBe('10.254.0.253');
    expect(swgStatus.connectionServerPort).toBe(44463);

    // 9. LoginClusterStatusEx carries branch + networkVersion strings.
    const exMsg = clusterStatusExes[0];
    if (exMsg === undefined) throw new Error('no LoginClusterStatusEx decoded');
    const swgEx = exMsg.clusters.find((c) => c.clusterId === swgCluster.clusterId);
    expect(swgEx, 'LoginClusterStatusEx row for the "swg" cluster').toBeDefined();
    if (swgEx === undefined) throw new Error('swg ex-status not found');
    expect(swgEx.branch).toBe('swg-main');
    expect(swgEx.networkVersion).toBe('20100225-17:43');

    // 10. Sanity-check the union of decoded payloads' bytes contains all
    //     four ground-truth strings (catches any silent regressions).
    let totalLen = 0;
    for (const p of appPayloads) totalLen += p.length;
    const combined = new Uint8Array(totalLen);
    let off = 0;
    for (const p of appPayloads) {
      combined.set(p, off);
      off += p.length;
    }
    const text = Buffer.from(combined).toString('binary');
    expect(text).toContain('swg');
    expect(text).toContain('10.254.0.253');
    expect(text).toContain('swg-main');
    expect(text).toContain('20100225-17:43');

    // Release the keep-alive timer.
    await conn.disconnect();
  });
});
