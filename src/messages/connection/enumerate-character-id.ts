/**
 * EnumerateCharacterId — server-to-client; the list of characters on this
 * account for the current cluster.
 *
 * Wire layout:
 *   [AutoArray<Chardata>] m_data
 *
 * Chardata layout (Archive::get/put in ClientCentralMessages.h):
 *   [UnicodeString]    m_name
 *   [i32]              m_objectTemplateId  (CRC of the shared template path)
 *   [NetworkId (u64)]  m_networkId
 *   [u32]              m_clusterId
 *   [i32]              m_characterType     (1=normal, 2=jedi, 3=spectral)
 *
 * Source:
 *   /home/tharper/code/swg-main/src/engine/shared/library/sharedNetworkMessages/src/shared/clientGameServer/ClientCentralMessages.{h,cpp}
 *     EnumerateCharacterId class + EnumerateCharacterId_Chardata struct
 */

import {
  readArray,
  readNetworkId,
  readUnicodeString,
  writeArray,
  writeNetworkId,
  writeUnicodeString,
} from '../../archive/_stub-byte-stream.js';
import type { CharacterInfo, NetworkId } from '../../types.js';
import type { CharacterType } from '../../types.js';
import {
  GameNetworkMessage,
  type IByteStream,
  type IReadIterator,
  constcrc,
  registerMessage,
} from '../_stub-base.js';

/** Single chardata row as it appears on the wire. */
export interface CharacterRow {
  name: string;
  objectTemplateId: number;
  networkId: NetworkId;
  clusterId: number;
  characterType: number;
}

function writeChardata(stream: IByteStream, c: CharacterRow): void {
  writeUnicodeString(stream, c.name);
  stream.writeI32(c.objectTemplateId);
  writeNetworkId(stream, c.networkId);
  stream.writeU32(c.clusterId);
  stream.writeI32(c.characterType);
}

function readChardata(iter: IReadIterator): CharacterRow {
  const name = readUnicodeString(iter);
  const objectTemplateId = iter.readI32();
  const networkId = readNetworkId(iter);
  const clusterId = iter.readU32();
  const characterType = iter.readI32();
  return { name, objectTemplateId, networkId, clusterId, characterType };
}

export class EnumerateCharacterId extends GameNetworkMessage {
  static override readonly messageName = 'EnumerateCharacterId';
  static readonly typeCrc = constcrc(EnumerateCharacterId.messageName);

  constructor(public readonly characters: readonly CharacterRow[]) {
    super();
  }

  /** Convenience: project wire rows to the shared `CharacterInfo` type. */
  toCharacterInfos(): CharacterInfo[] {
    return this.characters.map((c) => ({
      name: c.name,
      objectTemplateId: c.objectTemplateId,
      networkId: c.networkId,
      clusterId: c.clusterId,
      // characterType field on the wire is the raw int; map to the enum if it fits.
      characterType: c.characterType as CharacterType,
    }));
  }

  encodePayload(stream: IByteStream): void {
    writeArray(stream, this.characters, writeChardata);
  }

  static decodePayload(iter: IReadIterator): EnumerateCharacterId {
    return new EnumerateCharacterId(readArray(iter, readChardata));
  }
}

registerMessage(EnumerateCharacterId);
