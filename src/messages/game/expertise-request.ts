/**
 * ExpertiseRequestMessage — client→server. Carries one or more expertise
 * skill names the player wants to add (and optionally a flag to clear all
 * existing expertises first, which is what the Reset button in the in-game
 * Expertise window sends).
 *
 * Wire layout:
 *
 *     [u32 LE addExpertisesList count]
 *     [u16 LE strLen][UTF-8 bytes] × count
 *     [u8  clearAllExpertisesFirst]   (0 = false, 1 = true)
 *
 * varCount = 1 (cmd) + addExpertisesList + clearAllExpertisesFirst = 3.
 *
 * The live Windows client sends ONE expertise per message with
 * clearAllExpertisesFirst=false (additive picks); each Apply click in the
 * Expertise window emits one of these. The Reset button sends an empty list
 * with clearAllExpertisesFirst=true to wipe state before re-applying.
 *
 * Server handler: CreatureObject::processExpertiseRequest in
 * src/engine/server/library/serverGame/src/shared/object/CreatureObject.cpp:14523.
 * God-mode bypasses point/prereq checks, so batched grants with clear=true
 * also work for admin bots (see scripts/buff-bot.ts).
 *
 * C++ ref:
 *   src/engine/shared/library/sharedNetworkMessages/src/shared/clientGameServer/
 *     ExpertiseRequestMessage.{cpp,h}
 *
 * Wire format verified against a live Windows-client capture on
 * 2026-05-18 — see expertise-request.test.ts golden bytes.
 */

import { AutoArrayCodec } from '../../archive/containers.js';
import type { IByteStream, IReadIterator } from '../../archive/interface.js';
import { StringCodec } from '../../archive/string.js';
import { GameNetworkMessage, asDecoder, defineMessageMeta } from '../base.js';
import { registerMessage } from '../registry.js';

const META = defineMessageMeta('ExpertiseRequestMessage');

export class ExpertiseRequestMessage extends GameNetworkMessage {
  static override readonly messageName = META.messageName;
  static readonly typeCrc = META.typeCrc;
  static override readonly varCount = 3;

  constructor(
    public readonly addExpertisesList: readonly string[],
    public readonly clearAllExpertisesFirst: boolean,
  ) {
    super();
  }

  encodePayload(stream: IByteStream): void {
    AutoArrayCodec(StringCodec).encode(stream, [...this.addExpertisesList]);
    stream.writeU8(this.clearAllExpertisesFirst ? 1 : 0);
  }

  static decodePayload(iter: IReadIterator): ExpertiseRequestMessage {
    const list = AutoArrayCodec(StringCodec).decode(iter);
    const clear = iter.readU8() !== 0;
    return new ExpertiseRequestMessage(list, clear);
  }
}

export const ExpertiseRequestMessageDecoder = registerMessage(
  asDecoder(ExpertiseRequestMessage),
);
