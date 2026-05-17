/**
 * Tests for SoeConnection's `rawCapture` tee.
 *
 * Strategy: instantiate SoeConnection with `rawCapture: { writePath }`, feed
 * it captured bytes via the test hooks, then read the file back via
 * `readRawCapture` and assert the meta+session+frames look right.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EncryptMethod } from '../types.js';
import { SoeConnection } from './connection.js';
import { readRawCapture } from './raw-capture-io.js';

let tmp: string;
beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'swg-ts-conn-raw-test-'));
});
afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

// Construct a synthetic SessionResponse with known params so we can decrypt
// our own captured bytes if we want to (we don't need to here, but the
// driver tests will).
function makeConfirmPacket(connectionCode: number, encryptCode: number): Uint8Array {
  const buf = new Uint8Array(17);
  buf[0] = 0;
  buf[1] = 2; // Confirm
  buf[2] = (connectionCode >>> 24) & 0xff;
  buf[3] = (connectionCode >>> 16) & 0xff;
  buf[4] = (connectionCode >>> 8) & 0xff;
  buf[5] = connectionCode & 0xff;
  buf[6] = (encryptCode >>> 24) & 0xff;
  buf[7] = (encryptCode >>> 16) & 0xff;
  buf[8] = (encryptCode >>> 8) & 0xff;
  buf[9] = encryptCode & 0xff;
  buf[10] = 2; // crcBytes
  buf[11] = EncryptMethod.UserSupplied;
  buf[12] = EncryptMethod.Xor;
  buf[13] = 0;
  buf[14] = 0;
  buf[15] = 1;
  buf[16] = 0xf0;
  return buf;
}

async function flushAndRead(path: string, conn: SoeConnection): Promise<string> {
  // SoeConnection writes via a write-stream; closing flushes everything.
  // disconnect() calls cleanup() which calls closeRawCapture(). Give the
  // event loop a tick afterwards for the stream's 'finish' event.
  await conn.disconnect().catch(() => {
    /* idle in non-connected state — ignore */
  });
  await delay(10);
  return readFile(path, 'utf8');
}

describe('SoeConnection raw-capture: meta + session + frame tee', () => {
  it('writes a meta line on construction', async () => {
    const path = join(tmp, 'meta-only.ndjson');
    const conn = new SoeConnection({
      endpoint: { host: '10.254.0.253', port: 44453 },
      connectionCode: 0x00294823,
      onAppMessage: () => {},
      rawCapture: { writePath: path, stage: 'login' },
    });
    const text = await flushAndRead(path, conn);
    const firstLine = text.split('\n')[0];
    expect(firstLine).toBeDefined();
    const parsed = JSON.parse(firstLine ?? '');
    expect(parsed.type).toBe('meta');
    expect(parsed.connectionCode).toBe(0x00294823);
    expect(parsed.remoteEndpoint).toBe('10.254.0.253:44453');
    expect(parsed.stage).toBe('login');
    expect(parsed.maxRawPacketSize).toBe(496);
  });

  it('writes a session line on SessionResponse, then frame lines for sends/recvs', async () => {
    const path = join(tmp, 'session-and-frames.ndjson');
    const conn = new SoeConnection({
      endpoint: { host: '10.254.0.253', port: 44453 },
      connectionCode: 0x12345678,
      onAppMessage: () => {},
      rawCapture: { writePath: path, stage: 'game' },
    });
    // Suppress real UDP — sends just record cooked bytes
    conn.testSendOverride = () => {};

    // Inject Confirm (this also writes the recv frame for the Confirm itself
    // since testInjectDatagram would, but testInjectSessionResponse doesn't.
    // We use testInjectSessionResponse so the test stays free of CRC concerns).
    const confirm = makeConfirmPacket(0x12345678, 0xdeadbeef);
    conn.testInjectSessionResponse(confirm);

    // Send one app message — this goes through cookOutgoing → rawSend which
    // captures the cooked bytes.
    conn.sendApp(new Uint8Array([0x01, 0x00, 0xde, 0xad, 0xbe, 0xef]));

    // Flush + close the write stream
    await flushAndRead(path, conn);
    const capture = await readRawCapture(path);
    expect(capture.meta.connectionCode).toBe(0x12345678);
    expect(capture.meta.stage).toBe('game');
    expect(capture.session).not.toBeNull();
    expect(capture.session?.encryptCode).toBe(0xdeadbeef);
    expect(capture.session?.crcBytes).toBe(2);
    expect(capture.session?.encryptMethods).toEqual([
      EncryptMethod.UserSupplied,
      EncryptMethod.Xor,
    ]);

    // sendApp produced one send frame (we used testSendOverride, but
    // captureFrame runs BEFORE testSendOverride). disconnect() in
    // flushAndRead may add a Terminate send frame too, so >= 1 is the
    // tighter contract.
    expect(capture.frames.length).toBeGreaterThanOrEqual(1);
    expect(capture.frames[0]?.direction).toBe('send');
    expect(capture.frames[0]?.bytes.length).toBeGreaterThan(0);
  });

  it('captures both send and recv frames when testInjectDatagram is used', async () => {
    const path = join(tmp, 'send-and-recv.ndjson');
    const conn = new SoeConnection({
      endpoint: { host: '10.254.0.253', port: 44453 },
      connectionCode: 0x12345678,
      onAppMessage: () => {},
      rawCapture: { writePath: path },
    });
    conn.testSendOverride = () => {};

    const confirm = makeConfirmPacket(0x12345678, 0xcafebabe);
    conn.testInjectSessionResponse(confirm);

    // Build a self-encoded payload by routing through sendApp and recapturing
    // the cooked bytes
    let lastCooked: Uint8Array | null = null;
    conn.testSendOverride = (b) => {
      lastCooked = new Uint8Array(b);
    };
    conn.sendApp(new Uint8Array([0x01, 0x00, 0xff, 0xee]));
    expect(lastCooked).not.toBeNull();

    // Re-inject the cooked bytes as if they arrived from the server
    // (this counts as a recv frame in the capture)
    if (lastCooked !== null) {
      conn.testInjectDatagram(lastCooked);
    }

    await flushAndRead(path, conn);
    const capture = await readRawCapture(path);
    const sends = capture.frames.filter((f) => f.direction === 'send');
    const recvs = capture.frames.filter((f) => f.direction === 'recv');
    expect(sends.length).toBeGreaterThanOrEqual(1);
    expect(recvs.length).toBeGreaterThanOrEqual(1);
  });

  it('frames are appended in chronological order with monotonic timestamps', async () => {
    const path = join(tmp, 'monotonic-ts.ndjson');
    const conn = new SoeConnection({
      endpoint: { host: '10.254.0.253', port: 44453 },
      connectionCode: 0x12345678,
      onAppMessage: () => {},
      rawCapture: { writePath: path },
    });
    conn.testSendOverride = () => {};
    conn.testInjectSessionResponse(makeConfirmPacket(0x12345678, 0xfacefeed));

    // Send a few app messages back-to-back
    for (let i = 0; i < 4; i++) {
      conn.sendApp(new Uint8Array([1, 0, i, i, i, i]));
      await delay(1);
    }

    await flushAndRead(path, conn);
    const capture = await readRawCapture(path);
    const tses = capture.frames.map((f) => f.ts);
    expect(tses.length).toBeGreaterThanOrEqual(4);
    for (let i = 1; i < tses.length; i++) {
      const prev = tses[i - 1];
      const cur = tses[i];
      if (prev === undefined || cur === undefined) throw new Error('undefined ts');
      expect(cur).toBeGreaterThanOrEqual(prev);
    }
  });

  it('rawCapture: undefined creates no file', async () => {
    const path = join(tmp, 'should-not-exist.ndjson');
    const conn = new SoeConnection({
      endpoint: { host: '127.0.0.1', port: 1 },
      connectionCode: 0x12345678,
      onAppMessage: () => {},
    });
    conn.testSendOverride = () => {};
    conn.testInjectSessionResponse(makeConfirmPacket(0x12345678, 0xabcdef00));
    conn.sendApp(new Uint8Array([1, 0, 1, 2, 3, 4]));
    await conn.disconnect().catch(() => {});

    // File should not exist
    await expect(readFile(path, 'utf8')).rejects.toThrow();
  });
});
