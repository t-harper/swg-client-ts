/**
 * LoginIncorrectClientId — INBOUND (LoginServer → client)
 *
 * Server sends this when the LoginClientId we sent had a wrong / missing
 * version field (or other client-id rejection). It contains the server's
 * own identification so we can show a useful error message.
 *
 * Source: /home/tharper/code/swg-main/src/engine/shared/library/sharedNetworkMessages/src/shared/clientLoginServer/ClientLoginMessages.{h,cpp}
 *         lines 117-132 (.h) and 107-132 (.cpp).
 *
 * Wire layout (from addVariable calls .cpp:112-113):
 *   serverId                 : std::string
 *   serverApplicationVersion : std::string
 */

import type { IByteStream, IReadIterator } from '../../archive/interface.js';
import { readStdString, writeStdString } from '../../archive/string.js';
import { GameNetworkMessage, asDecoder, defineMessageMeta } from '../base.js';
import { registerMessage } from '../registry.js';

const META = defineMessageMeta('LoginIncorrectClientId');

export class LoginIncorrectClientId extends GameNetworkMessage {
  static override readonly messageName = META.messageName;
  static readonly typeCrc = META.typeCrc;

  constructor(
    public serverId = '',
    public serverApplicationVersion = '',
  ) {
    super();
  }

  encodePayload(stream: IByteStream): void {
    writeStdString(stream, this.serverId);
    writeStdString(stream, this.serverApplicationVersion);
  }

  static decodePayload(iter: IReadIterator): LoginIncorrectClientId {
    const serverId = readStdString(iter);
    const serverApplicationVersion = readStdString(iter);
    return new LoginIncorrectClientId(serverId, serverApplicationVersion);
  }
}

export const LoginIncorrectClientIdDecoder = registerMessage(asDecoder(LoginIncorrectClientId));
