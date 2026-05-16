/**
 * PopulateMissionBrowserMessage — server → client.
 *
 * Carries the list of MissionObject NetworkIds the server generated for
 * a mission terminal. The client uses this to know which MissionObjects
 * (delivered separately as SHARED baselines into the player's mission bag)
 * belong to which terminal so the browser UI can pick the right ones.
 *
 * Sent in response to (or shortly after) a `MissionListRequest` from the
 * client.
 *
 * Wire layout (addVariable order from PopulateMissionBrowserMessage.cpp:14-20):
 *   [AutoArray<NetworkId>] missions
 *
 * `AutoArray<NetworkId>` on the wire is `[u32 LE count][NetworkId × count]`.
 *
 * Source:
 *   /home/tharper/code/swg-main/src/engine/shared/library/sharedNetworkMessages/src/shared/clientGameServer/PopulateMissionBrowserMessage.{h,cpp}
 */

import type { IByteStream, IReadIterator } from '../../../archive/interface.js';
import { NetworkIdCodec } from '../../../archive/network-id.js';
import type { NetworkId } from '../../../types.js';
import { GameNetworkMessage, asDecoder, defineMessageMeta } from '../../base.js';
import { registerMessage } from '../../registry.js';

const META = defineMessageMeta('PopulateMissionBrowserMessage');

export class PopulateMissionBrowserMessage extends GameNetworkMessage {
  static override readonly messageName = META.messageName;
  static readonly typeCrc = META.typeCrc;
  /** cmd + missions */
  static override readonly varCount = 2;

  constructor(public readonly missions: readonly NetworkId[]) {
    super();
  }

  encodePayload(stream: IByteStream): void {
    stream.writeU32(this.missions.length);
    for (const id of this.missions) {
      NetworkIdCodec.encode(stream, id);
    }
  }

  static decodePayload(iter: IReadIterator): PopulateMissionBrowserMessage {
    const count = iter.readU32();
    const missions: NetworkId[] = [];
    for (let i = 0; i < count; i++) {
      missions.push(NetworkIdCodec.decode(iter));
    }
    return new PopulateMissionBrowserMessage(missions);
  }
}

export const PopulateMissionBrowserMessageDecoder = registerMessage(
  asDecoder(PopulateMissionBrowserMessage),
);
