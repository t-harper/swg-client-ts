import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import { encodeMessage, parseHeader, NETWORK_VERSION_ID } from '../base.js';
import { decodeMessageStrict } from '../registry.js';
import { LoginClientId } from './login-client-id.js';

describe('LoginClientId (OUTBOUND)', () => {
  it('has the expected constcrc identifier', () => {
    // constcrc("LoginClientId") = 0x41131f96 (see crc/constcrc.test.ts)
    expect(LoginClientId.typeCrc).toBe(0x41131f96);
  });

  it('encodes to a deterministic, hand-computed byte sequence', () => {
    const msg = new LoginClientId('hi', '', NETWORK_VERSION_ID);
    const bytes = encodeMessage(msg);

    // Layout:
    //   [4]    CRC = 0x41131f96 LE = 96 1f 13 41
    //   [2+2]  id  = "hi"   → u16 LE 2 + 'h' 'i' = 02 00 68 69
    //   [2]    key = ""     → u16 LE 0 = 00 00
    //   [2+14] ver = "20100225-17:43"  → u16 LE 14 + 14 bytes
    const expected = Buffer.concat([
      Buffer.from([0x96, 0x1f, 0x13, 0x41]),
      Buffer.from([0x02, 0x00, 0x68, 0x69]),
      Buffer.from([0x00, 0x00]),
      Buffer.from([14, 0]),
      Buffer.from(NETWORK_VERSION_ID, 'utf-8'),
    ]);
    expect(Array.from(bytes)).toEqual(Array.from(expected));
  });

  it('round-trips through the registry', () => {
    const msg = new LoginClientId('ts-test-1234', 'whatever', NETWORK_VERSION_ID);
    const bytes = encodeMessage(msg);
    const decoded = decodeMessageStrict(bytes);
    expect(decoded).toBeInstanceOf(LoginClientId);
    const lci = decoded as LoginClientId;
    expect(lci.id).toBe('ts-test-1234');
    expect(lci.key).toBe('whatever');
    expect(lci.version).toBe(NETWORK_VERSION_ID);
  });

  it('round-trips empty id/key/version', () => {
    const bytes = encodeMessage(new LoginClientId('', '', ''));
    const { typeCrc, payload } = parseHeader(bytes);
    expect(typeCrc).toBe(LoginClientId.typeCrc);
    const decoded = LoginClientId.decodePayload(payload);
    expect(decoded.id).toBe('');
    expect(decoded.key).toBe('');
    expect(decoded.version).toBe('');
  });
});
