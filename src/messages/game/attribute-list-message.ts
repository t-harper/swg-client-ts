/**
 * AttributeListMessage — server-to-client. Carries a list of
 * (key, localized-value) attribute pairs for an object (the "Examine"
 * panel content in the real client). The MVP doesn't surface these; we
 * parse enough to advance the cursor.
 *
 * Wire layout (addVariable order):
 *   [NetworkId (u64)]                                 m_networkId
 *   [string]                                          m_staticItemName
 *   [AutoArray<pair<string, UnicodeString>>]          m_data
 *       AutoArray = [u32 count] followed by `count` pairs
 *       Each pair = [string][UnicodeString]
 *   [i32]                                             m_revision
 *
 * Source:
 *   /home/tharper/code/swg-main/src/engine/shared/library/sharedNetworkMessages/src/shared/clientGameServer/AttributeListMessage.{h,cpp}
 */

import type { IByteStream, IReadIterator } from '../../archive/interface.js';
import { NetworkIdCodec } from '../../archive/network-id.js';
import { readStdString, writeStdString } from '../../archive/string.js';
import { readUnicodeString, writeUnicodeString } from '../../archive/unicode-string.js';
import type { NetworkId } from '../../types.js';
import { GameNetworkMessage, asDecoder, defineMessageMeta } from '../base.js';
import { registerMessage } from '../registry.js';

const META = defineMessageMeta('AttributeListMessage');

/** (attributeKey, localizedDisplayValue) — one entry in the attribute list. */
export interface AttributePair {
  key: string;
  value: string;
}

function writePair(stream: IByteStream, p: AttributePair): void {
  writeStdString(stream, p.key);
  writeUnicodeString(stream, p.value);
}

function readPair(iter: IReadIterator): AttributePair {
  const key = readStdString(iter);
  const value = readUnicodeString(iter);
  return { key, value };
}

export class AttributeListMessage extends GameNetworkMessage {
  static override readonly messageName = META.messageName;
  static readonly typeCrc = META.typeCrc;
  /** cmd + networkId + staticItemName + data + revision */
  static override readonly varCount = 5;

  constructor(
    public readonly networkId: NetworkId,
    public readonly staticItemName: string,
    public readonly data: readonly AttributePair[],
    public readonly revision: number,
  ) {
    super();
  }

  encodePayload(stream: IByteStream): void {
    NetworkIdCodec.encode(stream, this.networkId);
    writeStdString(stream, this.staticItemName);
    // AutoArray<pair<string, UnicodeString>>: [u32 count] + count * pair
    stream.writeU32(this.data.length);
    for (const p of this.data) writePair(stream, p);
    stream.writeI32(this.revision);
  }

  static decodePayload(iter: IReadIterator): AttributeListMessage {
    const networkId = NetworkIdCodec.decode(iter);
    const staticItemName = readStdString(iter);
    const n = iter.readU32();
    const data: AttributePair[] = [];
    for (let i = 0; i < n; i++) data.push(readPair(iter));
    const revision = iter.readI32();
    return new AttributeListMessage(networkId, staticItemName, data, revision);
  }
}

export const AttributeListMessageDecoder = registerMessage(asDecoder(AttributeListMessage));
