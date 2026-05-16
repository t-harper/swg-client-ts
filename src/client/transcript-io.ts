/**
 * Wire-capture I/O — serialize a captured `TranscriptEvent` stream to NDJSON
 * (one event per line) and read it back. Lossless round-trip:
 *
 *   - Wire bytes → hex string
 *   - bigints (network IDs, server time) → decimal strings
 *   - Uint8Array fields inside decoded payloads → hex strings
 *   - Date / Set objects → arrays + ISO strings via lifecycleResultToJSON's
 *     normalize logic
 *
 * NDJSON format (one JSON object per line, with trailing `\n`):
 *
 *   {
 *     "direction": "send" | "recv",
 *     "messageName": string,
 *     "typeCrc": number,
 *     "bytes": <hex string>,     // wire payload (varCount + crc + payload)
 *     "at": number,               // wall-clock millis (Date.now())
 *     "decoded"?: <normalized object>,   // omitted for sends; present for recvs
 *     "unknownCrc"?: true,        // present only when set
 *     "decodeError"?: string      // present only when set
 *   }
 *
 * The high-level `TranscriptEvent` already carries everything except the
 * raw wire bytes for sends — for those we re-encode via `encodeMessage` at
 * capture time. See `attachCapture()` for the dispatcher integration.
 *
 * Used by the replay harness — see `replay.ts`.
 */

import { Buffer } from 'node:buffer';
import { readFile, writeFile } from 'node:fs/promises';
import { encodeMessage, parseHeader } from '../messages/base.js';
import type { GameNetworkMessage } from '../messages/interface.js';
import { messageRegistry } from '../messages/registry.js';
import type { MessageDispatcher, TranscriptEvent } from './dispatcher.js';

/**
 * A captured wire event — superset of `TranscriptEvent` that carries the
 * actual on-wire bytes so the event can be losslessly serialized and
 * replayed. Produced by `attachCapture()` or `eventsFromTranscript()`.
 */
export type CapturedEvent =
  | {
      direction: 'send';
      messageName: string;
      typeCrc: number;
      /** Raw wire bytes: [u16 varCount][u32 typeCrc][payload]. */
      payload: Uint8Array;
      at: number;
    }
  | {
      direction: 'recv';
      messageName: string;
      typeCrc: number;
      /** Raw wire bytes: [u16 varCount][u32 typeCrc][payload]. */
      payload: Uint8Array;
      at: number;
      decoded: GameNetworkMessage | null;
      unknownCrc?: boolean;
      decodeError?: string;
    };

/**
 * Hook a dispatcher to record `CapturedEvent`s including raw wire bytes.
 *
 * Patches the dispatcher INSTANCE (not the prototype) by wrapping its
 * `send` and `handleAppMessage` methods. The original dispatcher's
 * transcript continues to record the metadata-only `TranscriptEvent`s as
 * before — this just captures a parallel byte-faithful stream.
 *
 * Returns the events array (mutated as new events arrive) and a `detach()`
 * that restores the original method pointers. Detaching does NOT
 * deactivate previously captured events.
 */
export function attachCapture(dispatcher: MessageDispatcher): {
  events: CapturedEvent[];
  detach: () => void;
} {
  const events: CapturedEvent[] = [];

  // Save originals (must bind so they re-enter the dispatcher correctly)
  const origSend = dispatcher.send.bind(dispatcher);
  const origHandle = dispatcher.handleAppMessage.bind(dispatcher);

  // Override send: capture bytes via encodeMessage, then call original which
  // will record its own TranscriptEvent and ship through the SoeConnection.
  (dispatcher as unknown as { send: typeof dispatcher.send }).send = ((
    msg: GameNetworkMessage,
  ): void => {
    const ctor = msg.constructor as unknown as { messageName: string; typeCrc: number };
    const bytes = encodeMessage(msg);
    events.push({
      direction: 'send',
      messageName: ctor.messageName,
      typeCrc: ctor.typeCrc,
      payload: bytes,
      at: Date.now(),
    });
    origSend(msg);
  }) as typeof dispatcher.send;

  // Override handleAppMessage: snapshot the raw payload + the result of
  // re-parsing via the registry. The original method also records its own
  // TranscriptEvent (which will include `decoded`).
  (
    dispatcher as unknown as { handleAppMessage: typeof dispatcher.handleAppMessage }
  ).handleAppMessage = (payload: Uint8Array): void => {
    const copy = new Uint8Array(payload); // defensive copy
    let typeCrc = 0;
    let messageName = '<header-decode-failed>';
    let decoded: GameNetworkMessage | null = null;
    let decodeError: string | undefined;
    let unknownCrc = false;
    try {
      const parsed = parseHeader(copy);
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
    events.push({
      direction: 'recv',
      messageName,
      typeCrc,
      payload: copy,
      at: Date.now(),
      decoded,
      ...(unknownCrc ? { unknownCrc: true } : {}),
      ...(decodeError !== undefined ? { decodeError } : {}),
    });
    origHandle(payload);
  };

  return {
    events,
    detach: () => {
      (dispatcher as unknown as { send: typeof dispatcher.send }).send = origSend;
      (
        dispatcher as unknown as { handleAppMessage: typeof dispatcher.handleAppMessage }
      ).handleAppMessage = origHandle;
    },
  };
}

/**
 * Best-effort lossy promotion: turn a plain `TranscriptEvent[]` into a
 * `CapturedEvent[]` by deriving bytes from `decoded` for recvs. Sends are
 * dropped because we don't have the original message instance.
 *
 * Use this when you only have access to the high-level transcript (e.g.,
 * from `LifecycleResult.transcript`) and want to write a recv-only capture.
 * For full round-trip support, prefer `attachCapture()`.
 */
export function eventsFromTranscript(transcript: readonly TranscriptEvent[]): CapturedEvent[] {
  const out: CapturedEvent[] = [];
  for (const e of transcript) {
    if (e.direction === 'send') continue; // can't derive bytes without instance
    if (e.decoded === null) {
      // unknown CRC or decode error — record a stub with empty payload
      out.push({
        direction: 'recv',
        messageName: e.messageName,
        typeCrc: e.typeCrc,
        payload: new Uint8Array(),
        at: e.at,
        decoded: null,
        ...(e.unknownCrc === true ? { unknownCrc: true } : {}),
        ...(e.decodeError !== undefined ? { decodeError: e.decodeError } : {}),
      });
      continue;
    }
    let bytes: Uint8Array;
    try {
      bytes = encodeMessage(e.decoded);
    } catch {
      bytes = new Uint8Array();
    }
    out.push({
      direction: 'recv',
      messageName: e.messageName,
      typeCrc: e.typeCrc,
      payload: bytes,
      at: e.at,
      decoded: e.decoded,
    });
  }
  return out;
}

/**
 * Serialize a captured event stream to NDJSON. Each event becomes one line
 * terminated by `\n`. Lossless: bigints → decimal strings, Uint8Array →
 * hex strings, Date → ISO strings, Set → array.
 */
export function transcriptToNdjson(events: readonly CapturedEvent[]): string {
  const lines: string[] = [];
  for (const e of events) {
    lines.push(JSON.stringify(serializeEvent(e)));
  }
  return lines.length === 0 ? '' : `${lines.join('\n')}\n`;
}

/**
 * Parse an NDJSON capture file. Tolerates leading/trailing whitespace and
 * blank lines. Throws on malformed JSON.
 */
export function transcriptFromNdjson(ndjson: string): CapturedEvent[] {
  const out: CapturedEvent[] = [];
  // NDJSON: split on newlines, skip empty lines.
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
        `transcriptFromNdjson: failed to parse line ${i + 1}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    out.push(deserializeEvent(raw, i + 1));
  }
  return out;
}

/** Read NDJSON capture file from disk. */
export async function readTranscript(filePath: string): Promise<CapturedEvent[]> {
  const buf = await readFile(filePath, 'utf8');
  return transcriptFromNdjson(buf);
}

/** Write NDJSON capture file to disk. */
export async function writeTranscript(
  events: readonly CapturedEvent[],
  filePath: string,
): Promise<void> {
  await writeFile(filePath, transcriptToNdjson(events), 'utf8');
}

// ─────────────────────────────────────────────────────────────────────────
// Internals
// ─────────────────────────────────────────────────────────────────────────

interface SerializedEvent {
  direction: 'send' | 'recv';
  messageName: string;
  typeCrc: number;
  bytes: string;
  at: number;
  decoded?: unknown;
  unknownCrc?: true;
  decodeError?: string;
}

function serializeEvent(e: CapturedEvent): SerializedEvent {
  if (e.direction === 'send') {
    return {
      direction: 'send',
      messageName: e.messageName,
      typeCrc: e.typeCrc,
      bytes: hexFromBytes(e.payload),
      at: e.at,
    };
  }
  const out: SerializedEvent = {
    direction: 'recv',
    messageName: e.messageName,
    typeCrc: e.typeCrc,
    bytes: hexFromBytes(e.payload),
    at: e.at,
  };
  if (e.decoded !== null) out.decoded = normalize(e.decoded);
  else out.decoded = null;
  if (e.unknownCrc === true) out.unknownCrc = true;
  if (e.decodeError !== undefined) out.decodeError = e.decodeError;
  return out;
}

function deserializeEvent(raw: unknown, lineNo: number): CapturedEvent {
  if (raw === null || typeof raw !== 'object') {
    throw new Error(`transcriptFromNdjson: line ${lineNo} is not an object`);
  }
  const obj = raw as Record<string, unknown>;
  const direction = obj.direction;
  if (direction !== 'send' && direction !== 'recv') {
    throw new Error(
      `transcriptFromNdjson: line ${lineNo} has invalid direction: ${String(direction)}`,
    );
  }
  const messageName = obj.messageName;
  if (typeof messageName !== 'string') {
    throw new Error(`transcriptFromNdjson: line ${lineNo} missing string messageName`);
  }
  const typeCrc = obj.typeCrc;
  if (typeof typeCrc !== 'number') {
    throw new Error(`transcriptFromNdjson: line ${lineNo} missing number typeCrc`);
  }
  const bytes = obj.bytes;
  if (typeof bytes !== 'string') {
    throw new Error(`transcriptFromNdjson: line ${lineNo} missing string bytes`);
  }
  const at = obj.at;
  if (typeof at !== 'number') {
    throw new Error(`transcriptFromNdjson: line ${lineNo} missing number at`);
  }
  const payload = bytesFromHex(bytes);
  if (direction === 'send') {
    return { direction: 'send', messageName, typeCrc, payload, at };
  }
  // recv
  const decodedRaw = obj.decoded;
  // For lossless replay we re-derive `decoded` from the payload bytes when
  // possible — keeps the resulting in-memory CapturedEvent's `decoded`
  // field as a live GameNetworkMessage instance.
  let decoded: GameNetworkMessage | null = null;
  if (decodedRaw !== null && decodedRaw !== undefined && payload.length >= 6) {
    try {
      const { payload: iter, typeCrc: crc } = parseHeader(payload);
      const decoder = messageRegistry.getByCrc(crc);
      if (decoder !== undefined) {
        decoded = decoder.decodePayload(iter);
      }
    } catch {
      // leave decoded as null — the decodeError field below will indicate why
    }
  }
  const out: CapturedEvent = {
    direction: 'recv',
    messageName,
    typeCrc,
    payload,
    at,
    decoded,
  };
  if (obj.unknownCrc === true) out.unknownCrc = true;
  if (typeof obj.decodeError === 'string') out.decodeError = obj.decodeError;
  return out;
}

function hexFromBytes(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('hex');
}

function bytesFromHex(hex: string): Uint8Array {
  if (hex === '') return new Uint8Array();
  if ((hex.length & 1) !== 0) {
    throw new Error(`bytesFromHex: odd-length hex string (${hex.length} chars)`);
  }
  const buf = Buffer.from(hex, 'hex');
  if (buf.length !== hex.length / 2) {
    throw new Error('bytesFromHex: invalid hex characters in input');
  }
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

/**
 * Normalize a value for JSON serialization. Mirrors `lifecycleResultToJSON`'s
 * approach (bigints, Uint8Array, Date) plus Set support.
 */
function normalize(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Uint8Array) {
    return hexFromBytes(value);
  }
  if (value instanceof Set) {
    return [...value].map(normalize);
  }
  if (value instanceof Map) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of value) out[String(k)] = normalize(v);
    return out;
  }
  if (Array.isArray(value)) return value.map(normalize);
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = normalize(v);
    }
    return out;
  }
  return value;
}
