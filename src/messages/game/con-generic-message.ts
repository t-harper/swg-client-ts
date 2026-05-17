/**
 * ConGenericMessage — bidirectional. Admin / console command channel. Sent
 * from the client to invoke server-side console commands like `/object
 * createIn <containerId> <template>`. Server replies with a ConGenericMessage
 * back carrying any output text.
 *
 * The message body is the command (without the leading slash). For example
 * `object createIn 1234 object/intangible/vehicle/landspeeder_av21_pcd.iff`.
 * Authorization is gated by `ClientPermissions.isAdmin` server-side.
 *
 * Wire layout (addVariable order):
 *   [string]  msg     — the console command body
 *   [u32]     msgId   — caller-allocated request id (echoed in the response)
 *
 * Source:
 *   /home/tharper/code/swg-main/src/engine/shared/library/sharedNetworkMessages/src/shared/clientGameServer/ConsoleChannelMessages.{h,cpp}
 */

import type { IByteStream, IReadIterator } from '../../archive/interface.js';
import { readStdString, writeStdString } from '../../archive/string.js';
import { GameNetworkMessage, asDecoder, defineMessageMeta } from '../base.js';
import { registerMessage } from '../registry.js';

const META = defineMessageMeta('ConGenericMessage');

export class ConGenericMessage extends GameNetworkMessage {
  static override readonly messageName = META.messageName;
  static readonly typeCrc = META.typeCrc;
  /** cmd + msg + msgId */
  static override readonly varCount = 3;

  constructor(
    public readonly msg: string,
    public readonly msgId: number = 0,
  ) {
    super();
  }

  encodePayload(stream: IByteStream): void {
    writeStdString(stream, this.msg);
    stream.writeU32(this.msgId);
  }

  static decodePayload(iter: IReadIterator): ConGenericMessage {
    const msg = readStdString(iter);
    const msgId = iter.readU32();
    return new ConGenericMessage(msg, msgId);
  }
}

export const ConGenericMessageDecoder = registerMessage(asDecoder(ConGenericMessage));
