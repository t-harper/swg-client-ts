/**
 * MoodChange (CM_setMood = 422) — server-to-client.
 *
 * Notifies that an observed creature's mood has changed. Mood drives the
 * idle animation set and the chat-bubble color (e.g. "happy", "angry",
 * "smug"). The wire value is a `uint32` index into the mood/animation
 * table loaded from `mood/mood.iff`.
 *
 * Registered via the generic `packUnsignedLong / unpackUnsignedLong`
 * helpers in SetupServerNetworkMessages.cpp:1394 — so the trailer is
 * literally a 4-byte LE unsigned int.
 *
 * Wire layout (trailer only):
 *   [u32] mood
 *
 * Source:
 *   /home/tharper/code/swg-main/src/engine/server/library/serverNetworkMessages/src/shared/core/SetupServerNetworkMessages.cpp:220-234  (packUnsignedLong)
 *   /home/tharper/code/swg-main/src/engine/server/library/serverNetworkMessages/src/shared/core/SetupServerNetworkMessages.cpp:1394
 */

import type { IByteStream, IReadIterator } from '../../../archive/interface.js';
import { ObjControllerSubtypeIds, registerObjControllerSubtype } from './registry.js';

export interface MoodChangeData {
  mood: number;
}

export const MoodChangeKind = 'MoodChange' as const;

export const MoodChangeDecoder = registerObjControllerSubtype<MoodChangeData>({
  kind: MoodChangeKind,
  subtypeId: ObjControllerSubtypeIds.CM_setMood,
  encode(stream: IByteStream, data: MoodChangeData): void {
    stream.writeU32(data.mood);
  },
  decode(iter: IReadIterator): MoodChangeData {
    const mood = iter.readU32();
    return { mood };
  },
});
