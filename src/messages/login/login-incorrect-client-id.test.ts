import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import { encodeMessage } from '../base.js';
import { decodeMessageStrict } from '../registry.js';
import { LoginIncorrectClientId } from './login-incorrect-client-id.js';

describe('LoginIncorrectClientId (INBOUND)', () => {
  it('has the expected constcrc identifier', () => {
    // constcrc("LoginIncorrectClientId") = 0x20e7e510
    expect(LoginIncorrectClientId.typeCrc).toBe(0x20e7e510);
  });

  it('encodes deterministically', () => {
    const msg = new LoginIncorrectClientId('swg-login', '20100225-17:43');
    const bytes = encodeMessage(msg);

    // Layout:
    //   [4]    CRC = 0x20E7E510 LE = 10 e5 e7 20
    //   [2+9]  serverId = "swg-login" → 09 00 + bytes
    //   [2+14] version = "20100225-17:43" → 0e 00 + bytes
    const expected = Buffer.concat([
      Buffer.from([0x10, 0xe5, 0xe7, 0x20]),
      Buffer.from([9, 0]),
      Buffer.from('swg-login', 'utf-8'),
      Buffer.from([14, 0]),
      Buffer.from('20100225-17:43', 'utf-8'),
    ]);
    expect(Array.from(bytes)).toEqual(Array.from(expected));
  });

  it('round-trips', () => {
    const msg = new LoginIncorrectClientId('swg-login', '20100225-17:43');
    const decoded = decodeMessageStrict(encodeMessage(msg)) as LoginIncorrectClientId;
    expect(decoded.serverId).toBe('swg-login');
    expect(decoded.serverApplicationVersion).toBe('20100225-17:43');
  });
});
