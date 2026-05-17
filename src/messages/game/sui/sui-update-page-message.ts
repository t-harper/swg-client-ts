// SuiUpdatePageMessage — S→C. Updates widgets on an open SUI page in-place.
// Same wire shape as SuiCreatePageMessage (AutoDeltaVariable<SuiPageData>);
// fully decoded into a `SuiPageData` tagged-union tree by `sui-page-data.ts`.
// Source: ~/code/swg-main/src/engine/shared/library/sharedNetworkMessages/src/shared/clientGameServer/SuiUpdatePageMessage.{h,cpp}

import type { IByteStream, IReadIterator } from '../../../archive/interface.js';
import { GameNetworkMessage, asDecoder, defineMessageMeta } from '../../base.js';
import { registerMessage } from '../../registry.js';
import {
  type SuiPageData,
  decodeSuiPageData,
  encodeSuiPageData,
  writeSuiPageData,
} from './sui-page-data.js';

const META = defineMessageMeta('SuiUpdatePageMessage');

export class SuiUpdatePageMessage extends GameNetworkMessage {
  static override readonly messageName = META.messageName;
  static readonly typeCrc = META.typeCrc;
  /** cmd + pageData (AutoDeltaVariable<SuiPageData>) */
  static override readonly varCount = 2;

  /**
   * The decoded SuiPageData widget tree. Same shape as
   * `SuiCreatePageMessage.pageData` — update messages reuse the full
   * `SuiPageData` struct rather than a delta.
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

  static decodePayload(iter: IReadIterator): SuiUpdatePageMessage {
    const bytes = iter.readBytes(iter.remaining);
    return new SuiUpdatePageMessage(bytes);
  }
}

export const SuiUpdatePageMessageDecoder = registerMessage(asDecoder(SuiUpdatePageMessage));
