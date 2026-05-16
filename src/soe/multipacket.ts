/**
 * cUdpPacketMulti unpacker / packer.
 *
 * Layout (after the SOE encryption layer has been stripped):
 *   [0..1]   00 03  (cUdpPacketMulti)
 *   loop:    [1 byte len][len bytes of sub-message]
 *
 * The sub-messages can themselves be any SOE packet type — including
 * Reliable1, Ack1, etc. — and they get re-fed into the main ProcessCookedPacket
 * dispatch loop.
 *
 * Maps to UdpLibrary.cpp lines 1997-2021 (receive side) and BufferedSend
 * lines 2553-2640 (send side).
 *
 * IMPORTANT: the per-message length byte uses unsigned 8 bits (max 255). For
 * messages larger than 255 bytes, the multi-packet path is bypassed and the
 * message is sent directly (PhysicalSend); we don't need to handle the
 * cUdpPacketGroup variant in the MVP.
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
