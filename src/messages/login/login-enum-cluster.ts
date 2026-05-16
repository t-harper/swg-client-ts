/**
 * LoginEnumCluster — INBOUND (LoginServer → client)
 *
 * Source: /home/tharper/code/swg-main/src/engine/shared/library/sharedNetworkMessages/src/shared/clientLoginServer/LoginEnumCluster.h
 *
 * Wire layout (from the addVariable / Archive helper calls):
 *   m_data: AutoArray<ClusterData> (uint32 count + N ClusterData records)
 *     ClusterData:
 *       m_clusterId   : uint32 LE
 *       m_clusterName : std::string
 *       m_timeZone    : int32 LE
 *   m_maxCharactersPerAccount: AutoVariable<int32> (= int32 LE passthrough)
 */

import type { IByteStream, IReadIterator } from '../../archive/interface.js';
import { readStdString, writeStdString } from '../../archive/string.js';
import { GameNetworkMessage, asDecoder, defineMessageMeta } from '../base.js';
import { registerMessage } from '../registry.js';

const META = defineMessageMeta('LoginEnumCluster');

export interface LoginEnumClusterData {
  clusterId: number;
  name: string;
  timeZone: number;
}

export class LoginEnumCluster extends GameNetworkMessage {
  static override readonly messageName = META.messageName;
  static readonly typeCrc = META.typeCrc;
  /** cmd + data + maxCharactersPerAccount */
  static override readonly varCount = 3;

  constructor(
    public clusters: LoginEnumClusterData[] = [],
    public maxCharactersPerAccount = 0,
  ) {
    super();
  }

  encodePayload(stream: IByteStream): void {
    stream.writeU32(this.clusters.length);
    for (const c of this.clusters) {
      stream.writeU32(c.clusterId);
      writeStdString(stream, c.name);
      stream.writeI32(c.timeZone);
    }
    stream.writeI32(this.maxCharactersPerAccount);
  }

  static decodePayload(iter: IReadIterator): LoginEnumCluster {
    const count = iter.readU32();
    const clusters: LoginEnumClusterData[] = [];
    for (let i = 0; i < count; i++) {
      const clusterId = iter.readU32();
      const name = readStdString(iter);
      const timeZone = iter.readI32();
      clusters.push({ clusterId, name, timeZone });
    }
    const maxCharactersPerAccount = iter.readI32();
    return new LoginEnumCluster(clusters, maxCharactersPerAccount);
  }
}

export const LoginEnumClusterDecoder = registerMessage(asDecoder(LoginEnumCluster));
