import { describe, expect, it } from 'vitest';
import { StubByteStream, StubReadIterator } from '../../archive/_stub-byte-stream.js';
import { ErrorMessage } from './error-message.js';

describe('ErrorMessage', () => {
  it('has the expected metadata', () => {
    expect(ErrorMessage.messageName).toBe('ErrorMessage');
    expect(ErrorMessage.typeCrc).toBeGreaterThan(0);
  });

  it('encodes [string name][string description][bool fatal] in that order', () => {
    const m = new ErrorMessage('Validation Failed', 'oops', true);
    const s = new StubByteStream();
    m.encodePayload(s);
    const iter = new StubReadIterator(s.toBytes());
    const d = ErrorMessage.decodePayload(iter);
    expect(iter.remaining).toBe(0);
    expect(d.errorName).toBe('Validation Failed');
    expect(d.description).toBe('oops');
    expect(d.fatal).toBe(true);
  });

  it('defaults fatal=false', () => {
    const m = new ErrorMessage('Warning', 'careful');
    expect(m.fatal).toBe(false);
    const s = new StubByteStream();
    m.encodePayload(s);
    const d = ErrorMessage.decodePayload(new StubReadIterator(s.toBytes()));
    expect(d.fatal).toBe(false);
  });
});
