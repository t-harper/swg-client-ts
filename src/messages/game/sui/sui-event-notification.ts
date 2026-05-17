// SuiEventNotification — C→S. Client reply to a server-pushed SUI page: identifies
// the page + which subscribed event fired + the list of widget property values
// the server asked to be sent back with the event.
//
// Wire layout (addVariable order; AutoDeltaVector adds a baselineCommandCount
// alongside the size — see AutoDeltaVector.h pack):
//   [i32]                       pageId
//   [i32]                       subscribedEventIndex
//   [u32]                       returnList.length
//   [u32]                       baselineCommandCount   (always 0 for fresh messages)
//   [UnicodeString][]*length    returnList
//
// Source: ~/code/swg-main/src/engine/shared/library/sharedNetworkMessages/src/shared/clientGameServer/SuiEventNotification.{h,cpp}

import type { IByteStream, IReadIterator } from '../../../archive/interface.js';
import { readUnicodeString, writeUnicodeString } from '../../../archive/unicode-string.js';
import { GameNetworkMessage, asDecoder, defineMessageMeta } from '../../base.js';
import { registerMessage } from '../../registry.js';

const META = defineMessageMeta('SuiEventNotification');

export class SuiEventNotification extends GameNetworkMessage {
  static override readonly messageName = META.messageName;
  static readonly typeCrc = META.typeCrc;
  /** cmd + pageId + subscribedEventIndex + subscribedProperties */
  static override readonly varCount = 4;

  constructor(
    public readonly pageId: number,
    public readonly subscribedEventIndex: number,
    public readonly returnList: readonly string[],
  ) {
    super();
  }

  encodePayload(stream: IByteStream): void {
    stream.writeI32(this.pageId);
    stream.writeI32(this.subscribedEventIndex);
    stream.writeU32(this.returnList.length);
    stream.writeU32(0);
    for (const v of this.returnList) {
      writeUnicodeString(stream, v);
    }
  }

  static decodePayload(iter: IReadIterator): SuiEventNotification {
    const pageId = iter.readI32();
    const subscribedEventIndex = iter.readI32();
    const size = iter.readU32();
    iter.readU32();
    const returnList: string[] = [];
    for (let i = 0; i < size; i++) {
      returnList.push(readUnicodeString(iter));
    }
    return new SuiEventNotification(pageId, subscribedEventIndex, returnList);
  }
}

export const SuiEventNotificationDecoder = registerMessage(asDecoder(SuiEventNotification));
