import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { appendCrc } from '../crc/crc32.js';
import type { EncryptionParams } from '../types.js';
import { EncryptMethod } from '../types.js';
import {
  buildClockReflect,
  buildClockSync,
  parseClockReflect,
} from './clock-sync.js';
import { SoeConnection } from './connection.js';
import { applyEncryption, reverseEncryption } from './encrypt.js';
import { SoePacketType } from './packet-types.js';

function loadHexFixture(relPath: string): Uint8Array {
  const url = new URL(`../../tests/fixtures/${relPath}`, import.meta.url);
  const text = readFileSync(fileURLToPath(url), 'utf8');
  const cleaned = text
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .join(' ')
    .replace(/\s+/g, '');
  if (cleaned.length % 2 !== 0) throw new Error(`bad hex: odd length ${cleaned.length}`);
  const out = new Uint8Array(cleaned.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(cleaned.substr(i * 2, 2), 16);
  }
  return out;
}

const SESSION_RESPONSE = loadHexFixture('session-response-17b.hex');
const LOGIN_ENUM_CLUSTER_PACKET = loadHexFixture('login-enum-cluster-223b.hex');

describe('SoeConnection end-state — captured fixtures through receive pipeline', () => {
  it('feeds SessionResponse + 223-byte LoginEnumCluster packet, yields plaintext payload', async () => {
    const received: Uint8Array[] = [];
    const events: unknown[] = [];

    // Use the SAME connectionCode that the captured SessionRequest used
    // (0x00294823 — see tests/fixtures/session-request-14b.hex).
    const conn = new SoeConnection({
      endpoint: { host: '127.0.0.1', port: 1 }, // never actually sent
      connectionCode: 0x00294823,
      onAppMessage: (payload) => {
        received.push(payload);
      },
      onEvent: (e) => {
        events.push(e);
      },
    });
    // Swallow the AckAll the connection wants to send back
    conn.testSendOverride = () => {
      /* no-op */
    };

    // 1. Inject the SessionResponse synchronously (bypass UDP)
    const params: EncryptionParams = conn.testInjectSessionResponse(SESSION_RESPONSE);
    expect(params.encryptCode).toBe(0xfe7b4873);
    expect(params.crcBytes).toBe(2);
    expect(params.encryptMethods).toEqual([EncryptMethod.UserSupplied, EncryptMethod.Xor]);

    // 2. The captured packet's reliable seq is 1 (the server's second reliable
    // packet — we never captured seq 0). Skip our expected counter forward so
    // the receive pipeline accepts seq 1 in-order.
    conn.testForceIncomingExpectedId(1);
    conn.testInjectDatagram(LOGIN_ENUM_CLUSTER_PACKET);

    // 3. Verify we got the decompressed app payload
    expect(received.length).toBeGreaterThan(0);
    // The packet was a Multi inside Reliable1, containing 5-6 sub-messages
    // (ServerNowEpochTime, LoginClientToken, LoginEnumCluster, ...). The first
    // call should yield a message with the LoginEnumCluster CRC + plaintext
    // containing "swg", "10.254.0.253", "swg-main", "20100225-17:43".

    // Concatenate all received app messages and check the union of bytes
    // contains the ground-truth strings.
    let total = 0;
    for (const r of received) total += r.length;
    const combined = new Uint8Array(total);
    let off = 0;
    for (const r of received) {
      combined.set(r, off);
      off += r.length;
    }
    const text = Buffer.from(combined).toString('binary');
    expect(text).toContain('swg');
    expect(text).toContain('10.254.0.253');
    expect(text).toContain('swg-main');
    expect(text).toContain('20100225-17:43');

    // Clean up to release the timer
    await conn.disconnect();
  });

  it('emits session_negotiated event when SessionResponse arrives', () => {
    const events: unknown[] = [];
    const conn = new SoeConnection({
      endpoint: { host: '127.0.0.1', port: 1 },
      connectionCode: 0x00294823,
      onAppMessage: () => {
        // no-op
      },
      onEvent: (e) => events.push(e),
    });
    conn.testInjectSessionResponse(SESSION_RESPONSE);
    expect(events.length).toBe(1);
    const ev = events[0] as { kind: string };
    expect(ev.kind).toBe('session_negotiated');
  });

  it('marks isConnected and exposes params after handshake', () => {
    const conn = new SoeConnection({
      endpoint: { host: '127.0.0.1', port: 1 },
      connectionCode: 0x00294823,
      onAppMessage: () => {
        // no-op
      },
    });
    expect(conn.isConnected).toBe(false);
    expect(conn.params).toBeUndefined();
    conn.testInjectSessionResponse(SESSION_RESPONSE);
    expect(conn.isConnected).toBe(true);
    expect(conn.params?.encryptCode).toBe(0xfe7b4873);
  });

  it('rejects bad CRC with a corrupt_packet event', () => {
    const events: Array<{ kind: string }> = [];
    const conn = new SoeConnection({
      endpoint: { host: '127.0.0.1', port: 1 },
      connectionCode: 0x00294823,
      onAppMessage: () => {
        // no-op
      },
      onEvent: (e) => events.push(e),
    });
    conn.testSendOverride = () => {
      /* swallow */
    };
    conn.testInjectSessionResponse(SESSION_RESPONSE);
    // Flip a byte in the captured packet — should fail CRC
    const bad = new Uint8Array(LOGIN_ENUM_CLUSTER_PACKET);
    if (bad[3] !== undefined) bad[3] ^= 0xff;
    conn.testInjectDatagram(bad);
    expect(events.some((e) => e.kind === 'corrupt_packet')).toBe(true);
  });
});

describe('SoeConnection round-trip (send + receive of self-encoded packet)', () => {
  it('sendApp byte sequence can be decoded by a peer SoeConnection', () => {
    // Use matching params for the two ends
    const params: EncryptionParams = {
      encryptCode: 0xdeadbeef,
      connectionCode: 0x12345678,
      crcBytes: 2,
      encryptMethods: [EncryptMethod.UserSupplied, EncryptMethod.Xor],
      maxRawPacketSize: 496,
    };

    // Build a synthetic 17-byte SessionResponse with these params
    const synthConfirm = new Uint8Array(17);
    synthConfirm[0] = 0;
    synthConfirm[1] = 2; // Confirm
    synthConfirm[2] = (params.connectionCode >>> 24) & 0xff;
    synthConfirm[3] = (params.connectionCode >>> 16) & 0xff;
    synthConfirm[4] = (params.connectionCode >>> 8) & 0xff;
    synthConfirm[5] = params.connectionCode & 0xff;
    synthConfirm[6] = (params.encryptCode >>> 24) & 0xff;
    synthConfirm[7] = (params.encryptCode >>> 16) & 0xff;
    synthConfirm[8] = (params.encryptCode >>> 8) & 0xff;
    synthConfirm[9] = params.encryptCode & 0xff;
    synthConfirm[10] = params.crcBytes;
    synthConfirm[11] = params.encryptMethods[0];
    synthConfirm[12] = params.encryptMethods[1];
    synthConfirm[13] = (params.maxRawPacketSize >>> 24) & 0xff;
    synthConfirm[14] = (params.maxRawPacketSize >>> 16) & 0xff;
    synthConfirm[15] = (params.maxRawPacketSize >>> 8) & 0xff;
    synthConfirm[16] = params.maxRawPacketSize & 0xff;

    // The "sender" — capture cooked bytes via testSendOverride
    let lastCooked: Uint8Array | null = null;
    const sender = new SoeConnection({
      endpoint: { host: '127.0.0.1', port: 1 },
      connectionCode: params.connectionCode,
      onAppMessage: () => {
        // sender doesn't receive in this test
      },
    });
    sender.testSendOverride = (bytes) => {
      lastCooked = new Uint8Array(bytes);
    };
    sender.testInjectSessionResponse(synthConfirm);

    // Now send an app payload
    const appPayload = new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0x01, 0x02, 0x03]);
    sender.sendApp(appPayload);
    expect(lastCooked).not.toBeNull();
    if (lastCooked === null) throw new Error('lastCooked null after sendApp');

    // The receiver: SAME params, fresh state
    const received: Uint8Array[] = [];
    const receiver = new SoeConnection({
      endpoint: { host: '127.0.0.1', port: 1 },
      connectionCode: params.connectionCode,
      onAppMessage: (m) => received.push(m),
    });
    receiver.testSendOverride = () => {
      /* swallow receiver's AckAll */
    };
    receiver.testInjectSessionResponse(synthConfirm);

    // Hand the cooked datagram to the receiver
    receiver.testInjectDatagram(lastCooked);
    expect(received.length).toBe(1);
    expect(received[0]).toEqual(appPayload);
  });
});

describe('SoeConnection ClockSync / ClockReflect', () => {
  /**
   * Build the SAME synthetic SessionResponse used by the round-trip test —
   * encryptCode + crcBytes + methods are constants so cookOutgoing /
   * uncookIncoming can round-trip with `applyEncryption` + `appendCrc` here.
   */
  function buildSynthConfirm(params: EncryptionParams): Uint8Array {
    const out = new Uint8Array(17);
    out[0] = 0;
    out[1] = 2;
    out[2] = (params.connectionCode >>> 24) & 0xff;
    out[3] = (params.connectionCode >>> 16) & 0xff;
    out[4] = (params.connectionCode >>> 8) & 0xff;
    out[5] = params.connectionCode & 0xff;
    out[6] = (params.encryptCode >>> 24) & 0xff;
    out[7] = (params.encryptCode >>> 16) & 0xff;
    out[8] = (params.encryptCode >>> 8) & 0xff;
    out[9] = params.encryptCode & 0xff;
    out[10] = params.crcBytes;
    out[11] = params.encryptMethods[0];
    out[12] = params.encryptMethods[1];
    out[13] = (params.maxRawPacketSize >>> 24) & 0xff;
    out[14] = (params.maxRawPacketSize >>> 16) & 0xff;
    out[15] = (params.maxRawPacketSize >>> 8) & 0xff;
    out[16] = params.maxRawPacketSize & 0xff;
    return out;
  }

  const params: EncryptionParams = {
    encryptCode: 0xdeadbeef,
    connectionCode: 0x12345678,
    crcBytes: 2,
    encryptMethods: [EncryptMethod.UserSupplied, EncryptMethod.Xor],
    maxRawPacketSize: 496,
  };

  function cookForWire(cooked: Uint8Array): Uint8Array {
    const encrypted = applyEncryption(cooked, params.encryptMethods, params.encryptCode);
    return appendCrc(encrypted, params.encryptCode, params.crcBytes);
  }

  function uncookFromWire(datagram: Uint8Array): Uint8Array {
    // Strip CRC then reverse encryption — mirrors uncookIncoming inside connection.
    const body = datagram.subarray(0, datagram.length - params.crcBytes);
    return reverseEncryption(body, params.encryptMethods, params.encryptCode);
  }

  it('auto-replies to an inbound ClockSync with a ClockReflect that echoes timeStamp', () => {
    const sent: Uint8Array[] = [];
    let rttCallbackCount = 0;
    const conn = new SoeConnection({
      endpoint: { host: '127.0.0.1', port: 1 },
      connectionCode: params.connectionCode,
      // Disable periodic ClockSync so we don't accidentally send extras.
      clockSyncIntervalMs: 0,
      onAppMessage: () => {
        // no-op
      },
      onClockSync: () => {
        rttCallbackCount++;
      },
    });
    conn.testSendOverride = (bytes) => {
      sent.push(new Uint8Array(bytes));
    };
    conn.testInjectSessionResponse(buildSynthConfirm(params));

    // Server "sends" us a ClockSync — cook it for the wire then inject.
    const sync = buildClockSync(0xc0de, {
      masterPingTime: 12,
      averagePingTime: 15,
      lowPingTime: 5,
      highPingTime: 40,
      lastPingTime: 10,
      ourSent: 100n,
      ourReceived: 99n,
    });
    const cookedSync = cookForWire(sync);
    conn.testInjectDatagram(cookedSync);

    // Connection should have auto-sent a ClockReflect.
    expect(sent.length).toBe(1);
    const reflectCooked = uncookFromWire(sent[0] as Uint8Array);
    expect(reflectCooked[0]).toBe(0);
    expect(reflectCooked[1]).toBe(SoePacketType.ClockReflect);

    const reflect = parseClockReflect(reflectCooked);
    expect(reflect.timeStamp).toBe(0xc0de); // echoed
    expect(reflect.yourSent).toBe(100n); // echoed
    expect(reflect.yourReceived).toBe(99n); // echoed

    // We didn't initiate, so no RTT sample should be recorded (and no
    // onClockSync callback fired — that fires on ClockReflect receive).
    expect(rttCallbackCount).toBe(0);
    expect(conn.getLatencyStats()).toBeNull();
  });

  it('records an RTT sample when a ClockReflect arrives', () => {
    const rttCallbacks: number[] = [];
    const conn = new SoeConnection({
      endpoint: { host: '127.0.0.1', port: 1 },
      connectionCode: params.connectionCode,
      clockSyncIntervalMs: 0,
      onAppMessage: () => {
        // no-op
      },
      onClockSync: (rtt) => rttCallbacks.push(rtt),
    });
    conn.testSendOverride = () => {
      /* swallow */
    };
    conn.testInjectSessionResponse(buildSynthConfirm(params));

    // We simulate having sent a ClockSync at timestamp t0; the server
    // reflects with that timeStamp; we receive it and the delta against
    // current local stamp is the RTT.
    //
    // Just use a recent-ish low-16-bits stamp to keep the delta small. The
    // RTT measured equals (currentStamp - reflectedStamp) & 0xffff (mod
    // the SyncStampShortDeltaTime branch).
    const reflectedStamp = (Date.now() - 25) & 0xffff;
    const fakeSync = {
      zeroByte: 0,
      packetType: 7,
      timeStamp: reflectedStamp,
      masterPingTime: 0,
      averagePingTime: 0,
      lowPingTime: 0,
      highPingTime: 0,
      lastPingTime: 0,
      ourSent: 0n,
      ourReceived: 0n,
    };
    const reflect = buildClockReflect(fakeSync, Date.now() & 0xffffffff);
    conn.testInjectDatagram(cookForWire(reflect));

    const stats = conn.getLatencyStats();
    expect(stats).not.toBeNull();
    if (stats === null) throw new Error('unreachable');
    expect(stats.count).toBe(1);
    expect(stats.samples.length).toBe(1);
    // The sample should be a small positive number — well under a second.
    expect(stats.samples[0]).toBeGreaterThanOrEqual(0);
    expect(stats.samples[0]).toBeLessThan(1000);
    // The onClockSync callback should have fired once with the same value.
    expect(rttCallbacks.length).toBe(1);
    expect(rttCallbacks[0]).toBe(stats.samples[0]);
  });

  it('sendClockSync produces a valid wire packet through the encryption pipeline', () => {
    const sent: Uint8Array[] = [];
    const conn = new SoeConnection({
      endpoint: { host: '127.0.0.1', port: 1 },
      connectionCode: params.connectionCode,
      clockSyncIntervalMs: 0,
      onAppMessage: () => {
        // no-op
      },
    });
    conn.testSendOverride = (bytes) => {
      sent.push(new Uint8Array(bytes));
    };
    conn.testInjectSessionResponse(buildSynthConfirm(params));

    const stamp = conn.sendClockSync();
    expect(stamp).toBeGreaterThanOrEqual(0);
    expect(stamp).toBeLessThanOrEqual(0xffff);
    expect(sent.length).toBe(1);
    const cooked = uncookFromWire(sent[0] as Uint8Array);
    expect(cooked[0]).toBe(0);
    expect(cooked[1]).toBe(SoePacketType.ClockSync);
    // timeStamp at off=2..3 should match what sendClockSync reported.
    expect(((cooked[2] ?? 0) << 8) | (cooked[3] ?? 0)).toBe(stamp);
  });

  it('getLatencyStats summarizes multiple samples with p50/p95/p99/min/max/mean', () => {
    const conn = new SoeConnection({
      endpoint: { host: '127.0.0.1', port: 1 },
      connectionCode: params.connectionCode,
      clockSyncIntervalMs: 0,
      onAppMessage: () => {
        // no-op
      },
    });
    conn.testInjectSessionResponse(buildSynthConfirm(params));
    // Inject synthetic samples directly through the test hook
    for (let i = 1; i <= 100; i++) conn.testPushLatencySample(i);
    const stats = conn.getLatencyStats();
    if (stats === null) throw new Error('unreachable');
    expect(stats.count).toBe(100);
    expect(stats.p50).toBe(50);
    expect(stats.p95).toBe(95);
    expect(stats.p99).toBe(99);
    expect(stats.min).toBe(1);
    expect(stats.max).toBe(100);
    expect(stats.mean).toBe(50.5);
  });

  it('ignores a malformed ClockSync without throwing (emits corrupt_packet)', () => {
    const events: Array<{ kind: string }> = [];
    const conn = new SoeConnection({
      endpoint: { host: '127.0.0.1', port: 1 },
      connectionCode: params.connectionCode,
      clockSyncIntervalMs: 0,
      onAppMessage: () => {
        // no-op
      },
      onEvent: (e) => events.push(e),
    });
    conn.testSendOverride = () => {
      /* swallow */
    };
    conn.testInjectSessionResponse(buildSynthConfirm(params));

    // Build a "ClockSync" that's only 10 bytes — too short to parse.
    const truncated = new Uint8Array(10);
    truncated[0] = 0;
    truncated[1] = SoePacketType.ClockSync;
    conn.testInjectDatagram(cookForWire(truncated));
    expect(events.some((e) => e.kind === 'corrupt_packet')).toBe(true);
  });
});
