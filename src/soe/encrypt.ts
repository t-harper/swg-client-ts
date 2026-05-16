/**
 * SOE encryption methods: Xor (rolling 4-byte feedback) and UserSupplied
 * (zlib compress/decompress with a trailing flag byte).
 *
 * Maps to:
 *   /home/tharper/code/swg-main/src/external/3rd/library/udplibrary/UdpLibrary.cpp
 *     EncryptXor (line 2758), DecryptXor (line 2781)
 *   /home/tharper/code/swg-main/src/engine/shared/library/sharedNetwork/src/shared/ManagerHandler.cpp
 *     OnUserSuppliedEncrypt (line 145), OnUserSuppliedDecrypt (line 181)
 *
 * Pipeline order (matches PhysicalSend / ProcessRawPacket):
 *   SEND: input → UserSupplied (zlib+flag) → XOR → CRC append
 *   RECV: strip CRC + verify → XOR-decrypt → UserSupplied-decrypt
 *
 * Special rule (PhysicalSend lines 2480-2495, ProcessRawPacket lines 1761-1771):
 *   If buf[0] == 0, bytes [0..1] are NOT encrypted; the encryption pass starts
 *   at offset 2. All SOE control packets have buf[0]=0x00.
 */

import { deflateSync, inflateSync } from 'node:zlib';
import type { EncryptMethod } from '../types.js';

// ──────────────────────────────────────────────────────────────────────────
// Xor (cEncryptMethodXor = 4): rolling 4-byte feedback
// ──────────────────────────────────────────────────────────────────────────

/**
 * Encrypt `src` with the XOR rolling-feedback algorithm. Returns a new buffer.
 *
 * Matches `EncryptXor` (line 2758): for each 4-byte block, output = input XOR
 * prev, and the next `prev` becomes the *encrypted* output.
 *
 * Tail bytes (1-3 trailing): each is XORed with the low byte of `prev`. The
 * C++ code does NOT shift prev between tail bytes — each leftover byte uses
 * the same LSB.
 */
export function encryptXor(src: Uint8Array, encryptCode: number): Uint8Array {
  const out = new Uint8Array(src.length);
  let prev = encryptCode >>> 0;
  let i = 0;
  while (i + 4 <= src.length) {
    const word = readU32LE(src, i);
    const encrypted = (word ^ prev) >>> 0;
    writeU32LE(out, i, encrypted);
    prev = encrypted;
    i += 4;
  }
  while (i < src.length) {
    const a = src[i];
    if (a === undefined) throw new Error('xor src OOB (impossible)');
    out[i] = a ^ (prev & 0xff);
    i++;
  }
  return out;
}

/**
 * Decrypt `src` with the XOR rolling-feedback algorithm.
 *
 * Matches `DecryptXor` (line 2781): each block's output = input XOR prev, and
 * the next `prev` becomes the (still-encrypted) input — not the decrypted output.
 */
export function decryptXor(src: Uint8Array, encryptCode: number): Uint8Array {
  const out = new Uint8Array(src.length);
  let prev = encryptCode >>> 0;
  let i = 0;
  while (i + 4 <= src.length) {
    const word = readU32LE(src, i);
    const decrypted = (word ^ prev) >>> 0;
    writeU32LE(out, i, decrypted);
    prev = word; // feedback = encrypted input, not decrypted output
    i += 4;
  }
  while (i < src.length) {
    const a = src[i];
    if (a === undefined) throw new Error('xor src OOB (impossible)');
    out[i] = a ^ (prev & 0xff);
    i++;
  }
  return out;
}

// ──────────────────────────────────────────────────────────────────────────
// UserSupplied (cEncryptMethodUserSupplied = 1): zlib + trailing flag byte
// ──────────────────────────────────────────────────────────────────────────

/**
 * Apply the UserSupplied encryption pass to `src`.
 *
 * Output format: [compressed][0x01] if zlib shrunk the data; otherwise [raw][0x00].
 * The server's compressor uses zlib WITH the standard 2-byte header (`78 9c`),
 * not raw deflate.
 *
 * The C++ logic in ManagerHandler::OnUserSuppliedEncrypt (line 145) is:
 *   - call compressor->compress(src, dest)
 *   - if result < 0 OR result > sourceLen → fall back to [raw][0x00]
 *   - otherwise → [compressed][0x01]
 *
 * We follow the same heuristic.
 */
export function encryptUserSupplied(src: Uint8Array): Uint8Array {
  let compressed: Buffer;
  try {
    compressed = deflateSync(Buffer.from(src.buffer, src.byteOffset, src.byteLength));
  } catch {
    compressed = Buffer.alloc(0);
  }

  if (compressed.length > 0 && compressed.length < src.length) {
    const out = new Uint8Array(compressed.length + 1);
    out.set(compressed, 0);
    out[compressed.length] = 0x01;
    return out;
  }
  const out = new Uint8Array(src.length + 1);
  out.set(src, 0);
  out[src.length] = 0x00;
  return out;
}

/**
 * Apply the UserSupplied decryption pass to `src`.
 *
 * Looks at the final byte:
 *   - 0x00 → input[:-1] is the plaintext, return a copy
 *   - 0x01 → input[:-1] is a zlib stream, inflate it
 *   - other → throw
 *
 * The "incorrect data check" zlib error is the canonical symptom of calling
 * inflate on the input WITHOUT first stripping the trailing flag byte.
 */
export function decryptUserSupplied(src: Uint8Array): Uint8Array {
  if (src.length < 1) {
    throw new Error('decryptUserSupplied: input must contain at least the flag byte');
  }
  const flag = src[src.length - 1];
  const body = src.subarray(0, src.length - 1);
  if (flag === 0x00) {
    return new Uint8Array(body);
  }
  if (flag === 0x01) {
    const inflated = inflateSync(Buffer.from(body.buffer, body.byteOffset, body.byteLength));
    return new Uint8Array(inflated.buffer, inflated.byteOffset, inflated.byteLength);
  }
  throw new Error(`decryptUserSupplied: unexpected compression flag 0x${flag?.toString(16)}`);
}

// ──────────────────────────────────────────────────────────────────────────
// Pipeline: apply encryption methods in sequence, respecting the
// "first byte == 0 ⇒ skip first 2 bytes" rule (the SOE opcode is sent in clear).
// ──────────────────────────────────────────────────────────────────────────

/**
 * Encrypt `src` for sending. Applies `methods[0]` then `methods[1]` (in order).
 *
 * If `src[0] === 0` and `src.length >= 2`, the first 2 bytes are the SOE
 * opcode and are passed through unencrypted; the encryption pass operates from
 * offset 2.
 *
 * If `src[0] !== 0`, only byte [0] is the opcode; encryption operates from
 * offset 1. (We don't actually send any such packets — the protocol's
 * one-byte-opcode form is cUdpPacketZeroEscape on receive only.)
 */
export function applyEncryption(
  src: Uint8Array,
  methods: ReadonlyArray<EncryptMethod>,
  encryptCode: number,
): Uint8Array {
  let cur = src;
  for (const method of methods) {
    if (method === 0) continue; // EncryptMethod.None
    cur = applyOneEncryptionPass(cur, method, encryptCode, /*encrypt=*/ true);
  }
  return cur;
}

/**
 * Decrypt `src` after receiving. Applies `methods` in REVERSE order.
 */
export function reverseEncryption(
  src: Uint8Array,
  methods: ReadonlyArray<EncryptMethod>,
  encryptCode: number,
): Uint8Array {
  let cur = src;
  for (let i = methods.length - 1; i >= 0; i--) {
    const method = methods[i];
    if (method === undefined || method === 0) continue;
    cur = applyOneEncryptionPass(cur, method, encryptCode, /*encrypt=*/ false);
  }
  return cur;
}

function applyOneEncryptionPass(
  src: Uint8Array,
  method: EncryptMethod,
  encryptCode: number,
  encrypt: boolean,
): Uint8Array {
  if (src.length === 0) return src;
  const headerLen = src[0] === 0 && src.length >= 2 ? 2 : 1;
  const body = src.subarray(headerLen);
  const transformed = transformBody(body, method, encryptCode, encrypt);
  const out = new Uint8Array(headerLen + transformed.length);
  for (let i = 0; i < headerLen; i++) {
    const b = src[i];
    if (b === undefined) throw new Error('applyOneEncryptionPass: header byte missing');
    out[i] = b;
  }
  out.set(transformed, headerLen);
  return out;
}

function transformBody(
  body: Uint8Array,
  method: EncryptMethod,
  encryptCode: number,
  encrypt: boolean,
): Uint8Array {
  switch (method) {
    case 1: // UserSupplied
      return encrypt ? encryptUserSupplied(body) : decryptUserSupplied(body);
    case 2: // UserSupplied2 — same as UserSupplied in this codebase
      return encrypt ? encryptUserSupplied(body) : decryptUserSupplied(body);
    case 3: // XorBuffer — not negotiated in our config
      throw new Error('XorBuffer (method 3) not implemented — not negotiated by the server');
    case 4: // Xor
      return encrypt ? encryptXor(body, encryptCode) : decryptXor(body, encryptCode);
    case 0:
      return body;
    default:
      throw new Error(`Unknown EncryptMethod ${method}`);
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Little-endian uint32 helpers — handles arbitrary Uint8Array views without
// requiring Buffer alignment (Buffer's readUInt32LE works but constructing
// a Buffer view over a sub-array can be tedious).
// ──────────────────────────────────────────────────────────────────────────

function readU32LE(buf: Uint8Array, offset: number): number {
  const b0 = buf[offset];
  const b1 = buf[offset + 1];
  const b2 = buf[offset + 2];
  const b3 = buf[offset + 3];
  if (b0 === undefined || b1 === undefined || b2 === undefined || b3 === undefined) {
    throw new Error(`readU32LE OOB at ${offset} (buf length ${buf.length})`);
  }
  return (b0 | (b1 << 8) | (b2 << 16) | (b3 << 24)) >>> 0;
}

function writeU32LE(buf: Uint8Array, offset: number, value: number): void {
  const v = value >>> 0;
  buf[offset] = v & 0xff;
  buf[offset + 1] = (v >>> 8) & 0xff;
  buf[offset + 2] = (v >>> 16) & 0xff;
  buf[offset + 3] = (v >>> 24) & 0xff;
}
