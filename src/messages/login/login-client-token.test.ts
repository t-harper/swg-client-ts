import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import { encodeMessage } from '../base.js';
import { decodeMessageStrict } from '../registry.js';
import { LoginClientToken } from './login-client-token.js';

describe('LoginClientToken (INBOUND)', () => {
  it('has the expected constcrc identifier', () => {
    // constcrc("LoginClientToken") = 0xaab296c6
    expect(LoginClientToken.typeCrc).toBe(0xaab296c6);
  });

  it('encodes deterministically with a tiny token', () => {
    const msg = new LoginClientToken(
      Uint8Array.of(0xaa, 0xbb, 0xcc, 0xdd), // 4-byte token
      0x12345678, // stationId
      'ts-user',
    );
    const bytes = encodeMessage(msg);

    // Layout:
    //   [4]  CRC = 0xAAB296C6 LE = c6 96 b2 aa
    //   [4]  token AutoArray count = 4 LE = 04 00 00 00
    //   [4]  token bytes = aa bb cc dd
    //   [4]  stationId = 0x12345678 LE = 78 56 34 12
    //   [2+7] username = 'ts-user' → 07 00 + 't' 's' '-' 'u' 's' 'e' 'r'
    const expected = Buffer.concat([
      Buffer.from([0xc6, 0x96, 0xb2, 0xaa]),
      Buffer.from([4, 0, 0, 0]),
      Buffer.from([0xaa, 0xbb, 0xcc, 0xdd]),
      Buffer.from([0x78, 0x56, 0x34, 0x12]),
      Buffer.from([7, 0]),
      Buffer.from('ts-user', 'utf-8'),
    ]);
    expect(Array.from(bytes)).toEqual(Array.from(expected));
  });

  it('round-trips a realistic ~78-byte token', () => {
    const token = new Uint8Array(78);
    for (let i = 0; i < token.length; i++) {
      token[i] = (i * 7) & 0xff;
    }
    const msg = new LoginClientToken(token, 0xabad1dea, 'ci-test-1234567890');
    const decoded = decodeMessageStrict(encodeMessage(msg)) as LoginClientToken;
    expect(Array.from(decoded.token)).toEqual(Array.from(token));
    expect(decoded.stationId).toBe(0xabad1dea);
    expect(decoded.username).toBe('ci-test-1234567890');
  });

  it('handles an empty token (degenerate but valid)', () => {
    const msg = new LoginClientToken(new Uint8Array(), 0, '');
    const decoded = decodeMessageStrict(encodeMessage(msg)) as LoginClientToken;
    expect(decoded.token.byteLength).toBe(0);
    expect(decoded.stationId).toBe(0);
    expect(decoded.username).toBe('');
  });
});
