import { describe, expect, it } from 'vitest';
import { ByteStream } from '../../archive/byte-stream.js';
import { ReadIterator } from '../../archive/read-iterator.js';
import type { Transform } from '../../archive/transform.js';
import { SceneCreateObjectByCrc } from './scene-create-object-by-crc.js';

describe('SceneCreateObjectByCrc', () => {
  it('has the expected metadata', () => {
    expect(SceneCreateObjectByCrc.messageName).toBe('SceneCreateObjectByCrc');
    expect(SceneCreateObjectByCrc.typeCrc).toBeGreaterThan(0);
  });

  it('round-trips', () => {
    // Approximate 45-degree yaw rotation. Use slightly off-Math.SQRT1_2
    // values to avoid biome's noApproximativeNumericConstant lint.
    const t: Transform = {
      rotation: { x: 0, y: 0.7, z: 0, w: 0.7 },
      position: { x: 100, y: 5, z: -50 },
    };
    // Use a value within signed i64 range — NetworkId is backed by int64
    // in C++ (NetworkIdArchive.cpp), so unsigned bit patterns above 2^63
    // would round-trip to the equivalent negative bigint.
    const id = 0x0011_2233_4455_6677n;
    const m = new SceneCreateObjectByCrc(id, t, 0x12345678, false);
    const s = new ByteStream();
    m.encodePayload(s);
    // Expected size: 8 (netid) + 28 (transform) + 4 (crc) + 1 (bool) = 41
    expect(s.toBytes().length).toBe(41);
    const iter = new ReadIterator(s.toBytes());
    const d = SceneCreateObjectByCrc.decodePayload(iter);
    expect(iter.remaining).toBe(0);
    expect(d.networkId).toBe(id);
    expect(d.transform.rotation.x).toBeCloseTo(0, 5);
    expect(d.transform.rotation.y).toBeCloseTo(0.7, 4);
    expect(d.transform.rotation.w).toBeCloseTo(0.7, 4);
    expect(d.transform.position.x).toBeCloseTo(100, 5);
    expect(d.transform.position.z).toBeCloseTo(-50, 5);
    expect(d.templateCrc).toBe(0x12345678);
    expect(d.hyperspace).toBe(false);
  });
});
