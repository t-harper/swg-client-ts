/**
 * SOE session-handshake packets:
 *   SessionRequest  (cUdpPacketConnect, opcode 1) — client → server
 *   SessionResponse (cUdpPacketConfirm, opcode 2) — server → client
 *
 * These packets are sent unencrypted and have NO CRC trailer.
 *
 * Maps to:
 *   /home/tharper/code/swg-main/src/external/3rd/library/udplibrary/UdpLibrary.cpp
 *     Connect handling around line 1832
 *     Confirm handling around line 1881
 *   /home/tharper/code/swg-main/src/external/3rd/library/udplibrary/UdpLibrary.hpp
 *     UdpPacketConnect struct (line 1402)
 *     UdpPacketConfirm struct (line 1411)
 *     cUdpPacketConnectSize = 14 (line 1498)
 */

import type { EncryptMethod } from '../types.js';
import { SoePacketType } from './packet-types.js';

/**
 * SessionRequest fields the client sends. The "protocol version" is always 2
 * in this codebase (lines confirming this: UdpLibrary.cpp 2261).
 */
export interface SessionRequestParams {
  /** Always 2 for SWG */
  protocolVersion: number;
  /** Client-chosen random uint32 identifying this connection attempt */
  connectionCode: number;
  /** Largest UDP packet we're willing to receive. Server will min() with its own setting. */
  maxRawPacketSize: number;
}

/**
 * SessionResponse fields the server returns.
 */
export interface SessionResponseFields {
  /** Echo of our connectionCode (must match for us to accept) */
  connectionCode: number;
  /** Server-chosen seed for XOR + CRC */
  encryptCode: number;
  /** Number of CRC bytes appended to every encrypted packet (1..4) */
  crcBytes: number;
  /** Two-pass encryption methods, applied in order on send */
  encryptMethods: [EncryptMethod, EncryptMethod];
  /** Negotiated max raw packet size (= min(our, theirs)) */
  maxRawPacketSize: number;
}

/**
 * Build the 14-byte SessionRequest (cUdpPacketConnect) packet.
 *
 * Byte layout (all uint32 fields are BIG-ENDIAN — see UdpMisc::PutValue32):
 *   [0..1]   00 01
 *   [2..5]   protocolVersion (BE)
 *   [6..9]   connectionCode  (BE)
 *   [10..13] maxRawPacketSize (BE)
 */
export function buildSessionRequest(params: SessionRequestParams): Uint8Array {
  const buf = new Uint8Array(14);
  buf[0] = 0x00;
  buf[1] = SoePacketType.Connect;
  putU32BE(buf, 2, params.protocolVersion);
  putU32BE(buf, 6, params.connectionCode);
  putU32BE(buf, 10, params.maxRawPacketSize);
  return buf;
}

/**
 * Parse a SessionResponse (cUdpPacketConfirm) packet.
 *
 * Byte layout (cEncryptPasses=2 → 17 bytes total):
 *   [0..1]   00 02
 *   [2..5]   connectionCode  (BE u32)
 *   [6..9]   encryptCode     (BE u32)
 *   [10]     crcBytes        (u8)
 *   [11]     encryptMethod[0]
 *   [12]     encryptMethod[1]
 *   [13..16] maxRawPacketSize (BE u32)
 */
export function parseSessionResponse(packet: Uint8Array): SessionResponseFields {
  if (packet.length < 17) {
    throw new Error(`SessionResponse too short: ${packet.length} bytes (expected 17)`);
  }
  if (packet[0] !== 0x00 || packet[1] !== SoePacketType.Confirm) {
    throw new Error(
      `Not a SessionResponse: opcode ${packet[0]?.toString(16)} ${packet[1]?.toString(16)}`,
    );
  }

  const connectionCode = getU32BE(packet, 2);
  const encryptCode = getU32BE(packet, 6);
  const crcBytes = packet[10];
  if (crcBytes === undefined) throw new Error('crcBytes missing');
  const em0 = packet[11];
  const em1 = packet[12];
  if (em0 === undefined || em1 === undefined) {
    throw new Error('encryptMethods missing');
  }
  const maxRawPacketSize = getU32BE(packet, 13);

  return {
    connectionCode,
    encryptCode,
    crcBytes,
    encryptMethods: [em0 as EncryptMethod, em1 as EncryptMethod],
    maxRawPacketSize,
  };
}

/**
 * Build a Terminate packet to send before closing the socket cleanly.
 *
 * Layout (matches UdpConnection::SendTerminatePacket lines 1428-1436):
 *   [0..1]   00 05
 *   [2..5]   connectCode (BE u32)
 *   [6..7]   reason (BE u16) — optional; we always send 0
 *
 * NOTE: This packet IS encrypted + CRC'd if a session has been established.
 * Caller is responsible for running it through the encryption pipeline.
 */
export function buildTerminatePacket(connectCode: number, reason = 0): Uint8Array {
  const buf = new Uint8Array(8);
  buf[0] = 0x00;
  buf[1] = SoePacketType.Terminate;
  putU32BE(buf, 2, connectCode);
  putU16BE(buf, 6, reason);
  return buf;
}

/**
 * Build a KeepAlive packet. 2 bytes total. Encrypted + CRC'd by the caller.
 */
export function buildKeepAlivePacket(): Uint8Array {
  return new Uint8Array([0x00, SoePacketType.KeepAlive]);
}

// ──────────────────────────────────────────────────────────────────────────
// Big-endian helpers (SOE control-packet fields are big-endian)
// ──────────────────────────────────────────────────────────────────────────

export function putU32BE(buf: Uint8Array, offset: number, value: number): void {
  const v = value >>> 0;
  buf[offset] = (v >>> 24) & 0xff;
  buf[offset + 1] = (v >>> 16) & 0xff;
  buf[offset + 2] = (v >>> 8) & 0xff;
  buf[offset + 3] = v & 0xff;
}

export function getU32BE(buf: Uint8Array, offset: number): number {
  const b0 = buf[offset];
  const b1 = buf[offset + 1];
  const b2 = buf[offset + 2];
  const b3 = buf[offset + 3];
  if (b0 === undefined || b1 === undefined || b2 === undefined || b3 === undefined) {
    throw new Error(`getU32BE OOB at ${offset} (buf length ${buf.length})`);
  }
  return ((b0 << 24) | (b1 << 16) | (b2 << 8) | b3) >>> 0;
}

export function putU16BE(buf: Uint8Array, offset: number, value: number): void {
  const v = value & 0xffff;
  buf[offset] = (v >>> 8) & 0xff;
  buf[offset + 1] = v & 0xff;
}

export function getU16BE(buf: Uint8Array, offset: number): number {
  const b0 = buf[offset];
  const b1 = buf[offset + 1];
  if (b0 === undefined || b1 === undefined) {
    throw new Error(`getU16BE OOB at ${offset} (buf length ${buf.length})`);
  }
  return ((b0 << 8) | b1) & 0xffff;
}
