import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import { encodeMessage } from '../base.js';
import { decodeMessageStrict } from '../registry.js';
import { LoginClusterStatusEx } from './login-cluster-status-ex.js';

describe('LoginClusterStatusEx (INBOUND)', () => {
  it('has the expected constcrc identifier', () => {
    // constcrc("LoginClusterStatusEx") = 0xfa5b4b5a
    expect(LoginClusterStatusEx.typeCrc).toBe(0xfa5b4b5a);
  });

  it('round-trips the live "swg" cluster ex fixture', () => {
    // Matches CLAUDE.md's expected values:
    //   branch: "swg-main", networkVersion: "20100225-17:43"
    const msg = new LoginClusterStatusEx([
      {
        clusterId: 1,
        branch: 'swg-main',
        networkVersion: '20100225-17:43',
        version: 0,
        reserved1: 0,
        reserved2: 0,
        reserved3: 0,
        reserved4: 0,
      },
    ]);
    const decoded = decodeMessageStrict(encodeMessage(msg)) as LoginClusterStatusEx;
    expect(decoded.clusters).toEqual(msg.clusters);
  });

  it('writes the 8 fields in order with no padding', () => {
    const msg = new LoginClusterStatusEx([
      {
        clusterId: 0xdeadbeef,
        branch: '',
        networkVersion: '',
        version: 1,
        reserved1: 2,
        reserved2: 3,
        reserved3: 4,
        reserved4: 5,
      },
    ]);
    const bytes = encodeMessage(msg);
    // 2 varCount + 4 CRC + 4 count + 4 clusterId + 2 empty branch + 2 empty netVer + 5 * 4 reserved = 10 + 28 = 38
    expect(bytes.byteLength).toBe(38);

    const view = Buffer.from(bytes);
    // clusterId at offset 10 (after 2 varCount + 4 CRC + 4 count)
    expect(view.readUInt32LE(10)).toBe(0xdeadbeef);
    // branch length (0) at offset 14
    expect(view.readUInt16LE(14)).toBe(0);
    // networkVersion length (0) at offset 16
    expect(view.readUInt16LE(16)).toBe(0);
    // version at offset 18
    expect(view.readUInt32LE(18)).toBe(1);
    // reserved4 at offset 34
    expect(view.readUInt32LE(34)).toBe(5);
  });
});
