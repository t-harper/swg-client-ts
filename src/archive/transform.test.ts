import { describe, expect, it } from 'vitest';
import { ByteStream } from './byte-stream.js';
import { ReadIterator } from './read-iterator.js';
import {
  QuaternionCodec,
  TransformCodec,
  Vector3Codec,
  quatToYaw,
  yawToQuat,
} from './transform.js';

describe('Vector3 codec', () => {
  it('round-trips a position', () => {
    const s = new ByteStream();
    Vector3Codec.encode(s, { x: 12.5, y: 0, z: -7.25 });
    expect(s.length).toBe(12);
    const v = Vector3Codec.decode(new ReadIterator(s.toBytes()));
    expect(v.x).toBeCloseTo(12.5, 5);
    expect(v.y).toBeCloseTo(0, 5);
    expect(v.z).toBeCloseTo(-7.25, 5);
  });
});

describe('Quaternion codec', () => {
  it('round-trips identity', () => {
    const s = new ByteStream();
    QuaternionCodec.encode(s, { x: 0, y: 0, z: 0, w: 1 });
    const q = QuaternionCodec.decode(new ReadIterator(s.toBytes()));
    expect(q).toEqual({ x: 0, y: 0, z: 0, w: 1 });
  });

  it('treats NaN as identity (matches C++ defensive reset)', () => {
    const s = new ByteStream();
    s.writeF32(Number.NaN);
    s.writeF32(0);
    s.writeF32(0);
    s.writeF32(1);
    const q = QuaternionCodec.decode(new ReadIterator(s.toBytes()));
    expect(q).toEqual({ x: 0, y: 0, z: 0, w: 1 });
  });
});

describe('Transform codec', () => {
  it('serializes quaternion then vector (7 floats / 28 bytes)', () => {
    const s = new ByteStream();
    TransformCodec.encode(s, {
      rotation: { x: 0, y: 0, z: 0, w: 1 },
      position: { x: 1, y: 2, z: 3 },
    });
    expect(s.length).toBe(28);
  });

  it('round-trips a typical zone-in transform', () => {
    const s = new ByteStream();
    const t = {
      rotation: yawToQuat(Math.PI / 4),
      position: { x: -120.5, y: 0.3, z: 17 },
    };
    TransformCodec.encode(s, t);
    const out = TransformCodec.decode(new ReadIterator(s.toBytes()));
    expect(out.position.x).toBeCloseTo(t.position.x, 4);
    expect(out.position.y).toBeCloseTo(t.position.y, 4);
    expect(out.position.z).toBeCloseTo(t.position.z, 4);
    expect(quatToYaw(out.rotation)).toBeCloseTo(Math.PI / 4, 4);
  });
});

describe('yaw <-> quat helpers', () => {
  it('yawToQuat then quatToYaw is identity (modulo round-off)', () => {
    for (const yaw of [-Math.PI + 0.001, -1, 0, 0.5, 1, Math.PI - 0.001]) {
      expect(quatToYaw(yawToQuat(yaw))).toBeCloseTo(yaw, 5);
    }
  });
});
