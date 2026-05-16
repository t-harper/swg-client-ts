import { describe, expect, it } from 'vitest';
import { StubByteStream, StubReadIterator } from '../../archive/_stub-byte-stream.js';
import { LogoutMessage } from './logout-message.js';

describe('LogoutMessage', () => {
  it('has the expected metadata', () => {
    expect(LogoutMessage.messageName).toBe('LogoutMessage');
    expect(LogoutMessage.typeCrc).toBeGreaterThan(0);
  });

  it('encodes empty', () => {
    const s = new StubByteStream();
    new LogoutMessage().encodePayload(s);
    expect(s.toBytes().length).toBe(0);
  });

  it('decodes empty', () => {
    const d = LogoutMessage.decodePayload(new StubReadIterator(new Uint8Array(0)));
    expect(d).toBeInstanceOf(LogoutMessage);
  });
});
