import { describe, expect, it } from 'vitest';
import { StubByteStream, StubReadIterator } from '../../archive/_stub-byte-stream.js';
import { HeartBeat } from './heart-beat.js';

describe('HeartBeat', () => {
  it('has the expected metadata', () => {
    expect(HeartBeat.messageName).toBe('HeartBeat');
    expect(HeartBeat.typeCrc).toBeGreaterThan(0);
  });

  it('encodes empty', () => {
    const s = new StubByteStream();
    new HeartBeat().encodePayload(s);
    expect(s.toBytes().length).toBe(0);
  });

  it('decodes empty', () => {
    const d = HeartBeat.decodePayload(new StubReadIterator(new Uint8Array(0)));
    expect(d).toBeInstanceOf(HeartBeat);
  });
});
