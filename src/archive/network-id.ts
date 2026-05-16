/**
 * NetworkId codec — 8-byte signed integer (int64 LE) on the wire.
 *
 * Maps to:
 *   /home/tharper/code/swg-main/src/engine/shared/library/sharedFoundation/src/shared/NetworkIdArchive.cpp
 *
 * NetworkId is conceptually a tagged uint64 (high 32 bits identify the
 * cluster, low 32 bits identify the object within the cluster), but the
 * C++ Archive helper goes through int64 — so we follow suit and expose
 * `bigint`. We treat the wire value as signed; callers wanting unsigned
 * semantics can BigInt.asUintN(64, v) themselves.
 *
 * The shared `NetworkId` type alias in `types.ts` is `bigint`.
 */

import type { NetworkId } from '../types.js';
import type { ICodec } from './interface.js';

export const NetworkIdCodec: ICodec<NetworkId> = {
  encode: (s, v) => s.writeI64(v),
  decode: (i) => i.readI64(),
};
