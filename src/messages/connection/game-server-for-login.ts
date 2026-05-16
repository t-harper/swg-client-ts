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

import type { IByteStream, IReadIterator } from '../../archive/interface.js';
import { NetworkIdCodec } from '../../archive/network-id.js';
import type { NetworkId } from '../../types.js';
import { GameNetworkMessage, asDecoder, defineMessageMeta } from '../base.js';
import { registerMessage } from '../registry.js';

const META = defineMessageMeta('GameServerForLoginMessage');

export class GameServerForLoginMessage extends GameNetworkMessage {
  static override readonly messageName = META.messageName;
  static readonly typeCrc = META.typeCrc;
  /** cmd + stationId + server + characterId */
  static override readonly varCount = 4;

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
    NetworkIdCodec.encode(stream, this.characterId);
  }

  static decodePayload(iter: IReadIterator): GameServerForLoginMessage {
    const stationId = iter.readU32();
    const server = iter.readU32();
    const characterId = NetworkIdCodec.decode(iter);
    return new GameServerForLoginMessage(stationId, server, characterId);
  }
}

export const GameServerForLoginMessageDecoder = registerMessage(
  asDecoder(GameServerForLoginMessage),
);
