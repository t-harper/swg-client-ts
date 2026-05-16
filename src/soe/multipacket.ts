/**
 * cUdpPacketMulti and cUdpPacketGroup unpackers / packers.
 *
 * Multi (opcode 3) layout:
 *   [0..1]   00 03
 *   loop:    [1 byte len][len bytes of sub-message]
 * Group (opcode 25 = 0x19) layout:
 *   [0..1]   00 19
 *   loop:    [variable-len length][len bytes of sub-message]
 *
 * Multi is used by the SOE layer itself to coalesce small SOE control packets
 * (Acks, KeepAlives, etc.) — sub-messages are recursed through ProcessCookedPacket.
 * Group is used by the higher-level UDP coalescing path (`CoalesceMessage`) to
 * bundle multiple application messages (each `[uint16 LE AutoByteStream var-count]
 * [uint32 LE constcrc][payload]`) into a single Reliable1 packet — sub-messages
 * are sent directly to the app callback (don't start with `[00 X]`).
 *
 * Maps to UdpLibrary.cpp:
 *   Multi: lines 1997-2021 (recv) + BufferedSend lines 2553-2640 (send)
 *   Group: lines 2152-2164 (recv) + Coalesce lines 3070-3130 (send)
 *
 * Variable-length encoding (PutVariableValue line 4249):
 *   value < 254          → 1 byte: [value]
 *   value < 0xffff       → 3 bytes: [0xff][value BE u16]
 *   else                  → 7 bytes: [0xff 0xff 0xff][value BE u32]
 */

import { SoePacketType } from './packet-types.js';

/**
 * Unpack a cUdpPacketMulti payload into individual sub-message buffers.
 * `packet` must start with [0x00, 0x03] (the Multi opcode).
 *
 * Throws if a length byte runs past the end of the packet.
 */
export function unpackMulti(packet: Uint8Array): Uint8Array[] {
  if (packet.length < 2) {
    throw new Error(`Multi packet too short: ${packet.length}`);
  }
  if (packet[0] !== 0x00 || packet[1] !== SoePacketType.Multi) {
    throw new Error(
      `Not a Multi packet: opcode ${packet[0]?.toString(16)} ${packet[1]?.toString(16)}`,
    );
  }

  const out: Uint8Array[] = [];
  let i = 2;
  while (i < packet.length) {
    const len = packet[i];
    if (len === undefined) throw new Error('Multi packet: length byte OOB');
    i++;
    const end = i + len;
    if (end > packet.length) {
      throw new Error(
        `Multi packet: sub-message length ${len} at offset ${i} exceeds packet end (${packet.length})`,
      );
    }
    out.push(packet.subarray(i, end));
    i = end;
  }
  return out;
}

/**
 * Build a cUdpPacketMulti from a list of sub-messages.
 *
 * Each sub-message must be ≤ 255 bytes (the length-prefix is a single byte).
 * Throws if any sub-message is too large.
 */
export function packMulti(subMessages: ReadonlyArray<Uint8Array>): Uint8Array {
  let total = 2; // for [00 03]
  for (const m of subMessages) {
    if (m.length > 255) {
      throw new Error(`packMulti: sub-message ${m.length} bytes exceeds 255-byte limit`);
    }
    total += 1 + m.length;
  }
  const out = new Uint8Array(total);
  out[0] = 0x00;
  out[1] = SoePacketType.Multi;
  let off = 2;
  for (const m of subMessages) {
    out[off] = m.length;
    off++;
    out.set(m, off);
    off += m.length;
  }
  return out;
}

// ──────────────────────────────────────────────────────────────────────────
// Group (variable-length per chunk)
// ──────────────────────────────────────────────────────────────────────────

/**
 * Decode a variable-length unsigned integer at `buf[off]`.
 * Returns `[value, bytesConsumed]`. Mirrors `UdpMisc::GetVariableValue` (line 4278).
 */
function readVarLen(buf: Uint8Array, off: number): [number, number] {
  const first = buf[off];
  if (first === undefined) throw new Error(`readVarLen OOB at ${off}`);
  if (first !== 0xff) {
    return [first, 1];
  }
  const b1 = buf[off + 1];
  const b2 = buf[off + 2];
  if (b1 === undefined || b2 === undefined) {
    throw new Error(`readVarLen 3-byte form truncated at ${off}`);
  }
  if (b1 !== 0xff || b2 !== 0xff) {
    // 3-byte form: [0xff][BE u16]
    return [((b1 << 8) | b2) >>> 0, 3];
  }
  // 7-byte form: [0xff 0xff 0xff][BE u32]
  const b3 = buf[off + 3];
  const b4 = buf[off + 4];
  const b5 = buf[off + 5];
  const b6 = buf[off + 6];
  if (b3 === undefined || b4 === undefined || b5 === undefined || b6 === undefined) {
    throw new Error(`readVarLen 7-byte form truncated at ${off}`);
  }
  return [((b3 << 24) | (b4 << 16) | (b5 << 8) | b6) >>> 0, 7];
}

/**
 * Encode a value into the variable-length format. Returns the byte sequence.
 */
function writeVarLen(value: number): Uint8Array {
  const v = value >>> 0;
  if (v < 254) {
    return new Uint8Array([v]);
  }
  if (v < 0xffff) {
    return new Uint8Array([0xff, (v >>> 8) & 0xff, v & 0xff]);
  }
  return new Uint8Array([
    0xff,
    0xff,
    0xff,
    (v >>> 24) & 0xff,
    (v >>> 16) & 0xff,
    (v >>> 8) & 0xff,
    v & 0xff,
  ]);
}

/**
 * Unpack a cUdpPacketGroup payload into individual sub-message buffers.
 * `packet` must start with [0x00, 0x19] (the Group opcode).
 *
 * Each sub-message is preceded by a variable-length integer giving its size.
 */
export function unpackGroup(packet: Uint8Array): Uint8Array[] {
  if (packet.length < 2) {
    throw new Error(`Group packet too short: ${packet.length}`);
  }
  if (packet[0] !== 0x00 || packet[1] !== SoePacketType.Group) {
    throw new Error(
      `Not a Group packet: opcode ${packet[0]?.toString(16)} ${packet[1]?.toString(16)}`,
    );
  }
  const out: Uint8Array[] = [];
  let i = 2;
  while (i < packet.length) {
    const [len, lenSize] = readVarLen(packet, i);
    i += lenSize;
    const end = i + len;
    if (end > packet.length) {
      throw new Error(
        `Group packet: sub-message length ${len} at offset ${i} exceeds packet end (${packet.length})`,
      );
    }
    out.push(packet.subarray(i, end));
    i = end;
  }
  return out;
}

/**
 * Build a cUdpPacketGroup from a list of sub-messages. Each sub-message can be
 * any length (the variable-length prefix accommodates up to 4 GB).
 */
export function packGroup(subMessages: ReadonlyArray<Uint8Array>): Uint8Array {
  let total = 2; // [00 19]
  const lenPrefixes: Uint8Array[] = [];
  for (const m of subMessages) {
    const prefix = writeVarLen(m.length);
    lenPrefixes.push(prefix);
    total += prefix.length + m.length;
  }
  const out = new Uint8Array(total);
  out[0] = 0x00;
  out[1] = SoePacketType.Group;
  let off = 2;
  for (let idx = 0; idx < subMessages.length; idx++) {
    const m = subMessages[idx];
    const prefix = lenPrefixes[idx];
    if (m === undefined || prefix === undefined) continue;
    out.set(prefix, off);
    off += prefix.length;
    out.set(m, off);
    off += m.length;
  }
  return out;
}
