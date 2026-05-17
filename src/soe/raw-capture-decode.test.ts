/**
 * Tests for the offline SOE decoder.
 *
 * Strategy 1: hand-construct a synthetic capture (Connect + Confirm + a
 * Reliable1 packet that the live encryption pipeline produced for known
 * cleartext) and feed it through the driver. Assert the recovered app
 * payloads round-trip back to the cleartext.
 *
 * Strategy 2: use the live `tests/fixtures/session-response-17b.hex` +
 * `tests/fixtures/login-enum-cluster-223b.hex` pair (captured from a real
 * SwgClient_r.exe session) — the decoder must reproduce the same plaintext
 * the live `SoeConnection.test.ts` end-state extracts.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { EncryptMethod } from '../types.js';
import { SoeConnection } from './connection.js';
import {
  OfflineSoeDriver,
  decodeRawFrames,
} from './raw-capture-decode.js';
import type {
  RawCaptureFrame,
  RawCaptureSession,
} from './raw-capture-io.js';

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

const SESSION_REQUEST = loadHexFixture('session-request-14b.hex');
const SESSION_RESPONSE = loadHexFixture('session-response-17b.hex');
const LOGIN_ENUM_CLUSTER_PACKET = loadHexFixture('login-enum-cluster-223b.hex');

describe('OfflineSoeDriver: handshake handling', () => {
  it('identifies SessionRequest and SessionResponse without needing pre-configured session', () => {
    const driver = new OfflineSoeDriver(null);

    const reqFrame: RawCaptureFrame = {
      direction: 'send',
      ts: 0,
      bytes: SESSION_REQUEST,
    };
    const reqResult = driver.feed(reqFrame, 0);
    expect(reqResult.description.kind).toBe('session_request');
    if (reqResult.description.kind === 'session_request') {
      expect(reqResult.description.connectionCode).toBe(0x00294823);
      expect(reqResult.description.protocolVersion).toBe(2);
    }

    const respFrame: RawCaptureFrame = {
      direction: 'recv',
      ts: 1,
      bytes: SESSION_RESPONSE,
    };
    const respResult = driver.feed(respFrame, 1);
    expect(respResult.description.kind).toBe('session_response');
    if (respResult.description.kind === 'session_response') {
      expect(respResult.description.encryptCode).toBe(0xfe7b4873);
      expect(respResult.description.crcBytes).toBe(2);
    }
    // After Confirm, the driver should now have session params
    expect(driver.session).not.toBeNull();
    expect(driver.session?.encryptCode).toBe(0xfe7b4873);
  });
});

describe('OfflineSoeDriver: real captured Reliable1 packet decode', () => {
  // Side-effect: register every message decoder so we get named messages back.
  // Mirrors `replay.ts` import.
  beforeAll(async () => {
    await import('../client/swg-client.js');
  });

  it('decodes the live LoginEnumCluster fixture into named app payloads', () => {
    const session: RawCaptureSession = {
      ts: 0,
      encryptCode: 0xfe7b4873,
      connectionCode: 0x00294823,
      crcBytes: 2,
      encryptMethods: [EncryptMethod.UserSupplied, EncryptMethod.Xor],
      negotiatedMaxRawPacketSize: 496,
    };
    const driver = new OfflineSoeDriver(session);

    // The captured fixture is reliable seq 1 (we never captured seq 0).
    // The driver's first-reliable auto-bump handles this — no manual
    // testForceExpectedId required.
    const result = driver.feed(
      { direction: 'recv', ts: 0, bytes: LOGIN_ENUM_CLUSTER_PACKET },
      0,
    );

    expect(result.error).toBeNull();
    expect(result.appPayloads.length).toBeGreaterThan(0);

    // The fixture contains LoginEnumCluster + a few siblings (ServerNowEpochTime,
    // LoginClientToken, ...). Check at least LoginEnumCluster was decoded.
    const names = result.appPayloads.map((a) => a.messageName);
    expect(names.some((n) => n === 'LoginEnumCluster')).toBe(true);

    // Validate the literal strings in the combined bytes
    let total = 0;
    for (const a of result.appPayloads) total += a.bytes.length;
    const combined = new Uint8Array(total);
    let off = 0;
    for (const a of result.appPayloads) {
      combined.set(a.bytes, off);
      off += a.bytes.length;
    }
    const text = Buffer.from(combined).toString('binary');
    expect(text).toContain('swg');
    expect(text).toContain('10.254.0.253');
  });
});

describe('OfflineSoeDriver: round-trip through SoeConnection', () => {
  it('decodes a payload that was self-encoded via SoeConnection.sendApp', () => {
    const params = {
      encryptCode: 0xdeadbeef,
      connectionCode: 0x12345678,
      crcBytes: 2,
      encryptMethods: [EncryptMethod.UserSupplied, EncryptMethod.Xor] as [
        EncryptMethod,
        EncryptMethod,
      ],
      maxRawPacketSize: 496,
    };

    // Build a Confirm packet for these params
    const confirm = new Uint8Array(17);
    confirm[0] = 0;
    confirm[1] = 2;
    confirm[2] = (params.connectionCode >>> 24) & 0xff;
    confirm[3] = (params.connectionCode >>> 16) & 0xff;
    confirm[4] = (params.connectionCode >>> 8) & 0xff;
    confirm[5] = params.connectionCode & 0xff;
    confirm[6] = (params.encryptCode >>> 24) & 0xff;
    confirm[7] = (params.encryptCode >>> 16) & 0xff;
    confirm[8] = (params.encryptCode >>> 8) & 0xff;
    confirm[9] = params.encryptCode & 0xff;
    confirm[10] = params.crcBytes;
    confirm[11] = params.encryptMethods[0];
    confirm[12] = params.encryptMethods[1];
    confirm[13] = 0;
    confirm[14] = 0;
    confirm[15] = 1;
    confirm[16] = 0xf0;

    // Capture cooked bytes from a live SoeConnection
    const cooked: Uint8Array[] = [];
    const conn = new SoeConnection({
      endpoint: { host: '127.0.0.1', port: 1 },
      connectionCode: params.connectionCode,
      onAppMessage: () => {},
    });
    conn.testSendOverride = (b) => {
      cooked.push(new Uint8Array(b));
    };
    conn.testInjectSessionResponse(confirm);

    const appBytes = new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0x42, 0x43, 0x44]);
    conn.sendApp(appBytes);
    expect(cooked).toHaveLength(1);

    // Feed cooked through the offline driver
    const session: RawCaptureSession = {
      ts: 0,
      encryptCode: params.encryptCode,
      connectionCode: params.connectionCode,
      crcBytes: params.crcBytes,
      encryptMethods: params.encryptMethods,
      negotiatedMaxRawPacketSize: params.maxRawPacketSize,
    };
    const frames: RawCaptureFrame[] = [
      { direction: 'send', ts: 0, bytes: cooked[0] as Uint8Array },
    ];
    const decoded = decodeRawFrames(frames, session);
    expect(decoded[0]?.appPayloads).toHaveLength(1);
    expect(Array.from(decoded[0]?.appPayloads[0]?.bytes ?? [])).toEqual(Array.from(appBytes));
  });
});

describe('OfflineSoeDriver: first-reliable auto-bump', () => {
  // Side-effect: register every message decoder for app-payload names
  beforeAll(async () => {
    await import('../client/swg-client.js');
  });

  it('delivers a Reliable packet whose seq is not 0 (mid-session capture)', () => {
    const session: RawCaptureSession = {
      ts: 0,
      encryptCode: 0xfe7b4873,
      connectionCode: 0x00294823,
      crcBytes: 2,
      encryptMethods: [EncryptMethod.UserSupplied, EncryptMethod.Xor],
      negotiatedMaxRawPacketSize: 496,
    };
    // No manual force — auto-bump should kick in
    const decoded = decodeRawFrames(
      [{ direction: 'recv', ts: 0, bytes: LOGIN_ENUM_CLUSTER_PACKET }],
      session,
    );
    expect(decoded[0]?.appPayloads.length).toBeGreaterThan(0);
  });
});

describe('OfflineSoeDriver: error handling', () => {
  it('reports CRC mismatch as a frame error, not a throw', () => {
    const session: RawCaptureSession = {
      ts: 0,
      encryptCode: 0xfe7b4873,
      connectionCode: 0x00294823,
      crcBytes: 2,
      encryptMethods: [EncryptMethod.UserSupplied, EncryptMethod.Xor],
      negotiatedMaxRawPacketSize: 496,
    };
    const driver = new OfflineSoeDriver(session);
    const bad = new Uint8Array(LOGIN_ENUM_CLUSTER_PACKET);
    if (bad[3] !== undefined) bad[3] ^= 0xff;
    const result = driver.feed({ direction: 'recv', ts: 0, bytes: bad }, 0);
    expect(result.error).toMatch(/CRC mismatch/);
    expect(result.appPayloads).toHaveLength(0);
  });

  it('returns "no session params" if asked to decrypt without a session', () => {
    const driver = new OfflineSoeDriver(null);
    // Send a frame that's not a Connect/Confirm — should error
    const frame: RawCaptureFrame = {
      direction: 'recv',
      ts: 0,
      bytes: new Uint8Array([0, 9, 0, 0, 0xaa, 0xbb]),
    };
    const result = driver.feed(frame, 0);
    expect(result.error).toMatch(/no session params/);
  });

  it('handles a tiny frame gracefully', () => {
    const driver = new OfflineSoeDriver(null);
    const result = driver.feed({ direction: 'recv', ts: 0, bytes: new Uint8Array([0]) }, 0);
    expect(result.error).toMatch(/too short/);
  });
});
