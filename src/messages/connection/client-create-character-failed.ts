/**
 * ClientCreateCharacterFailed — server-to-client; the attempted character
 * creation did NOT succeed. Carries the failing name plus a StringId that
 * tells the (localized) client what went wrong.
 *
 * Wire layout (addVariable order):
 *   [UnicodeString]   m_name
 *   [StringId]        m_errorMessage
 *       StringId on the wire = [string table][u32 textIndex][string name]
 *
 * Source:
 *   /home/tharper/code/swg-main/src/engine/shared/library/sharedNetworkMessages/src/shared/clientGameServer/ClientCentralMessages.{h,cpp}
 *   /home/tharper/code/swg-main/src/external/ours/library/localizationArchive/src/shared/StringIdArchive.cpp
 */

import {
  GameNetworkMessage,
  constcrc,
  registerMessage,
  type IByteStream,
  type IReadIterator,
} from '../_stub-base.js';
import {
  readString,
  readUnicodeString,
  writeString,
  writeUnicodeString,
} from '../../archive/_stub-byte-stream.js';

/** SWG StringId — `(table, textIndex, name)` triple referenced by clients. */
export interface StringId {
  table: string;
  textIndex: number;
  name: string;
}

export function writeStringId(stream: IByteStream, s: StringId): void {
  writeString(stream, s.table);
  stream.writeU32(s.textIndex);
  writeString(stream, s.name);
}

export function readStringId(iter: IReadIterator): StringId {
  const table = readString(iter);
  const textIndex = iter.readU32();
  const name = readString(iter);
  return { table, textIndex, name };
}

export class ClientCreateCharacterFailed extends GameNetworkMessage {
  static override readonly messageName = 'ClientCreateCharacterFailed';
  static readonly typeCrc = constcrc(ClientCreateCharacterFailed.messageName);

  constructor(
    public readonly name: string,
    public readonly errorMessage: StringId,
  ) {
    super();
  }

  encodePayload(stream: IByteStream): void {
    writeUnicodeString(stream, this.name);
    writeStringId(stream, this.errorMessage);
  }

  static decodePayload(iter: IReadIterator): ClientCreateCharacterFailed {
    const name = readUnicodeString(iter);
    const errorMessage = readStringId(iter);
    return new ClientCreateCharacterFailed(name, errorMessage);
  }
}

registerMessage(ClientCreateCharacterFailed);
