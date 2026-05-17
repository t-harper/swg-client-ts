/**
 * Live integration test for ClockSync / ClockReflect exchange.
 *
 * Gated on `LIVE=1`. Verifies the round-trip latency probe works end-to-end:
 * we open a real ConnectionServer SoeConnection, force-send a ClockSync, and
 * wait for the server to echo it back as a ClockReflect — which our recv
 * pipeline parses into a real RTT sample.
 *
 * The default ClockSync interval is 45s (way too long for a fast test), so
 * we drive a few manual ClockSync sends with `sendClockSync()` and poll the
 * histogram.
 */
import { describe, expect, it } from 'vitest';

import { ClientIdMsg } from '../../src/messages/connection/client-id-msg.js';
import { ClientPermissionsMessage } from '../../src/messages/connection/client-permissions-message.js';
import { runLoginStage } from '../../src/client/login-stage.js';
import { MessageDispatcher } from '../../src/client/dispatcher.js';
import { SoeConnection } from '../../src/soe/connection.js';
import { liveAccount } from './helpers.js';

const LIVE = process.env.LIVE === '1';
const HOST = process.env.SWG_HOST ?? '10.254.0.253';
const PORT = Number(process.env.SWG_LOGIN_PORT ?? 44453);

describe.skipIf(!LIVE)('live ClockSync / ClockReflect round-trip', () => {
  it('records an RTT sample when the server reflects a manually-sent ClockSync', async () => {
    // Stand up a real Stage-1 login so we have a token + a cluster to attach to.
    const account = liveAccount('cs');
    const login = await runLoginStage({
      endpoint: { host: HOST, port: PORT },
      username: account,
      password: undefined,
    });
    expect(login.clusters.length).toBeGreaterThan(0);
    const swg = login.clusters.find((c) => c.name === 'swg');
    expect(swg).toBeDefined();
    if (swg === undefined) throw new Error('cluster not found');
    expect(swg.connectionServerAddress).toBeDefined();
    expect(swg.connectionServerPort).toBeDefined();
    if (swg.connectionServerAddress === undefined || swg.connectionServerPort === undefined) {
      throw new Error('cluster missing connection address');
    }

    let dispatcher: MessageDispatcher | null = null;
    const conn = new SoeConnection({
      endpoint: { host: swg.connectionServerAddress, port: swg.connectionServerPort },
      // Disable the 45s periodic timer — we'll drive ClockSync manually for
      // fast verification.
      clockSyncIntervalMs: 0,
      onAppMessage: (payload) => {
        dispatcher?.handleAppMessage(payload);
      },
    });
    dispatcher = new MessageDispatcher({ connection: conn, stageLabel: 'connection' });

    try {
      await conn.connect();

      // Send ClientIdMsg + wait for ClientPermissionsMessage so the server
      // considers us a real client. Otherwise some servers may decline to
      // engage with ClockSync without a fully-authed connection.
      const permsP = dispatcher.waitFor(ClientPermissionsMessage, { timeoutMs: 10_000 });
      dispatcher.send(new ClientIdMsg(login.token.bytes, 0));
      await permsP;

      // Send 3 ClockSyncs spaced 200ms apart and poll for samples.
      conn.sendClockSync();
      await new Promise((r) => setTimeout(r, 300));
      conn.sendClockSync();
      await new Promise((r) => setTimeout(r, 300));
      conn.sendClockSync();

      // Give the server a beat to reflect, then poll up to 5s.
      let stats = conn.getLatencyStats();
      const deadline = Date.now() + 5_000;
      while (stats === null && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
        stats = conn.getLatencyStats();
      }

      expect(stats).not.toBeNull();
      if (stats === null) throw new Error('unreachable');
      expect(stats.count).toBeGreaterThanOrEqual(1);
      // Localhost-ish — RTT should be well under 1s.
      expect(stats.min).toBeLessThan(1_000);
      expect(stats.max).toBeLessThan(1_000);
      expect(stats.mean).toBeGreaterThanOrEqual(0);
    } finally {
      try {
        await conn.disconnect();
      } catch {
        // ignore
      }
    }
  }, 30_000);
});
