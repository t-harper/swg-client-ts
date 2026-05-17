/**
 * ClockSync / ClockReflect — SOE opcodes 7 / 8.
 *
 * These packets implement a round-trip latency probe at the SOE layer. They
 * are sent inside the normal encryption + CRC pipeline (NOT raw — see
 * UdpLibrary.cpp:2050 + 2267 + the PhysicalSend comment "it still needs to
 * be encrypted though, so don't raw send it"). After CRC strip + decrypt
 * they look exactly like the structs below — leading [00 07] / [00 08]
 * opcode header included.
 *
 * Roles in SWG:
 *   - The CLIENT has `clockSyncDelay = 45000` (sharedNetwork's
 *     `SetupSharedNetwork::getDefaultClientSetupData`, SetupSharedNetwork.cpp:46)
 *     and therefore periodically SENDS UdpPacketClockSync — every 45s plus
 *     accelerated retries if a sync is overdue.
 *   - The SERVER has `clockSyncDelay = 0` (Service.cpp:78 + SetupSharedNetwork
 *     .cpp:56). Servers don't initiate; they only respond.
 *   - On receiving a ClockSync the receiver builds a UdpPacketClockReflect
 *     that echoes the originator's `timeStamp` plus the receiver's own
 *     packet-count snapshot (UdpLibrary.cpp:2040-2050).
 *   - On receiving a ClockReflect the originator computes the round-trip
 *     time as `SyncStampShortDeltaTime(reflectedTimeStamp, localStampNow)`
 *     (UdpLibrary.cpp:2078-2079). That's the RTT estimate the histogram
 *     accumulates.
 *
 * Wire layouts — verified against UdpLibrary.hpp:1442-1466 and the
 * pack/unpack code at UdpLibrary.cpp:2027-2076. All multi-byte fields are
 * BIG-ENDIAN (see UdpMisc::PutValue16/32/64 at UdpLibrary.hpp:1699-1762).
 *
 * UdpPacketClockSync — 40 bytes total (server→client or client→server):
 * ```
 *   off  size  field            note
 *   ────────────────────────────────────────────────────────────────────────
 *   00   u8    zeroByte         always 0x00 (SOE control packet marker)
 *   01   u8    packetType       0x07 (cUdpPacketClockSync)
 *   02   u16   timeStamp        originator's LocalSyncStampShort (Clock & 0xffff)
 *   04   i32   masterPingTime   originator's mSyncStatMasterRoundTime
 *   08   i32   averagePingTime  originator's mSyncStatTotal/mSyncStatCount
 *   0c   i32   lowPingTime      originator's mSyncStatLow
 *   10   i32   highPingTime     originator's mSyncStatHigh
 *   14   i32   lastPingTime     originator's mSyncStatLast
 *   18   i64   ourSent          originator's totalPacketsSent (+1 to include this)
 *   20   i64   ourReceived      originator's totalPacketsReceived
 * ```
 *
 * UdpPacketClockReflect — 40 bytes total (responder back to originator):
 * ```
 *   off  size  field                note
 *   ────────────────────────────────────────────────────────────────────────
 *   00   u8    zeroByte             always 0x00
 *   01   u8    packetType           0x08 (cUdpPacketClockReflect)
 *   02   u16   timeStamp            ECHOED from the ClockSync we received
 *   04   u32   serverSyncStampLong  responder's LocalSyncStampLong (Clock & 0xffffffff)
 *   08   i64   yourSent             echo of the ClockSync's ourSent
 *   10   i64   yourReceived         echo of the ClockSync's ourReceived
 *   18   i64   ourSent              responder's totalPacketsSent
 *   20   i64   ourReceived          responder's totalPacketsReceived
 * ```
 *
 * Source references:
 *   ~/code/swg-main/src/external/3rd/library/udplibrary/UdpLibrary.hpp:1442-1466 (struct definitions)
 *   ~/code/swg-main/src/external/3rd/library/udplibrary/UdpLibrary.cpp:2022-2113 (parse + build)
 *   ~/code/swg-main/src/external/3rd/library/udplibrary/UdpLibrary.cpp:2256-2271 (periodic send)
 *   ~/code/swg-main/src/external/3rd/library/udplibrary/UdpLibrary.hpp:1688-1762 (BE Put/Get helpers)
 *   ~/code/swg-main/src/external/3rd/library/udplibrary/UdpLibrary.cpp:4121-4127 (SyncStampShortDeltaTime)
 *   ~/code/swg-main/src/engine/shared/library/sharedNetwork/src/shared/SetupSharedNetwork.cpp:41-57 (client vs server clockSyncDelay)
 */

import { SoePacketType } from './packet-types.js';

/** Number of bytes on the wire for both ClockSync and ClockReflect. */
export const CLOCK_SYNC_SIZE = 40;
export const CLOCK_REFLECT_SIZE = 40;

/**
 * Parsed UdpPacketClockSync. All multi-byte fields decoded from big-endian.
 * `i64` fields are stored as `bigint` to preserve precision on packet counters.
 */
export interface ClockSyncPacket {
  /** Always 0x00 — the SOE control-packet marker. */
  zeroByte: number;
  /** Always 0x07 (cUdpPacketClockSync). */
  packetType: number;
  /** Originator's LocalSyncStampShort (low 16 bits of its local Clock()). */
  timeStamp: number;
  /** Originator's master ping time (its current best round-trip in ms). */
  masterPingTime: number;
  /** Originator's running average ping time. */
  averagePingTime: number;
  /** Lowest observed ping time. */
  lowPingTime: number;
  /** Highest observed ping time. */
  highPingTime: number;
  /** Most recent observed ping time. */
  lastPingTime: number;
  /** Originator's totalPacketsSent (pre-incremented to include the ClockSync). */
  ourSent: bigint;
  /** Originator's totalPacketsReceived. */
  ourReceived: bigint;
}

/**
 * Parsed UdpPacketClockReflect.
 *
 * Layout shares the [zeroByte, packetType, timeStamp] header with ClockSync,
 * then deviates: a u32 `serverSyncStampLong` instead of the i32 ping-time
 * block, and four i64 counters instead of two.
 */
export interface ClockReflectPacket {
  /** Always 0x00. */
  zeroByte: number;
  /** Always 0x08 (cUdpPacketClockReflect). */
  packetType: number;
  /** Echo of the ClockSync `timeStamp` — what the originator uses for RTT. */
  timeStamp: number;
  /** Responder's LocalSyncStampLong (low 32 bits of its local Clock()). */
  serverSyncStampLong: number;
  /** Echo of the ClockSync `ourSent`. */
  yourSent: bigint;
  /** Echo of the ClockSync `ourReceived`. */
  yourReceived: bigint;
  /** Responder's totalPacketsSent. */
  ourSent: bigint;
  /** Responder's totalPacketsReceived. */
  ourReceived: bigint;
}

// ──────────────────────────────────────────────────────────────────────────
// Big-endian primitive helpers — match UdpMisc::Put/GetValue16/32/64.
// ──────────────────────────────────────────────────────────────────────────

function readU16BE(buf: Uint8Array, off: number): number {
  const a = buf[off];
  const b = buf[off + 1];
  if (a === undefined || b === undefined) {
    throw new RangeError(`readU16BE: out of bounds at ${off} (length ${buf.length})`);
  }
  return ((a << 8) | b) >>> 0;
}

function writeU16BE(buf: Uint8Array, off: number, value: number): void {
  buf[off] = (value >>> 8) & 0xff;
  buf[off + 1] = value & 0xff;
}

function readU32BE(buf: Uint8Array, off: number): number {
  const a = buf[off];
  const b = buf[off + 1];
  const c = buf[off + 2];
  const d = buf[off + 3];
  if (a === undefined || b === undefined || c === undefined || d === undefined) {
    throw new RangeError(`readU32BE: out of bounds at ${off} (length ${buf.length})`);
  }
  return ((a * 0x1000000) + ((b << 16) | (c << 8) | d)) >>> 0;
}

function writeU32BE(buf: Uint8Array, off: number, value: number): void {
  buf[off] = (value >>> 24) & 0xff;
  buf[off + 1] = (value >>> 16) & 0xff;
  buf[off + 2] = (value >>> 8) & 0xff;
  buf[off + 3] = value & 0xff;
}

function readU64BE(buf: Uint8Array, off: number): bigint {
  if (off + 8 > buf.length) {
    throw new RangeError(`readU64BE: out of bounds at ${off} (length ${buf.length})`);
  }
  const hi = BigInt(readU32BE(buf, off));
  const lo = BigInt(readU32BE(buf, off + 4));
  return (hi << 32n) | lo;
}

function writeU64BE(buf: Uint8Array, off: number, value: bigint): void {
  const hi = Number((value >> 32n) & 0xffffffffn);
  const lo = Number(value & 0xffffffffn);
  writeU32BE(buf, off, hi);
  writeU32BE(buf, off + 4, lo);
}

// ──────────────────────────────────────────────────────────────────────────
// Parse / build
// ──────────────────────────────────────────────────────────────────────────

/**
 * Parse a `UdpPacketClockSync` from bytes. `bytes` must be the COOKED packet
 * (already CRC-stripped and decrypted) — i.e. starting with `[0x00, 0x07]`.
 *
 * Throws if the buffer is shorter than 40 bytes or the opcode isn't 7.
 */
export function parseClockSync(bytes: Uint8Array): ClockSyncPacket {
  if (bytes.length < CLOCK_SYNC_SIZE) {
    throw new RangeError(
      `parseClockSync: packet too short (${bytes.length} bytes, need ${CLOCK_SYNC_SIZE})`,
    );
  }
  if (bytes[0] !== 0 || bytes[1] !== SoePacketType.ClockSync) {
    throw new Error(
      `parseClockSync: not a ClockSync packet (opcode bytes ${bytes[0]}, ${bytes[1]})`,
    );
  }
  return {
    zeroByte: 0,
    packetType: SoePacketType.ClockSync,
    timeStamp: readU16BE(bytes, 2),
    // Treat signed/unsigned the same on the wire — these are stat values that
    // shouldn't realistically exceed 2^31, but read as i32 (sign-extend) to
    // match C++ struct (`int` fields).
    masterPingTime: readI32BE(bytes, 4),
    averagePingTime: readI32BE(bytes, 8),
    lowPingTime: readI32BE(bytes, 12),
    highPingTime: readI32BE(bytes, 16),
    lastPingTime: readI32BE(bytes, 20),
    ourSent: readU64BE(bytes, 24),
    ourReceived: readU64BE(bytes, 32),
  };
}

/**
 * Build a `UdpPacketClockReflect` in response to a ClockSync we received.
 *
 * The reflect packet:
 *   - Echoes the ClockSync's `timeStamp` (so the originator can subtract
 *     against its current local clock for an RTT estimate).
 *   - Sets `serverSyncStampLong` to OUR local clock right now (Clock &
 *     0xffffffff). `clientStampNow` is passed in so callers can use a
 *     monotonic source or `Date.now() & 0xffffffff`.
 *   - Echoes the ClockSync's `ourSent` / `ourReceived` into
 *     `yourSent`/`yourReceived` (so the originator can compare).
 *   - Fills `ourSent` / `ourReceived` with the responder's own counts.
 *     We don't track per-connection packet counters here, so they default to
 *     0 unless caller provides them.
 *
 * Returns a fresh 40-byte buffer starting with `[0x00, 0x08]`. This buffer
 * is the COOKED form — the caller is still responsible for running it through
 * the connection's encryption + CRC pipeline.
 */
export function buildClockReflect(
  packet: ClockSyncPacket,
  clientStampNow: number,
  ourSent: bigint = 0n,
  ourReceived: bigint = 0n,
): Uint8Array {
  const buf = new Uint8Array(CLOCK_REFLECT_SIZE);
  buf[0] = 0;
  buf[1] = SoePacketType.ClockReflect;
  writeU16BE(buf, 2, packet.timeStamp & 0xffff);
  writeU32BE(buf, 4, clientStampNow >>> 0);
  writeU64BE(buf, 8, packet.ourSent);
  writeU64BE(buf, 16, packet.ourReceived);
  writeU64BE(buf, 24, ourSent);
  writeU64BE(buf, 32, ourReceived);
  return buf;
}

/**
 * Parse a `UdpPacketClockReflect` from cooked bytes (post-CRC-strip /
 * post-decrypt). Mirrors `parseClockSync` for the response form.
 *
 * Used by the originator (us) to extract the echoed timeStamp and compute
 * the RTT estimate via `clockReflectRttMs`.
 */
export function parseClockReflect(bytes: Uint8Array): ClockReflectPacket {
  if (bytes.length < CLOCK_REFLECT_SIZE) {
    throw new RangeError(
      `parseClockReflect: packet too short (${bytes.length} bytes, need ${CLOCK_REFLECT_SIZE})`,
    );
  }
  if (bytes[0] !== 0 || bytes[1] !== SoePacketType.ClockReflect) {
    throw new Error(
      `parseClockReflect: not a ClockReflect packet (opcode bytes ${bytes[0]}, ${bytes[1]})`,
    );
  }
  return {
    zeroByte: 0,
    packetType: SoePacketType.ClockReflect,
    timeStamp: readU16BE(bytes, 2),
    serverSyncStampLong: readU32BE(bytes, 4),
    yourSent: readU64BE(bytes, 8),
    yourReceived: readU64BE(bytes, 16),
    ourSent: readU64BE(bytes, 24),
    ourReceived: readU64BE(bytes, 32),
  };
}

/**
 * Build a `UdpPacketClockSync` we want to SEND as the originator. This is the
 * client→server direction in SWG. Most stats default to 0 — the periodic
 * sender in the C++ code fills them from `mConnectionStats`, but as an
 * observability tool here the counts are non-critical and the server only
 * uses `timeStamp` + `ourSent`/`ourReceived` to compute its own counters.
 *
 * Returns a fresh 40-byte buffer starting with `[0x00, 0x07]`.
 */
export function buildClockSync(
  clientStampShortNow: number,
  options: Partial<{
    masterPingTime: number;
    averagePingTime: number;
    lowPingTime: number;
    highPingTime: number;
    lastPingTime: number;
    ourSent: bigint;
    ourReceived: bigint;
  }> = {},
): Uint8Array {
  const buf = new Uint8Array(CLOCK_SYNC_SIZE);
  buf[0] = 0;
  buf[1] = SoePacketType.ClockSync;
  writeU16BE(buf, 2, clientStampShortNow & 0xffff);
  writeI32BE(buf, 4, options.masterPingTime ?? 0);
  writeI32BE(buf, 8, options.averagePingTime ?? 0);
  writeI32BE(buf, 12, options.lowPingTime ?? 0);
  writeI32BE(buf, 16, options.highPingTime ?? 0);
  writeI32BE(buf, 20, options.lastPingTime ?? 0);
  writeU64BE(buf, 24, options.ourSent ?? 0n);
  writeU64BE(buf, 32, options.ourReceived ?? 0n);
  return buf;
}

/**
 * Compute the round-trip-time estimate (in ms) for a ClockReflect we just
 * received. The reflect echoes our original `timeStamp` (low 16 bits of the
 * sender's Clock); subtracting current local stamp gives RTT.
 *
 * Mirrors `UdpMisc::SyncStampShortDeltaTime` (UdpLibrary.cpp:4121-4127) —
 * `delta = stamp1 - stamp2; if (delta > 0x7fff) return 0xffff - delta;`.
 * That formula handles wraparound: if `delta` looks larger than 32 seconds
 * it's almost certainly a wrap and we use the complement.
 */
export function clockReflectRttMs(reflectedStamp: number, localStampNowShort: number): number {
  const delta = (localStampNowShort - reflectedStamp) & 0xffff;
  if (delta > 0x7fff) return 0xffff - delta;
  return delta;
}

/**
 * Current `LocalSyncStampShort` — low 16 bits of `Date.now()`. Matches
 * UdpMisc::LocalSyncStampShort (UdpLibrary.hpp:1688-1691):
 *   `return((ushort)(Clock() & 0xffff))`
 * where `Clock()` is millisecond resolution.
 */
export function localSyncStampShort(): number {
  return Date.now() & 0xffff;
}

/**
 * Current `LocalSyncStampLong` — low 32 bits of `Date.now()`. Matches
 * UdpMisc::LocalSyncStampLong (UdpLibrary.hpp:1693-1696):
 *   `return((uint)(Clock() & 0xffffffff))`.
 */
export function localSyncStampLong(): number {
  return Date.now() & 0xffffffff;
}

// ──────────────────────────────────────────────────────────────────────────
// Latency histogram
// ──────────────────────────────────────────────────────────────────────────

/**
 * Full record of one ClockReflect observation. Delivered to listeners
 * registered via `SoeConnection.addClockReflectListener`.
 *
 * Where `LatencyStats` is the RTT histogram, this is a per-sample record
 * that includes the data needed to compute the client→server clock offset:
 * the responder's `serverSyncStampLong` (low 32 bits of the server's local
 * clock at the moment it reflected) and the wall-clock time on our side
 * when we received the reflect packet.
 */
export interface ClockReflectSample {
  /** Round-trip time in ms (from `clockReflectRttMs`). */
  rttMs: number;
  /**
   * Responder's `LocalSyncStampLong` (low 32 bits of the server's local
   * `Clock()` value at the time it built the reflect). Combined with our
   * `clientRecvWallMs - rttMs/2` (one-way estimate of when the server
   * actually stamped its clock) this gives us a server-vs-client offset
   * usable to project current server time.
   */
  serverSyncStampLong: number;
  /**
   * Our `Date.now()` at the moment the reflect arrived. Use
   * `clientRecvWallMs - rttMs / 2` as the best estimate of the server
   * wall-clock when it stamped `serverSyncStampLong`.
   */
  clientRecvWallMs: number;
}

/** Listener for ClockReflect samples. See `SoeConnection.addClockReflectListener`. */
export type ClockReflectListener = (sample: ClockReflectSample) => void;

/**
 * Summary of accumulated RTT samples. `samples` is the count of samples; the
 * actual raw values are owned by the recorder.
 */
export interface LatencyStats {
  /** Raw RTT samples in ms, in arrival order. */
  samples: number[];
  /** Convenience — `samples.length`. */
  count: number;
  /** 50th percentile (median) — nearest-rank, sorted ascending. */
  p50: number;
  /** 95th percentile — nearest-rank. */
  p95: number;
  /** 99th percentile — nearest-rank. */
  p99: number;
  /** Minimum sample. */
  min: number;
  /** Maximum sample. */
  max: number;
  /** Arithmetic mean. */
  mean: number;
}

/**
 * Compute summary statistics from an unsorted array of RTT samples. Returns
 * `null` if the array is empty so callers can distinguish "no data" from
 * "all zeros".
 *
 * Percentiles use the "nearest-rank" method (NIST primary definition): for
 * percentile `p` (0..100) and N samples, return the value at position
 * `ceil(p/100 * N) - 1` in the sorted array.
 */
export function summarizeLatency(samples: readonly number[]): LatencyStats | null {
  if (samples.length === 0) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  const n = sorted.length;
  const nearestRank = (p: number): number => {
    const idx = Math.max(0, Math.min(n - 1, Math.ceil((p / 100) * n) - 1));
    return sorted[idx] as number;
  };
  let total = 0;
  for (const s of sorted) total += s;
  return {
    samples: [...samples],
    count: n,
    p50: nearestRank(50),
    p95: nearestRank(95),
    p99: nearestRank(99),
    min: sorted[0] as number,
    max: sorted[n - 1] as number,
    mean: total / n,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Signed-int big-endian helpers (the i32 ping-stat fields are signed in C++)
// ──────────────────────────────────────────────────────────────────────────

function readI32BE(buf: Uint8Array, off: number): number {
  const u = readU32BE(buf, off);
  // Sign-extend
  return u > 0x7fffffff ? u - 0x100000000 : u;
}

function writeI32BE(buf: Uint8Array, off: number, value: number): void {
  writeU32BE(buf, off, value >>> 0);
}
