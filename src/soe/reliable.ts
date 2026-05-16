/**
 * Reliable-channel framing and ACK generation.
 *
 * SOE reliable packets carry a 16-bit reliable stamp that wraps. The C++
 * `GetReliableIncomingId` (UdpReliableChannel.cpp / UdpLibrary.cpp around
 * line 3496) reconstructs a full 64-bit ID from the 16-bit stamp by tracking
 * the high bits.
 *
 * For the MVP we use channel 0 exclusively (Reliable1/Fragment1/Ack1/AckAll1)
 * because that's what login/connection/game-server messages use.
 *
 * Wire layout (after stripping SOE encryption + CRC):
 *   Reliable1:
 *     [0..1]  00 09
 *     [2..3]  reliable seq (BE u16)
 *     [4..]   application payload
 *   Fragment1 (first):
 *     [0..1]  00 0d
 *     [2..3]  reliable seq (BE u16)
 *     [4..7]  total reassembled length (BE u32)
 *     [8..]   first chunk of fragment data
 *   Fragment1 (continuation):
 *     [0..1]  00 0d
 *     [2..3]  reliable seq (BE u16)
 *     [4..]   chunk data
 *   Ack1:
 *     [0..1]  00 11
 *     [2..3]  the seq being acknowledged (BE u16)
 *   AckAll1:
 *     [0..1]  00 15
 *     [2..3]  cumulative seq (everything up to AND INCLUDING this seq is acked)
 */

import { SoePacketType, ackAllTypeFor, ackTypeFor, reliableTypeFor } from './packet-types.js';
import { getU16BE, putU16BE } from './session.js';

/** Maximum 16-bit value — the wrap-around boundary */
const STAMP_MOD = 0x10000;

/**
 * Reconstruct a 64-bit reliable ID from a 16-bit stamp and the current
 * "expected next" 64-bit ID.
 *
 * Mirrors `UdpReliableChannel::GetReliableIncomingId` (UdpLibrary.cpp). Strategy:
 * round the candidate to the nearest 16-bit window around `expectedId`.
 */
export function reconstructReliableId(stamp16: number, expectedId: number): number {
  const stamp = stamp16 & 0xffff;
  const baseHigh = Math.floor(expectedId / STAMP_MOD) * STAMP_MOD;
  // Try -1, 0, +1 windows; pick the one with smallest |diff| to expectedId
  let best = baseHigh + stamp;
  let bestDist = Math.abs(best - expectedId);
  for (const delta of [-STAMP_MOD, STAMP_MOD]) {
    const candidate = baseHigh + stamp + delta;
    if (candidate < 0) continue;
    const dist = Math.abs(candidate - expectedId);
    if (dist < bestDist) {
      best = candidate;
      bestDist = dist;
    }
  }
  return best;
}

/**
 * Build a Reliable1 packet header given a sequence number and payload.
 * Returns the full [00 09][seq BE u16][payload] buffer.
 *
 * If the payload is too large to fit in one packet (caller's responsibility
 * to know `maxRawPacketSize`), use `buildFragmentPackets` instead.
 */
export function buildReliablePacket(
  channel: 0 | 1 | 2 | 3,
  seq: number,
  payload: Uint8Array,
): Uint8Array {
  const out = new Uint8Array(4 + payload.length);
  out[0] = 0x00;
  out[1] = reliableTypeFor(channel);
  putU16BE(out, 2, seq & 0xffff);
  out.set(payload, 4);
  return out;
}

/**
 * Build an Ack1 packet for a single reliable seq.
 *
 * Layout: [00 11][seq BE u16] — 4 bytes total.
 */
export function buildAckPacket(channel: 0 | 1 | 2 | 3, seq: number): Uint8Array {
  const out = new Uint8Array(4);
  out[0] = 0x00;
  out[1] = ackTypeFor(channel);
  putU16BE(out, 2, seq & 0xffff);
  return out;
}

/**
 * Build an AckAll1 packet for a cumulative seq.
 *
 * Layout: [00 15][seq BE u16] — 4 bytes total. Acknowledges every reliable
 * packet up to and INCLUDING this seq.
 */
export function buildAckAllPacket(channel: 0 | 1 | 2 | 3, seq: number): Uint8Array {
  const out = new Uint8Array(4);
  out[0] = 0x00;
  out[1] = ackAllTypeFor(channel);
  putU16BE(out, 2, seq & 0xffff);
  return out;
}

/**
 * Outgoing reliable sequence tracker. Stores not-yet-acked packets so they
 * can be resent if no ACK arrives in time.
 */
export interface PendingPacket {
  seq: number;
  /** The fully-cooked packet bytes (post-encryption + CRC) ready to retransmit */
  cookedBytes: Uint8Array;
  /** When the packet was first sent (ms since epoch) */
  sentAt: number;
}

export class OutgoingSequence {
  private nextSeq = 0;
  private pending: Map<number, PendingPacket> = new Map();

  /** Allocate the next outgoing seq. Wraps at 0x10000. */
  allocate(): number {
    const seq = this.nextSeq;
    this.nextSeq = (this.nextSeq + 1) & 0xffffffff;
    return seq;
  }

  /** Remember a packet for retransmission. */
  track(seq: number, cookedBytes: Uint8Array, sentAt: number): void {
    this.pending.set(seq, { seq, cookedBytes, sentAt });
  }

  /** Mark a single seq as acked (remove from pending) */
  ack(seq: number): void {
    this.pending.delete(seq);
  }

  /** Mark every seq <= cumulative as acked. */
  ackAll(cumulativeSeq: number): void {
    for (const seq of [...this.pending.keys()]) {
      if (seq <= cumulativeSeq) this.pending.delete(seq);
    }
  }

  /** All currently-unacked packets older than `olderThanMs`. */
  needingResend(now: number, olderThanMs: number): PendingPacket[] {
    const out: PendingPacket[] = [];
    for (const p of this.pending.values()) {
      if (now - p.sentAt >= olderThanMs) out.push(p);
    }
    return out;
  }

  get pendingCount(): number {
    return this.pending.size;
  }
}

/**
 * Incoming reliable sequence tracker. Decides when to fire an Ack vs AckAll
 * and which seq to put in it.
 *
 * Per UdpLibrary.cpp lines 3559-3573: after each reliable packet is received,
 * we either:
 *   - send an AckAll1 if `mReliableIncomingId > reliableId` (the channel
 *     advanced because the new packet was the one we were waiting for, and
 *     possibly some buffered later packets cleared too); OR
 *   - send an Ack1 for the specific seq if it was out-of-order (server still
 *     wants the missing ones).
 *
 * For the MVP we don't bother with out-of-order buffering — we just emit an
 * AckAll for every in-order packet (since channel 0 traffic from LoginServer
 * is small and serialized).
 */
export class IncomingSequence {
  /** The next expected reliable ID (full 64-bit form). 0 initially. */
  private expectedId = 0;
  /** Set of seq IDs we've received but couldn't process yet (out-of-order). */
  private buffered: Map<number, Uint8Array> = new Map();

  /** Reconstruct the 64-bit ID for a wire 16-bit stamp. */
  fullIdFor(stamp16: number): number {
    return reconstructReliableId(stamp16, this.expectedId);
  }

  /**
   * Result kind returned from receive():
   *   - 'in-order': we should process `payload` now and reply with AckAll(seq)
   *   - 'out-of-order': we should reply with Ack(seq) only (we buffered the payload)
   *   - 'duplicate': drop this packet, but still reply with AckAll(expectedId-1)
   */
  receive(stamp16: number, payload: Uint8Array): ReliableReceiveResult {
    const fullId = this.fullIdFor(stamp16);
    if (fullId < this.expectedId) {
      // Duplicate / late retransmit — server already saw this seq from us
      const cum = this.expectedId === 0 ? 0 : this.expectedId - 1;
      return {
        kind: 'duplicate',
        seq: stamp16,
        ackAllSeq: cum & 0xffff,
        payload: null,
      };
    }
    if (fullId > this.expectedId) {
      // Out of order — buffer it; ack only the specific seq
      this.buffered.set(fullId, payload);
      return { kind: 'out-of-order', seq: stamp16, payload: null };
    }
    // In order: deliver this payload, then advance through any buffered seqs
    const deliveries: Array<{ fullId: number; payload: Uint8Array }> = [{ fullId, payload }];
    this.expectedId++;
    while (this.buffered.has(this.expectedId)) {
      const buffered = this.buffered.get(this.expectedId);
      if (buffered === undefined) break;
      deliveries.push({ fullId: this.expectedId, payload: buffered });
      this.buffered.delete(this.expectedId);
      this.expectedId++;
    }
    // Cumulative ack covers everything up to and including (expectedId - 1)
    const cum = (this.expectedId - 1) & 0xffff;
    return { kind: 'in-order', seq: stamp16, ackAllSeq: cum, deliveries };
  }

  get expectedNext(): number {
    return this.expectedId;
  }

  /**
   * Skip ahead to the given seq value. Used for testing with a captured packet
   * that has a non-zero starting seq, where the prior seqs weren't captured.
   */
  testForceExpectedId(value: number): void {
    this.expectedId = value;
  }
}

export type ReliableReceiveResult =
  | {
      kind: 'in-order';
      /** Original 16-bit stamp from the wire (low 16 bits of full ID) */
      seq: number;
      /** Cumulative seq to AckAll (16-bit) */
      ackAllSeq: number;
      /** All the payloads now ready for the next pipeline stage (one or more, in order) */
      deliveries: Array<{ fullId: number; payload: Uint8Array }>;
    }
  | {
      kind: 'out-of-order';
      seq: number;
      payload: null;
    }
  | {
      kind: 'duplicate';
      seq: number;
      ackAllSeq: number;
      payload: null;
    };

/**
 * Parse an Ack/AckAll packet: returns { seq } as a 16-bit stamp value.
 *
 * Both Ack1 and AckAll1 have the same layout — caller checks the opcode.
 */
export function parseAckSeq(packet: Uint8Array): number {
  if (packet.length < 4) {
    throw new Error(`Ack/AckAll packet too short: ${packet.length}`);
  }
  return getU16BE(packet, 2);
}

/**
 * Parse a Reliable1 packet header. Returns the seq stamp + the app payload.
 *
 * Caller has already verified opcode (00 09).
 */
export function parseReliablePacket(packet: Uint8Array): { seq: number; payload: Uint8Array } {
  if (packet.length < 4) {
    throw new Error(`Reliable packet too short: ${packet.length}`);
  }
  const seq = getU16BE(packet, 2);
  const payload = packet.subarray(4);
  return { seq, payload };
}

/** Re-export the multi-packet type for convenience in connection.ts */
export { SoePacketType };
