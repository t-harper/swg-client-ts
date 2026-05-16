/**
 * Transform codec — Quaternion (4 floats: x, y, z, w) followed by
 * Vector (3 floats: x, y, z). 28 bytes total.
 *
 * Maps to:
 *   /home/tharper/code/swg-main/src/engine/shared/library/sharedMathArchive/src/shared/TransformArchive.h
 *   /home/tharper/code/swg-main/src/engine/shared/library/sharedMathArchive/src/shared/QuaternionArchive.h
 *   /home/tharper/code/swg-main/src/engine/shared/library/sharedMathArchive/src/shared/VectorArchive.h
 *
 * C++ side:
 *   get/put: Quaternion (x, y, z, w as 4 f32 LE), then Vector (x, y, z as 3 f32 LE)
 *
 * We expose the wire shape directly rather than reconstructing the C++
 * 3x4 matrix layout; CmdStartScene and the other consumers only need the
 * position + facing (which we expose as `yaw` derived from the quat when
 * helpful — see `quatToYaw`).
 */

import type { Vector3 } from '../types.js';
import type { IByteStream, ICodec, IReadIterator } from './interface.js';

export interface Quaternion {
  x: number;
  y: number;
  z: number;
  w: number;
}

export interface Transform {
  rotation: Quaternion;
  position: Vector3;
}

export const QuaternionCodec: ICodec<Quaternion> = {
  encode(s, v) {
    s.writeF32(v.x);
    s.writeF32(v.y);
    s.writeF32(v.z);
    s.writeF32(v.w);
  },
  decode(i): Quaternion {
    const x = i.readF32();
    const y = i.readF32();
    const z = i.readF32();
    let w = i.readF32();
    // C++ does a NaN sanity reset; replicate (helps fuzz robustness)
    if (Number.isNaN(x) || Number.isNaN(y) || Number.isNaN(z) || Number.isNaN(w)) {
      // Mirror the C++ fallback (w=1, x=y=z=0)
      return { x: 0, y: 0, z: 0, w: 1 };
    }
    if (Number.isNaN(w)) {
      w = 1;
    }
    return { x, y, z, w };
  },
};

export const Vector3Codec: ICodec<Vector3> = {
  encode(s, v) {
    s.writeF32(v.x);
    s.writeF32(v.y);
    s.writeF32(v.z);
  },
  decode(i): Vector3 {
    const x = i.readF32();
    const y = i.readF32();
    const z = i.readF32();
    return { x, y, z };
  },
};

export const TransformCodec: ICodec<Transform> = {
  encode(s, v) {
    QuaternionCodec.encode(s, v.rotation);
    Vector3Codec.encode(s, v.position);
  },
  decode(i): Transform {
    const rotation = QuaternionCodec.decode(i);
    const position = Vector3Codec.decode(i);
    return { rotation, position };
  },
};

/**
 * Convenience: derive the yaw (rotation about Y) in radians from a unit
 * quaternion. SWG's world-up axis is +Y, and CmdStartScene reports only
 * yaw — not the full quaternion — for the player's facing.
 *
 * yaw = atan2(2*(w*y + x*z), 1 - 2*(y*y + x*x))
 *
 * NOT exhaustive (gimbal lock at +/- pi/2 pitch is fine here; SWG
 * player facing is yaw-only). Returned in radians, range (-pi, pi].
 */
export function quatToYaw(q: Quaternion): number {
  const siny_cosp = 2 * (q.w * q.y + q.x * q.z);
  const cosy_cosp = 1 - 2 * (q.y * q.y + q.x * q.x);
  return Math.atan2(siny_cosp, cosy_cosp);
}

/** Inverse helper: yaw radians → quaternion (rotation about Y axis only). */
export function yawToQuat(yawRadians: number): Quaternion {
  const half = yawRadians / 2;
  return { x: 0, y: Math.sin(half), z: 0, w: Math.cos(half) };
}
