import { describe, expect, it } from 'vitest';
import type { ByteStream } from '../archive/byte-stream.js';
import { NETWORK_VERSION_ID, encodeMessage, parseHeader } from './base.js';
import { LoginClientId } from './login/login-client-id.js';

describe('GameNetworkMessage framing', () => {
  it('NETWORK_VERSION_ID matches the server hardcoded value', () => {
    // GameNetworkMessage::NetworkVersionId @ GameNetworkMessage.cpp:21
    expect(NETWORK_VERSION_ID).toBe('20100225-17:43');
  });

  it('encodeMessage prepends the 2-byte varCount + 4-byte CRC header (LE)', () => {
    const msg = new LoginClientId('u', '', NETWORK_VERSION_ID);
    const bytes = encodeMessage(msg);
    // first 2 bytes should be varCount = 4 LE = 04 00
    expect(Array.from(bytes.subarray(0, 2))).toEqual([0x04, 0x00]);
    // next 4 bytes should be constcrc("LoginClientId") = 0x41131f96, LE = 96 1f 13 41
    expect(Array.from(bytes.subarray(2, 6))).toEqual([0x96, 0x1f, 0x13, 0x41]);
  });

  it('parseHeader peels varCount + CRC + returns a sub-iterator at the payload', () => {
    const msg = new LoginClientId('a', 'b', 'c');
    const bytes = encodeMessage(msg);
    const { varCount, typeCrc, payload } = parseHeader(bytes);
    expect(varCount).toBe(LoginClientId.varCount);
    expect(typeCrc).toBe(LoginClientId.typeCrc);
    expect(payload.position).toBe(0);
    expect(payload.length).toBe(bytes.byteLength - 6);
  });

  it('encodeMessage works for any concrete subclass', () => {
    const msg = new LoginClientId('hello', '', NETWORK_VERSION_ID);
    expect(() => encodeMessage(msg)).not.toThrow();
  });

  it('errors clearly when a subclass forgot to define typeCrc', () => {
    class Bad {
      encodePayload(_s: ByteStream): void {}
    }
    expect(() => encodeMessage(new Bad() as never)).toThrow(/typeCrc/);
  });
});
