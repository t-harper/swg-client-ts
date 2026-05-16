/**
 * LoginClusterStatus — INBOUND (LoginServer → client)
 *
 * Source: /home/tharper/code/swg-main/src/engine/shared/library/sharedNetworkMessages/src/shared/clientLoginServer/LoginClusterStatus.h
 *
 * Wire layout — the 14-field post-Aug-2021 layout. The Aug 2021 "Admin
 * Account Routing Refactor" added `m_isAdmin` + `m_isSecret`. A version
 * skew at this boundary is exactly what caused the "Cluster: unknown"
 * crash documented in CLAUDE.md bug #7.
 *
 *   m_data: AutoArray<ClusterData> (uint32 count + N records)
 *     ClusterData (14 fields, in this exact order):
 *       m_clusterId                : uint32 LE
 *       m_connectionServerAddress  : std::string
 *       m_connectionServerPort     : uint16 LE
 *       m_connectionServerPingPort : uint16 LE
 *       m_populationOnline         : int32 LE (-1 = legitimate "not available")
 *       m_populationOnlineStatus   : int32 LE (PopulationStatus enum)
 *       m_maxCharactersPerAccount  : int32 LE
 *       m_timeZone                 : int32 LE
 *       m_status                   : int32 LE (Status enum: down/loading/up/locked/restricted/full)
 *       m_dontRecommend            : bool (1 byte)
 *       m_onlinePlayerLimit        : uint32 LE
 *       m_onlineFreeTrialLimit     : uint32 LE
 *       m_isAdmin                  : bool (1 byte) — added 2021
 *       m_isSecret                 : bool (1 byte) — added 2021
 */

import type { IByteStream, IReadIterator } from '../../archive/interface.js';
import { readStdString, writeStdString } from '../../archive/string.js';
import type { ClusterStatus, PopulationStatus } from '../../types.js';
import { GameNetworkMessage, asDecoder, defineMessageMeta } from '../base.js';
import { registerMessage } from '../registry.js';

const META = defineMessageMeta('LoginClusterStatus');

export interface LoginClusterStatusData {
  clusterId: number;
  connectionServerAddress: string;
  connectionServerPort: number;
  connectionServerPingPort: number;
  populationOnline: number;
  populationOnlineStatus: PopulationStatus;
  maxCharactersPerAccount: number;
  timeZone: number;
  status: ClusterStatus;
  dontRecommend: boolean;
  onlinePlayerLimit: number;
  onlineFreeTrialLimit: number;
  isAdmin: boolean;
  isSecret: boolean;
}

export class LoginClusterStatus extends GameNetworkMessage {
  static override readonly messageName = META.messageName;
  static readonly typeCrc = META.typeCrc;

  constructor(public clusters: LoginClusterStatusData[] = []) {
    super();
  }

  encodePayload(stream: IByteStream): void {
    stream.writeU32(this.clusters.length);
    for (const c of this.clusters) {
      stream.writeU32(c.clusterId);
      writeStdString(stream, c.connectionServerAddress);
      stream.writeU16(c.connectionServerPort);
      stream.writeU16(c.connectionServerPingPort);
      stream.writeI32(c.populationOnline);
      stream.writeI32(c.populationOnlineStatus);
      stream.writeI32(c.maxCharactersPerAccount);
      stream.writeI32(c.timeZone);
      stream.writeI32(c.status);
      stream.writeBool(c.dontRecommend);
      stream.writeU32(c.onlinePlayerLimit);
      stream.writeU32(c.onlineFreeTrialLimit);
      stream.writeBool(c.isAdmin);
      stream.writeBool(c.isSecret);
    }
  }

  static decodePayload(iter: IReadIterator): LoginClusterStatus {
    const count = iter.readU32();
    const clusters: LoginClusterStatusData[] = [];
    for (let i = 0; i < count; i++) {
      clusters.push({
        clusterId: iter.readU32(),
        connectionServerAddress: readStdString(iter),
        connectionServerPort: iter.readU16(),
        connectionServerPingPort: iter.readU16(),
        populationOnline: iter.readI32(),
        populationOnlineStatus: iter.readI32() as PopulationStatus,
        maxCharactersPerAccount: iter.readI32(),
        timeZone: iter.readI32(),
        status: iter.readI32() as ClusterStatus,
        dontRecommend: iter.readBool(),
        onlinePlayerLimit: iter.readU32(),
        onlineFreeTrialLimit: iter.readU32(),
        isAdmin: iter.readBool(),
        isSecret: iter.readBool(),
      });
    }
    return new LoginClusterStatus(clusters);
  }
}

export const LoginClusterStatusDecoder = registerMessage(asDecoder(LoginClusterStatus));
