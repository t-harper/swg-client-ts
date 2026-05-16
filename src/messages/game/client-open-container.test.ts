import { describe, expect, it } from 'vitest';
import { ByteStream } from '../../archive/byte-stream.js';
import { ReadIterator } from '../../archive/read-iterator.js';
import { ClientOpenContainerMessage } from './client-open-container.js';

describe('ClientOpenContainerMessage', () => {
  it('has the expected metadata', () => {
    expect(ClientOpenContainerMessage.messageName).toBe('ClientOpenContainerMessage');
    expect(ClientOpenContainerMessage.typeCrc).toBeGreaterThan(0);
    expect(ClientOpenContainerMessage.varCount).toBe(3);
  });

  it('encodes a NetworkId + slot string to the expected wire bytes', () => {
    const stream = new ByteStream();
    new ClientOpenContainerMessage(0x1234n, 'inventory').encodePayload(stream);
    const bytes = stream.toBytes();
    // NetworkId u64 LE 0x1234 → 34 12 00 00 00 00 00 00
    // std::string "inventory" → u16 LE len 9 (09 00) + ascii bytes
    expect(bytes).toEqual(
      new Uint8Array([
        0x34, 0x12, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x09, 0x00,
        0x69, 0x6e, 0x76, 0x65, 0x6e, 0x74, 0x6f, 0x72, 0x79,
      ]),
    );
  });

  it('round-trips encode → decode', () => {
    const stream = new ByteStream();
    const original = new ClientOpenContainerMessage(0x0123456789abcdefn, 'bank_1');
    original.encodePayload(stream);
    const decoded = ClientOpenContainerMessage.decodePayload(new ReadIterator(stream.toBytes()));
    expect(decoded.containerId).toBe(0x0123456789abcdefn);
    expect(decoded.slot).toBe('bank_1');
  });

  it('handles an empty slot string', () => {
    const stream = new ByteStream();
    new ClientOpenContainerMessage(1n, '').encodePayload(stream);
    const decoded = ClientOpenContainerMessage.decodePayload(new ReadIterator(stream.toBytes()));
    expect(decoded.slot).toBe('');
    expect(decoded.containerId).toBe(1n);
  });
});
