import { describe, expect, it } from 'vitest';
import { ByteStream } from '../../archive/byte-stream.js';
import { ReadIterator } from '../../archive/read-iterator.js';
import { LogoutMessage } from './logout-message.js';

describe('LogoutMessage', () => {
  it('has the expected metadata', () => {
    expect(LogoutMessage.messageName).toBe('LogoutMessage');
    expect(LogoutMessage.typeCrc).toBeGreaterThan(0);
  });

  it('encodes empty', () => {
    const s = new ByteStream();
    new LogoutMessage().encodePayload(s);
    expect(s.toBytes().length).toBe(0);
  });

  it('decodes empty', () => {
    const d = LogoutMessage.decodePayload(new ReadIterator(new Uint8Array(0)));
    expect(d).toBeInstanceOf(LogoutMessage);
  });
});
