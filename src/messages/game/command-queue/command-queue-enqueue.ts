/**
 * CommandQueueEnqueue — client → server.
 *
 * The MessageQueue payload subtype that carries an ability/command request
 * from the client (e.g. "attack <target>", "prone", "berserk1"). On the wire
 * this is the variable-length `data` trailer of an `ObjControllerMessage`
 * whose `message` field is `CM_commandQueueEnqueue` (278). The wrapping
 * happens in `wrapAsObjControllerMessage()` below; callers normally go
 * through `ScriptContext.useAbility(...)` rather than building this by hand.
 *
 * Wire layout (pack() order, matching the C++ implementation):
 *   [u32]            sequenceId      monotonic per-client counter
 *   [u32]            commandHash     constcrc(commandName.toLowerCase())
 *   [NetworkId u64]  targetId        0 == no target (self / area)
 *   [UnicodeString]  params          free-form ability args (often empty)
 *
 * Source:
 *   /home/tharper/code/swg-main/src/engine/shared/library/sharedNetworkMessages/src/shared/clientGameServer/MessageQueueCommandQueueEnqueue.{h,cpp}
 *   /home/tharper/code/swg-main/src/engine/shared/library/sharedFoundation/src/shared/GameControllerMessage.def:360 (CM_commandQueueEnqueue = 278)
 */

import { ByteStream } from '../../../archive/byte-stream.js';
import type { IByteStream, IReadIterator } from '../../../archive/interface.js';
import { NetworkIdCodec } from '../../../archive/network-id.js';
import { readUnicodeString, writeUnicodeString } from '../../../archive/unicode-string.js';
import type { NetworkId } from '../../../types.js';
import { ObjControllerMessage } from '../obj-controller-message.js';

/**
 * The CM_commandQueueEnqueue controller-message subtype constant.
 * Used as `ObjControllerMessage.message` to route this payload server-side.
 *
 * Source: GameControllerMessage.def line 360 (zero-indexed enum position 278).
 */
export const CM_COMMAND_QUEUE_ENQUEUE = 278;

/**
 * Default flag set for client-originated controller messages targeting the
 * authoritative game server. Matches the C++ convention
 * `SEND | RELIABLE | DEST_AUTH_SERVER`.
 *
 * Source: GameControllerMessage.h GameControllerMessageFlags constants
 *   SEND             = 0x00000001
 *   RELIABLE         = 0x00000002
 *   DEST_AUTH_SERVER = 0x00000020
 */
export const CLIENT_TO_AUTH_SERVER_FLAGS = 0x01 | 0x02 | 0x20; // = 0x23

/** Sentinel target meaning "no target / self / area". */
export const NO_TARGET: NetworkId = 0n;

export class CommandQueueEnqueue {
  static readonly controllerMessage = CM_COMMAND_QUEUE_ENQUEUE;

  constructor(
    public readonly sequenceId: number,
    public readonly commandHash: number,
    public readonly targetId: NetworkId,
    public readonly params: string,
  ) {}

  /** Serialize this payload (no ObjControllerMessage header) into a stream. */
  pack(stream: IByteStream): void {
    stream.writeU32(this.sequenceId);
    stream.writeU32(this.commandHash);
    NetworkIdCodec.encode(stream, this.targetId);
    writeUnicodeString(stream, this.params);
  }

  /** Convenience: pack into a fresh Uint8Array. */
  toBytes(): Uint8Array {
    const s = new ByteStream();
    this.pack(s);
    return s.toBytes();
  }

  /**
   * Parse a CommandQueueEnqueue payload (the `data` trailer of an
   * ObjControllerMessage that carries CM_commandQueueEnqueue).
   */
  static unpack(iter: IReadIterator): CommandQueueEnqueue {
    const sequenceId = iter.readU32();
    const commandHash = iter.readU32();
    const targetId = NetworkIdCodec.decode(iter);
    const params = readUnicodeString(iter);
    return new CommandQueueEnqueue(sequenceId, commandHash, targetId, params);
  }
}

/**
 * Wrap a CommandQueueEnqueue in an ObjControllerMessage ready to hand to
 * `dispatcher.send()`. The sourceNetworkId is the player's own NetworkId
 * (the actor running the command).
 */
export function wrapAsObjControllerMessage(
  enqueue: CommandQueueEnqueue,
  sourceNetworkId: NetworkId,
  flags: number = CLIENT_TO_AUTH_SERVER_FLAGS,
  value = 0,
): ObjControllerMessage {
  return new ObjControllerMessage(
    flags,
    CM_COMMAND_QUEUE_ENQUEUE,
    sourceNetworkId,
    value,
    enqueue.toBytes(),
  );
}
