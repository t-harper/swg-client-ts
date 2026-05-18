/**
 * EnterTicketPurchaseModeMessage — server → client. Pushed by the
 * server's `enterClientTicketPurchaseMode` JNI method (called from
 * `script/terminal/terminal_travel.java::OnObjectMenuSelect` after a
 * client `ObjectMenuSelectMessage(terminal, ITEM_USE=21)`).
 *
 * Tells the client to display its hard-coded ticket-purchase UI and
 * scopes it to the departure point (terminal's home starport).
 *
 * Wire layout (addVariable order, 3 vars):
 *   [std::string]  m_planetName        — departure planet (e.g. "tatooine")
 *   [std::string]  m_travelPointName   — departure point (e.g. "mos_eisley")
 *   [u8 bool]      m_instantTravel     — true for shuttleports w/ instant
 *                                         travel (intra-planet only)
 *
 * Source:
 *   ~/code/swg-main/src/engine/shared/library/sharedNetworkMessages/src/
 *     shared/clientGameServer/EnterTicketPurchaseModeMessage.{h,cpp}
 */

import type { IByteStream, IReadIterator } from '../../../archive/interface.js';
import { readStdString, writeStdString } from '../../../archive/string.js';
import { GameNetworkMessage, asDecoder, defineMessageMeta } from '../../base.js';
import { registerMessage } from '../../registry.js';

const META = defineMessageMeta('EnterTicketPurchaseModeMessage');

export class EnterTicketPurchaseModeMessage extends GameNetworkMessage {
  static override readonly messageName = META.messageName;
  static readonly typeCrc = META.typeCrc;
  /** cmd + planetName + travelPointName + instantTravel */
  static override readonly varCount = 4;

  constructor(
    public readonly planetName: string,
    public readonly travelPointName: string,
    public readonly instantTravel: boolean,
  ) {
    super();
  }

  encodePayload(stream: IByteStream): void {
    writeStdString(stream, this.planetName);
    writeStdString(stream, this.travelPointName);
    stream.writeU8(this.instantTravel ? 1 : 0);
  }

  static decodePayload(iter: IReadIterator): EnterTicketPurchaseModeMessage {
    const planetName = readStdString(iter);
    const travelPointName = readStdString(iter);
    const instantTravel = iter.readU8() !== 0;
    return new EnterTicketPurchaseModeMessage(planetName, travelPointName, instantTravel);
  }
}

export const EnterTicketPurchaseModeMessageDecoder = registerMessage(
  asDecoder(EnterTicketPurchaseModeMessage),
);
