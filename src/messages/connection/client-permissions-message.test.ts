import { describe, expect, it } from 'vitest';
import { StubByteStream, StubReadIterator } from '../../archive/_stub-byte-stream.js';
import { ClientPermissionsMessage } from './client-permissions-message.js';

describe('ClientPermissionsMessage', () => {
  it('exposes the right name + non-zero crc', () => {
    expect(ClientPermissionsMessage.messageName).toBe('ClientPermissionsMessage');
    expect(ClientPermissionsMessage.typeCrc).toBeGreaterThan(0);
  });

  it('encodes 5 bools in addVariable order: login, regular, jedi, tutorial, admin', () => {
    const m = new ClientPermissionsMessage(true, true, false, true, false);
    const s = new StubByteStream();
    m.encodePayload(s);
    expect(Array.from(s.toBytes())).toEqual([0x01, 0x01, 0x00, 0x01, 0x00]);
  });

  it('round-trips every bit pattern', () => {
    for (let bits = 0; bits < 32; ++bits) {
      const m = new ClientPermissionsMessage(
        Boolean(bits & 1),
        Boolean(bits & 2),
        Boolean(bits & 4),
        Boolean(bits & 8),
        Boolean(bits & 16),
      );
      const s = new StubByteStream();
      m.encodePayload(s);
      const iter = new StubReadIterator(s.toBytes());
      const d = ClientPermissionsMessage.decodePayload(iter);
      expect(d.canLogin).toBe(m.canLogin);
      expect(d.canCreateRegularCharacter).toBe(m.canCreateRegularCharacter);
      expect(d.canCreateJediCharacter).toBe(m.canCreateJediCharacter);
      expect(d.canSkipTutorial).toBe(m.canSkipTutorial);
      expect(d.isAdmin).toBe(m.isAdmin);
      expect(iter.remaining).toBe(0);
    }
  });
});
