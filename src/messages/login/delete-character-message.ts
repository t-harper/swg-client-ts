/**
 * DeleteCharacterMessage — OUTBOUND (client → LoginServer)
 *
 * Sent from the character-select screen when the player clicks "Delete
 * Character". The LoginServer queues the delete asynchronously and
 * replies with `DeleteCharacterReplyMessage`. The DB row is purged
 * out-of-band; the character continues to appear in subsequent
 * `EnumerateCharacterId` floods until the deletion task completes
 * server-side (typically seconds, but can be longer under load).
 *
 * Source:
 *   /home/tharper/code/swg-main/src/engine/shared/library/sharedNetworkMessages/src/shared/clientGameServer/DeleteCharacterMessage.{h,cpp}
 *
 * Server handler:
 *   /home/tharper/code/swg-main/src/engine/server/application/LoginServer/src/shared/ClientConnection.cpp:125
 *   → `LoginServer::deleteCharacter(clusterId, characterId, stationId)`.
 *
 * Wire layout (addVariable calls in DeleteCharacterMessage.cpp:14-15):
 *   clusterId    : uint32 LE   (LoginEnumCluster id — typically 1 for "swg")
 *   characterId  : NetworkId   (int64 LE)
 */

import { NetworkIdCodec } from '../../archive/network-id.js';
import type { IByteStream, IReadIterator } from '../../archive/interface.js';
import type { NetworkId } from '../../types.js';
import { GameNetworkMessage, asDecoder, defineMessageMeta } from '../base.js';
import { registerMessage } from '../registry.js';

const META = defineMessageMeta('DeleteCharacterMessage');

export class DeleteCharacterMessage extends GameNetworkMessage {
  static override readonly messageName = META.messageName;
  static readonly typeCrc = META.typeCrc;
  /** cmd + clusterId + characterId */
  static override readonly varCount = 3;

  constructor(
    public readonly clusterId: number,
    public readonly characterId: NetworkId,
  ) {
    super();
  }

  encodePayload(stream: IByteStream): void {
    stream.writeU32(this.clusterId);
    NetworkIdCodec.encode(stream, this.characterId);
  }

  static decodePayload(iter: IReadIterator): DeleteCharacterMessage {
    const clusterId = iter.readU32();
    const characterId = NetworkIdCodec.decode(iter);
    return new DeleteCharacterMessage(clusterId, characterId);
  }
}

export const DeleteCharacterMessageDecoder = registerMessage(asDecoder(DeleteCharacterMessage));
