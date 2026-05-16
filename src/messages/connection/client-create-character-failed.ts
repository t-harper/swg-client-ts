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

import type { IByteStream, IReadIterator } from '../../archive/interface.js';
import { readStdString, writeStdString } from '../../archive/string.js';
import { readUnicodeString, writeUnicodeString } from '../../archive/unicode-string.js';
import { GameNetworkMessage, asDecoder, defineMessageMeta } from '../base.js';
import { registerMessage } from '../registry.js';

const META = defineMessageMeta('ClientCreateCharacterFailed');

/** SWG StringId — `(table, textIndex, name)` triple referenced by clients. */
export interface StringId {
  table: string;
  textIndex: number;
  name: string;
}

export function writeStringId(stream: IByteStream, s: StringId): void {
  writeStdString(stream, s.table);
  stream.writeU32(s.textIndex);
  writeStdString(stream, s.name);
}

export function readStringId(iter: IReadIterator): StringId {
  const table = readStdString(iter);
  const textIndex = iter.readU32();
  const name = readStdString(iter);
  return { table, textIndex, name };
}

export class ClientCreateCharacterFailed extends GameNetworkMessage {
  static override readonly messageName = META.messageName;
  static readonly typeCrc = META.typeCrc;
  /** cmd + name + errorMessage (StringId is a single AutoVariable on the wire) */
  static override readonly varCount = 3;

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

export const ClientCreateCharacterFailedDecoder = registerMessage(
  asDecoder(ClientCreateCharacterFailed),
);
