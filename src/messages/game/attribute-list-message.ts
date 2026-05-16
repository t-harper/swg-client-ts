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

import type { NetworkId } from '../../types.js';
import {
  GameNetworkMessage,
  constcrc,
  registerMessage,
  type IByteStream,
  type IReadIterator,
} from '../_stub-base.js';
import {
  readArray,
  readNetworkId,
  readString,
  readUnicodeString,
  writeArray,
  writeNetworkId,
  writeString,
  writeUnicodeString,
} from '../../archive/_stub-byte-stream.js';

/** (attributeKey, localizedDisplayValue) — one entry in the attribute list. */
export interface AttributePair {
  key: string;
  value: string;
}

function writePair(stream: IByteStream, p: AttributePair): void {
  writeString(stream, p.key);
  writeUnicodeString(stream, p.value);
}

function readPair(iter: IReadIterator): AttributePair {
  const key = readString(iter);
  const value = readUnicodeString(iter);
  return { key, value };
}

export class AttributeListMessage extends GameNetworkMessage {
  static override readonly messageName = 'AttributeListMessage';
  static readonly typeCrc = constcrc(AttributeListMessage.messageName);

  constructor(
    public readonly networkId: NetworkId,
    public readonly staticItemName: string,
    public readonly data: readonly AttributePair[],
    public readonly revision: number,
  ) {
    super();
  }

  encodePayload(stream: IByteStream): void {
    writeNetworkId(stream, this.networkId);
    writeString(stream, this.staticItemName);
    writeArray(stream, this.data, writePair);
    stream.writeI32(this.revision);
  }

  static decodePayload(iter: IReadIterator): AttributeListMessage {
    const networkId = readNetworkId(iter);
    const staticItemName = readString(iter);
    const data = readArray(iter, readPair);
    const revision = iter.readI32();
    return new AttributeListMessage(networkId, staticItemName, data, revision);
  }
}

registerMessage(AttributeListMessage);
