/**
 * Offline SOE decoder — feed raw captured datagrams (from `readRawCapture`)
 * through the SOE pipeline as if they had just arrived on a live socket,
 * yielding the cooked app payloads plus GameNetworkMessage decodes.
 *
 * Used by `bin/swg-ts-cli decode-raw`. Stateless across the public API; the
 * `Driver` class encapsulates the per-direction sequence/fragment state.
 *
 * Bidirectional:
 *   - 'recv' frames are server→client, decoded with the negotiated params.
 *   - 'send' frames are client→server. The XOR + UserSupplied encryption is
 *     symmetric (it uses the same encryptCode on both sides), so we run
 *     identical `reverseEncryption` + CRC verify, then defragment + dispatch.
 *
 * Each direction maintains its OWN reliable sequence + fragment buffer
 * because the seq spaces are independent.
 *
 * Handshake packets (cUdpPacketConnect=1 / cUdpPacketConfirm=2) are NOT
 * encrypted and have no CRC trailer, so the decoder special-cases them.
 *
 * Errors decoding a single frame don't halt the driver — they're surfaced as
 * `error` entries on the result alongside the (possibly empty) `appPayloads`.
 */

import { verifyCrc } from '../crc/crc32.js';
import { parseHeader } from '../messages/base.js';
import type { GameNetworkMessage } from '../messages/interface.js';
import { messageRegistry } from '../messages/registry.js';
import { reverseEncryption } from './encrypt.js';
import { FragmentBuffer } from './fragment.js';
import { unpackGroup, unpackMulti } from './multipacket.js';
import {
  SoePacketType,
  isAck,
  isAckAll,
  isFragment,
  isReliable,
} from './packet-types.js';
import { IncomingSequence, parseAckSeq, parseReliablePacket } from './reliable.js';
import { getU32BE, parseSessionResponse } from './session.js';
import type { RawCaptureFrame, RawCaptureSession } from './raw-capture-io.js';

/** Description of a single SOE control / data packet identified within a frame. */
export type DecodedPacketDescription =
  | { kind: 'session_request'; protocolVersion: number; connectionCode: number; maxRawPacketSize: number }
  | { kind: 'session_response'; encryptCode: number; connectionCode: number; crcBytes: number }
  | { kind: 'keep_alive' }
  | { kind: 'terminate' }
  | { kind: 'port_alive' }
  | { kind: 'clock_sync' }
  | { kind: 'clock_reflect' }
  | { kind: 'ack'; channel: number; seq: number }
  | { kind: 'ack_all'; channel: number; seq: number }
  | { kind: 'reliable'; channel: number; seq: number }
  | { kind: 'fragment'; channel: number; seq: number }
  | { kind: 'multi'; subCount: number }
  | { kind: 'group'; subCount: number }
  | { kind: 'unknown_opcode'; opcode: number }
  | { kind: 'raw_app' };

/** One application payload decoded from a frame's reliable channel. */
export interface DecodedAppMessage {
  /** Same direction as the parent frame. */
  direction: 'send' | 'recv';
  /** Raw GameNetworkMessage wire bytes ([u16 varCount][u32 typeCrc][payload]). */
  bytes: Uint8Array;
  /** Cooked CRC (parsed). */
  typeCrc: number;
  /** Message name from the registry, or `<crc:0x...>` if unknown. */
  messageName: string;
  /** Decoded message instance, if the registry knew the CRC and decode succeeded. */
  decoded: GameNetworkMessage | null;
  /** If the registry didn't have a decoder for this CRC. */
  unknownCrc?: true;
  /** If decode threw. */
  decodeError?: string;
}

/** Per-frame decode result. */
export interface DecodedFrame {
  /** Source frame the description came from. */
  frame: RawCaptureFrame;
  /** Frame index within the input list (for log correlation). */
  index: number;
  /** Wall-clock delta from the first frame in millis. */
  deltaMs: number;
  /** What kind of SOE packet was identified (or `unknown_opcode`). */
  description: DecodedPacketDescription;
  /** App-level messages that arrived in this frame (one or more, in order). */
  appPayloads: DecodedAppMessage[];
  /** Fatal decoder error for this frame, if any. */
  error: string | null;
}

/**
 * Stateful driver that consumes captured frames in order, maintaining the
 * SOE sequence + fragment state per direction. Call `feed(frame, idx)` for
 * each frame; you get back the decoded description + any cooked app payloads
 * unwrapped from this frame.
 *
 * Session parameters must be provided up-front (via `session: ...` from the
 * capture file). The driver will still accept a live `Confirm` frame and
 * update `session` accordingly — useful for captures that contain the
 * handshake without an explicit `session` line.
 */
export class OfflineSoeDriver {
  /** Negotiated session parameters. May be updated on a Confirm packet. */
  session: RawCaptureSession | null;

  /** Per-direction reliable channel state (channel 0 only; SWG never uses 1-3). */
  private readonly recvIncoming = new IncomingSequence();
  private readonly sendIncoming = new IncomingSequence();
  /** Per-direction fragment reassembly buffers. */
  private readonly recvFragments = new FragmentBuffer();
  private readonly sendFragments = new FragmentBuffer();

  /** First-frame timestamp for `deltaMs` computation. */
  private firstTs: number | null = null;

  /**
   * Tracks whether we've seen ANY reliable packet in each direction yet. The
   * first reliable seq encountered after a fresh start auto-bumps
   * `IncomingSequence.expectedId` so captures that don't include seq 0 still
   * deliver their app payloads. (Real captures may start mid-session, e.g.
   * tcpdump from a partial recording.)
   */
  private recvSawReliable = false;
  private sendSawReliable = false;

  constructor(initialSession: RawCaptureSession | null) {
    this.session = initialSession;
  }

  /**
   * Decode one frame. Returns a `DecodedFrame` describing what was inside.
   */
  feed(frame: RawCaptureFrame, index: number): DecodedFrame {
    if (this.firstTs === null) this.firstTs = frame.ts;
    const deltaMs = frame.ts - this.firstTs;
    const out: DecodedFrame = {
      frame,
      index,
      deltaMs,
      description: { kind: 'raw_app' },
      appPayloads: [],
      error: null,
    };

    // Empty / 1-byte frames are degenerate
    if (frame.bytes.length < 2) {
      out.error = `frame too short (${frame.bytes.length} bytes)`;
      return out;
    }

    // ─── SessionRequest (Connect=1) ─────────────────────────────────────
    // Unencrypted, no CRC. Always client→server.
    if (frame.bytes[0] === 0 && frame.bytes[1] === SoePacketType.Connect) {
      if (frame.bytes.length >= 14) {
        out.description = {
          kind: 'session_request',
          protocolVersion: getU32BE(frame.bytes, 2),
          connectionCode: getU32BE(frame.bytes, 6),
          maxRawPacketSize: getU32BE(frame.bytes, 10),
        };
      } else {
        out.error = `Connect packet truncated (${frame.bytes.length} bytes)`;
      }
      return out;
    }

    // ─── SessionResponse (Confirm=2) ────────────────────────────────────
    // Unencrypted, no CRC. Server→client (or we synthesized one).
    if (frame.bytes[0] === 0 && frame.bytes[1] === SoePacketType.Confirm) {
      try {
        const fields = parseSessionResponse(frame.bytes);
        out.description = {
          kind: 'session_response',
          encryptCode: fields.encryptCode,
          connectionCode: fields.connectionCode,
          crcBytes: fields.crcBytes,
        };
        // Update session params if we didn't have them
        if (this.session === null) {
          this.session = {
            ts: frame.ts,
            encryptCode: fields.encryptCode,
            connectionCode: fields.connectionCode,
            crcBytes: fields.crcBytes,
            encryptMethods: fields.encryptMethods,
            negotiatedMaxRawPacketSize: fields.maxRawPacketSize,
          };
        }
      } catch (err) {
        out.error = `parseSessionResponse: ${err instanceof Error ? err.message : String(err)}`;
      }
      return out;
    }

    // ─── Encrypted data path ────────────────────────────────────────────
    if (this.session === null) {
      out.error = 'no session params available — cannot decrypt';
      return out;
    }
    const session = this.session;

    let cooked: Uint8Array;
    try {
      if (!verifyCrc(frame.bytes, session.encryptCode, session.crcBytes)) {
        out.error = 'CRC mismatch';
        return out;
      }
      const body = frame.bytes.subarray(0, frame.bytes.length - session.crcBytes);
      cooked = reverseEncryption(body, session.encryptMethods, session.encryptCode);
    } catch (err) {
      out.error = `decrypt: ${err instanceof Error ? err.message : String(err)}`;
      return out;
    }

    if (cooked.length < 2 || cooked[0] !== 0) {
      // Could be raw app data; deliver as-is.
      this.appendAppPayload(frame.direction, cooked, out);
      return out;
    }
    const opcode = cooked[1] as number;

    switch (opcode) {
      case SoePacketType.Multi: {
        const subs = unpackMulti(cooked);
        out.description = { kind: 'multi', subCount: subs.length };
        for (const sub of subs) {
          this.dispatchCooked(frame.direction, sub, out);
        }
        return out;
      }
      case SoePacketType.KeepAlive:
        out.description = { kind: 'keep_alive' };
        return out;
      case SoePacketType.Terminate:
        out.description = { kind: 'terminate' };
        return out;
      case SoePacketType.PortAlive:
        out.description = { kind: 'port_alive' };
        return out;
      case SoePacketType.ClockSync:
        out.description = { kind: 'clock_sync' };
        return out;
      case SoePacketType.ClockReflect:
        out.description = { kind: 'clock_reflect' };
        return out;
      default: {
        if (isReliable(opcode)) {
          this.consumeReliableOrFragment(frame.direction, cooked, opcode, false, out);
          return out;
        }
        if (isFragment(opcode)) {
          this.consumeReliableOrFragment(frame.direction, cooked, opcode, true, out);
          return out;
        }
        if (isAck(opcode)) {
          const channel = opcode - SoePacketType.Ack1;
          out.description = { kind: 'ack', channel, seq: parseAckSeq(cooked) };
          return out;
        }
        if (isAckAll(opcode)) {
          const channel = opcode - SoePacketType.AckAll1;
          out.description = { kind: 'ack_all', channel, seq: parseAckSeq(cooked) };
          return out;
        }
        out.description = { kind: 'unknown_opcode', opcode };
        return out;
      }
    }
  }

  /** Dispatch a cooked sub-packet (e.g. from inside a Multi). */
  private dispatchCooked(
    direction: 'send' | 'recv',
    cooked: Uint8Array,
    out: DecodedFrame,
  ): void {
    if (cooked.length < 2 || cooked[0] !== 0) {
      this.appendAppPayload(direction, cooked, out);
      return;
    }
    const opcode = cooked[1] as number;
    if (isReliable(opcode)) {
      this.consumeReliableOrFragment(direction, cooked, opcode, false, out);
      return;
    }
    if (isFragment(opcode)) {
      this.consumeReliableOrFragment(direction, cooked, opcode, true, out);
      return;
    }
    // Inside-multi control packets are rare but possible; we silently swallow.
  }

  private consumeReliableOrFragment(
    direction: 'send' | 'recv',
    cooked: Uint8Array,
    opcode: number,
    isFrag: boolean,
    out: DecodedFrame,
  ): void {
    const channel = isFrag ? opcode - SoePacketType.Fragment1 : opcode - SoePacketType.Reliable1;
    const { seq, payload } = parseReliablePacket(cooked);
    out.description = isFrag
      ? { kind: 'fragment', channel, seq }
      : { kind: 'reliable', channel, seq };

    if (channel !== 0) return; // SWG never uses 1-3

    const seqState = direction === 'send' ? this.sendIncoming : this.recvIncoming;
    const fragState = direction === 'send' ? this.sendFragments : this.recvFragments;

    // If this is the first reliable packet we've seen in this direction and
    // its seq isn't 0, fast-forward expectedId so the offline decoder
    // doesn't silently swallow it as out-of-order. This makes captures that
    // start mid-session (no seq 0) deliver their payloads.
    const isFirst = direction === 'send' ? !this.sendSawReliable : !this.recvSawReliable;
    if (isFirst) {
      if (direction === 'send') this.sendSawReliable = true;
      else this.recvSawReliable = true;
      if (seq !== 0 && seqState.expectedNext === 0) {
        seqState.testForceExpectedId(seq);
      }
    }

    const result = seqState.receive(seq, payload);
    if (result.kind !== 'in-order') {
      // out-of-order or duplicate — for offline decoding we drop. The live
      // pipeline would Ack and (eventually) deliver, but offline we don't
      // emit per-frame anything for these.
      return;
    }
    for (const d of result.deliveries) {
      if (isFrag) {
        const finished = fragState.addChunk(d.payload);
        if (finished !== null) {
          this.deliverApp(direction, finished, out);
        }
      } else if (fragState.inProgress) {
        // Same caveat as the live path — bug if non-fragment arrives mid-frag
        fragState.reset();
        this.deliverApp(direction, d.payload, out);
      } else {
        this.deliverApp(direction, d.payload, out);
      }
    }
  }

  private deliverApp(direction: 'send' | 'recv', payload: Uint8Array, out: DecodedFrame): void {
    // Multi / Group unwrap (same as deliverFromReliable in connection.ts)
    if (payload.length >= 2 && payload[0] === 0 && payload[1] === SoePacketType.Multi) {
      const subs = unpackMulti(payload);
      for (const sub of subs) {
        this.deliverApp(direction, sub, out);
      }
      return;
    }
    if (payload.length >= 2 && payload[0] === 0 && payload[1] === SoePacketType.Group) {
      const subs = unpackGroup(payload);
      for (const sub of subs) {
        this.appendAppPayload(direction, sub, out);
      }
      return;
    }
    this.appendAppPayload(direction, payload, out);
  }

  private appendAppPayload(
    direction: 'send' | 'recv',
    payload: Uint8Array,
    out: DecodedFrame,
  ): void {
    let typeCrc = 0;
    let messageName = '<header-decode-failed>';
    let decoded: GameNetworkMessage | null = null;
    let decodeError: string | undefined;
    let unknownCrc = false;
    try {
      const parsed = parseHeader(payload);
      typeCrc = parsed.typeCrc;
      const decoder = messageRegistry.getByCrc(typeCrc);
      if (decoder === undefined) {
        unknownCrc = true;
        messageName = `<crc:0x${typeCrc.toString(16).padStart(8, '0')}>`;
      } else {
        messageName = decoder.messageName;
        try {
          decoded = decoder.decodePayload(parsed.payload);
        } catch (err) {
          decodeError = err instanceof Error ? err.message : String(err);
        }
      }
    } catch (err) {
      decodeError = err instanceof Error ? err.message : String(err);
    }
    const app: DecodedAppMessage = {
      direction,
      bytes: payload,
      typeCrc,
      messageName,
      decoded,
      ...(unknownCrc ? { unknownCrc: true as const } : {}),
      ...(decodeError !== undefined ? { decodeError } : {}),
    };
    out.appPayloads.push(app);
  }
}

/**
 * Convenience: decode an entire frame stream in one call, returning an array
 * of `DecodedFrame` in the same order. Equivalent to constructing an
 * `OfflineSoeDriver` and calling `feed(...)` per frame.
 *
 * Side-effect-free: takes no socket, doesn't mutate process state.
 */
export function decodeRawFrames(
  frames: readonly RawCaptureFrame[],
  session: RawCaptureSession | null,
): DecodedFrame[] {
  const driver = new OfflineSoeDriver(session);
  return frames.map((f, i) => driver.feed(f, i));
}
