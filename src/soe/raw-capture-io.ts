/**
 * Raw SOE-layer capture I/O.
 *
 * Unlike the GameNetworkMessage-level capture in `client/transcript-io.ts`,
 * this records the actual encrypted UDP bytes — the same datagrams that hit
 * (or left) the socket, with SOE framing, CRC, and encryption intact.
 *
 * The file format is NDJSON, one of three line types:
 *
 *   {"type":"meta","ts":...,"localEndpoint":"...","remoteEndpoint":"...",
 *    "connectionCode":...,"maxRawPacketSize":...,"stage":"login"?}
 *
 *   {"type":"session","ts":...,"encryptCode":...,"encryptMethods":[1,4],
 *    "crcBytes":2,"connectionCode":...,"negotiatedMaxRawPacketSize":...}
 *
 *   {"type":"frame","direction":"send"|"recv","ts":...,"bytes":"hex..."}
 *
 * Older captures wrote frames without a `type` field; the reader tolerates
 * both. The first line should be a `meta`; the second is the `session` line
 * once the SessionResponse handshake completes. The session line may be
 * absent if the connection never negotiated.
 *
 * Used by the live capture path (`SoeConnection.rawCapture`) on write and
 * by `bin/swg-ts-cli decode-raw` on read.
 */

import { Buffer } from 'node:buffer';
import { readFile, writeFile } from 'node:fs/promises';
import type { EncryptMethod } from '../types.js';

/** Metadata describing the captured connection (one per session). */
export interface RawCaptureMeta {
  /** Wall-clock millis when the capture file was opened. */
  ts: number;
  /** `"host:port"` of the local UDP socket if known, else `null`. */
  localEndpoint: string | null;
  /** `"host:port"` of the remote (server) endpoint. */
  remoteEndpoint: string;
  /** The connectionCode the client picked at SessionRequest time. */
  connectionCode: number;
  /** Max raw packet size we advertised (server may reduce). */
  maxRawPacketSize: number;
  /** Optional stage label (`"login"`, `"connection"`, ...). */
  stage?: string;
}

/** Negotiated session parameters needed for offline decryption. */
export interface RawCaptureSession {
  /** Wall-clock millis when SessionResponse was processed. */
  ts: number;
  /** Server-chosen 32-bit seed for XOR + CRC. */
  encryptCode: number;
  /** Server-echoed connectionCode (must match the meta line's value). */
  connectionCode: number;
  /** Number of CRC bytes appended to every encrypted packet (1..4). */
  crcBytes: number;
  /** Two-pass encryption methods. */
  encryptMethods: [EncryptMethod, EncryptMethod];
  /** min(client maxRawPacketSize, server maxRawPacketSize). */
  negotiatedMaxRawPacketSize: number;
}

/** One captured UDP datagram. */
export interface RawCaptureFrame {
  direction: 'send' | 'recv';
  /** Wall-clock millis when the frame was sent/received. */
  ts: number;
  /** The raw datagram bytes (post-encrypt+CRC on send, pre-decrypt on recv). */
  bytes: Uint8Array;
}

/**
 * Read a raw-capture NDJSON file. Tolerates blank lines and unknown line
 * types (forward-compat). Throws on JSON parse failure or invalid hex.
 *
 * If the file has no `meta` line a synthetic one is generated from the first
 * frame's timestamp; we'd rather load best-effort than fail outright.
 */
export async function readRawCapture(path: string): Promise<{
  meta: RawCaptureMeta;
  session: RawCaptureSession | null;
  frames: RawCaptureFrame[];
}> {
  const buf = await readFile(path, 'utf8');
  return parseRawCapture(buf);
}

/**
 * Parse a raw-capture NDJSON string. Exported for direct use by tests that
 * round-trip without touching the filesystem.
 */
export function parseRawCapture(ndjson: string): {
  meta: RawCaptureMeta;
  session: RawCaptureSession | null;
  frames: RawCaptureFrame[];
} {
  let meta: RawCaptureMeta | null = null;
  let session: RawCaptureSession | null = null;
  const frames: RawCaptureFrame[] = [];

  const lines = ndjson.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue;
    const trimmed = line.trim();
    if (trimmed === '') continue;
    let raw: unknown;
    try {
      raw = JSON.parse(trimmed);
    } catch (err) {
      throw new Error(
        `readRawCapture: failed to parse line ${i + 1}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (raw === null || typeof raw !== 'object') {
      throw new Error(`readRawCapture: line ${i + 1} is not an object`);
    }
    const obj = raw as Record<string, unknown>;
    const type = typeof obj.type === 'string' ? obj.type : 'frame';
    switch (type) {
      case 'meta':
        meta = parseMeta(obj, i + 1);
        break;
      case 'session':
        session = parseSession(obj, i + 1);
        break;
      case 'frame':
        frames.push(parseFrame(obj, i + 1));
        break;
      default:
        // Forward-compatible: silently skip unknown line types.
        break;
    }
  }

  if (meta === null) {
    // Synthesize a placeholder meta so callers don't have to handle null.
    meta = {
      ts: frames[0]?.ts ?? 0,
      localEndpoint: null,
      remoteEndpoint: 'unknown:0',
      connectionCode: 0,
      maxRawPacketSize: 496,
    };
  }
  return { meta, session, frames };
}

/** Serialize the meta + session + frames into NDJSON. Always trailing `\n`. */
export function serializeRawCapture(parts: {
  meta: RawCaptureMeta;
  session: RawCaptureSession | null;
  frames: readonly RawCaptureFrame[];
}): string {
  const lines: string[] = [];
  lines.push(JSON.stringify(metaToJson(parts.meta)));
  if (parts.session !== null) {
    lines.push(JSON.stringify(sessionToJson(parts.session)));
  }
  for (const f of parts.frames) {
    lines.push(JSON.stringify(frameToJson(f)));
  }
  return `${lines.join('\n')}\n`;
}

/** Convenience writer for tests / tools. */
export async function writeRawCapture(
  path: string,
  parts: {
    meta: RawCaptureMeta;
    session: RawCaptureSession | null;
    frames: readonly RawCaptureFrame[];
  },
): Promise<void> {
  await writeFile(path, serializeRawCapture(parts), 'utf8');
}

// ─────────────────────────────────────────────────────────────────────────
// Line-shape helpers (exported for the live capture in connection.ts so
// both write paths produce identical bytes).
// ─────────────────────────────────────────────────────────────────────────

export function metaToJson(meta: RawCaptureMeta): Record<string, unknown> {
  const out: Record<string, unknown> = {
    type: 'meta',
    ts: meta.ts,
    localEndpoint: meta.localEndpoint,
    remoteEndpoint: meta.remoteEndpoint,
    connectionCode: meta.connectionCode,
    maxRawPacketSize: meta.maxRawPacketSize,
  };
  if (meta.stage !== undefined) out.stage = meta.stage;
  return out;
}

export function sessionToJson(session: RawCaptureSession): Record<string, unknown> {
  return {
    type: 'session',
    ts: session.ts,
    encryptCode: session.encryptCode,
    connectionCode: session.connectionCode,
    crcBytes: session.crcBytes,
    encryptMethods: [session.encryptMethods[0], session.encryptMethods[1]],
    negotiatedMaxRawPacketSize: session.negotiatedMaxRawPacketSize,
  };
}

export function frameToJson(frame: RawCaptureFrame): Record<string, unknown> {
  return {
    type: 'frame',
    direction: frame.direction,
    ts: frame.ts,
    bytes: hexFromBytes(frame.bytes),
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Internals
// ─────────────────────────────────────────────────────────────────────────

function parseMeta(obj: Record<string, unknown>, lineNo: number): RawCaptureMeta {
  const ts = expectNumber(obj.ts, 'ts', lineNo);
  const localEndpoint =
    obj.localEndpoint === null
      ? null
      : typeof obj.localEndpoint === 'string'
        ? obj.localEndpoint
        : null;
  const remoteEndpoint = expectString(obj.remoteEndpoint, 'remoteEndpoint', lineNo);
  const connectionCode = expectNumber(obj.connectionCode, 'connectionCode', lineNo);
  const maxRawPacketSize = expectNumber(obj.maxRawPacketSize, 'maxRawPacketSize', lineNo);
  const out: RawCaptureMeta = {
    ts,
    localEndpoint,
    remoteEndpoint,
    connectionCode,
    maxRawPacketSize,
  };
  if (typeof obj.stage === 'string') out.stage = obj.stage;
  return out;
}

function parseSession(obj: Record<string, unknown>, lineNo: number): RawCaptureSession {
  const ts = expectNumber(obj.ts, 'ts', lineNo);
  const encryptCode = expectNumber(obj.encryptCode, 'encryptCode', lineNo);
  const connectionCode = expectNumber(obj.connectionCode, 'connectionCode', lineNo);
  const crcBytes = expectNumber(obj.crcBytes, 'crcBytes', lineNo);
  const methods = obj.encryptMethods;
  if (!Array.isArray(methods) || methods.length !== 2) {
    throw new Error(`readRawCapture: line ${lineNo} encryptMethods must be a 2-element array`);
  }
  const m0 = methods[0];
  const m1 = methods[1];
  if (typeof m0 !== 'number' || typeof m1 !== 'number') {
    throw new Error(`readRawCapture: line ${lineNo} encryptMethods entries must be numbers`);
  }
  const negotiatedMaxRawPacketSize = expectNumber(
    obj.negotiatedMaxRawPacketSize,
    'negotiatedMaxRawPacketSize',
    lineNo,
  );
  return {
    ts,
    encryptCode,
    connectionCode,
    crcBytes,
    encryptMethods: [m0 as EncryptMethod, m1 as EncryptMethod],
    negotiatedMaxRawPacketSize,
  };
}

function parseFrame(obj: Record<string, unknown>, lineNo: number): RawCaptureFrame {
  const direction = obj.direction;
  if (direction !== 'send' && direction !== 'recv') {
    throw new Error(
      `readRawCapture: line ${lineNo} frame direction must be 'send' or 'recv', got ${String(direction)}`,
    );
  }
  const ts = expectNumber(obj.ts, 'ts', lineNo);
  const hex = expectString(obj.bytes, 'bytes', lineNo);
  return { direction, ts, bytes: bytesFromHex(hex, lineNo) };
}

function expectNumber(v: unknown, field: string, lineNo: number): number {
  if (typeof v !== 'number') {
    throw new Error(`readRawCapture: line ${lineNo} missing number ${field}`);
  }
  return v;
}

function expectString(v: unknown, field: string, lineNo: number): string {
  if (typeof v !== 'string') {
    throw new Error(`readRawCapture: line ${lineNo} missing string ${field}`);
  }
  return v;
}

export function hexFromBytes(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('hex');
}

function bytesFromHex(hex: string, lineNo: number): Uint8Array {
  if (hex === '') return new Uint8Array();
  if ((hex.length & 1) !== 0) {
    throw new Error(`readRawCapture: line ${lineNo} odd-length hex string (${hex.length} chars)`);
  }
  const buf = Buffer.from(hex, 'hex');
  if (buf.length !== hex.length / 2) {
    throw new Error(`readRawCapture: line ${lineNo} invalid hex characters`);
  }
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}
