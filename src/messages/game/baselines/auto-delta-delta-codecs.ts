/**
 * Delta-side codecs for AutoDeltaVector / Set / Map.
 *
 * Counterpart to `auto-delta-codecs.ts` (which handles the baseline / pack()
 * wire format). The packDelta format encodes a sequence of commands
 * (ERASE / INSERT / SET / SETALL / CLEAR for vectors;
 * ERASE / INSERT / CLEAR for sets;
 * ADD / ERASE / SET for maps) rather than the full container state.
 *
 * Used by `DeltaFieldCodec.decode` for any baseline field that's an
 * AutoDelta* container. Without these, packages with container fields
 * can't have their delta entries decoded — `tryDecodeDelta` will return
 * null because the iterator desyncs at the first container field.
 *
 * # Common framing
 *
 * Every packDelta wire form starts with two u32 LE words:
 *
 *   [u32 commandCount][u32 baselineCommandCount]
 *
 * The `baselineCommandCount` is the server's running total of writes that
 * have been applied to the container — used by the C++ side to detect
 * out-of-order delta application and skip-replay incoming commands when
 * the local state is behind. We don't reapply commands here (we're a
 * forensic decoder, not a stateful mirror), so we read and drop the
 * `baselineCommandCount`.
 *
 * # SETALL gotcha (AutoDeltaVector only)
 *
 * `AutoDeltaVector::set(VectorType &)` queues `1 + count` commands:
 * one SETALL followed by `count` SET commands. The C++ `packDelta`
 * loop advances the iterator `count` times within the SETALL case to
 * consume those queued SET commands — they're emitted INSIDE the SETALL
 * block as raw values, not re-emitted as standalone SET commands.
 *
 * So when DECODING SETALL we read `count` values directly and advance our
 * outer command counter by `1 + count` to skip past the slots the C++
 * iterator consumed.
 *
 * Source:
 *   /home/tharper/code/swg-main/src/external/ours/library/archive/src/shared/AutoDeltaVector.h:394-433 (packDelta) + :532-553 (set(VectorType) queueing)
 *   /home/tharper/code/swg-main/src/external/ours/library/archive/src/shared/AutoDeltaSet.h:323-343
 *   /home/tharper/code/swg-main/src/external/ours/library/archive/src/shared/AutoDeltaMap.h:404-429
 */

import type { IReadIterator } from '../../../archive/interface.js';

// --------------------------------------------------------------------
// Command enum values
// --------------------------------------------------------------------
//
// In the C++ headers these are unnamed enums inside `struct Command`, so
// they auto-number from 0 in declaration order. Verified against the
// headers cited above.

/** `AutoDeltaVector<T>::Command::{ERASE, INSERT, SET, SETALL, CLEAR}` */
export const AutoDeltaVectorCommand = {
  ERASE: 0,
  INSERT: 1,
  SET: 2,
  SETALL: 3,
  CLEAR: 4,
} as const;

/** `AutoDeltaSet<T>::Command::{ERASE, INSERT, CLEAR}` */
export const AutoDeltaSetCommand = {
  ERASE: 0,
  INSERT: 1,
  CLEAR: 2,
} as const;

/** `AutoDeltaMap<K, V>::Command::{ADD, ERASE, SET}` */
export const AutoDeltaMapCommand = {
  ADD: 0,
  ERASE: 1,
  SET: 2,
} as const;

// --------------------------------------------------------------------
// Decoded command types
// --------------------------------------------------------------------

/** One decoded AutoDeltaVector command. */
export type AutoDeltaVectorDelta<T> =
  | { kind: 'erase'; index: number }
  | { kind: 'insert'; index: number; value: T }
  | { kind: 'set'; index: number; value: T }
  | { kind: 'setAll'; values: T[] }
  | { kind: 'clear' };

/** One decoded AutoDeltaSet command. */
export type AutoDeltaSetDelta<T> =
  | { kind: 'erase'; value: T }
  | { kind: 'insert'; value: T }
  | { kind: 'clear' };

/**
 * One decoded AutoDeltaMap command.
 *
 * Note: ALL three command kinds carry both key AND value on the wire.
 * The ERASE command emits the (now-stale) value as well — the server
 * uses this to invoke `onErase` callbacks with the old value, and the
 * `packDelta` source (AutoDeltaMap.h:404-429) unconditionally writes
 * both key and value for ADD / SET / ERASE.
 */
export type AutoDeltaMapDelta<K, V> =
  | { kind: 'add'; key: K; value: V }
  | { kind: 'erase'; key: K; value: V }
  | { kind: 'set'; key: K; value: V };

// --------------------------------------------------------------------
// Readers
// --------------------------------------------------------------------

/**
 * Read an `AutoDeltaVector<T>::packDelta` byte stream.
 *
 * Wire layout:
 *   [u32 commandCount][u32 baselineCommandCount]
 *   for each command:
 *     [u8 cmd]
 *     ERASE(0):  [u16 index]
 *     INSERT(1): [u16 index][T value]
 *     SET(2):    [u16 index][T value]
 *     SETALL(3): [u16 count][count×T values]   (consumes 1+count outer slots)
 *     CLEAR(4):  (no payload)
 *
 * Throws on any unknown cmd byte (mirrors the C++ `assert(false)` in
 * `unpackDelta`).
 */
export function readAutoDeltaVectorDelta<T>(
  iter: IReadIterator,
  readValue: (i: IReadIterator) => T,
): AutoDeltaVectorDelta<T>[] {
  const commandCount = iter.readU32();
  // baselineCommandCount — drop, see file header
  iter.readU32();

  const out: AutoDeltaVectorDelta<T>[] = [];
  let i = 0;
  while (i < commandCount) {
    const cmd = iter.readU8();
    switch (cmd) {
      case AutoDeltaVectorCommand.ERASE: {
        const index = iter.readU16();
        out.push({ kind: 'erase', index });
        i += 1;
        break;
      }
      case AutoDeltaVectorCommand.INSERT: {
        const index = iter.readU16();
        const value = readValue(iter);
        out.push({ kind: 'insert', index, value });
        i += 1;
        break;
      }
      case AutoDeltaVectorCommand.SET: {
        const index = iter.readU16();
        const value = readValue(iter);
        out.push({ kind: 'set', index, value });
        i += 1;
        break;
      }
      case AutoDeltaVectorCommand.SETALL: {
        const count = iter.readU16();
        const values: T[] = [];
        for (let j = 0; j < count; j++) {
          values.push(readValue(iter));
        }
        out.push({ kind: 'setAll', values });
        // The C++ side queues 1 (SETALL) + count (SET) commands, but
        // packDelta consumes the count SET slots within the SETALL case.
        // So advancing the outer counter by 1+count keeps us in sync.
        i += 1 + count;
        break;
      }
      case AutoDeltaVectorCommand.CLEAR: {
        out.push({ kind: 'clear' });
        i += 1;
        break;
      }
      default:
        throw new Error(`AutoDeltaVector: unknown command byte ${cmd}`);
    }
  }
  return out;
}

/**
 * Read an `AutoDeltaSet<T>::packDelta` byte stream.
 *
 * Wire layout:
 *   [u32 commandCount][u32 baselineCommandCount]
 *   for each command:
 *     [u8 cmd]
 *     ERASE(0):  [T value]
 *     INSERT(1): [T value]
 *     CLEAR(2):  (no payload)
 */
export function readAutoDeltaSetDelta<T>(
  iter: IReadIterator,
  readValue: (i: IReadIterator) => T,
): AutoDeltaSetDelta<T>[] {
  const commandCount = iter.readU32();
  // baselineCommandCount — drop
  iter.readU32();

  const out: AutoDeltaSetDelta<T>[] = [];
  for (let i = 0; i < commandCount; i++) {
    const cmd = iter.readU8();
    switch (cmd) {
      case AutoDeltaSetCommand.ERASE: {
        out.push({ kind: 'erase', value: readValue(iter) });
        break;
      }
      case AutoDeltaSetCommand.INSERT: {
        out.push({ kind: 'insert', value: readValue(iter) });
        break;
      }
      case AutoDeltaSetCommand.CLEAR: {
        out.push({ kind: 'clear' });
        break;
      }
      default:
        throw new Error(`AutoDeltaSet: unknown command byte ${cmd}`);
    }
  }
  return out;
}

/**
 * Read an `AutoDeltaMap<K, V>::packDelta` byte stream.
 *
 * Wire layout:
 *   [u32 commandCount][u32 baselineCommandCount]
 *   for each command:
 *     [u8 cmd][K key][V value]
 *
 * ALL three commands (ADD / ERASE / SET) carry both key AND value on the
 * wire (AutoDeltaMap.h:404-429). The ERASE command emits the
 * about-to-be-removed value so the server can invoke `onErase` callbacks
 * with it.
 */
export function readAutoDeltaMapDelta<K, V>(
  iter: IReadIterator,
  readKey: (i: IReadIterator) => K,
  readValue: (i: IReadIterator) => V,
): AutoDeltaMapDelta<K, V>[] {
  const commandCount = iter.readU32();
  // baselineCommandCount — drop
  iter.readU32();

  const out: AutoDeltaMapDelta<K, V>[] = [];
  for (let i = 0; i < commandCount; i++) {
    const cmd = iter.readU8();
    const key = readKey(iter);
    const value = readValue(iter);
    switch (cmd) {
      case AutoDeltaMapCommand.ADD:
        out.push({ kind: 'add', key, value });
        break;
      case AutoDeltaMapCommand.ERASE:
        out.push({ kind: 'erase', key, value });
        break;
      case AutoDeltaMapCommand.SET:
        out.push({ kind: 'set', key, value });
        break;
      default:
        throw new Error(`AutoDeltaMap: unknown command byte ${cmd}`);
    }
  }
  return out;
}
