/**
 * Fragment reassembly for cUdpPacketFragment{1,2,3,4}.
 *
 * The C++ logic (UdpReliableChannel::ProcessPacket, lines 3585-3629):
 *   - First fragment in a sequence: payload starts with a 4-byte BE total-length
 *     header; remaining bytes are the first chunk.
 *   - Subsequent fragments: entire payload is data.
 *   - We know we have the first fragment when no big-packet is in flight.
 *
 * Notes for the receiver:
 *   - Fragments are interleaved with regular Reliable packets only by sequence.
 *     The IncomingSequence delivers payloads in order; the fragment buffer
 *     accumulates the chunks until the total-length is satisfied, then emits
 *     one big payload to the next stage (multi-packet unpack / dispatch).
 *   - The opcode (00 0d for channel 0) is part of the wire packet; the
 *     `addFragmentChunk` function takes the payload AFTER the 4-byte header
 *     (`[opcode][seq]`) has already been stripped — that's how IncomingSequence
 *     hands it off.
 *
 *   Wait — let me re-check. parseReliablePacket strips [opcode][seq] for
 *   Reliable1, but for Fragment1 the layout is also `[opcode][seq][...]`. The
 *   receive path will call `parseReliablePacket` for both (same 4-byte header
 *   format), so by the time we get here the payload is just the fragment data
 *   (with the 4-byte length header for the first fragment).
 */

import { fragmentTypeFor } from './packet-types.js';
import { putU16BE } from './session.js';

/** Maximum total fragment size (sanity check) — 1 MB is generous for SWG */
const MAX_FRAGMENT_TOTAL = 1024 * 1024;

/**
 * Stateful fragment buffer. One per reliable channel. Call `addChunk()` once
 * per fragment received (in order — IncomingSequence guarantees this).
 *
 * Returns either `null` (still accumulating) or the fully assembled payload
 * (and resets the buffer).
 */
export class FragmentBuffer {
  private buf: Uint8Array | null = null;
  private targetLen = 0;
  private writtenLen = 0;

  /**
   * Add a fragment chunk. The first chunk begins with a 4-byte BE total-length
   * header (per UdpLibrary.cpp line 3600). Subsequent chunks are pure data.
   *
   * Returns the assembled payload when complete; null otherwise.
   * Throws if the size header is implausible (>1 MB) or chunks overflow target.
   */
  addChunk(chunk: Uint8Array): Uint8Array | null {
    if (this.buf === null) {
      // First chunk: read 4-byte BE total length
      if (chunk.length < 4) {
        throw new Error(`first fragment chunk too short: ${chunk.length}`);
      }
      const b0 = chunk[0] ?? 0;
      const b1 = chunk[1] ?? 0;
      const b2 = chunk[2] ?? 0;
      const b3 = chunk[3] ?? 0;
      this.targetLen = ((b0 << 24) | (b1 << 16) | (b2 << 8) | b3) >>> 0;
      if (this.targetLen === 0 || this.targetLen > MAX_FRAGMENT_TOTAL) {
        throw new Error(
          `fragment total length ${this.targetLen} out of range (1..${MAX_FRAGMENT_TOTAL})`,
        );
      }
      this.buf = new Uint8Array(this.targetLen);
      const data = chunk.subarray(4);
      if (data.length > this.targetLen) {
        throw new Error(
          `first fragment data ${data.length} exceeds total length ${this.targetLen}`,
        );
      }
      this.buf.set(data, 0);
      this.writtenLen = data.length;
    } else {
      if (this.writtenLen + chunk.length > this.targetLen) {
        throw new Error(
          `fragment overflow: ${this.writtenLen + chunk.length} > target ${this.targetLen}`,
        );
      }
      this.buf.set(chunk, this.writtenLen);
      this.writtenLen += chunk.length;
    }
    if (this.writtenLen === this.targetLen) {
      const out = this.buf;
      this.buf = null;
      this.targetLen = 0;
      this.writtenLen = 0;
      return out;
    }
    return null;
  }

  /** True if we have started but not finished a fragment sequence. */
  get inProgress(): boolean {
    return this.buf !== null;
  }

  /** Reset (drop any in-progress fragment). */
  reset(): void {
    this.buf = null;
    this.targetLen = 0;
    this.writtenLen = 0;
  }
}

/**
 * Split a single oversized payload into fragment packets.
 *
 * `chunkSize` is the max bytes of fragment data per packet (i.e. after the
 * `[opcode][seq]` header and, for the first fragment, the 4-byte length header).
 *
 * Returns a list of packet bodies of the form `[opcode][seq=alloc()][data]`,
 * each ready to feed through the SOE encrypt + CRC pipeline.
 *
 * The first packet has the 4-byte BE total-length header inserted between
 * `[opcode][seq]` and the data.
 */
export function buildFragmentPackets(
  channel: 0 | 1 | 2 | 3,
  payload: Uint8Array,
  allocSeq: () => number,
  chunkSize: number,
): Uint8Array[] {
  if (chunkSize < 8) {
    throw new Error(`fragment chunkSize too small: ${chunkSize}`);
  }
  const opcode = fragmentTypeFor(channel);
  const out: Uint8Array[] = [];

  // First packet: [opcode][seq][totalLen u32 BE][data chunk]
  // The "data" part of the first fragment uses (chunkSize - 4) bytes since 4
  // bytes are eaten by the totalLen header.
  const firstChunkSize = chunkSize - 4;
  let offset = 0;
  const firstSeq = allocSeq();
  const firstDataLen = Math.min(firstChunkSize, payload.length);
  const firstPacket = new Uint8Array(4 + 4 + firstDataLen);
  firstPacket[0] = 0x00;
  firstPacket[1] = opcode;
  putU16BE(firstPacket, 2, firstSeq & 0xffff);
  // total length (BE u32)
  const totalLen = payload.length;
  firstPacket[4] = (totalLen >>> 24) & 0xff;
  firstPacket[5] = (totalLen >>> 16) & 0xff;
  firstPacket[6] = (totalLen >>> 8) & 0xff;
  firstPacket[7] = totalLen & 0xff;
  firstPacket.set(payload.subarray(0, firstDataLen), 8);
  out.push(firstPacket);
  offset += firstDataLen;

  // Subsequent: [opcode][seq][data chunk]
  while (offset < payload.length) {
    const seq = allocSeq();
    const dataLen = Math.min(chunkSize, payload.length - offset);
    const pkt = new Uint8Array(4 + dataLen);
    pkt[0] = 0x00;
    pkt[1] = opcode;
    putU16BE(pkt, 2, seq & 0xffff);
    pkt.set(payload.subarray(offset, offset + dataLen), 4);
    out.push(pkt);
    offset += dataLen;
  }
  return out;
}
