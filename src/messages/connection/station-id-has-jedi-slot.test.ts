import { describe, expect, it } from 'vitest';
import { StubByteStream, StubReadIterator } from '../../archive/_stub-byte-stream.js';
import { StationIdHasJediSlot } from './station-id-has-jedi-slot.js';

describe('StationIdHasJediSlot', () => {
  it('has the expected metadata', () => {
    expect(StationIdHasJediSlot.messageName).toBe('StationIdHasJediSlot');
    expect(StationIdHasJediSlot.typeCrc).toBeGreaterThan(0);
  });

  it('encodes a single i32 LE value', () => {
    const m = new StationIdHasJediSlot(0x01020304);
    const s = new StubByteStream();
    m.encodePayload(s);
    expect(Array.from(s.toBytes())).toEqual([0x04, 0x03, 0x02, 0x01]);
  });

  it('round-trips negative ints', () => {
    for (const v of [0, 1, -1, 0x7fffffff, -0x80000000]) {
      const s = new StubByteStream();
      new StationIdHasJediSlot(v).encodePayload(s);
      const d = StationIdHasJediSlot.decodePayload(new StubReadIterator(s.toBytes()));
      expect(d.value).toBe(v);
    }
  });
});
