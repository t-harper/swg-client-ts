/**
 * GameServerForLoginMessage — server-side message; in the upstream code
 * this is sent between PlanetServer and ConnectionServer (via Central),
 * NOT directly to the client. The ConnectionServer uses it to decide
 * which GameServer to internally route the client's traffic to.
 *
 * IMPORTANT CROSS-STREAM NOTE:
 *   The original plan listed this under "messages the client receives,"
 *   but inspection of `ClientConnection.cpp::handleGameServerForLoginMessage`
 *   shows the GameConnection is selected and the existing UDP socket is
 *   re-routed *internally*; no message goes back to the client telling it
 *   to reconnect. The wire-protocol-matching client stays on the
 *   ConnectionServer socket throughout the GameServer-bound part of the
 *   flow.
 *
 *   I'm keeping this class as the upstream wire layout for completeness
 *   (cross-stream test fixtures may need it) and flagging this for Stream A
 *   so the connection-stage orchestrator does NOT open a new socket on
 *   receipt of any message after `ClientPermissionsMessage`. Phase 2
 *   should revisit the lifecycle docs accordingly.
 *
 * Wire layout (addVariable order):
 *   [u32]              stationId
 *   [u32]              server      (the assigned GameServer process id)
 *   [NetworkId (u64)]  characterId
 *
 * Source:
 *   /home/tharper/code/swg-main/src/engine/server/library/serverNetworkMessages/src/shared/centralPlanetServer/GameServerForLoginMessage.h
 */

import type { NetworkId } from '../../types.js';
import {
  GameNetworkMessage,
  constcrc,
  registerMessage,
  type IByteStream,
  type IReadIterator,
} from '../_stub-base.js';
import { readNetworkId, writeNetworkId } from '../../archive/_stub-byte-stream.js';

export class GameServerForLoginMessage extends GameNetworkMessage {
  static override readonly messageName = 'GameServerForLoginMessage';
  static readonly typeCrc = constcrc(GameServerForLoginMessage.messageName);

  constructor(
    public readonly stationId: number,
    public readonly server: number,
    public readonly characterId: NetworkId,
  ) {
    super();
  }

  encodePayload(stream: IByteStream): void {
    stream.writeU32(this.stationId);
    stream.writeU32(this.server);
    writeNetworkId(stream, this.characterId);
  }

  static decodePayload(iter: IReadIterator): GameServerForLoginMessage {
    const stationId = iter.readU32();
    const server = iter.readU32();
    const characterId = readNetworkId(iter);
    return new GameServerForLoginMessage(stationId, server, characterId);
  }
}

registerMessage(GameServerForLoginMessage);
