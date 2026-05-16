import { describe, expect, it } from 'vitest';

import { ByteStream } from '../../archive/byte-stream.js';
import { ReadIterator } from '../../archive/read-iterator.js';
import { encodeMessage, parseHeader } from '../base.js';
import { messageRegistry } from '../registry.js';
import { UpdateContainmentMessage } from './update-containment-message.js';

describe('UpdateContainmentMessage', () => {
  it('has the expected metadata', () => {
    expect(UpdateContainmentMessage.messageName).toBe('UpdateContainmentMessage');
    expect(UpdateContainmentMessage.typeCrc).toBeGreaterThan(0);
    // cmd + networkId + containerId + slotArrangement
    expect(UpdateContainmentMessage.varCount).toBe(4);
  });

  it('encodes payload to the expected wire layout', () => {
    const stream = new ByteStream();
    new UpdateContainmentMessage(0x42n, 0x100n, -1).encodePayload(stream);
    const bytes = stream.toBytes();
    // networkId i64 LE 0x42 → 42 00 00 00 00 00 00 00
    // containerId i64 LE 0x100 → 00 01 00 00 00 00 00 00
    // slotArrangement i32 LE -1 → ff ff ff ff
    expect(bytes).toEqual(
      new Uint8Array([
        0x42, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0xff, 0xff, 0xff, 0xff,
      ]),
    );
  });

  it('round-trips encode → decode', () => {
    const stream = new ByteStream();
    const original = new UpdateContainmentMessage(0x0123456789abcdefn, 0x7777n, 5);
    original.encodePayload(stream);
    const decoded = UpdateContainmentMessage.decodePayload(new ReadIterator(stream.toBytes()));
    expect(decoded.networkId).toBe(0x0123456789abcdefn);
    expect(decoded.containerId).toBe(0x7777n);
    expect(decoded.slotArrangement).toBe(5);
  });

  it('survives a full encodeMessage → registry-dispatch round-trip', () => {
    const original = new UpdateContainmentMessage(123n, 456n, 0);
    const wire = encodeMessage(original);
    const { typeCrc, payload, varCount } = parseHeader(wire);
    expect(varCount).toBe(4);
    expect(typeCrc).toBe(UpdateContainmentMessage.typeCrc);
    const decoder = messageRegistry.getByCrc(typeCrc);
    expect(decoder).toBeDefined();
    const decoded = decoder?.decodePayload(payload);
    expect(decoded).toBeInstanceOf(UpdateContainmentMessage);
    if (!(decoded instanceof UpdateContainmentMessage)) throw new Error('typeguard');
    expect(decoded.networkId).toBe(123n);
    expect(decoded.containerId).toBe(456n);
    expect(decoded.slotArrangement).toBe(0);
  });

  it('handles "no container" (containerId 0n, slot -1)', () => {
    const stream = new ByteStream();
    new UpdateContainmentMessage(99n, 0n, -1).encodePayload(stream);
    const decoded = UpdateContainmentMessage.decodePayload(new ReadIterator(stream.toBytes()));
    expect(decoded.containerId).toBe(0n);
    expect(decoded.slotArrangement).toBe(-1);
  });
});
