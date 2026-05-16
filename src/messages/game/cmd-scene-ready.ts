/**
 * CmdSceneReady — client-to-server; empty body. The client signals it has
 * loaded the scene and is ready to participate. The server marks us as
 * "zoned in" after receiving this.
 *
 * Wire layout: empty.
 *
 * Source:
 *   /home/tharper/code/swg-main/src/engine/shared/library/sharedNetworkMessages/src/shared/clientGameServer/CommandChannelMessages.{h,cpp}
 */

import type { IByteStream, IReadIterator } from '../../archive/interface.js';
import { GameNetworkMessage, asDecoder, defineMessageMeta } from '../base.js';
import { registerMessage } from '../registry.js';

const META = defineMessageMeta('CmdSceneReady');

export class CmdSceneReady extends GameNetworkMessage {
  static override readonly messageName = META.messageName;
  static readonly typeCrc = META.typeCrc;
  /** cmd only (empty body) */
  static override readonly varCount = 1;

  encodePayload(_stream: IByteStream): void {
    // empty body
  }

  static decodePayload(_iter: IReadIterator): CmdSceneReady {
    return new CmdSceneReady();
  }
}

export const CmdSceneReadyDecoder = registerMessage(asDecoder(CmdSceneReady));
