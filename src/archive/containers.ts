/**
 * Codec builders for the SOE/SWG Archive containers.
 *
 * Maps to:
 *   /home/tharper/code/swg-main/src/external/ours/library/archive/src/shared/Archive.h
 *     vector<T>: int32 LE count + T items                 (lines 130-141, 346-353)
 *     set<T>:    int32 LE count + T items (iter order)    (lines 145-156, 358-364)
 *     pair<A,B>: A then B, no separator                   (lines 122-126, 338-342)
 *     deque<T>:  same wire format as vector<T>            (lines 160-171, 368-376)
 *     map<K,V>:  size_t (4 bytes on 32-bit) count + pairs (lines 191-203, 380-388)
 *
 *   /home/tharper/code/swg-main/src/external/ours/library/archive/src/shared/AutoByteStream.h
 *     AutoArray<T>:    uint32 LE count + T items          (lines 459-504)
 *     AutoVariable<T>: passthrough — just T's bytes       (no count framing)
 *
 * The C++ AutoVariable<T> wraps a single value and pack/unpack only emit
 * the value bytes. On the wire there's no difference between an
 * AutoVariable<T> and writing T directly — that's why the message base
 * class only needs `addVariable()` to remember the order.
 *
 * Important distinction: vector<T>::pack writes an `int32` (line 348-349
 * — `signed int length = source.size(); target.put(&length, 4)`). The
 * AutoArray<T>::pack writes an `unsigned int` (line 461-462). The wire
 * bytes are identical (both 4 LE), but the type intent differs. We expose
 * both flavors and let the message wiring pick.
 */

import type { IByteStream, ICodec, IReadIterator } from './interface.js';

/**
 * AutoArray<T>: count is uint32 LE.
 */
export function AutoArrayCodec<T>(item: ICodec<T>): ICodec<T[]> {
  return {
    encode(stream: IByteStream, value: T[]): void {
      stream.writeU32(value.length);
      for (const v of value) {
        item.encode(stream, v);
      }
    },
    decode(iter: IReadIterator): T[] {
      const n = iter.readU32();
      const out: T[] = [];
      for (let i = 0; i < n; i++) {
        out.push(item.decode(iter));
      }
      return out;
    },
  };
}

/**
 * std::vector<T>: count is int32 LE. Wire-identical to AutoArray for
 * counts < 2^31, but kept separate so the read-side type intent is clear.
 */
export function VectorCodec<T>(item: ICodec<T>): ICodec<T[]> {
  return {
    encode(stream: IByteStream, value: T[]): void {
      stream.writeI32(value.length);
      for (const v of value) {
        item.encode(stream, v);
      }
    },
    decode(iter: IReadIterator): T[] {
      const n = iter.readI32();
      if (n < 0) {
        throw new RangeError(`std::vector decode: negative length ${n}`);
      }
      const out: T[] = [];
      for (let i = 0; i < n; i++) {
        out.push(item.decode(iter));
      }
      return out;
    },
  };
}

/**
 * std::set<T>: count is int32 LE, items in iteration (sorted) order.
 *
 * The encode side assumes the input is already de-duplicated. If you need
 * to enforce uniqueness, dedupe upstream or use a Set<T> input and convert.
 *
 * Decoder returns a JS `Set<T>` — but note JS Set uniqueness uses
 * SameValueZero, which doesn't dedupe structurally-equal objects. For
 * `string` and primitive `number`/`bigint` inputs (what SWG uses) it works.
 */
export function SetCodec<T>(item: ICodec<T>): ICodec<Set<T>> {
  return {
    encode(stream: IByteStream, value: Set<T>): void {
      stream.writeI32(value.size);
      // Iteration order is insertion order — matches C++ std::set iteration
      // only if the caller has pre-sorted. We do NOT re-sort here because
      // most uses are short and the receiver is a set (order doesn't
      // affect equality). The C++ encoder simply iterates the set.
      for (const v of value) {
        item.encode(stream, v);
      }
    },
    decode(iter: IReadIterator): Set<T> {
      const n = iter.readI32();
      if (n < 0) {
        throw new RangeError(`std::set decode: negative length ${n}`);
      }
      const out = new Set<T>();
      for (let i = 0; i < n; i++) {
        out.add(item.decode(iter));
      }
      return out;
    },
  };
}

/**
 * std::pair<A, B>: A then B with no separator or framing.
 */
export function PairCodec<A, B>(a: ICodec<A>, b: ICodec<B>): ICodec<[A, B]> {
  return {
    encode(stream: IByteStream, value: [A, B]): void {
      a.encode(stream, value[0]);
      b.encode(stream, value[1]);
    },
    decode(iter: IReadIterator): [A, B] {
      const first = a.decode(iter);
      const second = b.decode(iter);
      return [first, second];
    },
  };
}

/**
 * AutoVariable<T> is pure passthrough on the wire. We expose a helper
 * that's literally the input codec — this exists so message-construction
 * call sites can be explicit about what they're modeling.
 */
export function AutoVariableCodec<T>(item: ICodec<T>): ICodec<T> {
  return item;
}

/**
 * std::map<K, V>: 4-byte (size_t on 32-bit) count + K-V pairs.
 *
 * On 32-bit (the server's build) `size_t` is 4 bytes. On 64-bit clients
 * it'd be 8 bytes — but we mimic the server, which is the source of
 * truth on the wire. If you ever talk to a 64-bit server, fork this.
 */
export function MapCodec<K, V>(key: ICodec<K>, val: ICodec<V>): ICodec<Map<K, V>> {
  return {
    encode(stream: IByteStream, value: Map<K, V>): void {
      stream.writeU32(value.size);
      for (const [k, v] of value) {
        key.encode(stream, k);
        val.encode(stream, v);
      }
    },
    decode(iter: IReadIterator): Map<K, V> {
      const n = iter.readU32();
      const out = new Map<K, V>();
      for (let i = 0; i < n; i++) {
        const k = key.decode(iter);
        const v = val.decode(iter);
        out.set(k, v);
      }
      return out;
    },
  };
}
