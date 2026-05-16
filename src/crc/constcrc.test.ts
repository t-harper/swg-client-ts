import { describe, expect, it } from 'vitest';
import { constcrc, constcrcBytes } from './constcrc.js';

describe('constcrc', () => {
  it('returns 0 for empty string (early-return per CrcConstexpr.hpp)', () => {
    expect(constcrc('')).toBe(0);
  });

  it('returns 0 for null / undefined', () => {
    expect(constcrc(null)).toBe(0);
    expect(constcrc(undefined)).toBe(0);
  });

  /**
   * Golden values computed from the C++ algorithm (see Crc.cpp + CrcConstexpr.hpp)
   * via a side-by-side Python reimplementation that uses the exact 256-entry table.
   * These are the CRCs the server's switch statements match against — if any of
   * them drift the server will silently ignore our messages.
   */
  it.each([
    ['LoginClientId', 0x41131f96],
    ['LoginClientToken', 0xaab296c6],
    ['LoginEnumCluster', 0xc11c63b9],
    ['LoginClusterStatus', 0x3436aeb6],
    ['LoginClusterStatusEx', 0xfa5b4b5a],
    ['LoginIncorrectClientId', 0x20e7e510],
    ['ServerNowEpochTime', 0x24b73893],
    ['CharacterCreationDisabled', 0xf41a5265],
    ['CmdStartScene', 0x3ae6dfae],
    ['ClientIdMsg', 0xd5899226],
    ['HeartBeat', 0xa16cf9af],
  ])('matches the server-side switch value for %s', (name, expected) => {
    expect(constcrc(name)).toBe(expected);
  });

  it('matches constcrcBytes for ASCII inputs', () => {
    const name = 'LoginClientId';
    const bytes = new TextEncoder().encode(name);
    expect(constcrcBytes(bytes)).toBe(constcrc(name));
  });

  it('produces an unsigned 32-bit number', () => {
    const v = constcrc('LoginClusterStatus');
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThanOrEqual(0xffffffff);
    // Should not have a sign bit interpretation
    expect(Number.isInteger(v)).toBe(true);
  });
});
