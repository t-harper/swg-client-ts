/**
 * Concrete SoeConnection — one per UDP socket. Implements ISoeConnection.
 *
 * Pipeline (send):
 *   sendApp(payload)
 *     → wrap in Reliable1 with next seq
 *     → applyEncryption (UserSupplied + XOR, per negotiated methods)
 *     → appendCrc (per negotiated crcBytes)
 *     → socket.send
 *     → store in OutgoingSequence for resend if no Ack
 *
 * Pipeline (receive):
 *   socket.message(datagram)
 *     → verifyCrc + strip
 *     → if buf[1] is a SOE opcode we recognize → dispatch:
 *         - Reliable/Fragment → reverseEncryption → parseReliablePacket
 *             → IncomingSequence.receive
 *             → for each in-order delivery: FragmentBuffer if fragment, else
 *               unpackMulti if Multi, else direct call to onAppMessage
 *             → send AckAll back
 *         - Ack / AckAll → mark outgoing as confirmed
 *         - KeepAlive → ignore
 *         - Terminate → fire 'disconnected' event, close
 *
 * The receive callback (onAppMessage) is invoked with the "cooked" app payload —
 * one GameNetworkMessage's worth of bytes — not framed with reliable headers
 * or fragment headers.
 */

import { type WriteStream, createWriteStream } from 'node:fs';
import { type Socket, createSocket } from 'node:dgram';
import { appendCrc, verifyCrc } from '../crc/crc32.js';
import { EncryptMethod } from '../types.js';
import type { EncryptionParams } from '../types.js';
import { applyEncryption, reverseEncryption } from './encrypt.js';
import { FragmentBuffer, buildFragmentPackets } from './fragment.js';
import type {
  AppMessageHandler,
  ConnectionEvent,
  ConnectionStateHandler,
  ISoeConnection,
  RawCaptureOptions,
  SoeConnectionOptions,
} from './interface.js';
import { unpackGroup, unpackMulti } from './multipacket.js';
import {
  SoePacketType,
  channelOf,
  isAck,
  isAckAll,
  isFragment,
  isReliable,
} from './packet-types.js';
import {
  frameToJson,
  metaToJson,
  sessionToJson,
} from './raw-capture-io.js';
import {
  IncomingSequence,
  OutgoingSequence,
  buildAckAllPacket,
  buildReliablePacket,
  parseAckSeq,
  parseReliablePacket,
} from './reliable.js';
import {
  buildKeepAlivePacket,
  buildSessionRequest,
  buildTerminatePacket,
  parseSessionResponse,
} from './session.js';

const PROTOCOL_VERSION = 2;
const DEFAULT_MAX_RAW = 496;
const DEFAULT_KEEPALIVE_MS = 5000;
const SESSION_RETRIES = 5;
const SESSION_RETRY_MS = 500;

/**
 * The state of a connection.
 */
type ConnectionStatus =
  | { kind: 'idle' }
  | { kind: 'negotiating' }
  | { kind: 'connected'; params: EncryptionParams }
  | { kind: 'disconnected'; reason: string };

/**
 * Concrete SOE UDP connection.
 *
 * Public surface matches `ISoeConnection` exactly so Stream B/C can program
 * against the interface only.
 */
export class SoeConnection implements ISoeConnection {
  private readonly endpoint: { host: string; port: number };
  private readonly maxRawPacketSize: number;
  private readonly connectionCode: number;
  private readonly keepAliveMs: number;
  private readonly onAppMessage: AppMessageHandler;
  private readonly onEvent: ConnectionStateHandler | undefined;

  private socket: Socket | null = null;
  private status: ConnectionStatus = { kind: 'idle' };

  // Reliable channel 0 state (the only channel we use)
  private readonly outgoingCh0 = new OutgoingSequence();
  private readonly incomingCh0 = new IncomingSequence();
  private readonly fragmentCh0 = new FragmentBuffer();

  private keepAliveTimer: NodeJS.Timeout | null = null;

  /** Internal one-shot listeners (drained on next emit()). Used by connect(). */
  private readonly oneShotListeners: ConnectionStateHandler[] = [];

  /** Raw-capture tee state. See `SoeConnectionOptions.rawCapture`. */
  private readonly rawCaptureOptions: RawCaptureOptions | undefined;
  private rawCaptureStream: WriteStream | null = null;
  private rawCaptureSessionWritten = false;

  constructor(options: SoeConnectionOptions) {
    this.endpoint = options.endpoint;
    this.maxRawPacketSize = options.maxRawPacketSize ?? DEFAULT_MAX_RAW;
    this.connectionCode = options.connectionCode ?? randomU32();
    this.keepAliveMs = options.keepAliveMs ?? DEFAULT_KEEPALIVE_MS;
    this.onAppMessage = options.onAppMessage;
    this.onEvent = options.onEvent;
    this.rawCaptureOptions = options.rawCapture;
    if (this.rawCaptureOptions !== undefined) {
      this.openRawCapture(this.rawCaptureOptions);
    }
  }

  get isConnected(): boolean {
    return this.status.kind === 'connected';
  }

  get params(): EncryptionParams | undefined {
    return this.status.kind === 'connected' ? this.status.params : undefined;
  }

  /**
   * Send SessionRequest and wait for SessionResponse. Resolves with the
   * negotiated params. Retries up to SESSION_RETRIES times with SESSION_RETRY_MS
   * between attempts.
   */
  async connect(): Promise<EncryptionParams> {
    if (this.status.kind === 'connected') return this.status.params;
    if (this.status.kind === 'negotiating') {
      throw new Error('SoeConnection.connect() already in progress');
    }
    this.status = { kind: 'negotiating' };

    // Open the socket
    this.socket = createSocket('udp4');
    this.attachSocketHandlers();
    await new Promise<void>((resolve, reject) => {
      // The socket doesn't strictly need bind() — sending will auto-bind to an
      // ephemeral port — but binding explicitly gives us a 'listening' event.
      const sock = this.socket;
      if (sock === null) {
        reject(new Error('socket vanished'));
        return;
      }
      sock.once('error', reject);
      sock.bind(0, () => {
        sock.removeListener('error', reject);
        resolve();
      });
    });

    const sessionRequest = buildSessionRequest({
      protocolVersion: PROTOCOL_VERSION,
      connectionCode: this.connectionCode,
      maxRawPacketSize: this.maxRawPacketSize,
    });

    return new Promise<EncryptionParams>((resolve, reject) => {
      let attempts = 0;
      let timer: NodeJS.Timeout | null = null;
      const tryOnce = (): void => {
        if (this.status.kind !== 'negotiating') return; // already resolved or failed
        if (attempts >= SESSION_RETRIES) {
          this.status = { kind: 'disconnected', reason: 'session_request_timeout' };
          this.cleanup();
          reject(new Error(`SessionRequest timed out after ${SESSION_RETRIES} attempts`));
          return;
        }
        attempts++;
        this.rawSend(sessionRequest).catch((err) => reject(err));
        timer = setTimeout(tryOnce, SESSION_RETRY_MS);
      };

      this.oneShotListeners.push((event) => {
        if (event.kind === 'session_negotiated') {
          if (timer !== null) clearTimeout(timer);
          this.startKeepAlive();
          resolve(event.params);
        } else if (event.kind === 'disconnected' || event.kind === 'error') {
          if (timer !== null) clearTimeout(timer);
          reject(event.kind === 'error' ? event.error : new Error(event.reason));
        }
      });

      tryOnce();
    });
  }

  /**
   * Send an application-level payload. Wraps in Reliable1, encrypts, CRCs, sends.
   *
   * If the payload exceeds `maxDataBytesForFragment(params)` it is automatically
   * split across multiple Fragment1 packets (UdpLibrary.cpp:3173-3220). Each
   * fragment is its own reliable packet with its own seq, independently encrypted
   * and CRCd, and tracked separately by `outgoingCh0` so re-send works per-packet.
   *
   * Small sends (the typical < 200 byte case) take the unchanged fast path —
   * one reliable packet, no fragmentation involved.
   */
  sendApp(payload: Uint8Array): void {
    if (this.status.kind !== 'connected') {
      throw new Error('sendApp: not connected');
    }
    const params = this.status.params;
    const maxDataBytes = maxDataBytesForFragment(params);

    // Fast path: the unencrypted payload fits in a single reliable packet.
    // The C++ uses the same comparison (payload size vs mMaxDataBytes) before
    // deciding to fragment; only when it doesn't fit do we walk the fragment path.
    if (payload.length <= maxDataBytes) {
      const seq = this.outgoingCh0.allocate();
      const reliablePacket = buildReliablePacket(0, seq, payload);
      const cooked = this.cookOutgoing(reliablePacket, params);
      this.outgoingCh0.track(seq, cooked, Date.now());
      void this.rawSend(cooked);
      return;
    }

    // Fragment path: split the unencrypted payload across N Fragment1 packets.
    // Fragmentation happens BEFORE encryption (UdpLibrary.cpp:3347-3351 builds
    // the fragment packet, then PhysicalSend encrypts the whole thing at 2455).
    const fragments = buildFragmentPackets(
      0,
      payload,
      () => this.outgoingCh0.allocate(),
      maxDataBytes,
    );
    const now = Date.now();
    for (const fragment of fragments) {
      const seq = readReliableSeq(fragment);
      const cooked = this.cookOutgoing(fragment, params);
      this.outgoingCh0.track(seq, cooked, now);
      void this.rawSend(cooked);
    }
  }

  async disconnect(): Promise<void> {
    if (this.status.kind === 'connected') {
      try {
        const terminate = buildTerminatePacket(this.connectionCode);
        const cooked = this.cookOutgoing(terminate, this.status.params);
        await this.rawSend(cooked);
      } catch {
        // ignore — we're tearing down anyway
      }
    }
    this.status = { kind: 'disconnected', reason: 'client_initiated' };
    this.cleanup();
  }

  // ────────────────────────────────────────────────────────────────────────
  // Public test hooks — feed bytes directly into the receive pipeline without
  // a real UDP socket. Stream A's end-state test uses these.
  // ────────────────────────────────────────────────────────────────────────

  /**
   * Inject a "datagram" into the receive pipeline as if it had just arrived on
   * the socket. Used by the unit-test path that feeds the captured fixtures
   * through without doing real UDP.
   *
   * Throws if the connection is not connected (we need negotiated params first).
   * Use `injectSessionResponse()` for the handshake step.
   */
  testInjectDatagram(bytes: Uint8Array): void {
    this.captureFrame('recv', bytes);
    this.handleDatagram(bytes);
  }

  /**
   * Override the underlying UDP send for tests. If set, `rawSend` invokes this
   * instead of the dgram socket. The function may be sync or return a promise.
   */
  testSendOverride: ((bytes: Uint8Array) => void | Promise<void>) | null = null;

  /**
   * Skip the incoming-channel-0 expectedId forward. Used in tests where the
   * captured fixture's reliable seq isn't 0 (and the prior packets weren't
   * captured), so we need to advance state to accept the captured seq in-order.
   */
  testForceIncomingExpectedId(value: number): void {
    this.incomingCh0.testForceExpectedId(value);
  }

  /**
   * Feed a SessionResponse into the negotiation flow synchronously (skipping
   * any real UDP I/O). After this returns, `isConnected` will be true.
   */
  testInjectSessionResponse(bytes: Uint8Array): EncryptionParams {
    const fields = parseSessionResponse(bytes);
    if (fields.connectionCode !== this.connectionCode) {
      throw new Error('SessionResponse connectionCode mismatch (in test)');
    }
    const params: EncryptionParams = {
      encryptCode: fields.encryptCode,
      connectionCode: fields.connectionCode,
      crcBytes: fields.crcBytes,
      encryptMethods: fields.encryptMethods,
      maxRawPacketSize: Math.min(fields.maxRawPacketSize, this.maxRawPacketSize),
    };
    this.status = { kind: 'connected', params };
    this.captureSession(params);
    this.emit({ kind: 'session_negotiated', params });
    return params;
  }

  // ────────────────────────────────────────────────────────────────────────
  // Internal: cook + uncook (encryption + CRC)
  // ────────────────────────────────────────────────────────────────────────

  /**
   * Apply the encryption + CRC pipeline to outgoing bytes.
   * `bytes` must already include the SOE [opcode, opcode] header.
   */
  private cookOutgoing(bytes: Uint8Array, params: EncryptionParams): Uint8Array {
    const encrypted = applyEncryption(bytes, params.encryptMethods, params.encryptCode);
    return appendCrc(encrypted, params.encryptCode, params.crcBytes);
  }

  /**
   * Strip CRC + reverse encryption on incoming bytes. Returns the cooked
   * (decrypted) packet starting with [00 opcode] or throws if the CRC fails.
   */
  private uncookIncoming(bytes: Uint8Array, params: EncryptionParams): Uint8Array {
    if (!verifyCrc(bytes, params.encryptCode, params.crcBytes)) {
      throw new Error('CRC mismatch on incoming packet');
    }
    const body = bytes.subarray(0, bytes.length - params.crcBytes);
    return reverseEncryption(body, params.encryptMethods, params.encryptCode);
  }

  // ────────────────────────────────────────────────────────────────────────
  // Socket I/O
  // ────────────────────────────────────────────────────────────────────────

  private async rawSend(bytes: Uint8Array): Promise<void> {
    this.captureFrame('send', bytes);
    if (this.testSendOverride !== null) {
      await this.testSendOverride(bytes);
      return;
    }
    const sock = this.socket;
    if (sock === null) {
      throw new Error('rawSend: socket is closed');
    }
    return new Promise<void>((resolve, reject) => {
      sock.send(
        Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength),
        this.endpoint.port,
        this.endpoint.host,
        (err) => (err ? reject(err) : resolve()),
      );
    });
  }

  private attachSocketHandlers(): void {
    const sock = this.socket;
    if (sock === null) return;
    sock.on('message', (msg) => {
      const datagram = new Uint8Array(msg.buffer, msg.byteOffset, msg.byteLength);
      // Tee BEFORE any decrypt/CRC strip so the capture preserves the exact
      // bytes that arrived on the wire.
      this.captureFrame('recv', datagram);
      try {
        this.handleDatagram(datagram);
      } catch (err) {
        this.emit({ kind: 'error', error: err instanceof Error ? err : new Error(String(err)) });
      }
    });
    sock.on('error', (err) => {
      this.emit({ kind: 'error', error: err });
    });
  }

  /**
   * Top-level datagram handler. Demultiplexes by opcode and feeds the right
   * subsystem.
   */
  private handleDatagram(datagram: Uint8Array): void {
    // SessionResponse special case (no encryption, no CRC)
    if (
      this.status.kind === 'negotiating' &&
      datagram.length >= 2 &&
      datagram[0] === 0 &&
      datagram[1] === SoePacketType.Confirm
    ) {
      try {
        const fields = parseSessionResponse(datagram);
        if (fields.connectionCode !== this.connectionCode) {
          // Stale negotiation echo — ignore
          return;
        }
        const params: EncryptionParams = {
          encryptCode: fields.encryptCode,
          connectionCode: fields.connectionCode,
          crcBytes: fields.crcBytes,
          encryptMethods: fields.encryptMethods,
          maxRawPacketSize: Math.min(fields.maxRawPacketSize, this.maxRawPacketSize),
        };
        this.status = { kind: 'connected', params };
        this.captureSession(params);
        this.emit({ kind: 'session_negotiated', params });
      } catch (err) {
        this.emit({
          kind: 'corrupt_packet',
          reason: `parseSessionResponse: ${err instanceof Error ? err.message : String(err)}`,
          rawBytes: datagram,
        });
      }
      return;
    }

    if (this.status.kind !== 'connected') {
      // We're not negotiated yet but this isn't a SessionResponse — ignore
      return;
    }
    const params = this.status.params;

    let cooked: Uint8Array;
    try {
      cooked = this.uncookIncoming(datagram, params);
    } catch (err) {
      this.emit({
        kind: 'corrupt_packet',
        reason: err instanceof Error ? err.message : String(err),
        rawBytes: datagram,
      });
      return;
    }

    this.dispatchCookedPacket(cooked);
  }

  /**
   * Dispatch a fully-decrypted, CRC-stripped packet starting with [00 opcode].
   * Mirrors UdpConnection::ProcessCookedPacket (UdpLibrary.cpp line 1820).
   */
  private dispatchCookedPacket(cooked: Uint8Array): void {
    if (cooked.length < 2) {
      this.emit({ kind: 'corrupt_packet', reason: 'cooked too short', rawBytes: cooked });
      return;
    }
    if (cooked[0] !== 0) {
      // Application data starting with non-zero byte (rare; we don't use this path)
      // For SWG we send/receive only zero-prefixed SOE packets. Treat as app data.
      this.onAppMessage(cooked);
      return;
    }
    const opcode = cooked[1];
    if (opcode === undefined) return;

    switch (opcode) {
      case SoePacketType.Multi: {
        // Recursively dispatch each sub-message through this same function
        const subs = unpackMulti(cooked);
        for (const sub of subs) {
          this.dispatchCookedPacket(sub);
        }
        return;
      }
      case SoePacketType.KeepAlive:
        // Server is pinging us — no action needed (it just keeps NAT alive).
        return;
      case SoePacketType.Terminate:
        this.status = { kind: 'disconnected', reason: 'server_terminated' };
        this.emit({ kind: 'disconnected', reason: 'server_terminated' });
        this.cleanup();
        return;
      case SoePacketType.PortAlive:
      case SoePacketType.ClockSync:
      case SoePacketType.ClockReflect:
        // Not implementing clock-sync in the MVP — these are nice-to-have for
        // ping stats but the server is local and we don't need them.
        return;
      default:
        if (isReliable(opcode) || isFragment(opcode)) {
          this.handleReliableOrFragment(cooked, opcode);
          return;
        }
        if (isAck(opcode)) {
          const ch = channelOf(opcode);
          if (ch === 0) {
            const seq = parseAckSeq(cooked);
            this.outgoingCh0.ack(seq);
          }
          return;
        }
        if (isAckAll(opcode)) {
          const ch = channelOf(opcode);
          if (ch === 0) {
            const seq = parseAckSeq(cooked);
            // We need to ack-all using the FULL 64-bit id, but for the MVP
            // we just ack-all the 16-bit window since pending seqs are tiny.
            this.outgoingCh0.ackAll(seq);
          }
          return;
        }
        // Unknown opcode — log if there's an event handler, otherwise drop
        this.emit({
          kind: 'corrupt_packet',
          reason: `unknown opcode ${opcode}`,
          rawBytes: cooked,
        });
    }
  }

  private handleReliableOrFragment(cooked: Uint8Array, opcode: number): void {
    const ch = channelOf(opcode);
    if (ch !== 0) return; // we don't handle channels 1-3
    const isFrag = isFragment(opcode);
    const { seq, payload } = parseReliablePacket(cooked);
    const result = this.incomingCh0.receive(seq, payload);

    if (result.kind === 'in-order') {
      // Send AckAll back for the cumulative seq
      this.sendAckAll(result.ackAllSeq);
      // Process each delivered payload (one or more)
      for (const d of result.deliveries) {
        if (isFrag) {
          // Was this packet ALSO a fragment? Only the FIRST received-in-order
          // delivery corresponds to the current packet; the buffered ones may
          // be either Reliable or Fragment, but we don't track that. The MVP
          // serializes reliable channel 0 traffic, so this is unlikely to
          // matter — treat all in-order deliveries as fragment-or-not based on
          // the current packet's opcode. (A more complete impl would store
          // the opcode per-buffered-seq.)
          const finished = this.fragmentCh0.addChunk(d.payload);
          if (finished !== null) {
            this.deliverFromReliable(finished);
          }
        } else if (this.fragmentCh0.inProgress) {
          // A non-fragment slipping into an in-progress fragment is a bug; clear it
          this.fragmentCh0.reset();
          this.deliverFromReliable(d.payload);
        } else {
          this.deliverFromReliable(d.payload);
        }
      }
    } else if (result.kind === 'out-of-order') {
      // We need to Ack only this specific seq (server keeps trying others).
      // Since we don't track the buffered opcode either, just send a plain Ack.
      // For the MVP path this won't fire — channel 0 is well-serialized.
      const ackPkt = buildAckAllPacket(0, seq); // simpler — single seq cumulative
      this.sendCookedSoe(ackPkt);
    } else {
      // duplicate — re-send the last cumulative AckAll
      this.sendAckAll(result.ackAllSeq);
    }
  }

  /**
   * Deliver a "cooked from Reliable/Fragment" payload. This may be:
   *   - a Multi (`[00 03]`) — SOE-level coalescer, recurse on sub-msgs
   *   - a Group (`[00 19]`) — app-level bundler, each sub-msg is one
   *     GameNetworkMessage; deliver each to onAppMessage
   *   - a single GameNetworkMessage — deliver to onAppMessage directly
   *
   * A GameNetworkMessage starts with `[uint16 LE: var count]` (typically a
   * small value like 02 00 or 04 00), then `[uint32 LE: cmd CRC]`, then payload.
   * So `[00 19]` could in theory be ambiguous with a 1-var GameNetworkMessage
   * whose CRC starts with `0x19`, but in practice such a message would have
   * an absurd var count of 6400+ which never happens.
   */
  private deliverFromReliable(payload: Uint8Array): void {
    if (payload.length >= 2 && payload[0] === 0 && payload[1] === SoePacketType.Multi) {
      const subs = unpackMulti(payload);
      for (const sub of subs) {
        this.deliverFromReliable(sub);
      }
      return;
    }
    if (payload.length >= 2 && payload[0] === 0 && payload[1] === SoePacketType.Group) {
      const subs = unpackGroup(payload);
      for (const sub of subs) {
        // Each Group sub-message is a complete GameNetworkMessage; deliver directly
        this.onAppMessage(sub);
      }
      return;
    }
    // Otherwise: a single app payload. Hand to the message-layer callback.
    this.onAppMessage(payload);
  }

  private sendAckAll(seq: number): void {
    const ackPkt = buildAckAllPacket(0, seq);
    this.sendCookedSoe(ackPkt);
  }

  /**
   * Send a "control" SOE packet (Ack, AckAll, KeepAlive, etc.) — same
   * encryption + CRC pipeline as sendApp, but the packet is NOT added to the
   * reliable retransmit queue.
   */
  private sendCookedSoe(bytes: Uint8Array): void {
    if (this.status.kind !== 'connected') return;
    const cooked = this.cookOutgoing(bytes, this.status.params);
    void this.rawSend(cooked);
  }

  private startKeepAlive(): void {
    if (this.keepAliveMs <= 0) return;
    this.keepAliveTimer = setInterval(() => {
      if (this.status.kind !== 'connected') return;
      this.sendCookedSoe(buildKeepAlivePacket());
    }, this.keepAliveMs);
    // Don't keep the process alive just for the keep-alive timer
    this.keepAliveTimer.unref?.();
  }

  private cleanup(): void {
    if (this.keepAliveTimer !== null) {
      clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = null;
    }
    if (this.socket !== null) {
      try {
        this.socket.close();
      } catch {
        // ignore
      }
      this.socket = null;
    }
    this.closeRawCapture();
  }

  // ────────────────────────────────────────────────────────────────────────
  // Raw-byte capture tee (see SoeConnectionOptions.rawCapture)
  //
  // All capture writes are wrapped in try/catch so a misbehaving filesystem
  // can never abort a send/recv. We open lazily, write append-only with a
  // trailing `\n`, and rely on Node's WriteStream buffering — fsync isn't
  // needed for a debug-only tool.
  // ────────────────────────────────────────────────────────────────────────

  private openRawCapture(opts: RawCaptureOptions): void {
    try {
      this.rawCaptureStream = createWriteStream(opts.writePath, {
        encoding: 'utf8',
        flags: 'w', // truncate so re-running tests doesn't append to stale captures
      });
      const meta: Record<string, unknown> = metaToJson({
        ts: Date.now(),
        // No socket yet (we haven't bind()ed) — fill localEndpoint on
        // socket-attach if needed. For now report null.
        localEndpoint: null,
        remoteEndpoint: `${this.endpoint.host}:${this.endpoint.port}`,
        connectionCode: this.connectionCode,
        maxRawPacketSize: this.maxRawPacketSize,
        ...(opts.stage !== undefined ? { stage: opts.stage } : {}),
      });
      this.rawCaptureStream.write(`${JSON.stringify(meta)}\n`);
    } catch {
      // Capture failures must never crash the connection. Drop silently.
      this.rawCaptureStream = null;
    }
  }

  private captureSession(params: EncryptionParams): void {
    if (this.rawCaptureStream === null || this.rawCaptureSessionWritten) return;
    try {
      const line = JSON.stringify(
        sessionToJson({
          ts: Date.now(),
          encryptCode: params.encryptCode,
          connectionCode: params.connectionCode,
          crcBytes: params.crcBytes,
          encryptMethods: params.encryptMethods,
          negotiatedMaxRawPacketSize: params.maxRawPacketSize,
        }),
      );
      this.rawCaptureStream.write(`${line}\n`);
      this.rawCaptureSessionWritten = true;
    } catch {
      // ignore
    }
  }

  private captureFrame(direction: 'send' | 'recv', bytes: Uint8Array): void {
    if (this.rawCaptureStream === null) return;
    try {
      const line = JSON.stringify(frameToJson({ direction, ts: Date.now(), bytes }));
      this.rawCaptureStream.write(`${line}\n`);
    } catch {
      // ignore
    }
  }

  private closeRawCapture(): void {
    if (this.rawCaptureStream === null) return;
    try {
      this.rawCaptureStream.end();
    } catch {
      // ignore
    }
    this.rawCaptureStream = null;
  }

  private emit(event: ConnectionEvent): void {
    try {
      this.onEvent?.(event);
    } catch {
      // swallow listener errors so they don't crash the receive loop
    }
    // Drain one-shot listeners (used by connect())
    if (this.oneShotListeners.length > 0) {
      const listeners = this.oneShotListeners.splice(0);
      for (const fn of listeners) {
        try {
          fn(event);
        } catch {
          // swallow
        }
      }
    }
  }
}

function randomU32(): number {
  return Math.floor(Math.random() * 0x100000000) >>> 0;
}

/**
 * Worst-case expansion (in bytes) the encryption stack may add to an
 * unencrypted reliable payload. Mirrors `mEncryptExpansionBytes` in
 * UdpLibrary.cpp:2808-2867 — `cEncryptMethodUserSupplied` adds the configured
 * `userSuppliedEncryptExpansionBytes` (always 1 for SWG; see
 * `sharedNetwork/.../Service.cpp:113` and `Connection.cpp:220`); the other
 * methods add 0.
 *
 * We use this to budget per-fragment data so the cooked datagram never
 * overflows `maxRawPacketSize` even when zlib decides not to shrink.
 */
function encryptExpansionFor(methods: ReadonlyArray<EncryptMethod>): number {
  let total = 0;
  for (const m of methods) {
    if (m === EncryptMethod.UserSupplied || m === EncryptMethod.UserSupplied2) {
      total += 1;
    }
  }
  return total;
}

/**
 * Max payload data bytes per reliable/fragment packet for a given session.
 * Mirrors `mMaxDataBytes = fragmentSize - cUdpPacketReliableSize - crcBytes -
 * mEncryptExpansionBytes` (UdpLibrary.cpp:2938). For SWG defaults
 * (maxRawPacketSize=496, crcBytes=2, UserSupplied+Xor expansion=1) this is 489.
 */
function maxDataBytesForFragment(params: EncryptionParams): number {
  const RELIABLE_HEADER = 4; // [opcode u8 x2][seq BE u16]
  return (
    params.maxRawPacketSize -
    RELIABLE_HEADER -
    params.crcBytes -
    encryptExpansionFor(params.encryptMethods)
  );
}

/**
 * Read the BE u16 reliable seq from a `[opcode u8 x2][seq BE u16][...]` packet.
 * Used after `buildFragmentPackets` allocates the seq so we can re-track it.
 */
function readReliableSeq(packet: Uint8Array): number {
  const hi = packet[2];
  const lo = packet[3];
  if (hi === undefined || lo === undefined) {
    throw new Error('readReliableSeq: packet too short');
  }
  return ((hi << 8) | lo) & 0xffff;
}

// Re-export the EncryptMethod enum for downstream test convenience
export { EncryptMethod };
