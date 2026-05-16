import { describe, expect, it } from 'vitest';
import { encodeMessage } from './base.js';
import { LoginClientId } from './login/login-client-id.js';
import { LoginEnumCluster } from './login/login-enum-cluster.js';
import { decodeMessage, decodeMessageStrict, messageRegistry } from './registry.js';

describe('messageRegistry', () => {
  it('looks up login messages by CRC and by name', () => {
    expect(messageRegistry.getByCrc(LoginClientId.typeCrc)?.messageName).toBe('LoginClientId');
    expect(messageRegistry.getByName('LoginClientId')?.typeCrc).toBe(LoginClientId.typeCrc);
    expect(messageRegistry.getByName('LoginEnumCluster')?.typeCrc).toBe(LoginEnumCluster.typeCrc);
  });

  it('returns undefined for unknown CRCs', () => {
    expect(messageRegistry.getByCrc(0xdeadbeef)).toBeUndefined();
    expect(messageRegistry.getByName('NoSuchMessage')).toBeUndefined();
  });

  it('decodeMessage returns null for unknown CRCs (non-strict)', () => {
    // Synthesize a packet with an unknown CRC + empty payload
    const bytes = new Uint8Array([0xef, 0xbe, 0xad, 0xde]);
    expect(decodeMessage(bytes)).toBeNull();
  });

  it('decodeMessageStrict throws for unknown CRCs', () => {
    const bytes = new Uint8Array([0xef, 0xbe, 0xad, 0xde]);
    expect(() => decodeMessageStrict(bytes)).toThrow(/unknown message crc/i);
  });

  it('round-trips a real login message via the registry', () => {
    const out = new LoginClientId('u', '', '20100225-17:43');
    const wire = encodeMessage(out);
    const back = decodeMessageStrict(wire) as LoginClientId;
    expect(back.id).toBe('u');
  });
});
