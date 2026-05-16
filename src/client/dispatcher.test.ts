/**
 * Unit tests for `MessageDispatcher` — exercises the wait/listen/transcript
 * paths without any real UDP traffic.
 *
 * Approach:
 *   - Build a fake `SoeConnection`-shaped object that records `sendApp` calls
 *     and lets us inject inbound payloads.
 *   - Hand it to MessageDispatcher.
 *   - Verify waitFor / onMessage / transcript / cancelAllWaiters behaviors.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { encodeMessage } from '../messages/base.js';
import { LoginClientId } from '../messages/login/login-client-id.js';
import { LoginClientToken } from '../messages/login/login-client-token.js';
import { LoginEnumCluster } from '../messages/login/login-enum-cluster.js';
import { ServerNowEpochTime } from '../messages/login/server-now-epoch-time.js';
import type { SoeConnection } from '../soe/connection.js';
import { MessageDispatcher } from './dispatcher.js';

// Side-effect: register the login message decoders we exercise here.
import '../messages/login/index.js';

interface FakeConnection {
  /** Capture of every sendApp() call. */
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
    disconnect: async () => {
      /* no-op */
    },
    get isConnected() {
      return true;
    },
    params: undefined,
  };
}

describe('MessageDispatcher', () => {
  let conn: FakeConnection;
  let dispatcher: MessageDispatcher;

  beforeEach(() => {
    conn = makeFakeConnection();
    dispatcher = new MessageDispatcher({ connection: conn as unknown as SoeConnection });
  });

  it('records sends in the transcript and forwards to connection', () => {
    const msg = new LoginClientId('alice', '', '20100225-17:43');
    dispatcher.send(msg);
    expect(conn.sent.length).toBe(1);
    expect(dispatcher.transcript.length).toBe(1);
    expect(dispatcher.transcript[0]?.direction).toBe('send');
    expect(dispatcher.transcript[0]?.messageName).toBe('LoginClientId');
    expect(dispatcher.transcript[0]?.typeCrc).toBe(LoginClientId.typeCrc);
  });

  it('waitFor resolves when a matching message arrives', async () => {
    const tokenMsg = new LoginClientToken(new Uint8Array([1, 2, 3]), 42, 'alice');
    const tokenP = dispatcher.waitFor(LoginClientToken, { timeoutMs: 1000 });
    dispatcher.handleAppMessage(encodeMessage(tokenMsg));
    const got = await tokenP;
    expect(got).toBeInstanceOf(LoginClientToken);
    expect(got.username).toBe('alice');
    expect(got.stationId).toBe(42);
  });

  it('waitFor times out if message never arrives', async () => {
    const p = dispatcher.waitFor(LoginEnumCluster, { timeoutMs: 50 });
    await expect(p).rejects.toThrow(/Timed out/);
  });

  it('onMessage listeners fire for every matching incoming message', () => {
    const calls: number[] = [];
    const unsub = dispatcher.onMessage(ServerNowEpochTime, (m) => {
      calls.push(m.value);
    });
    dispatcher.handleAppMessage(encodeMessage(new ServerNowEpochTime(111)));
    dispatcher.handleAppMessage(encodeMessage(new ServerNowEpochTime(222)));
    expect(calls).toEqual([111, 222]);
    unsub();
    dispatcher.handleAppMessage(encodeMessage(new ServerNowEpochTime(333)));
    expect(calls).toEqual([111, 222]);
  });

  it('transcript records inbound messages with decoded payload', () => {
    dispatcher.handleAppMessage(
      encodeMessage(new LoginClientToken(new Uint8Array([7, 8, 9]), 1, 'bob')),
    );
    const last = dispatcher.transcript.at(-1);
    expect(last?.direction).toBe('recv');
    if (last?.direction !== 'recv') throw new Error('typeguard');
    expect(last.messageName).toBe('LoginClientToken');
    expect(last.decoded).toBeInstanceOf(LoginClientToken);
  });

  it('inbound messages with unregistered CRC are recorded as unknown but not delivered', () => {
    // Construct a payload with a CRC the registry doesn't know.
    // Layout: [u16 varCount=1][u32 typeCrc=0xDEADBEEF]
    const bogus = new Uint8Array([
      0x01,
      0x00, // varCount = 1
      0xef,
      0xbe,
      0xad,
      0xde, // CRC LE
    ]);
    dispatcher.handleAppMessage(bogus);
    const last = dispatcher.transcript.at(-1);
    expect(last?.direction).toBe('recv');
    if (last?.direction !== 'recv') throw new Error('typeguard');
    expect(last.unknownCrc).toBe(true);
    expect(last.typeCrc).toBe(0xdeadbeef);
    expect(last.decoded).toBeNull();
  });

  it('cancelAllWaiters rejects every pending waiter', async () => {
    const p1 = dispatcher.waitFor(LoginEnumCluster, { timeoutMs: 60_000 });
    const p2 = dispatcher.waitFor(LoginClientToken, { timeoutMs: 60_000 });
    dispatcher.cancelAllWaiters('shutdown');
    await expect(p1).rejects.toThrow(/shutdown/);
    await expect(p2).rejects.toThrow(/shutdown/);
  });

  it('onAny gets every transcript event (sent, inbound typed, and inbound unknown)', () => {
    const events: { dir: 'send' | 'recv'; name: string }[] = [];
    dispatcher.onAny((event) => {
      events.push({ dir: event.direction, name: event.messageName });
    });
    dispatcher.send(new LoginClientId('out', '', '20100225-17:43'));
    dispatcher.handleAppMessage(encodeMessage(new ServerNowEpochTime(1)));
    dispatcher.handleAppMessage(new Uint8Array([0x01, 0x00, 0xef, 0xbe, 0xad, 0xde]));
    expect(events).toEqual([
      { dir: 'send', name: 'LoginClientId' },
      { dir: 'recv', name: 'ServerNowEpochTime' },
      { dir: 'recv', name: '<crc:0xdeadbeef>' },
    ]);
  });

  it('waitFor predicate filters which message satisfies the wait', async () => {
    const p = dispatcher.waitFor(ServerNowEpochTime, {
      timeoutMs: 1000,
      predicate: (m) => m.value > 100,
    });
    dispatcher.handleAppMessage(encodeMessage(new ServerNowEpochTime(50)));
    dispatcher.handleAppMessage(encodeMessage(new ServerNowEpochTime(200)));
    const got = await p;
    expect(got.value).toBe(200);
  });
});
