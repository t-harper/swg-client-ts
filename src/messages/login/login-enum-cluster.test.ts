import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import { encodeMessage } from '../base.js';
import { decodeMessageStrict } from '../registry.js';
import { LoginEnumCluster } from './login-enum-cluster.js';

describe('LoginEnumCluster (INBOUND)', () => {
  it('has the expected constcrc identifier', () => {
    // constcrc("LoginEnumCluster") = 0xc11c63b9
    expect(LoginEnumCluster.typeCrc).toBe(0xc11c63b9);
  });

  it('encodes the single-cluster "swg" fixture to deterministic bytes', () => {
    // Matches the actual cluster setup documented in CLAUDE.md:
    //   cluster_list: name='swg', timezone=0, maxCharactersPerAccount=8
    const msg = new LoginEnumCluster([{ clusterId: 1, name: 'swg', timeZone: 0 }], 8);
    const bytes = encodeMessage(msg);

    // Layout:
    //   [4]  CRC = 0xC11C63B9 LE = b9 63 1c c1
    //   [4]  AutoArray count = 1 LE
    //   [4]  clusterId = 1
    //   [2+3] name = "swg" → 03 00 + 73 77 67
    //   [4]  timeZone = 0
    //   [4]  maxCharactersPerAccount = 8
    const expected = Buffer.concat([
      Buffer.from([0xb9, 0x63, 0x1c, 0xc1]),
      Buffer.from([1, 0, 0, 0]),
      Buffer.from([1, 0, 0, 0]),
      Buffer.from([3, 0]),
      Buffer.from('swg', 'utf-8'),
      Buffer.from([0, 0, 0, 0]),
      Buffer.from([8, 0, 0, 0]),
    ]);
    expect(Array.from(bytes)).toEqual(Array.from(expected));
  });

  it('round-trips a zero-cluster (empty) response', () => {
    const msg = new LoginEnumCluster([], 8);
    const decoded = decodeMessageStrict(encodeMessage(msg));
    expect(decoded).toBeInstanceOf(LoginEnumCluster);
    expect((decoded as LoginEnumCluster).clusters).toEqual([]);
    expect((decoded as LoginEnumCluster).maxCharactersPerAccount).toBe(8);
  });

  it('round-trips multi-cluster data', () => {
    const msg = new LoginEnumCluster(
      [
        { clusterId: 1, name: 'swg', timeZone: 0 },
        { clusterId: 7, name: 'TestCluster', timeZone: -5 },
        { clusterId: 42, name: 'BigBoy', timeZone: 12 },
      ],
      8,
    );
    const decoded = decodeMessageStrict(encodeMessage(msg)) as LoginEnumCluster;
    expect(decoded.clusters).toEqual(msg.clusters);
    expect(decoded.maxCharactersPerAccount).toBe(8);
  });
});
