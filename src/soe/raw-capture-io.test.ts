/**
 * Round-trip tests for the raw-capture NDJSON serializer + reader.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EncryptMethod } from '../types.js';
import {
  type RawCaptureFrame,
  type RawCaptureMeta,
  type RawCaptureSession,
  parseRawCapture,
  readRawCapture,
  serializeRawCapture,
  writeRawCapture,
} from './raw-capture-io.js';

const meta: RawCaptureMeta = {
  ts: 1_700_000_000_000,
  localEndpoint: '0.0.0.0:54321',
  remoteEndpoint: '10.254.0.253:44453',
  connectionCode: 0x00294823,
  maxRawPacketSize: 496,
  stage: 'login',
};

const session: RawCaptureSession = {
  ts: 1_700_000_000_010,
  encryptCode: 0xfe7b4873,
  connectionCode: 0x00294823,
  crcBytes: 2,
  encryptMethods: [EncryptMethod.UserSupplied, EncryptMethod.Xor],
  negotiatedMaxRawPacketSize: 496,
};

const frames: RawCaptureFrame[] = [
  {
    direction: 'send',
    ts: 1_700_000_000_001,
    bytes: new Uint8Array([0, 1, 0, 0, 0, 2, 0, 0x29, 0x48, 0x23, 0, 0, 1, 0xf0]),
  },
  {
    direction: 'recv',
    ts: 1_700_000_000_011,
    bytes: new Uint8Array([
      0, 2, 0, 0x29, 0x48, 0x23, 0xfe, 0x7b, 0x48, 0x73, 2, 1, 4, 0, 0, 1, 0xf0,
    ]),
  },
  {
    direction: 'send',
    ts: 1_700_000_000_050,
    bytes: new Uint8Array([0, 0x09, 0, 1, 0xab, 0xcd, 0xef]),
  },
];

describe('raw-capture-io: serialize → parse round-trip', () => {
  it('preserves meta, session, and every frame byte-for-byte', () => {
    const text = serializeRawCapture({ meta, session, frames });
    const parsed = parseRawCapture(text);

    expect(parsed.meta).toEqual(meta);
    expect(parsed.session).toEqual(session);
    expect(parsed.frames).toHaveLength(frames.length);
    for (let i = 0; i < frames.length; i++) {
      const expected = frames[i];
      const actual = parsed.frames[i];
      if (expected === undefined || actual === undefined) throw new Error('missing frame');
      expect(actual.direction).toBe(expected.direction);
      expect(actual.ts).toBe(expected.ts);
      expect(Array.from(actual.bytes)).toEqual(Array.from(expected.bytes));
    }
  });

  it('handles a capture with no session (handshake never completed)', () => {
    const text = serializeRawCapture({ meta, session: null, frames: [frames[0] as RawCaptureFrame] });
    const parsed = parseRawCapture(text);
    expect(parsed.session).toBeNull();
    expect(parsed.frames).toHaveLength(1);
  });

  it('skips unknown line types (forward-compat)', () => {
    const lines = [
      JSON.stringify({ type: 'meta', ts: 1, localEndpoint: null, remoteEndpoint: 'x:1', connectionCode: 0, maxRawPacketSize: 496 }),
      JSON.stringify({ type: 'future', anything: true }),
      JSON.stringify({ type: 'frame', direction: 'send', ts: 2, bytes: 'aabb' }),
    ].join('\n');
    const parsed = parseRawCapture(lines);
    expect(parsed.frames).toHaveLength(1);
    expect(Array.from(parsed.frames[0]?.bytes ?? [])).toEqual([0xaa, 0xbb]);
  });

  it('tolerates frames without an explicit "type" field (legacy)', () => {
    const lines = [
      JSON.stringify({ type: 'meta', ts: 1, localEndpoint: null, remoteEndpoint: 'x:1', connectionCode: 0, maxRawPacketSize: 496 }),
      JSON.stringify({ direction: 'recv', ts: 2, bytes: '00ff' }),
    ].join('\n');
    const parsed = parseRawCapture(lines);
    expect(parsed.frames).toHaveLength(1);
    expect(parsed.frames[0]?.direction).toBe('recv');
  });

  it('throws helpful errors on malformed JSON', () => {
    expect(() => parseRawCapture('not-json\n')).toThrow(/line 1/);
  });

  it('throws on invalid hex characters', () => {
    const bad =
      JSON.stringify({ type: 'meta', ts: 1, localEndpoint: null, remoteEndpoint: 'x:1', connectionCode: 0, maxRawPacketSize: 496 }) +
      '\n' +
      JSON.stringify({ type: 'frame', direction: 'send', ts: 2, bytes: 'zzzz' });
    expect(() => parseRawCapture(bad)).toThrow(/invalid hex/);
  });

  it('throws on odd-length hex', () => {
    const bad =
      JSON.stringify({ type: 'meta', ts: 1, localEndpoint: null, remoteEndpoint: 'x:1', connectionCode: 0, maxRawPacketSize: 496 }) +
      '\n' +
      JSON.stringify({ type: 'frame', direction: 'send', ts: 2, bytes: 'abc' });
    expect(() => parseRawCapture(bad)).toThrow(/odd-length/);
  });

  it('produces a single trailing newline', () => {
    const text = serializeRawCapture({ meta, session: null, frames: [] });
    expect(text.endsWith('\n')).toBe(true);
    expect(text.endsWith('\n\n')).toBe(false);
  });

  it('synthesizes a placeholder meta when the file has none', () => {
    const onlyFrame = JSON.stringify({ type: 'frame', direction: 'send', ts: 1234, bytes: 'aa' });
    const parsed = parseRawCapture(onlyFrame);
    expect(parsed.meta.connectionCode).toBe(0);
    expect(parsed.meta.remoteEndpoint).toBe('unknown:0');
    expect(parsed.meta.ts).toBe(1234);
  });
});

describe('raw-capture-io: file I/O', () => {
  let tmp: string;
  beforeAll(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'swg-ts-raw-capture-test-'));
  });
  afterAll(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('writes and reads back identical content', async () => {
    const path = join(tmp, 'capture.ndjson');
    await writeRawCapture(path, { meta, session, frames });
    const onDisk = await readFile(path, 'utf8');
    const parsed = await readRawCapture(path);

    // The file should be exactly `serializeRawCapture` output
    expect(onDisk).toBe(serializeRawCapture({ meta, session, frames }));
    expect(parsed.meta).toEqual(meta);
    expect(parsed.session).toEqual(session);
    expect(parsed.frames).toHaveLength(frames.length);
  });
});
