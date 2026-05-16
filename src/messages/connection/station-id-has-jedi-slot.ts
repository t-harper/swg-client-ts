/**
 * StationIdHasJediSlot — server-to-client; informs the client whether the
 * account is allowed to host a Jedi character. Sent by the LoginServer
 * IMMEDIATELY before the avatar list (EnumerateCharacterId).
 *
 * Despite being sent by the LoginServer, it shares the
 * ConnectionServer-stage code path on the client because both flow over
 * the same UDP session in the original codebase. We file it under
 * `connection/` for that reason.
 *
 * Wire layout: `GenericValueTypeMessage<int>` — a single i32 value.
 *
 * Source:
 *   /home/tharper/code/swg-main/src/engine/server/application/LoginServer/src/shared/LoginServer.cpp
 *     `GenericValueTypeMessage<int> const msgStationIdHasJediSlot("StationIdHasJediSlot", ...)`
 *   /home/tharper/code/swg-main/src/engine/shared/library/sharedNetworkMessages/src/shared/common/GenericValueTypeMessage.h
 */

import {
  GameNetworkMessage,
  constcrc,
  registerMessage,
  type IByteStream,
  type IReadIterator,
} from '../_stub-base.js';

export class StationIdHasJediSlot extends GameNetworkMessage {
  static override readonly messageName = 'StationIdHasJediSlot';
  static readonly typeCrc = constcrc(StationIdHasJediSlot.messageName);

  constructor(public readonly value: number) {
    super();
  }

  encodePayload(stream: IByteStream): void {
    stream.writeI32(this.value);
  }

  static decodePayload(iter: IReadIterator): StationIdHasJediSlot {
    return new StationIdHasJediSlot(iter.readI32());
  }
}

registerMessage(StationIdHasJediSlot);
