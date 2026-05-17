import { describe, expect, it } from 'vitest';

import { ByteStream } from '../../../archive/byte-stream.js';
import { ReadIterator } from '../../../archive/read-iterator.js';
import { encodeMessage, parseHeader } from '../../base.js';
import { messageRegistry } from '../../registry.js';
import { UnAcceptTransactionMessage } from './unaccept-transaction-message.js';

import './unaccept-transaction-message.js';

describe('UnAcceptTransactionMessage', () => {
  it('has the expected metadata', () => {
    expect(UnAcceptTransactionMessage.messageName).toBe('UnAcceptTransactionMessage');
    expect(UnAcceptTransactionMessage.varCount).toBe(1);
    expect(UnAcceptTransactionMessage.typeCrc).toBeGreaterThan(0);
  });

  it('encodes empty payload', () => {
    const s = new ByteStream();
    new UnAcceptTransactionMessage().encodePayload(s);
    expect(s.toBytes().length).toBe(0);
  });

  it('decodes empty payload', () => {
    const d = UnAcceptTransactionMessage.decodePayload(new ReadIterator(new Uint8Array(0)));
    expect(d).toBeInstanceOf(UnAcceptTransactionMessage);
  });

  it('full encode-decode round-trip via registry', () => {
    const bytes = encodeMessage(new UnAcceptTransactionMessage());
    const { typeCrc, payload } = parseHeader(bytes);
    const decoder = messageRegistry.getByCrc(typeCrc);
    if (!decoder) throw new Error('decoder not registered');
    expect(decoder.decodePayload(payload)).toBeInstanceOf(UnAcceptTransactionMessage);
  });

  it('has the exact byte layout we expect (header-only)', () => {
    const bytes = encodeMessage(new UnAcceptTransactionMessage());
    expect(bytes.length).toBe(6);
    expect(bytes[0]).toBe(0x01);
    expect(bytes[1]).toBe(0x00);
  });
});
