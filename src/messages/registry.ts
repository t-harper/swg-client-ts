/**
 * Singleton MessageRegistry — maps the 4-byte constcrc on the wire to the
 * decoder responsible for that message. Each concrete message module
 * self-registers at import time via `registerMessage()`.
 *
 * On the receive side, the SOE layer hands us raw app payloads. We:
 *   1. parseHeader(bytes) → { typeCrc, payload }
 *   2. registry.getByCrc(typeCrc) → decoder | undefined
 *   3. decoder.decodePayload(payload) → typed message
 *
 * Unknown CRCs are NOT registry errors — they are common (the server emits
 * many messages we don't model, like ObjControllerMessage / movement /
 * combat). Callers decide whether to log or ignore.
 */

import { parseHeader } from './base.js';
import type { GameNetworkMessage, IMessageRegistry, MessageDecoder } from './interface.js';

class MessageRegistry implements IMessageRegistry {
  private readonly byCrc = new Map<number, MessageDecoder>();
  private readonly byName = new Map<string, MessageDecoder>();

  register(decoder: MessageDecoder): void {
    const existing = this.byCrc.get(decoder.typeCrc);
    if (existing && existing !== decoder) {
      throw new Error(
        `CRC collision: ${decoder.messageName} and ${existing.messageName} both have CRC 0x${decoder.typeCrc.toString(16)}`,
      );
    }
    this.byCrc.set(decoder.typeCrc, decoder);
    this.byName.set(decoder.messageName, decoder);
  }

  getByCrc(crc: number): MessageDecoder | undefined {
    return this.byCrc.get(crc);
  }

  getByName(name: string): MessageDecoder | undefined {
    return this.byName.get(name);
  }

  /** Test helper — clear all registrations. NOT for production use. */
  clear(): void {
    this.byCrc.clear();
    this.byName.clear();
  }

  /** Iterate the registered decoders (useful for debugging). */
  entries(): IterableIterator<[number, MessageDecoder]> {
    return this.byCrc.entries();
  }
}

/** Process-wide singleton. */
export const messageRegistry = new MessageRegistry();

/**
 * Convenience: register a decoder and return it. Use in module-level
 * `const _ = registerMessage(asDecoder(MyMessage))`.
 */
export function registerMessage<T extends GameNetworkMessage>(
  decoder: MessageDecoder<T>,
): MessageDecoder<T> {
  messageRegistry.register(decoder);
  return decoder;
}

/**
 * High-level decode: take raw app-payload bytes off the SOE wire and
 * return a typed message instance. Throws if the buffer is shorter than
 * the 4-byte header. Returns `null` (NOT throwing) if the CRC is
 * registered but we don't have a decoder — callers can fall back to a
 * raw "unknown message" log.
 */
export function decodeMessage(bytes: Uint8Array): GameNetworkMessage | null {
  const { typeCrc, payload } = parseHeader(bytes);
  const decoder = messageRegistry.getByCrc(typeCrc);
  if (!decoder) {
    return null;
  }
  return decoder.decodePayload(payload);
}

/** Same as decodeMessage but throws on unknown CRC. Use in strict-test paths. */
export function decodeMessageStrict(bytes: Uint8Array): GameNetworkMessage {
  const { typeCrc, payload } = parseHeader(bytes);
  const decoder = messageRegistry.getByCrc(typeCrc);
  if (!decoder) {
    throw new Error(`Unknown message CRC 0x${typeCrc.toString(16).padStart(8, '0')}`);
  }
  return decoder.decodePayload(payload);
}
