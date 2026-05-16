/**
 * ClientIdMsg — sent from client to ConnectionServer (and again to GameServer)
 * to re-authenticate using the LoginClientToken issued by LoginServer.
 *
 * Wire layout (Archive addVariable order from the C++ source):
 *   [u32]                  gameBitsToClear
 *   [u32 count][N bytes]   token  (AutoArray<unsigned char>)
 *   [string]               version
 *
 * Source of truth:
 *   /home/tharper/code/swg-main/src/engine/shared/library/sharedNetworkMessages/src/shared/clientGameServer/ClientCentralMessages.{h,cpp}
 *     ClientIdMsg::ClientIdMsg constructor
 */

import type { IByteStream, IReadIterator } from '../../archive/interface.js';
import { readStdString, writeStdString } from '../../archive/string.js';
import { GameNetworkMessage, asDecoder, defineMessageMeta } from '../base.js';
import { registerMessage } from '../registry.js';

/** SWG client-version string the server expects (default.cfg / NetworkVersionId). */
export const DEFAULT_CLIENT_VERSION = '20100225-17:43';

const META = defineMessageMeta('ClientIdMsg');

export class ClientIdMsg extends GameNetworkMessage {
  static override readonly messageName = META.messageName;
  static readonly typeCrc = META.typeCrc;
  /** cmd + gameBitsToClear + token + version */
  static override readonly varCount = 4;

  constructor(
    public readonly token: Uint8Array,
    public readonly gameBitsToClear: number,
    public readonly version: string = DEFAULT_CLIENT_VERSION,
  ) {
    super();
  }

  encodePayload(stream: IByteStream): void {
    stream.writeU32(this.gameBitsToClear);
    // AutoArray<unsigned char>: [u32 count][bytes...]
    stream.writeU32(this.token.length);
    stream.writeBytes(this.token);
    writeStdString(stream, this.version);
  }

  static decodePayload(iter: IReadIterator): ClientIdMsg {
    const gameBitsToClear = iter.readU32();
    const tokenLen = iter.readU32();
    const token = iter.readBytes(tokenLen);
    const version = readStdString(iter);
    return new ClientIdMsg(token, gameBitsToClear, version);
  }
}

export const ClientIdMsgDecoder = registerMessage(asDecoder(ClientIdMsg));
