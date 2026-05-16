import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EncryptMethod } from '../types.js';
import {
  applyEncryption,
  decryptUserSupplied,
  decryptXor,
  encryptUserSupplied,
  encryptXor,
  reverseEncryption,
} from './encrypt.js';

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

/**
 * The captured 223-byte LoginEnumCluster reliable packet (with CRC).
 * We strip the trailing 2 CRC bytes for encryption tests, leaving 221 bytes.
 */
const CAPTURED_PACKET_FULL = loadHexFixture('login-enum-cluster-223b.hex');
const CAPTURED_PACKET_BODY = CAPTURED_PACKET_FULL.subarray(0, CAPTURED_PACKET_FULL.length - 2);

describe('encryptXor / decryptXor', () => {
  it('round-trips arbitrary buffers', () => {
    for (const len of [0, 1, 2, 3, 4, 5, 8, 13, 16, 19, 100, 256]) {
      const buf = new Uint8Array(len);
      for (let i = 0; i < len; i++) buf[i] = (i * 31 + 7) & 0xff;
      const enc = encryptXor(buf, 0xfe7b4873);
      const dec = decryptXor(enc, 0xfe7b4873);
      expect(dec).toEqual(buf);
    }
  });

  it('different seeds produce different output', () => {
    const buf = new Uint8Array(16).fill(0x42);
    const a = encryptXor(buf, 0x11111111);
    const b = encryptXor(buf, 0x22222222);
    expect(a).not.toEqual(b);
  });
});

describe('encryptUserSupplied / decryptUserSupplied', () => {
  it('round-trips compressible data', () => {
    const buf = new Uint8Array(256).fill(0xaa);
    const enc = encryptUserSupplied(buf);
    // Expect the trailing flag byte to be 0x01 (compressed)
    expect(enc[enc.length - 1]).toBe(0x01);
    const dec = decryptUserSupplied(enc);
    expect(dec).toEqual(buf);
  });

  it('round-trips uncompressible data', () => {
    // Random data won't compress; flag should be 0x00
    const buf = new Uint8Array(8);
    for (let i = 0; i < buf.length; i++) buf[i] = i;
    const enc = encryptUserSupplied(buf);
    expect(enc[enc.length - 1]).toBe(0x00);
    const dec = decryptUserSupplied(enc);
    expect(dec).toEqual(buf);
  });

  it('throws on bad flag byte', () => {
    expect(() => decryptUserSupplied(new Uint8Array([0x78, 0x9c, 0x99]))).toThrow();
  });

  it('round-trips empty data via the "raw" path', () => {
    const buf = new Uint8Array(0);
    const enc = encryptUserSupplied(buf);
    expect(enc.length).toBe(1);
    expect(enc[0]).toBe(0x00);
    const dec = decryptUserSupplied(enc);
    expect(dec).toEqual(buf);
  });
});

describe('full SOE decryption pipeline on captured LoginEnumCluster packet', () => {
  it('XOR-decrypt produces a zlib stream starting with 78 9c', () => {
    // The packet body is 221 bytes: [00 09] header + 219 bytes encrypted
    // (with the last byte being the UserSupplied flag).
    const body = CAPTURED_PACKET_BODY;
    expect(body.length).toBe(221);
    expect(body[0]).toBe(0x00);
    expect(body[1]).toBe(0x09); // cUdpPacketReliable1

    const decrypted = reverseEncryption(
      body,
      [EncryptMethod.UserSupplied, EncryptMethod.Xor],
      0xfe7b4873,
    );
    // Wait — reverseEncryption ALSO inflates. Let's separate the passes for clarity.
    // Instead: do just the XOR pass manually here.
    const opcode = body.subarray(0, 2);
    const ciphertext = body.subarray(2);
    const plainXor = decryptXor(ciphertext, 0xfe7b4873);
    // plainXor should be a zlib stream + trailing flag byte
    expect(plainXor[0]).toBe(0x78); // zlib header
    expect(plainXor[1]).toBe(0x9c);
    expect(plainXor[plainXor.length - 1]).toBe(0x01); // compressed flag

    // The full reverseEncryption also runs decryptUserSupplied → plaintext
    // app payload. Check first byte too.
    expect(decrypted[0]).toBe(opcode[0]);
    expect(decrypted[1]).toBe(opcode[1]);
  });

  it('full receive pipeline yields plaintext containing "swg", "10.254.0.253", "swg-main", "20100225-17:43"', () => {
    const body = CAPTURED_PACKET_BODY;
    const cooked = reverseEncryption(
      body,
      [EncryptMethod.UserSupplied, EncryptMethod.Xor],
      0xfe7b4873,
    );

    // Strip the [00 09] reliable-packet header to get the app-level bytes
    expect(cooked[0]).toBe(0x00);
    expect(cooked[1]).toBe(0x09);
    const appBytes = cooked.subarray(2);

    // App-level layout for a Reliable1 packet:
    //   [2 bytes reliable seq, big-endian]
    //   [N bytes Multi packet payload OR a single GameNetworkMessage]
    // The first GameNetworkMessage in the multi-packet payload should contain
    // the LoginEnumCluster body, which has the "swg" cluster string.

    const text = Buffer.from(appBytes).toString('binary');
    expect(text).toContain('swg');
    expect(text).toContain('10.254.0.253');
    expect(text).toContain('swg-main');
    expect(text).toContain('20100225-17:43');
  });

  it('the [00 09] opcode bytes are PRESERVED through reverseEncryption', () => {
    const body = CAPTURED_PACKET_BODY;
    const cooked = reverseEncryption(
      body,
      [EncryptMethod.UserSupplied, EncryptMethod.Xor],
      0xfe7b4873,
    );
    expect(cooked[0]).toBe(0x00);
    expect(cooked[1]).toBe(0x09);
  });
});

describe('encrypt → decrypt symmetry across the full pipeline', () => {
  it('round-trips a synthetic Reliable1 payload', () => {
    // Construct a [00 09 00 00 <payload>] packet body and ensure encrypt/decrypt round-trips
    const payload = new Uint8Array(64);
    for (let i = 0; i < payload.length; i++) payload[i] = (i * 17 + 3) & 0xff;
    const body = new Uint8Array(2 + 2 + payload.length);
    body[0] = 0x00;
    body[1] = 0x09;
    body[2] = 0x00;
    body[3] = 0x00;
    body.set(payload, 4);

    const enc = applyEncryption(body, [EncryptMethod.UserSupplied, EncryptMethod.Xor], 0xdeadbeef);
    expect(enc[0]).toBe(0x00);
    expect(enc[1]).toBe(0x09);
    const dec = reverseEncryption(enc, [EncryptMethod.UserSupplied, EncryptMethod.Xor], 0xdeadbeef);
    expect(dec).toEqual(body);
  });
});
