// SuiCreatePageMessage — S→C. Opens a SUI dialog (banker, vendor, quest, list picker, etc.).
// Wire payload is the packed `SuiPageData` struct (pageId + pageName + commands[] + ...);
// modeled as opaque bytes — clients can identify and respond to pages without decoding widgets.
// Source: ~/code/swg-main/src/engine/shared/library/sharedNetworkMessages/src/shared/clientGameServer/SuiCreatePageMessage.{h,cpp}

import type { IByteStream, IReadIterator } from '../../../archive/interface.js';
import { GameNetworkMessage, asDecoder, defineMessageMeta } from '../../base.js';
import { registerMessage } from '../../registry.js';

const META = defineMessageMeta('SuiCreatePageMessage');

export class SuiCreatePageMessage extends GameNetworkMessage {
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

  static decodePayload(iter: IReadIterator): SuiCreatePageMessage {
    const bytes = iter.readBytes(iter.remaining);
    return new SuiCreatePageMessage(bytes);
  }

  /**
   * Best-effort `pageId` extraction. `SuiPageData::put` starts with
   * `Archive::put(target, m_pageId)` which serializes as a 4-byte LE i32, so
   * the first 4 bytes of `pageData` are the page id. Returns null if there
   * aren't enough bytes.
   */
  get pageId(): number | null {
    if (this.pageData.length < 4) return null;
    const b = this.pageData;
    return (b[0] ?? 0) | ((b[1] ?? 0) << 8) | ((b[2] ?? 0) << 16) | ((b[3] ?? 0) << 24) | 0;
  }
}

export const SuiCreatePageMessageDecoder = registerMessage(asDecoder(SuiCreatePageMessage));
