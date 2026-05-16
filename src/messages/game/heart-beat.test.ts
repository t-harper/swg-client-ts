import { describe, expect, it } from 'vitest';
import { ByteStream } from '../../archive/byte-stream.js';
import { ReadIterator } from '../../archive/read-iterator.js';
import { HeartBeat } from './heart-beat.js';

describe('HeartBeat', () => {
  it('has the expected metadata', () => {
    expect(HeartBeat.messageName).toBe('HeartBeat');
    expect(HeartBeat.typeCrc).toBeGreaterThan(0);
  });

  it('encodes empty', () => {
    const s = new ByteStream();
    new HeartBeat().encodePayload(s);
    expect(s.toBytes().length).toBe(0);
  });

  it('decodes empty', () => {
    const d = HeartBeat.decodePayload(new ReadIterator(new Uint8Array(0)));
    expect(d).toBeInstanceOf(HeartBeat);
  });
});
