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
  /** cmd + data */
  static override readonly varCount = 2;

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
      const clusterId = iter.readU32();
      const connectionServerAddress = readStdString(iter);
      const connectionServerPort = iter.readU16();
      const connectionServerPingPort = iter.readU16();
      const populationOnline = iter.readI32();
      const populationOnlineStatus = iter.readI32() as PopulationStatus;
      const maxCharactersPerAccount = iter.readI32();
      const timeZone = iter.readI32();
      const status = iter.readI32() as ClusterStatus;
      const dontRecommend = iter.readBool();
      const onlinePlayerLimit = iter.readU32();
      const onlineFreeTrialLimit = iter.readU32();
      // Pre-Aug-2021 servers omit isAdmin/isSecret. When talking to such a
      // server, the row ends after onlineFreeTrialLimit. We tolerate either
      // shape because in practice we have to coexist with both — see CLAUDE.md
      // bug #7 (the version-skew "Cluster: unknown" crash on the real client;
      // the bug-7 captured-fixture itself exhibits the old 12-field shape).
      //
      // Strategy: on the last cluster in the array, if there are fewer than 2
      // bytes remaining we assume the legacy 12-field shape and default both
      // bools to false. Inside the array (not the last cluster) we always try
      // to read both, so any malformed mid-array row will throw a normal
      // ReadException via readBool's own bounds check.
      let isAdmin = false;
      let isSecret = false;
      const isLastCluster = i === count - 1;
      if (!isLastCluster || iter.remaining >= 2) {
        isAdmin = iter.readBool();
        isSecret = iter.readBool();
      }
      clusters.push({
        clusterId,
        connectionServerAddress,
        connectionServerPort,
        connectionServerPingPort,
        populationOnline,
        populationOnlineStatus,
        maxCharactersPerAccount,
        timeZone,
        status,
        dontRecommend,
        onlinePlayerLimit,
        onlineFreeTrialLimit,
        isAdmin,
        isSecret,
      });
    }
    return new LoginClusterStatus(clusters);
  }
}

export const LoginClusterStatusDecoder = registerMessage(asDecoder(LoginClusterStatus));
