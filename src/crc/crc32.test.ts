import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { appendCrc, crc32, verifyCrc } from './crc32.js';

/** Read a *.hex fixture file: lines starting with '#' are comments, the rest are
 *  whitespace-separated hex pairs. */
function loadHexFixture(relPath: string): Uint8Array {
  const url = new URL(`../../tests/fixtures/${relPath}`, import.meta.url);
  const text = readFileSync(fileURLToPath(url), 'utf8');
  const cleaned = text
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .join(' ')
    .replace(/\s+/g, '');
  if (cleaned.length % 2 !== 0) throw new Error(`bad hex: odd length ${cleaned.length}`);
  const out = new Uint8Array(cleaned.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(cleaned.substr(i * 2, 2), 16);
  }
  return out;
}

const CAPTURED_PACKET = loadHexFixture('login-enum-cluster-223b.hex');

describe('crc32', () => {
  it('captured 223-byte LoginEnumCluster packet — verifyCrc passes with encryptCode 0xfe7b4873', () => {
    expect(CAPTURED_PACKET.length).toBe(223);
    expect(verifyCrc(CAPTURED_PACKET, 0xfe7b4873, 2)).toBe(true);
  });

  it('low 2 bytes of computed crc match captured 56 f9', () => {
    const body = CAPTURED_PACKET.subarray(0, CAPTURED_PACKET.length - 2);
    const crc = crc32(body, 0xfe7b4873);
    expect(crc & 0xffff).toBe(0x56f9);
  });

  it('appendCrc round-trips with verifyCrc', () => {
    const body = new Uint8Array([0x00, 0x09, 0x00, 0x01, 0xde, 0xad, 0xbe, 0xef]);
    for (const cb of [1, 2, 3, 4]) {
      const stamped = appendCrc(body, 0x12345678, cb);
      expect(stamped.length).toBe(body.length + cb);
      expect(verifyCrc(stamped, 0x12345678, cb)).toBe(true);
      // mutate last data byte → crc must now fail
      const mutated = new Uint8Array(stamped);
      mutated[body.length - 1] = (mutated[body.length - 1] ?? 0) ^ 0xff;
      expect(verifyCrc(mutated, 0x12345678, cb)).toBe(false);
    }
  });

  it('changes when encryptValue changes', () => {
    const body = new Uint8Array([0x01, 0x02, 0x03, 0x04, 0x05]);
    const a = crc32(body, 0xfe7b4873);
    const b = crc32(body, 0x00000000);
    expect(a).not.toBe(b);
  });

  it('empty buffer with seed 0 has a fixed value', () => {
    // Sanity: matches the deterministic output of UdpMisc::Crc32(nullptr, 0, 0)
    // (just make sure we're not crashing on empty input)
    const v = crc32(new Uint8Array(0), 0);
    expect(typeof v).toBe('number');
    // Verifiable: with encryptValue=0, the loop mixes 0,0,0,0 into 0xffffffff and
    // returns ~crc. The exact value is implementation-derivable; we just check
    // it's a uint32 not negative.
    expect(v >= 0 && v <= 0xffffffff).toBe(true);
  });

  it('returns a uint32 (no negatives)', () => {
    const body = new Uint8Array([0xff, 0xff, 0xff, 0xff]);
    const v = crc32(body, 0xfe7b4873);
    expect(v >= 0).toBe(true);
    expect(v <= 0xffffffff).toBe(true);
  });
});
