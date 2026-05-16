/**
 * LoginClientId — OUTBOUND (client → LoginServer)
 *
 * The first GameNetworkMessage we send after the SOE session handshake.
 * Server hashes `id` to a `stationId` (dev mode = no actual auth) and
 * uses `version` for the wire-protocol compatibility check.
 *
 * Source: /home/tharper/code/swg-main/src/engine/shared/library/sharedNetworkMessages/src/shared/clientLoginServer/ClientLoginMessages.{h,cpp}
 *
 * Field order (from the C++ addVariable calls in the ctor at .cpp:24-26):
 *   id      : std::string  (the username — usually whatever, dev mode hashes it)
 *   key     : std::string  (the password — ignored in dev mode; pass "" or anything)
 *   version : std::string  (must be "20100225-17:43" per NETWORK_VERSION_ID)
 */

import type { IByteStream, IReadIterator } from '../../archive/interface.js';
import { readStdString, writeStdString } from '../../archive/string.js';
import { GameNetworkMessage, NETWORK_VERSION_ID, asDecoder, defineMessageMeta } from '../base.js';
import { registerMessage } from '../registry.js';

const META = defineMessageMeta('LoginClientId');

export class LoginClientId extends GameNetworkMessage {
  static override readonly messageName = META.messageName;
  static readonly typeCrc = META.typeCrc;

  constructor(
    public id: string,
    public key = '',
    public version: string = NETWORK_VERSION_ID,
  ) {
    super();
  }

  encodePayload(stream: IByteStream): void {
    writeStdString(stream, this.id);
    writeStdString(stream, this.key);
    writeStdString(stream, this.version);
  }

  static decodePayload(iter: IReadIterator): LoginClientId {
    const id = readStdString(iter);
    const key = readStdString(iter);
    const version = readStdString(iter);
    return new LoginClientId(id, key, version);
  }
}

export const LoginClientIdDecoder = registerMessage(asDecoder(LoginClientId));
