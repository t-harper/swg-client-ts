import { describe, expect, it } from 'vitest';
import { StubByteStream, StubReadIterator } from '../../archive/_stub-byte-stream.js';
import { ClientCreateCharacterSuccess } from './client-create-character-success.js';

describe('ClientCreateCharacterSuccess', () => {
  it('has the expected metadata', () => {
    expect(ClientCreateCharacterSuccess.messageName).toBe('ClientCreateCharacterSuccess');
    expect(ClientCreateCharacterSuccess.typeCrc).toBeGreaterThan(0);
  });

  it('encodes the NetworkId as 8 bytes LE', () => {
    const id = 0x0011_2233_4455_6677n;
    const s = new StubByteStream();
    new ClientCreateCharacterSuccess(id).encodePayload(s);
    expect(Array.from(s.toBytes())).toEqual([0x77, 0x66, 0x55, 0x44, 0x33, 0x22, 0x11, 0x00]);
  });

  it('round-trips', () => {
    const ids = [0n, 1n, 0xffff_ffff_ffff_ffffn / 2n, -1n];
    for (const id of ids) {
      const s = new StubByteStream();
      new ClientCreateCharacterSuccess(id).encodePayload(s);
      const d = ClientCreateCharacterSuccess.decodePayload(new StubReadIterator(s.toBytes()));
      expect(d.networkId).toBe(id);
    }
  });
});
