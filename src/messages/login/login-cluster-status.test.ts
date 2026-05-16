import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import { encodeMessage } from '../base.js';
import { decodeMessageStrict } from '../registry.js';
import { LoginClusterStatus } from './login-cluster-status.js';
import { ClusterStatus, PopulationStatus } from '../../types.js';

describe('LoginClusterStatus (INBOUND, 14-field post-2021 layout)', () => {
  it('has the expected constcrc identifier', () => {
    // constcrc("LoginClusterStatus") = 0x3436aeb6
    expect(LoginClusterStatus.typeCrc).toBe(0x3436aeb6);
  });

  it('round-trips the live "swg" cluster status', () => {
    // Matches what's in cluster_list per CLAUDE.md bug #6:
    //   name=swg, address=10.254.0.253, port=44463, online_player_limit=2500,
    //   online_free_trial_limit=250, status=up (loaded), not_recommended='N', secret='N'
    const msg = new LoginClusterStatus([
      {
        clusterId: 1,
        connectionServerAddress: '10.254.0.253',
        connectionServerPort: 44463,
        connectionServerPingPort: 44460,
        populationOnline: 0,
        populationOnlineStatus: PopulationStatus.VeryLight,
        maxCharactersPerAccount: 8,
        timeZone: 0,
        status: ClusterStatus.Up,
        dontRecommend: false,
        onlinePlayerLimit: 2500,
        onlineFreeTrialLimit: 250,
        isAdmin: false,
        isSecret: false,
      },
    ]);
    const bytes = encodeMessage(msg);
    const decoded = decodeMessageStrict(bytes) as LoginClusterStatus;
    expect(decoded.clusters).toEqual(msg.clusters);
  });

  it('encodes each field at the expected offset (14 fields = 41 bytes per record)', () => {
    const msg = new LoginClusterStatus([
      {
        clusterId: 1,
        connectionServerAddress: '',
        connectionServerPort: 44463,
        connectionServerPingPort: 44460,
        populationOnline: -1,
        populationOnlineStatus: PopulationStatus.VeryLight,
        maxCharactersPerAccount: 8,
        timeZone: 0,
        status: ClusterStatus.Up,
        dontRecommend: false,
        onlinePlayerLimit: 2500,
        onlineFreeTrialLimit: 250,
        isAdmin: false,
        isSecret: false,
      },
    ]);
    const bytes = encodeMessage(msg);

    // 4-byte CRC + 4-byte count + (4 cluster + 2 empty string + 2 + 2 + 4*5 + 1 + 4 + 4 + 1 + 1) = 8 + 41
    expect(bytes.byteLength).toBe(4 + 4 + 4 + 2 + 2 + 2 + 4 + 4 + 4 + 4 + 4 + 1 + 4 + 4 + 1 + 1);

    // Spot-check: byte 8 onwards should be 01 00 00 00 (clusterId=1 LE), then 00 00 (empty std::string length)
    const view = Buffer.from(bytes);
    expect(view.readUInt32LE(8)).toBe(1);
    expect(view.readUInt16LE(12)).toBe(0);
    expect(view.readUInt16LE(14)).toBe(44463);
  });

  it('handles -1 (population not available)', () => {
    const msg = new LoginClusterStatus([
      {
        clusterId: 1,
        connectionServerAddress: '127.0.0.1',
        connectionServerPort: 44463,
        connectionServerPingPort: 44460,
        populationOnline: -1, // legitimate value: "not available"
        populationOnlineStatus: PopulationStatus.VeryLight,
        maxCharactersPerAccount: 8,
        timeZone: 0,
        status: ClusterStatus.Loading,
        dontRecommend: true,
        onlinePlayerLimit: 100,
        onlineFreeTrialLimit: 10,
        isAdmin: true,
        isSecret: true,
      },
    ]);
    const decoded = decodeMessageStrict(encodeMessage(msg)) as LoginClusterStatus;
    expect(decoded.clusters[0]?.populationOnline).toBe(-1);
    expect(decoded.clusters[0]?.dontRecommend).toBe(true);
    expect(decoded.clusters[0]?.isAdmin).toBe(true);
    expect(decoded.clusters[0]?.isSecret).toBe(true);
    expect(decoded.clusters[0]?.status).toBe(ClusterStatus.Loading);
  });

  it('round-trips zero clusters', () => {
    const decoded = decodeMessageStrict(encodeMessage(new LoginClusterStatus([])));
    expect((decoded as LoginClusterStatus).clusters).toEqual([]);
  });
});
