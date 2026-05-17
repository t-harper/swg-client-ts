// SuiUpdatePageMessage — S→C. Updates widgets on an open SUI page in-place.
// Same wire shape as SuiCreatePageMessage (AutoDeltaVariable<SuiPageData>); modeled as opaque bytes.
// Source: ~/code/swg-main/src/engine/shared/library/sharedNetworkMessages/src/shared/clientGameServer/SuiUpdatePageMessage.{h,cpp}

import type { IByteStream, IReadIterator } from '../../../archive/interface.js';
import { GameNetworkMessage, asDecoder, defineMessageMeta } from '../../base.js';
import { registerMessage } from '../../registry.js';

const META = defineMessageMeta('SuiUpdatePageMessage');

export class SuiUpdatePageMessage extends GameNetworkMessage {
  static override readonly messageName = META.messageName;
  static readonly typeCrc = META.typeCrc;
  /** cmd + pageData (AutoDeltaVariable<SuiPageData>) */
  static override readonly varCount = 2;

  constructor(public readonly pageData: Uint8Array) {
    super();
  }

  encodePayload(stream: IByteStream): void {
    stream.writeBytes(this.pageData);
  }

  static decodePayload(iter: IReadIterator): SuiUpdatePageMessage {
    const bytes = iter.readBytes(iter.remaining);
    return new SuiUpdatePageMessage(bytes);
  }

  /** First 4 bytes are the LE i32 pageId; same layout as SuiCreatePageMessage. */
  get pageId(): number | null {
    if (this.pageData.length < 4) return null;
    const b = this.pageData;
    return (b[0] ?? 0) | ((b[1] ?? 0) << 8) | ((b[2] ?? 0) << 16) | ((b[3] ?? 0) << 24) | 0;
  }
}

export const SuiUpdatePageMessageDecoder = registerMessage(asDecoder(SuiUpdatePageMessage));
