/**
 * ErrorMessage — server-to-client. Generic "something went wrong" with an
 * error name (e.g. "Validation Failed"), a human-readable description, and
 * a fatal flag indicating whether the client should give up trying.
 *
 * NOTE: The upstream wire layout is `[string name][string description][bool fatal]`,
 * NOT `[bool fatal][string errorText]` as the task description initially
 * suggested. Verified against ErrorMessage.cpp's `addVariable` order.
 *
 * Wire layout (addVariable order):
 *   [string]  errorName
 *   [string]  description
 *   [bool]    fatal
 *
 * Source:
 *   /home/tharper/code/swg-main/src/engine/shared/library/sharedNetworkMessages/src/shared/common/ErrorMessage.{h,cpp}
 */

import {
  GameNetworkMessage,
  constcrc,
  registerMessage,
  type IByteStream,
  type IReadIterator,
} from '../_stub-base.js';
import { readString, writeString } from '../../archive/_stub-byte-stream.js';

export class ErrorMessage extends GameNetworkMessage {
  static override readonly messageName = 'ErrorMessage';
  static readonly typeCrc = constcrc(ErrorMessage.messageName);

  constructor(
    public readonly errorName: string,
    public readonly description: string,
    public readonly fatal: boolean = false,
  ) {
    super();
  }

  encodePayload(stream: IByteStream): void {
    writeString(stream, this.errorName);
    writeString(stream, this.description);
    stream.writeBool(this.fatal);
  }

  static decodePayload(iter: IReadIterator): ErrorMessage {
    const errorName = readString(iter);
    const description = readString(iter);
    const fatal = iter.readBool();
    return new ErrorMessage(errorName, description, fatal);
  }
}

registerMessage(ErrorMessage);
