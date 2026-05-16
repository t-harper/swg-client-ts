import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EncryptMethod } from '../types.js';
import {
  buildKeepAlivePacket,
  buildSessionRequest,
  buildTerminatePacket,
  parseSessionResponse,
} from './session.js';

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

describe('buildSessionRequest', () => {
  it('matches the captured 14-byte SessionRequest from a real client', () => {
    const expected = loadHexFixture('session-request-14b.hex');
    expect(expected.length).toBe(14);
    // From the fixture: protocolVersion=2, connectionCode=0x00294823, maxRawPacketSize=496
    const got = buildSessionRequest({
      protocolVersion: 2,
      connectionCode: 0x00294823,
      maxRawPacketSize: 496,
    });
    expect(got).toEqual(expected);
  });
});

describe('parseSessionResponse', () => {
  it('parses the captured 17-byte SessionResponse correctly', () => {
    const packet = loadHexFixture('session-response-17b.hex');
    expect(packet.length).toBe(17);
    const r = parseSessionResponse(packet);
    expect(r.connectionCode).toBe(0x00294823);
    expect(r.encryptCode).toBe(0xfe7b4873);
    expect(r.crcBytes).toBe(2);
    expect(r.encryptMethods).toEqual([EncryptMethod.UserSupplied, EncryptMethod.Xor]);
    expect(r.maxRawPacketSize).toBe(496);
  });

  it('throws on too-short input', () => {
    expect(() => parseSessionResponse(new Uint8Array([0x00, 0x02, 0x00, 0x00]))).toThrow();
  });

  it('throws on wrong opcode', () => {
    const bogus = new Uint8Array(17);
    bogus[0] = 0x00;
    bogus[1] = 0x09; // Reliable1, not Confirm
    expect(() => parseSessionResponse(bogus)).toThrow();
  });
});

describe('buildTerminatePacket', () => {
  it('produces the expected 8-byte layout', () => {
    const p = buildTerminatePacket(0xfeedface, 0x1234);
    expect(p).toEqual(new Uint8Array([0x00, 0x05, 0xfe, 0xed, 0xfa, 0xce, 0x12, 0x34]));
  });

  it('defaults reason=0', () => {
    const p = buildTerminatePacket(0x11223344);
    expect(p).toEqual(new Uint8Array([0x00, 0x05, 0x11, 0x22, 0x33, 0x44, 0x00, 0x00]));
  });
});

describe('buildKeepAlivePacket', () => {
  it('is exactly [00 06]', () => {
    expect(buildKeepAlivePacket()).toEqual(new Uint8Array([0x00, 0x06]));
  });
});
