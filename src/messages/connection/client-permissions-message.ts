/**
 * ClientPermissionsMessage — server-to-client; tells the client what it's
 * allowed to do on this cluster (login, create characters, etc.).
 *
 * Wire layout (addVariable order):
 *   [bool] canLogin
 *   [bool] canCreateRegularCharacter
 *   [bool] canCreateJediCharacter
 *   [bool] canSkipTutorial
 *   [bool] isAdmin
 *
 * Source:
 *   /home/tharper/code/swg-main/src/engine/shared/library/sharedNetworkMessages/src/shared/clientGameServer/ClientPermissionsMessage.{h,cpp}
 */

import {
  GameNetworkMessage,
  constcrc,
  registerMessage,
  type IByteStream,
  type IReadIterator,
} from '../_stub-base.js';

export class ClientPermissionsMessage extends GameNetworkMessage {
  static override readonly messageName = 'ClientPermissionsMessage';
  static readonly typeCrc = constcrc(ClientPermissionsMessage.messageName);

  constructor(
    public readonly canLogin: boolean,
    public readonly canCreateRegularCharacter: boolean,
    public readonly canCreateJediCharacter: boolean,
    public readonly canSkipTutorial: boolean,
    public readonly isAdmin: boolean,
  ) {
    super();
  }

  encodePayload(stream: IByteStream): void {
    stream.writeBool(this.canLogin);
    stream.writeBool(this.canCreateRegularCharacter);
    stream.writeBool(this.canCreateJediCharacter);
    stream.writeBool(this.canSkipTutorial);
    stream.writeBool(this.isAdmin);
  }

  static decodePayload(iter: IReadIterator): ClientPermissionsMessage {
    const canLogin = iter.readBool();
    const canCreateRegularCharacter = iter.readBool();
    const canCreateJediCharacter = iter.readBool();
    const canSkipTutorial = iter.readBool();
    const isAdmin = iter.readBool();
    return new ClientPermissionsMessage(
      canLogin,
      canCreateRegularCharacter,
      canCreateJediCharacter,
      canSkipTutorial,
      isAdmin,
    );
  }
}

registerMessage(ClientPermissionsMessage);
