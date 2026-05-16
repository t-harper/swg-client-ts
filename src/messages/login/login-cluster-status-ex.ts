/**
 * LoginClusterStatusEx — INBOUND (LoginServer → client)
 *
 * Source: /home/tharper/code/swg-main/src/engine/shared/library/sharedNetworkMessages/src/shared/clientLoginServer/LoginClusterStatusEx.h
 *
 * Wire layout:
 *   m_data: AutoArray<ClusterData> (uint32 count + N records)
 *     ClusterData (8 fields):
 *       m_clusterId      : uint32 LE
 *       m_branch         : std::string
 *       m_networkVersion : std::string
 *       m_version        : uint32 LE
 *       m_reserved1      : uint32 LE
 *       m_reserved2      : uint32 LE
 *       m_reserved3      : uint32 LE
 *       m_reserved4      : uint32 LE
 */

import type { IByteStream, IReadIterator } from '../../archive/interface.js';
import { readStdString, writeStdString } from '../../archive/string.js';
import { GameNetworkMessage, asDecoder, defineMessageMeta } from '../base.js';
import { registerMessage } from '../registry.js';

const META = defineMessageMeta('LoginClusterStatusEx');

export interface LoginClusterStatusExData {
  clusterId: number;
  branch: string;
  networkVersion: string;
  version: number;
  reserved1: number;
  reserved2: number;
  reserved3: number;
  reserved4: number;
}

export class LoginClusterStatusEx extends GameNetworkMessage {
  static override readonly messageName = META.messageName;
  static readonly typeCrc = META.typeCrc;
  /** cmd + data */
  static override readonly varCount = 2;

  constructor(public clusters: LoginClusterStatusExData[] = []) {
    super();
  }

  encodePayload(stream: IByteStream): void {
    stream.writeU32(this.clusters.length);
    for (const c of this.clusters) {
      stream.writeU32(c.clusterId);
      writeStdString(stream, c.branch);
      writeStdString(stream, c.networkVersion);
      stream.writeU32(c.version);
      stream.writeU32(c.reserved1);
      stream.writeU32(c.reserved2);
      stream.writeU32(c.reserved3);
      stream.writeU32(c.reserved4);
    }
  }

  static decodePayload(iter: IReadIterator): LoginClusterStatusEx {
    const count = iter.readU32();
    const clusters: LoginClusterStatusExData[] = [];
    for (let i = 0; i < count; i++) {
      clusters.push({
        clusterId: iter.readU32(),
        branch: readStdString(iter),
        networkVersion: readStdString(iter),
        version: iter.readU32(),
        reserved1: iter.readU32(),
        reserved2: iter.readU32(),
        reserved3: iter.readU32(),
        reserved4: iter.readU32(),
      });
    }
    return new LoginClusterStatusEx(clusters);
  }
}

export const LoginClusterStatusExDecoder = registerMessage(asDecoder(LoginClusterStatusEx));
