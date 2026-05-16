/**
 * CommandQueueRemove — server → client.
 *
 * Acknowledges that an entry left the command queue (executed, cancelled,
 * timed out, or failed). The wire form is the `data` trailer of an
 * `ObjControllerMessage` whose `message` field is `CM_commandQueueRemove`
 * (279). Used by the client UI to grey out cooldowns / show error messages
 * for failed abilities.
 *
 * Wire layout (pack() order):
 *   [u32]  sequenceId    matches an earlier CommandQueueEnqueue.sequenceId
 *   [f32]  waitTime      remaining cooldown seconds (often 0)
 *   [i32]  status        Command::ErrorCode (0 = CEC_Success)
 *   [i32]  statusDetail  sub-reason (often 0)
 *
 * Source:
 *   /home/tharper/code/swg-main/src/engine/shared/library/sharedNetworkMessages/src/shared/clientGameServer/MessageQueueCommandQueueRemove.{h,cpp}
 *   /home/tharper/code/swg-main/src/engine/shared/library/sharedFoundation/src/shared/GameControllerMessage.def:361 (CM_commandQueueRemove = 279)
 */

import { ByteStream } from '../../../archive/byte-stream.js';
import type { IByteStream, IReadIterator } from '../../../archive/interface.js';

export const CM_COMMAND_QUEUE_REMOVE = 279;

/**
 * Subset of Command::ErrorCode values (full enum in CommandQueue.cpp).
 * Only the most common ones; treat numeric values as opaque elsewhere.
 *
 * Source: /home/tharper/code/swg-main/src/engine/server/library/serverGame/include/public/serverGame/Command.h
 */
export const CommandErrorCode = {
  Success: 0,
  Failure: 1,
  Locomotion: 2,
  GameSystem: 3,
  GenericCannotForce: 4,
  Cancelled: 5,
} as const;

export class CommandQueueRemove {
  static readonly controllerMessage = CM_COMMAND_QUEUE_REMOVE;

  constructor(
    public readonly sequenceId: number,
    public readonly waitTime: number,
    public readonly status: number,
    public readonly statusDetail: number,
  ) {}

  pack(stream: IByteStream): void {
    stream.writeU32(this.sequenceId);
    stream.writeF32(this.waitTime);
    stream.writeI32(this.status);
    stream.writeI32(this.statusDetail);
  }

  toBytes(): Uint8Array {
    const s = new ByteStream();
    this.pack(s);
    return s.toBytes();
  }

  static unpack(iter: IReadIterator): CommandQueueRemove {
    const sequenceId = iter.readU32();
    const waitTime = iter.readF32();
    const status = iter.readI32();
    const statusDetail = iter.readI32();
    return new CommandQueueRemove(sequenceId, waitTime, status, statusDetail);
  }
}
