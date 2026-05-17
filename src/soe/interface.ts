/**
 * Public interface for the SOE UDP transport layer.
 * Concrete implementation lives in `connection.ts` + helpers.
 *
 * Maps to:
 *   /home/tharper/code/swg-main/src/external/3rd/library/udplibrary/UdpLibrary.{cpp,hpp}
 */

import type { EncryptionParams, ServerEndpoint } from '../types.js';
import type { ClockReflectListener, LatencyStats } from './clock-sync.js';

/** Callback for an incoming, fully-decrypted, fully-defragmented application payload. */
export type AppMessageHandler = (payload: Uint8Array) => void;

/** Callback for SOE-level state transitions or errors the caller should know about. */
export type ConnectionStateHandler = (event: ConnectionEvent) => void;

export type ConnectionEvent =
  | { kind: 'session_negotiated'; params: EncryptionParams }
  | { kind: 'disconnected'; reason: string }
  | { kind: 'corrupt_packet'; reason: string; rawBytes: Uint8Array }
  | { kind: 'error'; error: Error };

/** Options for opening a new SoeConnection. */
export interface SoeConnectionOptions {
  endpoint: ServerEndpoint;
  /** Max raw packet size we'll advertise in SessionRequest. Default 496. */
  maxRawPacketSize?: number;
  /** Random 32-bit value to identify this connection. Default: random. */
  connectionCode?: number;
  /**
   * If true, send a KeepAlive every N ms during idle. Default true (5000ms).
   * SOE-level only — doesn't include app-level HeartBeat.
   */
  keepAliveMs?: number;
  /**
   * Periodic ClockSync interval in ms. Set to 0 to disable. Default 45000
   * (matches sharedNetwork's `getDefaultClientSetupData`,
   * SetupSharedNetwork.cpp:46). When enabled, the connection sends a
   * UdpPacketClockSync every N ms and accumulates RTT samples from the
   * server's ClockReflect responses.
   */
  clockSyncIntervalMs?: number;
  /**
   * Optional callback fired each time we record a new RTT sample (i.e. each
   * time we receive a ClockReflect that we can match against a sent
   * ClockSync). Useful for streaming latency to a metric sink.
   */
  onClockSync?: (rttMs: number) => void;
  /** Callback when the server sends us an application payload (post-decrypt/defrag) */
  onAppMessage: AppMessageHandler;
  /** Optional connection lifecycle callback */
  onEvent?: ConnectionStateHandler;
  /**
   * If set, every outgoing/incoming UDP datagram (BEFORE decrypt on recv,
   * AFTER encrypt+CRC on send) is appended to the named NDJSON file as a
   * raw-capture frame. Plus a `meta` line on open and a `session` line once
   * the SessionResponse is processed. Used by `bin/swg-ts-cli decode-raw`.
   *
   * The file is created/truncated on first write. Errors writing capture
   * lines are silently swallowed so they can never abort send/recv.
   */
  rawCapture?: RawCaptureOptions;
}

/**
 * Configuration for raw-byte capture. The connection writes one NDJSON line
 * per datagram plus metadata lines describing how to decrypt them.
 */
export interface RawCaptureOptions {
  /** Absolute path to NDJSON file. Will be created/truncated. */
  writePath: string;
  /**
   * Optional free-form `stage` label included in the `meta` line so a
   * single-file capture spanning multiple SOE sessions can be told apart by
   * the offline decoder. Convention: `"login"`, `"connection"`, etc.
   */
  stage?: string;
}

/**
 * One SOE session over a single UDP socket. We'll instantiate three of these
 * during a full lifecycle (LoginServer, ConnectionServer, GameServer) — each
 * is independent and has its own encryptCode.
 */
export interface ISoeConnection {
  /** SessionRequest → SessionResponse handshake. Resolves once negotiated. */
  connect(): Promise<EncryptionParams>;

  /**
   * Send an application-level payload (e.g. a GameNetworkMessage's encoded bytes).
   * Wraps in cUdpPacketReliable1, encrypts, CRCs, and ACK-handles automatically.
   */
  sendApp(payload: Uint8Array): void;

  /** Send a clean cUdpPacketTerminate and close the socket */
  disconnect(): Promise<void>;

  /** True once SessionResponse has been received and params are set */
  readonly isConnected: boolean;

  /** Negotiated params (only valid after connect()) */
  readonly params: EncryptionParams | undefined;

  /**
   * Accumulated round-trip-time samples from ClockSync/ClockReflect exchanges,
   * summarized with min/mean/p50/p95/p99/max. Returns `null` if no samples
   * have been recorded yet (which is the case for short-lived connections
   * that disconnect before the first ClockSync interval elapses).
   */
  getLatencyStats(): LatencyStats | null;

  /**
   * Subscribe to ClockReflect samples (per-sample, full record including
   * RTT + the server's reflected `serverSyncStampLong`). Returns an
   * unsubscribe function. Distinct from the single `onClockSync` option
   * callback that only delivers RTT.
   */
  addClockReflectListener(listener: ClockReflectListener): () => void;
}
