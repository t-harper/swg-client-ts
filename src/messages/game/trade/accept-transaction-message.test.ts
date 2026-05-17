import { describe, expect, it } from 'vitest';

import { ByteStream } from '../../../archive/byte-stream.js';
import { ReadIterator } from '../../../archive/read-iterator.js';
import { encodeMessage, parseHeader } from '../../base.js';
import { messageRegistry } from '../../registry.js';
import { AcceptTransactionMessage } from './accept-transaction-message.js';

import './accept-transaction-message.js';

describe('AcceptTransactionMessage', () => {
  it('has the expected metadata', () => {
    expect(AcceptTransactionMessage.messageName).toBe('AcceptTransactionMessage');
    expect(AcceptTransactionMessage.varCount).toBe(1);
    expect(AcceptTransactionMessage.typeCrc).toBeGreaterThan(0);
  });

  it('encodes empty payload', () => {
    const s = new ByteStream();
    new AcceptTransactionMessage().encodePayload(s);
    expect(s.toBytes().length).toBe(0);
  });

  it('decodes empty payload', () => {
    const d = AcceptTransactionMessage.decodePayload(new ReadIterator(new Uint8Array(0)));
    expect(d).toBeInstanceOf(AcceptTransactionMessage);
  });

  it('full encode-decode round-trip via registry', () => {
    const bytes = encodeMessage(new AcceptTransactionMessage());
    const { varCount, typeCrc, payload } = parseHeader(bytes);
    expect(varCount).toBe(1);
    expect(typeCrc).toBe(AcceptTransactionMessage.typeCrc);
    const decoder = messageRegistry.getByCrc(typeCrc);
    if (!decoder) throw new Error('decoder not registered');
    expect(decoder.decodePayload(payload)).toBeInstanceOf(AcceptTransactionMessage);
  });

  it('has the exact byte layout we expect (header-only)', () => {
    const bytes = encodeMessage(new AcceptTransactionMessage());
    expect(bytes.length).toBe(6);
    expect(bytes[0]).toBe(0x01);
    expect(bytes[1]).toBe(0x00);
  });
});
