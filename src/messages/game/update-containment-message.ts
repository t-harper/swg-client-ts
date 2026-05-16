/**
 * UpdateContainmentMessage — server → client (and inter-server). Establishes
 * or updates the containment relationship of an object: "this networkId is
 * contained by containerId in slot slotArrangement".
 *
 * Sent during the zone-in baseline flood for every object that has a parent
 * container (right next to the SceneCreateObject* + BaselinesMessage events
 * for the same object), and again any time an object moves between containers
 * (drop, pick-up, equip, unequip, move-to-bank, etc.). It is the **only**
 * authoritative source of parent-container information on the client side —
 * the SHARED baseline package contains the publicly-visible per-object state
 * (name, condition, complexity, ...) but NOT the parent. See:
 *   `/home/tharper/code/swg-main/src/engine/server/library/serverGame/src/shared/object/ServerObject_Synchronization.cpp:887`
 *
 * Wire layout (addVariable order):
 *   [NetworkId (u64)] m_networkId
 *   [NetworkId (u64)] m_containerId       — NetworkId(0) when not contained
 *   [i32 LE]          m_slotArrangement   — slot index (-1 when no specific slot)
 *
 * Source:
 *   /home/tharper/code/swg-main/src/engine/shared/library/sharedNetworkMessages/src/shared/clientGameServer/UpdateContainmentMessage.{h,cpp}
 */

import type { IByteStream, IReadIterator } from '../../archive/interface.js';
import { NetworkIdCodec } from '../../archive/network-id.js';
import type { NetworkId } from '../../types.js';
import { GameNetworkMessage, asDecoder, defineMessageMeta } from '../base.js';
import { registerMessage } from '../registry.js';

const META = defineMessageMeta('UpdateContainmentMessage');

export class UpdateContainmentMessage extends GameNetworkMessage {
  static override readonly messageName = META.messageName;
  static readonly typeCrc = META.typeCrc;
  /** cmd + networkId + containerId + slotArrangement */
  static override readonly varCount = 4;

  constructor(
    /** Object being relocated / whose containment is being announced. */
    public readonly networkId: NetworkId,
    /** New parent container's NetworkId. `0n` indicates "no container" (world). */
    public readonly containerId: NetworkId,
    /** Slot/arrangement id within the parent container. `-1` if not slotted. */
    public readonly slotArrangement: number,
  ) {
    super();
  }

  encodePayload(stream: IByteStream): void {
    NetworkIdCodec.encode(stream, this.networkId);
    NetworkIdCodec.encode(stream, this.containerId);
    stream.writeI32(this.slotArrangement);
  }

  static decodePayload(iter: IReadIterator): UpdateContainmentMessage {
    const networkId = NetworkIdCodec.decode(iter);
    const containerId = NetworkIdCodec.decode(iter);
    const slotArrangement = iter.readI32();
    return new UpdateContainmentMessage(networkId, containerId, slotArrangement);
  }
}

export const UpdateContainmentMessageDecoder = registerMessage(asDecoder(UpdateContainmentMessage));
