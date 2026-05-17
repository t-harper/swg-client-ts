// SuiForceClosePage — S→C. Tells the client to close an open SUI page (the server's
// "close this dialog now" signal, e.g. when the player moves out of range).
// Wire payload is just the SUIMessage base's `m_clientPageId` (AutoVariable<int>).
// Source: ~/code/swg-main/src/engine/shared/library/sharedNetworkMessages/src/shared/clientGameServer/ServerUserInterfaceMessages.{h,cpp} lines 201-218

import type { IByteStream, IReadIterator } from '../../../archive/interface.js';
import { GameNetworkMessage, asDecoder, defineMessageMeta } from '../../base.js';
import { registerMessage } from '../../registry.js';

const META = defineMessageMeta('SuiForceClosePage');

export class SuiForceClosePage extends GameNetworkMessage {
  static override readonly messageName = META.messageName;
  static readonly typeCrc = META.typeCrc;
  /** cmd + clientPageId (from SUIMessage base ctor) */
  static override readonly varCount = 2;

  constructor(public readonly clientPageId: number) {
    super();
  }

  encodePayload(stream: IByteStream): void {
    stream.writeI32(this.clientPageId);
  }

  static decodePayload(iter: IReadIterator): SuiForceClosePage {
    return new SuiForceClosePage(iter.readI32());
  }
}

export const SuiForceClosePageDecoder = registerMessage(asDecoder(SuiForceClosePage));
