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

import {
  GameNetworkMessage,
  constcrc,
  registerMessage,
  type IByteStream,
  type IReadIterator,
} from '../_stub-base.js';
import { writeString, readString } from '../../archive/_stub-byte-stream.js';

/** SWG client-version string the server expects (default.cfg / NetworkVersionId). */
export const DEFAULT_CLIENT_VERSION = '20100225-17:43';

export class ClientIdMsg extends GameNetworkMessage {
  static override readonly messageName = 'ClientIdMsg';
  static readonly typeCrc = constcrc(ClientIdMsg.messageName);

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
    writeString(stream, this.version);
  }

  static decodePayload(iter: IReadIterator): ClientIdMsg {
    const gameBitsToClear = iter.readU32();
    const tokenLen = iter.readU32();
    const token = iter.readBytes(tokenLen);
    const version = readString(iter);
    return new ClientIdMsg(token, gameBitsToClear, version);
  }
}

registerMessage(ClientIdMsg);
