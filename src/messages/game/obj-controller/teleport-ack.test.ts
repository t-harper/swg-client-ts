import { describe, expect, it } from 'vitest';
import { ByteStream } from '../../../archive/byte-stream.js';
import { ReadIterator } from '../../../archive/read-iterator.js';
import { TeleportAckDecoder } from './teleport-ack.js';

describe('TeleportAckDecoder', () => {
  it('round-trips a positive sequenceId', () => {
    const stream = new ByteStream();
    TeleportAckDecoder.encode(stream, { sequenceId: 42 });
    const bytes = stream.toBytes();
    expect(bytes.length).toBe(4);
    const decoded = TeleportAckDecoder.decode(new ReadIterator(bytes));
    expect(decoded.sequenceId).toBe(42);
  });

  it('round-trips a negative sequenceId (the common case during zone-in ACK)', () => {
    const stream = new ByteStream();
    TeleportAckDecoder.encode(stream, { sequenceId: -5 });
    const bytes = stream.toBytes();
    expect(bytes.length).toBe(4);
    const decoded = TeleportAckDecoder.decode(new ReadIterator(bytes));
    expect(decoded.sequenceId).toBe(-5);
  });

  it('emits little-endian wire bytes (sequenceId=-1 → ff ff ff ff)', () => {
    const stream = new ByteStream();
    TeleportAckDecoder.encode(stream, { sequenceId: -1 });
    const bytes = stream.toBytes();
    expect(Array.from(bytes)).toEqual([0xff, 0xff, 0xff, 0xff]);
  });
});
