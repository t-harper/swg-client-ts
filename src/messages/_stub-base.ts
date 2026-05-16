/**
 * TEMPORARY STUB — Stream C scaffolding while Stream B implements the real
 * `base.ts` and `registry.ts`.
 *
 * After Phase 2 merge:
 *  1. Delete this file.
 *  2. Replace `from '../_stub-base.js'` imports in every concrete message
 *     class with imports from the real modules:
 *       - `GameNetworkMessage`        from `../base.js`
 *       - `MessageDirection`          from `../interface.js`
 *       - `registerMessage` / `constcrc` from the real registry/crc modules.
 *
 * What's stubbed:
 *  - `GameNetworkMessage` retains the same abstract shape as the public
 *    interface, but is concrete enough to be subclassed at compile time.
 *  - `constcrc(name)` always returns 0 here. The real one (Stream B) uses
 *    the custom CrcConstexpr.hpp table; we can't reproduce it without
 *    duplicating that work. The runtime invariant is "two distinct names
 *    must produce two distinct CRCs"; the stub doesn't satisfy that, so
 *    `registerMessage` would collide. We avoid the collision by making
 *    `registerMessage` a no-op stub.
 */

import type { IByteStream, IReadIterator } from '../archive/interface.js';
import type { MessageDecoder } from './interface.js';
import { GameNetworkMessage as RealGameNetworkMessage } from './interface.js';

// Re-export the abstract base from the public interface so subclasses can
// extend a single type. The real implementation in Stream B will provide
// additional helpers (header encode/decode) but the public shape is fixed.
export { RealGameNetworkMessage as GameNetworkMessage };

/**
 * Stub for `constcrc(messageName)`. Real implementation lives in
 * `src/crc/constcrc.ts` (Stream B) and uses the algorithm + table from
 *   /home/tharper/code/swg-main/src/engine/shared/library/sharedFoundation/include/public/sharedFoundation/CrcConstexpr.hpp
 *
 * Returns 0 — every message gets the same CRC, but that's fine because
 * `registerMessage` is also a stub. Post-merge, the real `constcrc` will
 * compute the actual CRC and the registry will dispatch correctly.
 */
export function constcrc(_name: string): number {
  return 0;
}

/** Stub registry storage so we can introspect from tests if needed. */
const stubRegistry = new Map<string, MessageDecoder>();

/**
 * Stub for `registerMessage`. No-op during Stream C development; real
 * implementation lives in `src/messages/registry.ts` (Stream B) and
 * indexes by `typeCrc`.
 */
export function registerMessage(decoder: MessageDecoder): void {
  // Use the name as the key (CRC would collide because constcrc=0).
  stubRegistry.set(decoder.messageName, decoder);
}

/** Test-only accessor for the stub registry. */
export function _stubRegistry(): ReadonlyMap<string, MessageDecoder> {
  return stubRegistry;
}

// Re-export the iterator/stream types so subclasses can import everything
// from a single barrel during development.
export type { IByteStream, IReadIterator };
