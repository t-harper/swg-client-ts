/**
 * LoginClientToken — INBOUND (LoginServer → client)
 *
 * Server hands us this token after validating LoginClientId. We replay
 * the token to the ConnectionServer (via ClientIdMsg) and then to the
 * GameServer to re-authenticate without re-sending credentials.
 *
 * Source: /home/tharper/code/swg-main/src/engine/shared/library/sharedNetworkMessages/src/shared/clientLoginServer/ClientLoginMessages.{h,cpp}
 *         lines 63-85 (.h) and 53-104 (.cpp).
 *
 * Wire layout (from addVariable calls in the receive ctor at .cpp:85-87):
 *   token     : AutoArray<unsigned char>   (uint32 count + N raw token bytes)
 *   stationId : AutoVariable<uint32>        (uint32 LE)
 *   m_username: AutoVariable<std::string>   (std::string)
 *
 * Note the C++ getter `getTokenSize()` returns `unsigned char` (claims max
 * 255-byte token), but the AutoArray on the wire uses uint32 — so callers
 * must not assume 1-byte length. In practice the token is ~78 bytes.
 */

import type { IByteStream, IReadIterator } from '../../archive/interface.js';
import { readStdString, writeStdString } from '../../archive/string.js';
import { GameNetworkMessage, asDecoder, defineMessageMeta } from '../base.js';
import { registerMessage } from '../registry.js';

const META = defineMessageMeta('LoginClientToken');

export class LoginClientToken extends GameNetworkMessage {
  static override readonly messageName = META.messageName;
  static readonly typeCrc = META.typeCrc;
  /** cmd + token + stationId + username */
  static override readonly varCount = 4;

  constructor(
    public token: Uint8Array = new Uint8Array(),
    public stationId = 0,
    public username = '',
  ) {
    super();
  }

  encodePayload(stream: IByteStream): void {
    // AutoArray<unsigned char> — uint32 count + raw bytes
    stream.writeU32(this.token.byteLength);
    if (this.token.byteLength > 0) {
      stream.writeBytes(this.token);
    }
    stream.writeU32(this.stationId);
    writeStdString(stream, this.username);
  }

  static decodePayload(iter: IReadIterator): LoginClientToken {
    const tokenLen = iter.readU32();
    const token = iter.readBytes(tokenLen);
    const stationId = iter.readU32();
    const username = readStdString(iter);
    return new LoginClientToken(token, stationId, username);
  }
}

export const LoginClientTokenDecoder = registerMessage(asDecoder(LoginClientToken));
