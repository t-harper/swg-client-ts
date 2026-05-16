/**
 * ObjController subtype registry — maps `ObjControllerMessage.message`
 * (a `GameControllerMessage` enum value) to a decoder for the trailer.
 *
 * On the wire, an `ObjControllerMessage` has:
 *   - the 20-byte AutoByteStream-framed header (flags, message, networkId, value)
 *   - a variable-length trailer whose layout is determined by `message` and
 *     looked up in C++ via `ControllerMessageFactory::unpack`.
 *
 * The C++ enum is declared in:
 *   /home/tharper/code/swg-main/src/engine/shared/library/sharedFoundation/src/shared/GameControllerMessage.def
 *
 * Each entry starts at 0 (CM_nothing) and increments by 1 with no holes.
 * The most-relevant subtypes for our headless lifecycle and any combat /
 * social automation are exported here.
 *
 * Pattern mirrors `src/messages/registry.ts` but is independent — these are
 * NOT GameNetworkMessages, just typed wrappers around the trailer bytes.
 */

import type { IByteStream, IReadIterator } from '../../../archive/interface.js';

/**
 * Decoder for an ObjController subtype.
 *
 * Each subtype module declares:
 *   - `kind` — a stable string used for routing/dispatch in tests and consumers
 *   - `subtypeId` — the int32 controller-message id (CM_* enum value)
 *   - `encode(stream, data)` — symmetric to decode; round-trips test fixtures
 *   - `decode(iter)` — reads from a sub-iterator scoped to the trailer
 */
export interface ObjControllerSubtypeDecoder<T> {
  readonly kind: string;
  readonly subtypeId: number;
  encode(stream: IByteStream, data: T): void;
  decode(iter: IReadIterator): T;
}

class ObjControllerRegistry {
  private readonly byId = new Map<number, ObjControllerSubtypeDecoder<unknown>>();
  private readonly byKind = new Map<string, ObjControllerSubtypeDecoder<unknown>>();

  register<T>(decoder: ObjControllerSubtypeDecoder<T>): ObjControllerSubtypeDecoder<T> {
    const existing = this.byId.get(decoder.subtypeId);
    if (existing && existing !== decoder) {
      throw new Error(
        `ObjController subtype collision: ${decoder.kind} and ${existing.kind} both have subtypeId ${decoder.subtypeId}`,
      );
    }
    const decoderUnknown = decoder as ObjControllerSubtypeDecoder<unknown>;
    this.byId.set(decoder.subtypeId, decoderUnknown);
    this.byKind.set(decoder.kind, decoderUnknown);
    return decoder;
  }

  getById(id: number): ObjControllerSubtypeDecoder<unknown> | undefined {
    return this.byId.get(id);
  }

  getByKind(kind: string): ObjControllerSubtypeDecoder<unknown> | undefined {
    return this.byKind.get(kind);
  }

  /** Test helper — clear all registrations. NOT for production use. */
  clear(): void {
    this.byId.clear();
    this.byKind.clear();
  }

  entries(): IterableIterator<[number, ObjControllerSubtypeDecoder<unknown>]> {
    return this.byId.entries();
  }
}

/** Process-wide singleton. */
export const objControllerRegistry = new ObjControllerRegistry();

/**
 * Convenience: register a subtype decoder and return it. Use at module load:
 *
 *   export const Foo = registerObjControllerSubtype({ ... });
 */
export function registerObjControllerSubtype<T>(
  decoder: ObjControllerSubtypeDecoder<T>,
): ObjControllerSubtypeDecoder<T> {
  return objControllerRegistry.register(decoder);
}

/**
 * Result of dispatching a trailer against the registry.
 *
 * `kind` and `data` are non-null IFF a decoder is registered for the
 * subtype id. Otherwise both are null and the caller falls back to the
 * opaque `Uint8Array` trailer on the parent ObjControllerMessage.
 */
export interface DecodedSubtype<T = unknown> {
  kind: string;
  data: T;
}

/**
 * Try to decode the trailer for an ObjControllerMessage. The caller supplies
 * the subtype id (from `ObjControllerMessage.message`) and a fresh iterator
 * scoped to the trailer bytes.
 *
 * Returns `null` if no decoder is registered, OR if the registered decoder
 * throws (e.g. for a structural mismatch — the wire format we modeled doesn't
 * match this particular instance). We swallow decode errors here because
 * `ObjControllerMessage` itself has already successfully parsed the header,
 * and we don't want a subtype decoder bug to bubble up and break the parent
 * dispatch. The caller can still see the opaque trailer.
 */
export function tryDecodeSubtype(
  subtypeId: number,
  trailer: Uint8Array,
  iterCtor: (bytes: Uint8Array) => IReadIterator,
): DecodedSubtype | null {
  const decoder = objControllerRegistry.getById(subtypeId);
  if (!decoder) return null;
  try {
    const iter = iterCtor(trailer);
    const data = decoder.decode(iter);
    return { kind: decoder.kind, data };
  } catch {
    return null;
  }
}

/**
 * The 8 controller-message ids we model. Exported as named constants so
 * tests and consumers can reference them by name rather than literal int.
 *
 * Source line numbers refer to entry order in GameControllerMessage.def
 * (starting at CM_nothing = 0).
 */
export const ObjControllerSubtypeIds = {
  CM_combatAction: 204,
  CM_setPosture: 305,
  CM_combatSpam: 308,
  CM_sitOnObject: 315,
  CM_objectMenuRequest: 326,
  CM_objectMenuResponse: 327,
  CM_alterHitPoints: 384,
  CM_setMood: 422,
} as const;
