/**
 * CmdStartScene — server-to-client. The GameServer's signal to start
 * initializing the world: where to put the player, what scene, server time
 * baseline, etc.
 *
 * Wire layout (addVariable order — note `disableWorldSnapshot` is FIRST,
 * which contradicts the constructor argument order):
 *   [bool]            disableWorldSnapshot
 *   [NetworkId (u64)] objectId            (the player's NetworkId)
 *   [string]          sceneName           (e.g. "tatooine")
 *   [Vector (3 f32)]  startPosition       (x, y, z)
 *   [f32]             startYaw
 *   [string]          templateName        (the player's shared object template)
 *   [i64]             timeSeconds         (server wall-clock seconds since epoch)
 *   [i32]             serverEpoch
 *
 * Source:
 *   /home/tharper/code/swg-main/src/engine/shared/library/sharedNetworkMessages/src/shared/clientGameServer/CommandChannelMessages.{h,cpp}
 */

import {
  readNetworkId,
  readString,
  readVector3,
  writeNetworkId,
  writeString,
  writeVector3,
} from '../../archive/_stub-byte-stream.js';
import type { NetworkId, Vector3 } from '../../types.js';
import {
  GameNetworkMessage,
  type IByteStream,
  type IReadIterator,
  constcrc,
  registerMessage,
} from '../_stub-base.js';

export interface CmdStartSceneParams {
  playerNetworkId: NetworkId;
  sceneName: string;
  startPosition: Vector3;
  startYaw: number;
  templateName: string;
  serverTimeSeconds: bigint;
  serverEpoch: number;
  disableWorldSnapshot?: boolean;
}

export class CmdStartScene extends GameNetworkMessage {
  static override readonly messageName = 'CmdStartScene';
  static readonly typeCrc = constcrc(CmdStartScene.messageName);

  readonly playerNetworkId: NetworkId;
  readonly sceneName: string;
  readonly startPosition: Vector3;
  readonly startYaw: number;
  readonly templateName: string;
  readonly serverTimeSeconds: bigint;
  readonly serverEpoch: number;
  readonly disableWorldSnapshot: boolean;

  constructor(p: CmdStartSceneParams) {
    super();
    this.playerNetworkId = p.playerNetworkId;
    this.sceneName = p.sceneName;
    this.startPosition = p.startPosition;
    this.startYaw = p.startYaw;
    this.templateName = p.templateName;
    this.serverTimeSeconds = p.serverTimeSeconds;
    this.serverEpoch = p.serverEpoch;
    this.disableWorldSnapshot = p.disableWorldSnapshot ?? false;
  }

  encodePayload(stream: IByteStream): void {
    stream.writeBool(this.disableWorldSnapshot);
    writeNetworkId(stream, this.playerNetworkId);
    writeString(stream, this.sceneName);
    writeVector3(stream, this.startPosition);
    stream.writeF32(this.startYaw);
    writeString(stream, this.templateName);
    stream.writeI64(this.serverTimeSeconds);
    stream.writeI32(this.serverEpoch);
  }

  static decodePayload(iter: IReadIterator): CmdStartScene {
    const disableWorldSnapshot = iter.readBool();
    const playerNetworkId = readNetworkId(iter);
    const sceneName = readString(iter);
    const startPosition = readVector3(iter);
    const startYaw = iter.readF32();
    const templateName = readString(iter);
    const serverTimeSeconds = iter.readI64();
    const serverEpoch = iter.readI32();
    return new CmdStartScene({
      playerNetworkId,
      sceneName,
      startPosition,
      startYaw,
      templateName,
      serverTimeSeconds,
      serverEpoch,
      disableWorldSnapshot,
    });
  }
}

registerMessage(CmdStartScene);
