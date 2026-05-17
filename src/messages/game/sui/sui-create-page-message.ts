// SuiCreatePageMessage — S→C. Opens a SUI dialog (banker, vendor, quest, list picker, etc.).
// Wire payload is the packed `SuiPageData` struct (pageId + pageName + commands[] + ...);
// fully decoded into a `SuiPageData` tagged-union tree by `sui-page-data.ts`.
// Source: ~/code/swg-main/src/engine/shared/library/sharedNetworkMessages/src/shared/clientGameServer/SuiCreatePageMessage.{h,cpp}

import type { IByteStream, IReadIterator } from '../../../archive/interface.js';
import { GameNetworkMessage, asDecoder, defineMessageMeta } from '../../base.js';
import { registerMessage } from '../../registry.js';
import {
  type SuiPageData,
  decodeSuiPageData,
  encodeSuiPageData,
  writeSuiPageData,
} from './sui-page-data.js';

const META = defineMessageMeta('SuiCreatePageMessage');

export class SuiCreatePageMessage extends GameNetworkMessage {
  static override readonly messageName = META.messageName;
  static readonly typeCrc = META.typeCrc;
  /** cmd + pageData (AutoDeltaVariable<SuiPageData>) */
  static override readonly varCount = 2;

  /**
   * The decoded SuiPageData widget tree. For raw-byte access (e.g. for
   * transcript inspection or to forward unchanged through a relay), use
   * `pageDataBytes`.
   *
   * Accepts either the fully-typed `SuiPageData` struct OR a raw byte buffer
   * (which is decoded eagerly) — the latter exists so legacy call-sites and
   * test fixtures that hand-craft a `Uint8Array` keep working.
   */
  public readonly pageData: SuiPageData;

  constructor(pageData: SuiPageData | Uint8Array) {
    super();
    this.pageData = pageData instanceof Uint8Array ? decodeSuiPageData(pageData) : pageData;
  }

  /** The convenient leading-i32 pageId (always present, identifies the page). */
  get pageId(): number {
    return this.pageData.pageId;
  }

  /** Re-encode the `SuiPageData` back into its wire-form `Uint8Array` (round-trip-stable). */
  get pageDataBytes(): Uint8Array {
    return encodeSuiPageData(this.pageData);
  }

  encodePayload(stream: IByteStream): void {
    writeSuiPageData(stream, this.pageData);
  }

  static decodePayload(iter: IReadIterator): SuiCreatePageMessage {
    // Consume the remainder of the message envelope; the SuiPageData blob
    // is the only payload field.
    const bytes = iter.readBytes(iter.remaining);
    return new SuiCreatePageMessage(bytes);
  }
}

export const SuiCreatePageMessageDecoder = registerMessage(asDecoder(SuiCreatePageMessage));
