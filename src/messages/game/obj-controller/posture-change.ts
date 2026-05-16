/**
 * PostureChange (CM_setPosture = 305) — server-to-client.
 *
 * Sent when a creature transitions between postures (standing, kneeling,
 * sitting, dead, etc.). The new posture comes as a `uint8` enum value;
 * see `swgSharedUtility/Postures.def` for the full table (Upright=0,
 * Crouched, Prone, Sneaking, Blocking, Climbing, Flying, Lying-Down, Sitting,
 * Skill-Animating, Driving-Vehicle, Riding-Creature, Knocked-Down,
 * Incapacitated, Dead — these are stable on-wire values).
 *
 * `isClientImmediate` is a hint to the client: true means "apply this
 * posture change without waiting for an animation slot", which the script
 * client uses when the change is induced by a UI action vs. a combat
 * outcome.
 *
 * Wire layout (trailer only — the 20-byte ObjControllerMessage header is
 * peeled off upstream):
 *   [u8] posture
 *   [u8] isClientImmediate     (1 = immediate, 0 = animated)
 *
 * Source:
 *   /home/tharper/code/swg-main/src/engine/shared/library/sharedNetworkMessages/src/shared/clientGameServer/MessageQueuePosture.cpp:27-49
 */

import type { IByteStream, IReadIterator } from '../../../archive/interface.js';
import { ObjControllerSubtypeIds, registerObjControllerSubtype } from './registry.js';

export interface PostureChangeData {
  posture: number;
  isClientImmediate: boolean;
}

export const PostureChangeKind = 'PostureChange' as const;

export const PostureChangeDecoder = registerObjControllerSubtype<PostureChangeData>({
  kind: PostureChangeKind,
  subtypeId: ObjControllerSubtypeIds.CM_setPosture,
  encode(stream: IByteStream, data: PostureChangeData): void {
    stream.writeU8(data.posture);
    stream.writeU8(data.isClientImmediate ? 1 : 0);
  },
  decode(iter: IReadIterator): PostureChangeData {
    const posture = iter.readU8();
    const isClientImmediate = iter.readU8() !== 0;
    return { posture, isClientImmediate };
  },
});
