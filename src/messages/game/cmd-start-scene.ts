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

import type { IByteStream, IReadIterator } from '../../archive/interface.js';
import { NetworkIdCodec } from '../../archive/network-id.js';
import { readStdString, writeStdString } from '../../archive/string.js';
import { Vector3Codec } from '../../archive/transform.js';
import type { NetworkId, Vector3 } from '../../types.js';
import { GameNetworkMessage, asDecoder, defineMessageMeta } from '../base.js';
import { registerMessage } from '../registry.js';

const META = defineMessageMeta('CmdStartScene');

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
  static override readonly messageName = META.messageName;
  static readonly typeCrc = META.typeCrc;
  /** cmd + 8 fields (disableWorldSnapshot, objectId, sceneName, startPosition, startYaw, templateName, timeSeconds, serverEpoch) */
  static override readonly varCount = 9;

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
    NetworkIdCodec.encode(stream, this.playerNetworkId);
    writeStdString(stream, this.sceneName);
    Vector3Codec.encode(stream, this.startPosition);
    stream.writeF32(this.startYaw);
    writeStdString(stream, this.templateName);
    stream.writeI64(this.serverTimeSeconds);
    stream.writeI32(this.serverEpoch);
  }

  static decodePayload(iter: IReadIterator): CmdStartScene {
    const disableWorldSnapshot = iter.readBool();
    const playerNetworkId = NetworkIdCodec.decode(iter);
    const sceneName = readStdString(iter);
    const startPosition = Vector3Codec.decode(iter);
    const startYaw = iter.readF32();
    const templateName = readStdString(iter);
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

export const CmdStartSceneDecoder = registerMessage(asDecoder(CmdStartScene));
