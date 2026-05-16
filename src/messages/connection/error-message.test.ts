import { describe, expect, it } from 'vitest';
import { ByteStream } from '../../archive/byte-stream.js';
import { ReadIterator } from '../../archive/read-iterator.js';
import { ErrorMessage } from './error-message.js';

describe('ErrorMessage', () => {
  it('has the expected metadata', () => {
    expect(ErrorMessage.messageName).toBe('ErrorMessage');
    expect(ErrorMessage.typeCrc).toBeGreaterThan(0);
  });

  it('encodes [string name][string description][bool fatal] in that order', () => {
    const m = new ErrorMessage('Validation Failed', 'oops', true);
    const s = new ByteStream();
    m.encodePayload(s);
    const iter = new ReadIterator(s.toBytes());
    const d = ErrorMessage.decodePayload(iter);
    expect(iter.remaining).toBe(0);
    expect(d.errorName).toBe('Validation Failed');
    expect(d.description).toBe('oops');
    expect(d.fatal).toBe(true);
  });

  it('defaults fatal=false', () => {
    const m = new ErrorMessage('Warning', 'careful');
    expect(m.fatal).toBe(false);
    const s = new ByteStream();
    m.encodePayload(s);
    const d = ErrorMessage.decodePayload(new ReadIterator(s.toBytes()));
    expect(d.fatal).toBe(false);
  });
});
