import { describe, expect, it } from 'vitest';
import { ByteStream } from '../../archive/byte-stream.js';
import { ReadIterator } from '../../archive/read-iterator.js';
import { SelectCharacter } from './select-character.js';

describe('SelectCharacter', () => {
  it('has the expected metadata', () => {
    expect(SelectCharacter.messageName).toBe('SelectCharacter');
    expect(SelectCharacter.typeCrc).toBeGreaterThan(0);
  });

  it('encodes a single 8-byte LE NetworkId', () => {
    const m = new SelectCharacter(0x0102_0304_0506_0708n);
    const s = new ByteStream();
    m.encodePayload(s);
    expect(Array.from(s.toBytes())).toEqual([0x08, 0x07, 0x06, 0x05, 0x04, 0x03, 0x02, 0x01]);
  });

  it('round-trips', () => {
    for (const id of [0n, 1n, 0x7fff_ffff_ffff_ffffn, -42n]) {
      const s = new ByteStream();
      new SelectCharacter(id).encodePayload(s);
      const d = SelectCharacter.decodePayload(new ReadIterator(s.toBytes()));
      expect(d.networkId).toBe(id);
    }
  });
});
