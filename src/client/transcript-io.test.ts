/**
 * Unit tests for the NDJSON capture serializer (`transcript-io.ts`).
 *
 * Covers:
 *   - Round-trip of a synthetic CapturedEvent[] (send + recv + unknown CRC + decode error)
 *   - bigint round-trip (NetworkId in decoded payload)
 *   - Uint8Array round-trip (token bytes)
 *   - attachCapture() on a fake dispatcher captures both directions losslessly
 *   - File read/write
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { encodeMessage } from '../messages/base.js';
import type { GameNetworkMessage } from '../messages/interface.js';
import { LoginClientId } from '../messages/login/login-client-id.js';
import { LoginClientToken } from '../messages/login/login-client-token.js';
import type { SoeConnection } from '../soe/connection.js';
import { MessageDispatcher } from './dispatcher.js';
import {
  type CapturedEvent,
  attachCapture,
  eventsFromTranscript,
  readTranscript,
  transcriptFromNdjson,
  transcriptToNdjson,
  writeTranscript,
} from './transcript-io.js';

// Side-effect: register message decoders we exercise here.
import '../messages/login/index.js';

interface FakeConnection {
  sent: Uint8Array[];
  sendApp(payload: Uint8Array): void;
  disconnect(): Promise<void>;
  readonly isConnected: boolean;
  readonly params: undefined;
}

function makeFakeConnection(): FakeConnection {
  return {
    sent: [],
    sendApp(payload) {
      this.sent.push(payload);
    },
    disconnect: async () => {},
    get isConnected() {
      return true;
    },
    params: undefined,
  };
}

describe('transcript-io', () => {
  describe('transcriptToNdjson / transcriptFromNdjson', () => {
    it('round-trips a synthetic CapturedEvent[] (send + recv + unknown + decodeError)', () => {
      const sendBytes = encodeMessage(new LoginClientId('alice', 'pw', '20100225-17:43'));
      const tokenMsg = new LoginClientToken(new Uint8Array([0xde, 0xad, 0xbe, 0xef]), 42, 'alice');
      const recvBytes = encodeMessage(tokenMsg);
      const unknownBytes = new Uint8Array([0x01, 0x00, 0xef, 0xbe, 0xad, 0xde]);

      const original: CapturedEvent[] = [
        {
          direction: 'send',
          messageName: 'LoginClientId',
          typeCrc: LoginClientId.typeCrc,
          payload: sendBytes,
          at: 1700000000000,
        },
        {
          direction: 'recv',
          messageName: 'LoginClientToken',
          typeCrc: LoginClientToken.typeCrc,
          payload: recvBytes,
          at: 1700000000050,
          decoded: tokenMsg,
        },
        {
          direction: 'recv',
          messageName: '<crc:0xdeadbeef>',
          typeCrc: 0xdeadbeef,
          payload: unknownBytes,
          at: 1700000000100,
          decoded: null,
          unknownCrc: true,
        },
        {
          direction: 'recv',
          messageName: 'BogusFailedDecode',
          typeCrc: 0x12345678,
          payload: new Uint8Array([0x01, 0x00, 0x78, 0x56, 0x34, 0x12]),
          at: 1700000000150,
          decoded: null,
          decodeError: 'fake decode error',
        },
      ];

      const ndjson = transcriptToNdjson(original);
      // Must be NDJSON: each line a JSON object, trailing newline.
      const lines = ndjson.split('\n').filter((l) => l !== '');
      expect(lines).toHaveLength(4);
      expect(ndjson.endsWith('\n')).toBe(true);

      const parsed = transcriptFromNdjson(ndjson);
      expect(parsed).toHaveLength(4);

      // 0: send
      const ev0 = parsed[0];
      if (ev0 === undefined || ev0.direction !== 'send') throw new Error('ev0 wrong');
      expect(ev0.messageName).toBe('LoginClientId');
      expect(ev0.typeCrc).toBe(LoginClientId.typeCrc);
      expect(ev0.at).toBe(1700000000000);
      expect(Array.from(ev0.payload)).toEqual(Array.from(sendBytes));

      // 1: recv with decoded
      const ev1 = parsed[1];
      if (ev1 === undefined || ev1.direction !== 'recv') throw new Error('ev1 wrong');
      expect(ev1.messageName).toBe('LoginClientToken');
      expect(ev1.typeCrc).toBe(LoginClientToken.typeCrc);
      expect(Array.from(ev1.payload)).toEqual(Array.from(recvBytes));
      // After deserialize, decoded is reconstructed by re-decoding payload bytes.
      expect(ev1.decoded).toBeInstanceOf(LoginClientToken);
      if (!(ev1.decoded instanceof LoginClientToken)) throw new Error('decoded class');
      expect(ev1.decoded.stationId).toBe(42);
      expect(ev1.decoded.username).toBe('alice');
      expect(Array.from(ev1.decoded.token)).toEqual([0xde, 0xad, 0xbe, 0xef]);

      // 2: recv unknown CRC
      const ev2 = parsed[2];
      if (ev2 === undefined || ev2.direction !== 'recv') throw new Error('ev2 wrong');
      expect(ev2.unknownCrc).toBe(true);
      expect(ev2.decoded).toBeNull();
      expect(ev2.typeCrc).toBe(0xdeadbeef);
      expect(Array.from(ev2.payload)).toEqual(Array.from(unknownBytes));

      // 3: recv decode error
      const ev3 = parsed[3];
      if (ev3 === undefined || ev3.direction !== 'recv') throw new Error('ev3 wrong');
      expect(ev3.decodeError).toBe('fake decode error');
      // decoded may be null because the captured typeCrc isn't registered
      expect(ev3.unknownCrc).toBeUndefined();
    });

    it('serializes bigints as decimal strings within decoded payloads', () => {
      // Build a synthetic recv with a decoded value containing a bigint —
      // verify the JSON contains a string, not a number.
      class FakeDecoded {
        networkId = 0x1234567890abcdefn;
        flag = true;
      }
      const events: CapturedEvent[] = [
        {
          direction: 'recv',
          messageName: 'FakeMsg',
          typeCrc: 0xabad1dea,
          payload: new Uint8Array(),
          at: 1,
          decoded: new FakeDecoded() as unknown as GameNetworkMessage,
        },
      ];
      const ndjson = transcriptToNdjson(events);
      expect(ndjson).toContain('"1311768467294899695"'); // 0x1234567890abcdef as decimal
      expect(ndjson).not.toContain('"networkId":1311768467294899695'); // no raw number
    });

    it('serializes Uint8Array inside decoded as a hex string', () => {
      class FakeDecoded {
        blob = new Uint8Array([0x01, 0xfe, 0x99]);
      }
      const events: CapturedEvent[] = [
        {
          direction: 'recv',
          messageName: 'FakeMsg',
          typeCrc: 0,
          payload: new Uint8Array(),
          at: 1,
          decoded: new FakeDecoded() as unknown as GameNetworkMessage,
        },
      ];
      const ndjson = transcriptToNdjson(events);
      expect(ndjson).toContain('"blob":"01fe99"');
    });

    it('returns empty string for empty events array', () => {
      expect(transcriptToNdjson([])).toBe('');
      expect(transcriptFromNdjson('')).toEqual([]);
    });

    it('tolerates blank lines and trailing whitespace when parsing', () => {
      const sendBytes = encodeMessage(new LoginClientId('bob', '', '20100225-17:43'));
      const events: CapturedEvent[] = [
        {
          direction: 'send',
          messageName: 'LoginClientId',
          typeCrc: LoginClientId.typeCrc,
          payload: sendBytes,
          at: 1,
        },
      ];
      const ndjson = transcriptToNdjson(events);
      const messy = `\n\n${ndjson}\n   \n`;
      const parsed = transcriptFromNdjson(messy);
      expect(parsed).toHaveLength(1);
    });

    it('throws a useful error on malformed JSON', () => {
      expect(() => transcriptFromNdjson('not json')).toThrow(/line 1/);
    });

    it('throws a useful error on invalid direction', () => {
      expect(() =>
        transcriptFromNdjson(
          JSON.stringify({
            direction: 'sideways',
            messageName: 'x',
            typeCrc: 0,
            bytes: '',
            at: 0,
          }),
        ),
      ).toThrow(/invalid direction/);
    });
  });

  describe('attachCapture', () => {
    it('captures bytes for both sends and recvs on a real dispatcher', () => {
      const conn = makeFakeConnection();
      const dispatcher = new MessageDispatcher({ connection: conn as unknown as SoeConnection });
      const { events, detach } = attachCapture(dispatcher);

      // Send a real message — should be captured with bytes
      const sendMsg = new LoginClientId('alice', '', '20100225-17:43');
      dispatcher.send(sendMsg);

      // Inject an inbound message
      const tokenMsg = new LoginClientToken(new Uint8Array([1, 2, 3]), 99, 'bob');
      const recvBytes = encodeMessage(tokenMsg);
      dispatcher.handleAppMessage(recvBytes);

      expect(events).toHaveLength(2);
      const e0 = events[0];
      const e1 = events[1];
      if (e0 === undefined || e0.direction !== 'send') throw new Error('e0');
      if (e1 === undefined || e1.direction !== 'recv') throw new Error('e1');

      // Sent bytes must match what encodeMessage produces
      expect(Array.from(e0.payload)).toEqual(Array.from(encodeMessage(sendMsg)));
      // Sent bytes must match what the connection received
      expect(conn.sent).toHaveLength(1);
      expect(Array.from(e0.payload)).toEqual(Array.from(conn.sent[0] as Uint8Array));

      // Recv bytes match
      expect(Array.from(e1.payload)).toEqual(Array.from(recvBytes));
      expect(e1.decoded).toBeInstanceOf(LoginClientToken);

      // Detach restores original methods
      detach();
      dispatcher.send(new LoginClientId('after-detach', '', '20100225-17:43'));
      // events list does NOT grow after detach
      expect(events).toHaveLength(2);
    });

    it('captures unknown-CRC recv as a stub with payload bytes', () => {
      const conn = makeFakeConnection();
      const dispatcher = new MessageDispatcher({ connection: conn as unknown as SoeConnection });
      const { events } = attachCapture(dispatcher);

      const bogus = new Uint8Array([0x01, 0x00, 0xef, 0xbe, 0xad, 0xde]);
      dispatcher.handleAppMessage(bogus);

      expect(events).toHaveLength(1);
      const e0 = events[0];
      if (e0 === undefined || e0.direction !== 'recv') throw new Error('e0');
      expect(e0.unknownCrc).toBe(true);
      expect(e0.typeCrc).toBe(0xdeadbeef);
      expect(Array.from(e0.payload)).toEqual(Array.from(bogus));
      expect(e0.decoded).toBeNull();
    });

    it('does not break the dispatcher transcript or waitFor behavior', async () => {
      const conn = makeFakeConnection();
      const dispatcher = new MessageDispatcher({ connection: conn as unknown as SoeConnection });
      attachCapture(dispatcher);

      const tokenP = dispatcher.waitFor(LoginClientToken, { timeoutMs: 1000 });
      const tokenMsg = new LoginClientToken(new Uint8Array([7, 8, 9]), 1, 'wf');
      dispatcher.handleAppMessage(encodeMessage(tokenMsg));
      const got = await tokenP;
      expect(got).toBeInstanceOf(LoginClientToken);
      expect(got.username).toBe('wf');

      // The dispatcher's own transcript should also have recorded both events.
      expect(dispatcher.transcript).toHaveLength(1);
      const t0 = dispatcher.transcript[0];
      if (t0 === undefined || t0.direction !== 'recv') throw new Error('t0');
      expect(t0.messageName).toBe('LoginClientToken');
    });
  });

  describe('eventsFromTranscript', () => {
    it('promotes recv-only events from a plain TranscriptEvent[] by re-encoding decoded', () => {
      const tokenMsg = new LoginClientToken(new Uint8Array([0xaa]), 1, 'tx');
      const bytes = encodeMessage(tokenMsg);
      const events = eventsFromTranscript([
        // send: dropped because no instance to re-encode
        {
          direction: 'send',
          messageName: 'LoginClientId',
          typeCrc: LoginClientId.typeCrc,
          bytes: 50,
          at: 1,
        },
        // recv with decoded: promoted with bytes derived from re-encoding
        {
          direction: 'recv',
          messageName: 'LoginClientToken',
          typeCrc: LoginClientToken.typeCrc,
          bytes: bytes.length,
          at: 2,
          decoded: tokenMsg,
        },
        // recv with no decoded (unknown CRC): stub with empty payload
        {
          direction: 'recv',
          messageName: '<crc:0xdeadbeef>',
          typeCrc: 0xdeadbeef,
          bytes: 6,
          at: 3,
          decoded: null,
          unknownCrc: true,
        },
      ]);
      expect(events).toHaveLength(2);
      const e0 = events[0];
      if (e0 === undefined || e0.direction !== 'recv') throw new Error('e0');
      expect(Array.from(e0.payload)).toEqual(Array.from(bytes));
      const e1 = events[1];
      if (e1 === undefined || e1.direction !== 'recv') throw new Error('e1');
      expect(e1.unknownCrc).toBe(true);
      expect(e1.payload.length).toBe(0);
    });
  });

  describe('readTranscript / writeTranscript', () => {
    let tmpDir: string;
    beforeAll(async () => {
      tmpDir = await mkdtemp(join(tmpdir(), 'swg-ts-capture-'));
    });
    afterAll(async () => {
      await rm(tmpDir, { recursive: true, force: true });
    });

    it('round-trips through a real file', async () => {
      const sendBytes = encodeMessage(new LoginClientId('file-test', '', '20100225-17:43'));
      const events: CapturedEvent[] = [
        {
          direction: 'send',
          messageName: 'LoginClientId',
          typeCrc: LoginClientId.typeCrc,
          payload: sendBytes,
          at: 1700000001000,
        },
      ];
      const path = join(tmpDir, 'capture.ndjson');
      await writeTranscript(events, path);
      const read = await readTranscript(path);
      expect(read).toHaveLength(1);
      const r0 = read[0];
      if (r0 === undefined || r0.direction !== 'send') throw new Error('r0');
      expect(Array.from(r0.payload)).toEqual(Array.from(sendBytes));
      expect(r0.messageName).toBe('LoginClientId');
    });
  });
});
