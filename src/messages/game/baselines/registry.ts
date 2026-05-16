/**
 * Baseline package decoder registry.
 *
 * The `BaselinesMessage` envelope carries:
 *   - `target`     — the NetworkId of the object being baselined
 *   - `typeId`     — a 4-byte object-type Tag (e.g. 'TANO' = ServerTangibleObjectTemplate,
 *                    'PLAY' = ServerPlayerObjectTemplate, 'CREO' = ServerCreatureObjectTemplate)
 *   - `packageId`  — one of the BASELINES_* enum values (1 = CLIENT_SERVER, 3 = SHARED,
 *                    4 = CLIENT_SERVER_NP, 6 = SHARED_NP, 8 = FIRST_PARENT_CLIENT_SERVER,
 *                    9 = FIRST_PARENT_CLIENT_SERVER_NP, etc.)
 *   - `package`    — the variable-length AutoByteStream payload whose member order
 *                    is determined by the (typeId, packageId) pair.
 *
 * Each `(typeId, packageId)` pair is a distinct decoder. We index by `Tag << 8 |
 * packageId` (a 40-bit key fits comfortably in a JS number) so lookups are O(1).
 *
 * Source for `BaselinesMessage`:
 *   /home/tharper/code/swg-main/src/engine/shared/library/sharedNetworkMessages/src/shared/common/BaselinesMessage.{h,cpp}
 *
 * Source for `BASELINES_*` enum:
 *   /home/tharper/code/swg-main/src/engine/shared/library/sharedNetworkMessages/src/shared/common/BaselinesMessage.h:50-62
 *
 * Source for per-type package contents:
 *   /home/tharper/code/swg-main/src/engine/server/library/serverGame/src/shared/generated/Packager.cpp
 *   (one `addMembersToPackages()` function per Server*Object class — each `addSharedVariable`
 *    call appends a field to the SHARED package in `addVariable` order).
 */

import type { IReadIterator } from '../../../archive/interface.js';

/**
 * Convert a 4-char ASCII string to a u32 IFF tag. SWG's `TAG(a,b,c,d)` macro
 * packs as `(a<<24 | b<<16 | c<<8 | d)` — big-endian. The same integer is
 * then serialized as a little-endian u32 on the wire, so reading it via
 * `iter.readU32()` reproduces this big-endian-packed integer.
 *
 * `stringToTag('TANO')` == 0x54414E4F (== `TAG(T,A,N,O)` server-side).
 */
export function stringToTag(s: string): number {
  if (s.length !== 4) {
    throw new Error(`Tag string must be exactly 4 chars, got ${s.length}: "${s}"`);
  }
  return (
    ((s.charCodeAt(0) << 24) |
      (s.charCodeAt(1) << 16) |
      (s.charCodeAt(2) << 8) |
      s.charCodeAt(3)) >>>
    0
  );
}

/** Inverse of `stringToTag`. */
export function tagToString(tag: number): string {
  const b0 = (tag >>> 24) & 0xff;
  const b1 = (tag >>> 16) & 0xff;
  const b2 = (tag >>> 8) & 0xff;
  const b3 = tag & 0xff;
  return (
    String.fromCharCode(b0) +
    String.fromCharCode(b1) +
    String.fromCharCode(b2) +
    String.fromCharCode(b3)
  );
}

/**
 * The 4-byte object-type Tags we recognize. Each is the IFF tag declared in
 * the corresponding `Server*ObjectTemplate.h` file. Stored as the
 * little-endian uint32 read off the wire (e.g. 'TANO' on the wire is bytes
 * 'T','A','N','O' → u32 LE = 0x4F4E4154).
 *
 * Source for all server-template tags:
 *   `grep "_tag = TAG" /home/tharper/code/swg-main/src/engine/server/library/serverGame/src/shared/objectTemplate/*.h`
 */
export const ObjectTypeTags = {
  /** ServerTangibleObjectTemplate — TAG(T,A,N,O). */
  TANO: stringToTag('TANO'),
  /** ServerCreatureObjectTemplate — TAG(C,R,E,O). */
  CREO: stringToTag('CREO'),
  /** ServerPlayerObjectTemplate — TAG(P,L,A,Y). */
  PLAY: stringToTag('PLAY'),
  /** ServerIntangibleObjectTemplate — TAG(I,T,N,O). */
  ITNO: stringToTag('ITNO'),
  /** ServerWeaponObjectTemplate — TAG(W,E,A,O). */
  WEAO: stringToTag('WEAO'),
  /** ServerShipObjectTemplate — TAG(S,H,I,P). */
  SHIP: stringToTag('SHIP'),
  /** ServerBuildingObjectTemplate — TAG(B,U,I,O). */
  BUIO: stringToTag('BUIO'),
  /** ServerCellObjectTemplate — TAG(S,C,L,T). */
  SCLT: stringToTag('SCLT'),
  /** ServerStaticObjectTemplate — TAG(S,T,A,O). */
  STAO: stringToTag('STAO'),
} as const;

/**
 * BASELINES_* enum from `BaselinesMessage.h`. Sequential from 0.
 *
 * Most-relevant for client-bound baselines:
 *   - 1 (CLIENT_SERVER)               — sent to the auth client (owner of the object)
 *   - 3 (SHARED)                      — sent to ALL clients (broadest visibility)
 *   - 4 (CLIENT_SERVER_NP)            — same as 1 but not persisted (transient)
 *   - 6 (SHARED_NP)                   — same as 3 but not persisted (transient)
 *   - 8 (FIRST_PARENT_CLIENT_SERVER)  — for child objects sent to the first-parent auth client
 *   - 9 (FIRST_PARENT_CLIENT_SERVER_NP)
 */
export const BaselinePackageIds = {
  CLIENT_ONLY: 0,
  CLIENT_SERVER: 1,
  SERVER: 2,
  SHARED: 3,
  CLIENT_SERVER_NP: 4,
  SERVER_NP: 5,
  SHARED_NP: 6,
  UI: 7,
  FIRST_PARENT_CLIENT_SERVER: 8,
  FIRST_PARENT_CLIENT_SERVER_NP: 9,
} as const;

export type BaselinePackageId = (typeof BaselinePackageIds)[keyof typeof BaselinePackageIds];

/**
 * Decoder for a single `(typeId, packageId)` pair. Each baseline package
 * module declares:
 *
 *   - `kind`       — stable string for routing/dispatch (e.g. `'TangibleObjectShared'`)
 *   - `typeId`     — the u32 tag (e.g. `ObjectTypeTags.TANO`)
 *   - `packageId`  — the BASELINES_* enum value (e.g. `BaselinePackageIds.SHARED`)
 *   - `decode`     — reads from an iterator positioned at the AutoByteStream payload
 *                    (i.e. AFTER the u32 length prefix on the BaselinesMessage
 *                    package field). The first thing on the wire is the u16
 *                    member count — the decoder strips it and validates against
 *                    the expected count, then reads members in `addVariable` order.
 */
export interface BaselineDecoder<T> {
  readonly kind: string;
  readonly typeId: number;
  readonly packageId: number;
  /** Expected `[u16 memberCount]` at the head of the AutoByteStream payload. */
  readonly expectedMemberCount: number;
  decode(iter: IReadIterator): T;
}

/**
 * Result of a successful baseline dispatch.
 */
export interface DecodedBaseline<T = unknown> {
  kind: string;
  data: T;
}

class BaselineRegistry {
  /** key = (typeId << 8) | packageId */
  private readonly byKey = new Map<number, BaselineDecoder<unknown>>();
  private readonly byKind = new Map<string, BaselineDecoder<unknown>>();

  private static makeKey(typeId: number, packageId: number): number {
    // typeId fits in 32 bits; packageId is 1 byte; the result is up to 40 bits
    // which is safe in a JS number (< 2^53).
    return typeId * 256 + (packageId & 0xff);
  }

  register<T>(decoder: BaselineDecoder<T>): BaselineDecoder<T> {
    const key = BaselineRegistry.makeKey(decoder.typeId, decoder.packageId);
    const existing = this.byKey.get(key);
    if (existing && existing !== decoder) {
      throw new Error(
        `Baseline decoder collision for (${tagToString(decoder.typeId)}, ${decoder.packageId}): ${decoder.kind} vs ${existing.kind}`,
      );
    }
    const decoderUnknown = decoder as BaselineDecoder<unknown>;
    this.byKey.set(key, decoderUnknown);
    this.byKind.set(decoder.kind, decoderUnknown);
    return decoder;
  }

  get(typeId: number, packageId: number): BaselineDecoder<unknown> | undefined {
    return this.byKey.get(BaselineRegistry.makeKey(typeId, packageId));
  }

  getByKind(kind: string): BaselineDecoder<unknown> | undefined {
    return this.byKind.get(kind);
  }

  /** Test helper — NOT for production. */
  clear(): void {
    this.byKey.clear();
    this.byKind.clear();
  }

  entries(): IterableIterator<[number, BaselineDecoder<unknown>]> {
    return this.byKey.entries();
  }
}

/** Process-wide singleton. */
export const baselineRegistry = new BaselineRegistry();

/**
 * Convenience: register a baseline decoder and return it. Use at module load.
 *
 *   export const TangibleObjectSharedDecoder = registerBaseline({ ... });
 */
export function registerBaseline<T>(decoder: BaselineDecoder<T>): BaselineDecoder<T> {
  return baselineRegistry.register(decoder);
}

/**
 * Try to decode a baseline package. The caller supplies the typeId, packageId,
 * and a fresh iterator scoped to the AutoByteStream payload bytes (i.e. starting
 * with `[u16 memberCount][members...]`).
 *
 * Returns `null` if no decoder is registered, OR if the registered decoder
 * throws (e.g. for a structural mismatch — the wire format we modeled doesn't
 * match this particular instance). We swallow decode errors here because the
 * `BaselinesMessage` envelope has already successfully parsed; we don't want
 * one bad baseline to abort an entire baseline flood.
 */
export function tryDecodeBaseline(
  typeId: number,
  packageId: number,
  payload: Uint8Array,
  iterCtor: (bytes: Uint8Array) => IReadIterator,
): DecodedBaseline | null {
  const decoder = baselineRegistry.get(typeId, packageId);
  if (!decoder) return null;
  try {
    const iter = iterCtor(payload);
    const data = decoder.decode(iter);
    return { kind: decoder.kind, data };
  } catch {
    return null;
  }
}
