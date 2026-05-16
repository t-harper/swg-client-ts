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

import type { IByteStream, IReadIterator } from '../../archive/interface.js';
import { readStdString, writeStdString } from '../../archive/string.js';
import { GameNetworkMessage, asDecoder, defineMessageMeta } from '../base.js';
import { registerMessage } from '../registry.js';

const META = defineMessageMeta('ErrorMessage');

export class ErrorMessage extends GameNetworkMessage {
  static override readonly messageName = META.messageName;
  static readonly typeCrc = META.typeCrc;
  /** cmd + errorName + description + fatal */
  static override readonly varCount = 4;

  constructor(
    public readonly errorName: string,
    public readonly description: string,
    public readonly fatal: boolean = false,
  ) {
    super();
  }

  encodePayload(stream: IByteStream): void {
    writeStdString(stream, this.errorName);
    writeStdString(stream, this.description);
    stream.writeBool(this.fatal);
  }

  static decodePayload(iter: IReadIterator): ErrorMessage {
    const errorName = readStdString(iter);
    const description = readStdString(iter);
    const fatal = iter.readBool();
    return new ErrorMessage(errorName, description, fatal);
  }
}

export const ErrorMessageDecoder = registerMessage(asDecoder(ErrorMessage));
