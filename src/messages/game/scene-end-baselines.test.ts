import { describe, expect, it } from 'vitest';
import { ByteStream } from '../../archive/byte-stream.js';
import { ReadIterator } from '../../archive/read-iterator.js';
import { SceneEndBaselines } from './scene-end-baselines.js';

describe('SceneEndBaselines', () => {
  it('has the expected metadata', () => {
    expect(SceneEndBaselines.messageName).toBe('SceneEndBaselines');
    expect(SceneEndBaselines.typeCrc).toBeGreaterThan(0);
  });

  it('encodes 8-byte NetworkId only', () => {
    const m = new SceneEndBaselines(0x0102_0304_0506_0708n);
    const s = new ByteStream();
    m.encodePayload(s);
    expect(s.toBytes().length).toBe(8);
    const d = SceneEndBaselines.decodePayload(new ReadIterator(s.toBytes()));
    expect(d.networkId).toBe(0x0102_0304_0506_0708n);
  });
});
