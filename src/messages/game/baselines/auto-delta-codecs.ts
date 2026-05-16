/**
 * Codecs for the AutoDelta* container types whose wire formats live in
 * `external/ours/library/archive/src/shared/AutoDelta*.h`. These are used by
 * baseline package decoders; the AutoByteStream `[u16 memberCount]` prefix is
 * handled separately by the caller, so each codec here is just a single field.
 *
 * For full baselines (NOT delta updates) the wire formats are:
 *
 *   AutoDeltaSet<T>:
 *     [u32 size][u32 baselineCommandCount=0][T values...]
 *     (`AutoDeltaSet.h:302-308`)
 *
 *   AutoDeltaMap<K, V>:
 *     [u32 size][u32 baselineCommandCount=0][for each: u8 cmd=ADD(0), K, V]
 *     (`AutoDeltaMap.h:349-362`)
 *
 *   AutoDeltaVector<T>:
 *     [u32 size][u32 baselineCommandCount=0][T values...]
 *
 * For the values inside Set/Map/Vector we use whatever `Archive::put` /
 * `Archive::get` would resolve to for T — same on-wire format as bare T.
 */

import type { IReadIterator } from '../../../archive/interface.js';
import { NetworkIdCodec } from '../../../archive/network-id.js';
import { readStdString } from '../../../archive/string.js';
import type { NetworkId } from '../../../types.js';

/**
 * Generic AutoDeltaSet<T> reader. Caller provides the per-element reader.
 *
 * @returns the values in iteration order (the C++ side stores a std::set so
 *          the wire order is sorted by T's `<` operator).
 */
export function readAutoDeltaSet<T>(
  iter: IReadIterator,
  readElement: (i: IReadIterator) => T,
): T[] {
  const size = iter.readU32();
  // baselineCommandCount — always 0 for a baseline, we drop it
  iter.readU32();
  const out: T[] = [];
  for (let i = 0; i < size; i++) {
    out.push(readElement(iter));
  }
  return out;
}

/** Specialization: `AutoDeltaSet<int>`. */
export function readAutoDeltaSetI32(iter: IReadIterator): number[] {
  return readAutoDeltaSet(iter, (i) => i.readI32());
}

/** Specialization: `AutoDeltaSet<NetworkId>`. */
export function readAutoDeltaSetNetworkId(iter: IReadIterator): NetworkId[] {
  return readAutoDeltaSet(iter, NetworkIdCodec.decode);
}

/** Specialization: `AutoDeltaSet<std::string>`. */
export function readAutoDeltaSetString(iter: IReadIterator): string[] {
  return readAutoDeltaSet(iter, readStdString);
}

/**
 * Specialization: `AutoDeltaSet<std::pair<NetworkId, NetworkId>>`.
 *
 * Used for things like `m_groupMissionCriticalObjectSet` where each entry is
 * an (owner, object) tuple. Wire format is the standard AutoDeltaSet header
 * plus each value as `[NetworkId][NetworkId]`.
 */
export function readAutoDeltaSetNetworkIdPair(
  iter: IReadIterator,
): { first: NetworkId; second: NetworkId }[] {
  return readAutoDeltaSet(iter, (i) => ({
    first: NetworkIdCodec.decode(i),
    second: NetworkIdCodec.decode(i),
  }));
}

/**
 * Specialization: `AutoDeltaSet<std::pair<std::string, std::string>>`.
 *
 * Used for things like `m_notifyRegions` where each entry is a
 * (planet, region) tuple.
 */
export function readAutoDeltaSetStringPair(
  iter: IReadIterator,
): { first: string; second: string }[] {
  return readAutoDeltaSet(iter, (i) => ({
    first: readStdString(i),
    second: readStdString(i),
  }));
}

/**
 * Generic AutoDeltaVector<T> reader. Same wire format as AutoDeltaSet but the
 * underlying container is `std::vector` (preserves insertion order, no sort).
 */
export function readAutoDeltaVector<T>(
  iter: IReadIterator,
  readElement: (i: IReadIterator) => T,
): T[] {
  // Same layout as set: [u32 size][u32 baselineCommandCount][values...]
  return readAutoDeltaSet(iter, readElement);
}

/** Specialization: `AutoDeltaVector<std::string>`. */
export function readAutoDeltaVectorString(iter: IReadIterator): string[] {
  return readAutoDeltaVector(iter, readStdString);
}

/** Specialization: `AutoDeltaVector<int>`. */
export function readAutoDeltaVectorI32(iter: IReadIterator): number[] {
  return readAutoDeltaVector(iter, (i) => i.readI32());
}

/** Specialization: `AutoDeltaVector<float>`. */
export function readAutoDeltaVectorF32(iter: IReadIterator): number[] {
  return readAutoDeltaVector(iter, (i) => i.readF32());
}

/** Specialization: `AutoDeltaVector<uint32>`. */
export function readAutoDeltaVectorU32(iter: IReadIterator): number[] {
  return readAutoDeltaVector(iter, (i) => i.readU32());
}

/** An entry in a decoded AutoDeltaMap. */
export interface MapEntry<K, V> {
  key: K;
  value: V;
}

/**
 * Generic AutoDeltaMap<K, V> reader. Caller provides per-key and per-value
 * readers.
 *
 * The wire format includes a per-entry `u8 cmd` byte; for a full baseline it
 * MUST be `ADD = 0`. We tolerate any value and treat it as ADD (mirroring the
 * server's no-op for unrecognized cmds in baseline context).
 *
 * Source:
 *   /home/tharper/code/swg-main/src/external/ours/library/archive/src/shared/AutoDeltaMap.h:349-362
 */
export function readAutoDeltaMap<K, V>(
  iter: IReadIterator,
  readKey: (i: IReadIterator) => K,
  readValue: (i: IReadIterator) => V,
): MapEntry<K, V>[] {
  const size = iter.readU32();
  // baselineCommandCount — always 0 for a baseline
  iter.readU32();
  const out: MapEntry<K, V>[] = [];
  for (let i = 0; i < size; i++) {
    // cmd: ADD=0, REMOVE=1, SET=2, CLEAR=3. Baselines only use ADD.
    iter.readU8();
    const key = readKey(iter);
    const value = readValue(iter);
    out.push({ key, value });
  }
  return out;
}

/**
 * `BitArray` codec — variable-length packed bit string.
 *
 * Wire layout:
 *   [i32 numInUseBytes][i32 numInUseBits][i8 byteArray[numInUseBytes]]
 *
 * If either count is <= 0 we treat the BitArray as empty.
 *
 * Source:
 *   /home/tharper/code/swg-main/src/engine/shared/library/sharedFoundation/src/shared/BitArray.cpp:344-394
 */
export interface BitArrayValue {
  /** Total bits the consumer wrote (NOT padded to byte boundary). */
  numInUseBits: number;
  /** The underlying byte array. Length == numInUseBytes from the wire (>= ceil(numInUseBits / 8)). */
  bytes: Uint8Array;
}

/** Static "empty" / cleared BitArray. */
export const EMPTY_BIT_ARRAY: BitArrayValue = { numInUseBits: 0, bytes: new Uint8Array(0) };

export function readBitArray(iter: IReadIterator): BitArrayValue {
  const numInUseBytes = iter.readI32();
  const numInUseBits = iter.readI32();
  if (numInUseBytes <= 0 || numInUseBits <= 0) {
    return EMPTY_BIT_ARRAY;
  }
  const bytes = iter.readBytes(numInUseBytes);
  return { numInUseBits, bytes };
}

/**
 * `MatchMakingId` codec — a 128-bit bitfield serialized as `std::vector<int>`
 * of 4 elements (32 bits each).
 *
 * Wire layout:
 *   [u32 count=4][i32 v0][i32 v1][i32 v2][i32 v3]
 *
 * The C++ stores it as `std::bitset<128>` and packs via `getInts()` →
 * `std::vector<int>` → `Archive::put(vector)`.
 *
 * Source:
 *   /home/tharper/code/swg-main/src/engine/shared/library/sharedGame/src/shared/object/MatchMakingId.cpp:38-46
 *   plus Archive.h vector `put` (i32 count + values).
 */
export interface MatchMakingIdValue {
  /** Always 4 in practice (128 bits / 32). */
  ints: number[];
}

export const EMPTY_MATCH_MAKING_ID: MatchMakingIdValue = { ints: [0, 0, 0, 0] };

export function readMatchMakingId(iter: IReadIterator): MatchMakingIdValue {
  // std::vector pack: [i32 count][i32 values...]
  const count = iter.readI32();
  const ints: number[] = [];
  for (let i = 0; i < count; i++) {
    ints.push(iter.readI32());
  }
  return { ints };
}
