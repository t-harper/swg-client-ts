import { describe, expect, it } from 'vitest';
import { ByteStream } from '../../../archive/byte-stream.js';
import { ReadIterator } from '../../../archive/read-iterator.js';
import { ObjControllerMessage } from '../obj-controller-message.js';
import { hashCommand } from './command-hash.js';
import {
  CLIENT_TO_AUTH_SERVER_FLAGS,
  CM_COMMAND_QUEUE_ENQUEUE,
  CommandQueueEnqueue,
  NO_TARGET,
  wrapAsObjControllerMessage,
} from './command-queue-enqueue.js';

describe('CommandQueueEnqueue', () => {
  it('exposes the controller-message subtype constant (CM_commandQueueEnqueue = 278)', () => {
    expect(CM_COMMAND_QUEUE_ENQUEUE).toBe(278);
    expect(CommandQueueEnqueue.controllerMessage).toBe(278);
  });

  it('round-trips pack → unpack with all fields populated', () => {
    const original = new CommandQueueEnqueue(
      0x12345678,
      hashCommand('attack'),
      0x0011_2233_4455_6677n,
      'someParam',
    );
    const bytes = original.toBytes();
    const decoded = CommandQueueEnqueue.unpack(new ReadIterator(bytes));
    expect(decoded.sequenceId).toBe(0x12345678);
    expect(decoded.commandHash).toBe(hashCommand('attack'));
    expect(decoded.targetId).toBe(0x0011_2233_4455_6677n);
    expect(decoded.params).toBe('someParam');
  });

  it('round-trips with empty params and NO_TARGET', () => {
    const original = new CommandQueueEnqueue(1, hashCommand('prone'), NO_TARGET, '');
    const bytes = original.toBytes();
    const decoded = CommandQueueEnqueue.unpack(new ReadIterator(bytes));
    expect(decoded.sequenceId).toBe(1);
    expect(decoded.commandHash).toBe(hashCommand('prone'));
    expect(decoded.targetId).toBe(0n);
    expect(decoded.params).toBe('');
  });

  it('has the exact byte layout we expect (golden bytes)', () => {
    // sequenceId = 1 (u32 LE)            -> 01 00 00 00
    // commandHash = 0xAABBCCDD (u32 LE)  -> DD CC BB AA
    // targetId = 0x42n (i64 LE)          -> 42 00 00 00 00 00 00 00
    // params = "" (u32 LE count = 0)     -> 00 00 00 00
    // Total: 4 + 4 + 8 + 4 = 20 bytes
    const msg = new CommandQueueEnqueue(1, 0xaabbccdd, 0x42n, '');
    const s = new ByteStream();
    msg.pack(s);
    const bytes = s.toBytes();
    expect(bytes.length).toBe(20);
    expect(Array.from(bytes)).toEqual([
      0x01, 0x00, 0x00, 0x00, // sequenceId
      0xdd, 0xcc, 0xbb, 0xaa, // commandHash
      0x42, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // targetId
      0x00, 0x00, 0x00, 0x00, // params length 0
    ]);
  });

  it('encodes params as Unicode::String (u32 char-count + UTF-16 LE bytes)', () => {
    const msg = new CommandQueueEnqueue(0, 0, 0n, 'ab');
    const bytes = msg.toBytes();
    // 4 (seq) + 4 (hash) + 8 (target) + 4 (count=2) + 4 (UTF-16 LE 'a','b') = 24
    expect(bytes.length).toBe(24);
    // The last 8 bytes are the UnicodeString
    // count = 2 (u32 LE)  -> 02 00 00 00
    // 'a' = 0x61, 'b' = 0x62 (LE u16 each)
    expect(bytes[16]).toBe(0x02);
    expect(bytes[20]).toBe(0x61);
    expect(bytes[21]).toBe(0x00);
    expect(bytes[22]).toBe(0x62);
    expect(bytes[23]).toBe(0x00);
  });
});

describe('wrapAsObjControllerMessage', () => {
  it('produces an ObjControllerMessage with the correct envelope and trailer', () => {
    const playerId = 0x500ad9n;
    const enqueue = new CommandQueueEnqueue(7, hashCommand('attack'), 0xc0ffeen, '');
    const wrapped = wrapAsObjControllerMessage(enqueue, playerId);

    expect(wrapped).toBeInstanceOf(ObjControllerMessage);
    expect(wrapped.flags).toBe(CLIENT_TO_AUTH_SERVER_FLAGS);
    expect(wrapped.flags).toBe(0x23);
    expect(wrapped.message).toBe(CM_COMMAND_QUEUE_ENQUEUE);
    expect(wrapped.networkId).toBe(playerId);
    expect(wrapped.value).toBe(0);
    expect(wrapped.data).toEqual(enqueue.toBytes());
  });

  it('round-trips through ObjControllerMessage encode/decode', () => {
    const playerId = 0x42n;
    const enqueue = new CommandQueueEnqueue(99, hashCommand('berserk1'), 0n, '');
    const wrapped = wrapAsObjControllerMessage(enqueue, playerId);

    const s = new ByteStream();
    wrapped.encodePayload(s);
    const bytes = s.toBytes();

    const decoded = ObjControllerMessage.decodePayload(new ReadIterator(bytes));
    expect(decoded.message).toBe(CM_COMMAND_QUEUE_ENQUEUE);
    expect(decoded.networkId).toBe(playerId);
    expect(decoded.flags).toBe(CLIENT_TO_AUTH_SERVER_FLAGS);

    // The trailer should round-trip back to the original CommandQueueEnqueue
    const inner = CommandQueueEnqueue.unpack(new ReadIterator(decoded.data));
    expect(inner.sequenceId).toBe(99);
    expect(inner.commandHash).toBe(hashCommand('berserk1'));
    expect(inner.targetId).toBe(0n);
  });

  it('allows overriding flags and value when needed', () => {
    const enqueue = new CommandQueueEnqueue(1, 0xdeadbeef, 0n, '');
    const wrapped = wrapAsObjControllerMessage(enqueue, 1n, 0x1234, 7.5);
    expect(wrapped.flags).toBe(0x1234);
    expect(wrapped.value).toBeCloseTo(7.5, 5);
  });
});
