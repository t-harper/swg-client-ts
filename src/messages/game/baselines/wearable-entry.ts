/**
 * `WearableEntry` codec — describes one item worn or attached to a creature
 * (clothing slot, weapon, custom appearance attachment).
 *
 * Wire layout (matches `WearableEntry.cpp::Archive::put`):
 *   [std::string]    m_appearanceString
 *   [i32]            m_arrangement
 *   [NetworkId i64]  m_networkId
 *   [i32]            m_objectTemplate
 *   [u8 bool]        isWeapon
 *   if isWeapon:
 *     [BaselinesMessage] m_weaponSharedBaselines     (full AutoByteStream pack)
 *     [BaselinesMessage] m_weaponSharedNpBaselines
 *
 * The nested baselines are full BaselinesMessage AutoByteStreams (5 vars:
 * cmd + target + typeId + packageId + package). We decode them via the
 * standard message dispatch — see `BaselinesMessage.decodePayload`.
 *
 * Source:
 *   /home/tharper/code/swg-main/src/engine/shared/library/sharedGame/src/shared/core/WearableEntry.cpp:80-115
 */

import type { IReadIterator } from '../../../archive/interface.js';
import { NetworkIdCodec } from '../../../archive/network-id.js';
import { readStdString } from '../../../archive/string.js';
import type { NetworkId } from '../../../types.js';
import { BaselinesMessage } from './baselines-message.js';

export interface WearableEntryValue {
  /** Appearance string for this item (e.g. an .iff path or override). */
  appearanceString: string;
  /** Slot arrangement id; -1 means no arrangement. */
  arrangement: number;
  /** NetworkId of the worn object; `0n` if invalid. */
  networkId: NetworkId;
  /** Server-template hash. */
  objectTemplate: number;
  /**
   * If this entry is a weapon, the nested BaselinesMessages for SHARED
   * and SHARED_NP. Otherwise `null`. Weapons replicate their own baselines
   * inline so observers can render them without a separate ObjectCreate.
   */
  weaponSharedBaselines: BaselinesMessage | null;
  weaponSharedNpBaselines: BaselinesMessage | null;
}

/**
 * Read a WearableEntry off the wire.
 *
 * For weapon entries, we parse the two nested BaselinesMessages via the
 * standard `parseHeader` + `BaselinesMessage.decodePayload` path. This
 * mirrors what the C++ does (`std::make_shared<const BaselinesMessage>(source)`
 * — i.e. the BaselinesMessage's `(ReadIterator&)` ctor consumes from the
 * SAME stream and advances it).
 */
export function readWearableEntry(iter: IReadIterator): WearableEntryValue {
  const appearanceString = readStdString(iter);
  const arrangement = iter.readI32();
  const networkId = NetworkIdCodec.decode(iter);
  const objectTemplate = iter.readI32();
  const isWeapon = iter.readBool();
  let weaponSharedBaselines: BaselinesMessage | null = null;
  let weaponSharedNpBaselines: BaselinesMessage | null = null;
  if (isWeapon) {
    weaponSharedBaselines = readNestedBaselinesMessage(iter);
    weaponSharedNpBaselines = readNestedBaselinesMessage(iter);
  }
  return {
    appearanceString,
    arrangement,
    networkId,
    objectTemplate,
    weaponSharedBaselines,
    weaponSharedNpBaselines,
  };
}

/**
 * Decode a nested BaselinesMessage from an iterator already positioned at the
 * start of its AutoByteStream. The C++ ctor `BaselinesMessage(ReadIterator &)`
 * does exactly this: it consumes a varCount-prefixed sequence of (target,
 * typeId, packageId, package) from the stream. We delegate to `parseHeader`
 * (which strips the varCount + typeCrc framing) and then to
 * `BaselinesMessage.decodePayload`.
 *
 * NOTE: a nested BaselinesMessage on the wire has the SAME framing as a
 * top-level one (varCount=5 + typeCrc + 4 payload fields). The exception
 * is that the nested one isn't dispatched through `messageRegistry` —
 * we know it's a BaselinesMessage by construction.
 */
function readNestedBaselinesMessage(iter: IReadIterator): BaselinesMessage {
  // The bytes from `iter.position` onward are a full AutoByteStream pack:
  //   [u16 varCount][u32 typeCrc][NetworkId][u32 typeId][u8 packageId][u32 pkgLen][bytes]
  // We can't strictly tell where it ends without parsing it. But the payload
  // length IS deterministic once we read the AutoVariables in order — we
  // simply consume from the iterator.
  // We can directly inline the parse since we know the structure:
  const varCount = iter.readU16();
  if (varCount !== 5) {
    throw new Error(`Nested BaselinesMessage: expected varCount=5, got ${varCount}`);
  }
  // typeCrc — verify it's BaselinesMessage's CRC
  const typeCrc = iter.readU32();
  if (typeCrc !== BaselinesMessage.typeCrc) {
    throw new Error(`Nested BaselinesMessage: typeCrc mismatch (got ${typeCrc.toString(16)})`);
  }
  return BaselinesMessage.decodePayload(iter);
}
