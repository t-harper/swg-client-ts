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

import type { IByteStream, IReadIterator } from '../../archive/interface.js';
import { NetworkIdCodec } from '../../archive/network-id.js';
import { readUnicodeString, writeUnicodeString } from '../../archive/unicode-string.js';
import type { CharacterInfo, NetworkId } from '../../types.js';
import type { CharacterType } from '../../types.js';
import { GameNetworkMessage, asDecoder, defineMessageMeta } from '../base.js';
import { registerMessage } from '../registry.js';

const META = defineMessageMeta('EnumerateCharacterId');

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
  NetworkIdCodec.encode(stream, c.networkId);
  stream.writeU32(c.clusterId);
  stream.writeI32(c.characterType);
}

function readChardata(iter: IReadIterator): CharacterRow {
  const name = readUnicodeString(iter);
  const objectTemplateId = iter.readI32();
  const networkId = NetworkIdCodec.decode(iter);
  const clusterId = iter.readU32();
  const characterType = iter.readI32();
  return { name, objectTemplateId, networkId, clusterId, characterType };
}

export class EnumerateCharacterId extends GameNetworkMessage {
  static override readonly messageName = META.messageName;
  static readonly typeCrc = META.typeCrc;
  /** cmd + data (AutoArray<Chardata>) */
  static override readonly varCount = 2;

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
    // AutoArray<Chardata>: [u32 count] + count * Chardata
    stream.writeU32(this.characters.length);
    for (const c of this.characters) writeChardata(stream, c);
  }

  static decodePayload(iter: IReadIterator): EnumerateCharacterId {
    const n = iter.readU32();
    const rows: CharacterRow[] = [];
    for (let i = 0; i < n; i++) rows.push(readChardata(iter));
    return new EnumerateCharacterId(rows);
  }
}

export const EnumerateCharacterIdDecoder = registerMessage(asDecoder(EnumerateCharacterId));
