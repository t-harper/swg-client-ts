/**
 * DeltasMessage — server-to-client. Carries an incremental update to ONE
 * AutoDelta package of ONE object. The wire envelope is identical to
 * `BaselinesMessage` (target + typeId + packageId + AutoVariable<ByteStream>);
 * the difference is what's inside the package:
 *
 *   - `BaselinesMessage` package = `AutoByteStream::pack` output for the
 *     ENTIRE package — `[u16 memberCount][member0 bytes][member1 bytes]...`
 *     in `addVariable` order.
 *
 *   - `DeltasMessage` package    = `AutoDeltaByteStream::packDeltas` output —
 *     `[u16 dirtyCount]` followed by N entries of `[u16 memberIndex][delta bytes]`.
 *     Only the changed members are present; the rest are unchanged from the
 *     last baseline.
 *
 * When the server changes a single AutoDeltaVariable on an object (e.g.
 * the invitee's `m_groupInviter` when an invite arrives), the auth server
 * builds one `DeltasMessage(target=inviteeId, typeId=CREO,
 * packageId=SHARED_NP, package=<just the one dirty member>)`.
 *
 * We parse the envelope (target/typeId/packageId/packageBytes) eagerly and
 * also walk just the dirty-list u16 header to expose the indices of changed
 * members for callers that want to detect "did field X change?" without
 * decoding the full delta payload. Decoding the actual per-member delta
 * bytes is type-specific and not done here — callers can re-iterate
 * `packageBytes` themselves if they need full reconstruction.
 *
 * Wire layout (AutoByteStream framing — `cmd` + 4 payload AutoVariables):
 *   [u16 LE 5]                  varCount (handled by base)
 *   [u32 LE typeCrc]            cmd (handled by base — constcrc('DeltasMessage'))
 *   [i64 LE NetworkId]          target
 *   [u32 LE Tag]                typeId    (e.g. 0x4F45524F = 'CREO')
 *   [u8 packageId]              packageId (one of DELTAS_*)
 *   [u32 LE packageLen]         length prefix on AutoVariable<ByteStream>
 *   [packageLen bytes]          packageBytes — `AutoDeltaByteStream::packDeltas` output:
 *                               [u16 dirtyCount][u16 idx0][delta0 bytes][u16 idx1]...
 *
 * The DELTAS_* enum mirrors BASELINES_* (same numeric values):
 *   0 CLIENT_ONLY, 1 CLIENT_SERVER, 2 SERVER, 3 SHARED,
 *   4 CLIENT_SERVER_NP, 5 SERVER_NP, 6 SHARED_NP,
 *   7 UI, 8 FIRST_PARENT_CLIENT_SERVER, 9 FIRST_PARENT_CLIENT_SERVER_NP.
 *
 * Source:
 *   /home/tharper/code/swg-main/src/engine/shared/library/sharedNetworkMessages/src/shared/common/DeltasMessage.{h,cpp}
 *   /home/tharper/code/swg-main/src/external/ours/library/archive/src/shared/AutoDeltaByteStream.cpp
 *     (AutoDeltaByteStream::packDeltas — "[u16 count] then per dirty: [u16 index][packDelta]")
 */

import type { IByteStream, IReadIterator } from '../../../archive/interface.js';
import { NetworkIdCodec } from '../../../archive/network-id.js';
import { ReadIterator } from '../../../archive/read-iterator.js';
import { readStdString } from '../../../archive/string.js';
import type { NetworkId } from '../../../types.js';
import { GameNetworkMessage, asDecoder, defineMessageMeta } from '../../base.js';
import { registerMessage } from '../../registry.js';
import { BaselinePackageIds, ObjectTypeTags, tagToString } from './registry.js';

const META = defineMessageMeta('DeltasMessage');

/**
 * Best-effort scan of the dirty-list HEADER: `[u16 dirtyCount]` followed by
 * `[u16 memberIndex]...` entries. We DON'T attempt to consume the per-member
 * delta payload (its size is type-dependent and unknown without per-member
 * decoders), so the returned indices are reliable only if the caller doesn't
 * try to read past them.
 *
 * For "did a known-index field change?" the dirtyCount is reliable; reading
 * the first index is reliable; subsequent indices may be off if a prior
 * delta payload is large. Conservative consumers should stick to the
 * single-dirty case (dirtyCount === 1) where index is unambiguous.
 */
export function readFirstDirtyIndex(packageBytes: Uint8Array): {
  dirtyCount: number;
  firstIndex: number | null;
} {
  if (packageBytes.length < 2) return { dirtyCount: 0, firstIndex: null };
  const iter = new ReadIterator(packageBytes);
  const dirtyCount = iter.readU16();
  if (dirtyCount === 0 || packageBytes.length < 4) return { dirtyCount, firstIndex: null };
  const firstIndex = iter.readU16();
  return { dirtyCount, firstIndex };
}

export class DeltasMessage extends GameNetworkMessage {
  static override readonly messageName = META.messageName;
  static readonly typeCrc = META.typeCrc;
  /** cmd + target + typeId + packageId + package */
  static override readonly varCount = 5;

  /** Diagnostic: human-readable typeId (e.g. "TANO", "PLAY", "CREO"). */
  public readonly typeIdString: string;

  /** Number of changed members (parsed from the package header). 0 if package is malformed/empty. */
  public readonly dirtyCount: number;

  /**
   * Index of the FIRST changed member, or null if package is empty.
   * Reliable when `dirtyCount === 1`. With multiple dirties, the index is
   * still correct, but reading subsequent ones from `packageBytes` requires
   * type-specific per-member decoders to skip past the payload bytes.
   */
  public readonly firstDirtyIndex: number | null;

  constructor(
    /** NetworkId of the object whose state is changing. */
    public readonly target: NetworkId,
    /** Object-type Tag (u32 — 4 ASCII chars little-endian). */
    public readonly typeId: number,
    /** Which DELTAS_* package this is (1, 3, 4, 6, 8, 9, etc.). */
    public readonly packageId: number,
    /**
     * Raw bytes of the inner `AutoDeltaByteStream::packDeltas` payload (NOT
     * including the u32 length prefix). Begins with `[u16 dirtyCount]`.
     */
    public readonly packageBytes: Uint8Array = new Uint8Array(0),
  ) {
    super();
    this.typeIdString = tagToString(typeId);
    const { dirtyCount, firstIndex } = readFirstDirtyIndex(packageBytes);
    this.dirtyCount = dirtyCount;
    this.firstDirtyIndex = firstIndex;
  }

  encodePayload(stream: IByteStream): void {
    NetworkIdCodec.encode(stream, this.target);
    stream.writeU32(this.typeId);
    stream.writeU8(this.packageId);
    // AutoVariable<ByteStream> wire: [u32 length][bytes]
    stream.writeU32(this.packageBytes.length);
    if (this.packageBytes.length > 0) {
      stream.writeBytes(this.packageBytes);
    }
  }

  static decodePayload(iter: IReadIterator): DeltasMessage {
    const target = NetworkIdCodec.decode(iter);
    const typeId = iter.readU32();
    const packageId = iter.readU8();
    const packageLen = iter.readU32();
    const packageBytes = packageLen > 0 ? iter.readBytes(packageLen) : new Uint8Array(0);
    return new DeltasMessage(target, typeId, packageId, packageBytes);
  }
}

export const DeltasMessageDecoder = registerMessage(asDecoder(DeltasMessage));

/**
 * Indices of well-known fields inside the CREO SHARED_NP package.
 *
 * Derived by counting `addSharedVariable_np` calls in `addMembersToPackages`
 * in dependency order: ServerObject (2) + TangibleObject (6) + CreatureObject
 * (the rest). See:
 *   /home/tharper/code/swg-main/src/engine/server/library/serverGame/src/shared/generated/Packager.cpp:110-199
 *
 * If `addSharedVariable_np` calls are inserted/removed/reordered upstream
 * these indices must shift. Each entry below has a comment with the
 * line range where the call lives in Packager.cpp.
 */
export const CreoSharedNpIndices = {
  /** `m_group` (CachedNetworkId) — Packager.cpp:161. */
  M_GROUP: 13,
  /** `m_groupInviter` (PlayerAndShipPair) — Packager.cpp:162. */
  M_GROUP_INVITER: 14,
} as const;

/**
 * Decode the m_groupInviter delta payload from a SINGLE-dirty
 * `DeltasMessage(target=CREO, packageId=SHARED_NP, firstDirtyIndex=14)`
 * package. Returns `null` if the message isn't a single-dirty m_groupInviter
 * delta or if the payload is malformed.
 *
 * On the wire (after the `[u16 count=1][u16 index=14]` header):
 *   [i64 LE]            inviterId
 *   [u16 LE strLen][N bytes UTF-8] inviterName (std::string)
 *   [i64 LE]            inviterShipId
 *
 * Total payload size = 8 + (2 + strLen) + 8 bytes; the package envelope
 * adds 4 bytes for the dirty-list header, so a minimal "clear" delta
 * (empty name) is 22 bytes.
 *
 * This is for inspecting INVITE / DECLINE wire events. A fresh invite
 * shows up with `inviterId != 0n`; a server-driven clear (decline, timeout,
 * or `setGroup` post-accept) shows up with `inviterId == 0n` and empty name.
 */
export function decodeGroupInviterDelta(msg: DeltasMessage): {
  inviterId: NetworkId;
  inviterName: string;
  inviterShipId: NetworkId;
} | null {
  if (msg.typeId !== ObjectTypeTags.CREO) return null;
  if (msg.packageId !== BaselinePackageIds.SHARED_NP) return null;
  if (msg.dirtyCount !== 1) return null;
  if (msg.firstDirtyIndex !== CreoSharedNpIndices.M_GROUP_INVITER) return null;
  // Skip past [u16 count][u16 index] = 4 bytes
  if (msg.packageBytes.length < 4 + 8 + 2 + 8) return null;
  const iter = new ReadIterator(msg.packageBytes);
  iter.readU16(); // count
  iter.readU16(); // index
  try {
    const inviterId = NetworkIdCodec.decode(iter);
    const inviterName = readStdString(iter);
    const inviterShipId = NetworkIdCodec.decode(iter);
    return { inviterId, inviterName, inviterShipId };
  } catch {
    return null;
  }
}

/**
 * Decode the m_group delta payload from a SINGLE-dirty
 * `DeltasMessage(target=CREO, packageId=SHARED_NP, firstDirtyIndex=13)`
 * package. Returns `null` if the message isn't a single-dirty m_group
 * delta or if the payload is malformed.
 *
 * On the wire (after `[u16 count=1][u16 index=13]` header):
 *   [i64 LE]   groupId (the new NetworkId of the GroupObject, 0 = leaving)
 *
 * Total payload size = 4 (header) + 8 (NetworkId) = 12 bytes minimum.
 */
export function decodeGroupDelta(msg: DeltasMessage): { groupId: NetworkId } | null {
  if (msg.typeId !== ObjectTypeTags.CREO) return null;
  if (msg.packageId !== BaselinePackageIds.SHARED_NP) return null;
  if (msg.dirtyCount !== 1) return null;
  if (msg.firstDirtyIndex !== CreoSharedNpIndices.M_GROUP) return null;
  if (msg.packageBytes.length < 4 + 8) return null;
  const iter = new ReadIterator(msg.packageBytes);
  iter.readU16(); // count
  iter.readU16(); // index
  try {
    const groupId = NetworkIdCodec.decode(iter);
    return { groupId };
  } catch {
    return null;
  }
}
