/**
 * Delta package decoder registry — the post-baseline counterpart to
 * `baseline-registry.ts`.
 *
 * After the zone-in baseline flood completes, the server emits per-object
 * `DeltasMessage` packets whenever any AutoDeltaVariable on the object's
 * watched package changes value. Each delta carries the same
 * `(target, typeId, packageId)` keys as a baseline, plus a variable-length
 * inner blob:
 *
 *   [u16 count]
 *   for each dirty field:
 *     [u16 fieldIndex]            ← position in the package's addVariable() order
 *     [type-specific bytes]       ← the new value (or AutoDelta* command sequence)
 *
 * **Critical wire-format note**: there's no opaque-slicing escape. The
 * client must know the wire size of each field type to walk the blob — the
 * server's `AutoDeltaByteStream::unpackDeltas` reads `count`, then loops
 * `while (source.getSize())`, dispatching each entry through
 * `members[index]->unpackDelta(source)` which consumes a type-specific
 * number of bytes. Skipping an unknown field index is impossible.
 *
 * Consequence: a delta package decoder must cover **every** field in the
 * package's addVariable order, not just the ones the consumer cares about.
 * Partial coverage means a delta touching an uncovered field is undecodable
 * (the iterator desyncs on the next entry).
 *
 * Source:
 *   /home/tharper/code/swg-main/src/external/ours/library/archive/src/shared/AutoDeltaByteStream.cpp:122-188
 *
 * # Adding a new package decoder
 *
 * Look up the baseline file for the same (typeId, packageId) — the
 * `addVariable` order there IS the field order here. For each field,
 * pick the right `decode(iter)` function. Primitive fields are trivial
 * (one stream read). AutoDelta* container fields encode a command
 * sequence; see `AutoDeltaVector.h::packDelta` / `AutoDeltaSet.h::packDelta`
 * / `AutoDeltaMap.h::packDelta` for the wire layouts.
 */

import type { IReadIterator } from '../../../archive/interface.js';
import { tagToString } from './registry.js';

/**
 * Decoder for a single field in a delta package. Each entry must read
 * EXACTLY the bytes its wire type consumes — no over-read, no under-read.
 *
 * `name` should match the property name on the corresponding baseline
 * interface (e.g. `bankBalance` to match `TangibleObjectClientServerBaseline.bankBalance`)
 * so consumers can use the baseline type as the static type for the
 * delta's sparse `data` object.
 */
export interface DeltaFieldCodec {
  /** Property name on the parent baseline interface. */
  readonly name: string;
  /** Read exactly this field's delta bytes from `iter`. */
  decode(iter: IReadIterator): unknown;
}

/**
 * Per-package delta decoder. `fields[i]` MUST correspond to position `i`
 * in the package's `addVariable()` order (and to the same field in the
 * matching `BaselineDecoder`).
 */
export interface DeltaPackageDecoder<T = unknown> {
  /** Stable string for dispatch (e.g. `'TangibleObjectClientServerDelta'`). */
  readonly kind: string;
  /** Object-type Tag, e.g. `ObjectTypeTags.TANO`. */
  readonly typeId: number;
  /** `BASELINES_*` / `DELTAS_*` enum value (same enum, separate prefix). */
  readonly packageId: number;
  /** Field decoders in `addVariable()` order. */
  readonly fields: ReadonlyArray<DeltaFieldCodec>;
  /** Phantom type carrier so `DecodedDelta<T>` can pick up `T`. */
  readonly __baselineType?: T;
}

/**
 * Result of a successful delta dispatch. Mirrors `DecodedBaseline` shape,
 * except `data` is a sparse `Partial<T>` — only the changed fields are
 * present.
 */
export interface DecodedDelta<T = unknown> {
  kind: string;
  /** Sparse: only fields that changed in this packet are present. */
  data: Partial<T>;
}

class DeltaRegistry {
  /** key = (typeId << 8) | packageId — same scheme as `BaselineRegistry`. */
  private readonly byKey = new Map<number, DeltaPackageDecoder<unknown>>();
  private readonly byKind = new Map<string, DeltaPackageDecoder<unknown>>();

  private static makeKey(typeId: number, packageId: number): number {
    return typeId * 256 + (packageId & 0xff);
  }

  register<T>(decoder: DeltaPackageDecoder<T>): DeltaPackageDecoder<T> {
    const key = DeltaRegistry.makeKey(decoder.typeId, decoder.packageId);
    const existing = this.byKey.get(key);
    if (existing && existing !== decoder) {
      throw new Error(
        `Delta decoder collision for (${tagToString(decoder.typeId)}, ${decoder.packageId}): ${decoder.kind} vs ${existing.kind}`,
      );
    }
    const decoderUnknown = decoder as unknown as DeltaPackageDecoder<unknown>;
    this.byKey.set(key, decoderUnknown);
    this.byKind.set(decoder.kind, decoderUnknown);
    return decoder;
  }

  get(typeId: number, packageId: number): DeltaPackageDecoder<unknown> | undefined {
    return this.byKey.get(DeltaRegistry.makeKey(typeId, packageId));
  }

  getByKind(kind: string): DeltaPackageDecoder<unknown> | undefined {
    return this.byKind.get(kind);
  }

  /** Test helper — NOT for production. */
  clear(): void {
    this.byKey.clear();
    this.byKind.clear();
  }

  entries(): IterableIterator<[number, DeltaPackageDecoder<unknown>]> {
    return this.byKey.entries();
  }
}

/** Process-wide singleton. */
export const deltaRegistry = new DeltaRegistry();

/** Convenience: register and return. Use at module load. */
export function registerDelta<T>(decoder: DeltaPackageDecoder<T>): DeltaPackageDecoder<T> {
  return deltaRegistry.register(decoder);
}

/**
 * Try to decode a delta package payload. Returns `null` if no decoder is
 * registered for `(typeId, packageId)`, or if decoding throws (e.g. an
 * unknown field index, or the iterator desyncs).
 *
 * Failures are swallowed (returned as `null`) the same way `tryDecodeBaseline`
 * does — one bad delta shouldn't abort the higher-level dispatcher. The
 * caller still has `packageBytes` for forensic inspection.
 */
export function tryDecodeDelta(
  typeId: number,
  packageId: number,
  payload: Uint8Array,
  iterCtor: (bytes: Uint8Array) => IReadIterator,
): DecodedDelta | null {
  const decoder = deltaRegistry.get(typeId, packageId);
  if (!decoder) return null;
  try {
    const iter = iterCtor(payload);
    // The leading u16 count is informational; the authoritative termination
    // condition is "iterator exhausted" (mirrors `AutoDeltaByteStream::unpackDeltas`
    // which reads count then loops `while (source.getSize())`).
    iter.readU16();
    const data: Record<string, unknown> = {};
    while (iter.remaining > 0) {
      const fieldIndex = iter.readU16();
      const field = decoder.fields[fieldIndex];
      if (!field) {
        throw new Error(
          `Delta field index out of range: ${fieldIndex} (package has ${decoder.fields.length} fields)`,
        );
      }
      data[field.name] = field.decode(iter);
    }
    return { kind: decoder.kind, data };
  } catch {
    return null;
  }
}
