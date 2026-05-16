/**
 * Property-based-testing helpers for the GameNetworkMessage round-trip
 * fuzz suite. Built on `fast-check` arbitraries with realistic ranges for
 * each wire primitive.
 *
 * Conventions:
 *   - fcU8 / fcI8 / ... : bounded integer arbitraries matching the wire range.
 *   - fcU64 / fcI64    : bigint arbitraries spanning the full signed/unsigned range.
 *   - fcF32 / fcF64    : floats excluding NaN (NaN is non-equal to itself and
 *                        breaks round-trip equality; codecs that special-case
 *                        NaN have their own dedicated tests).
 *   - fcStdString      : arbitrary string with realistic UTF-8 widths.
 *   - fcUnicodeString  : arbitrary string including BMP + non-surrogate-pair
 *                        codepoints. SWG's Unicode::String is wire-level UCS-2
 *                        (16-bit fixed code-units; no surrogate pair handling),
 *                        so we keep generated chars in the BMP excluding the
 *                        surrogate range so the round-trip preserves them.
 *   - fcNetworkId      : signed bigint NetworkId (full i64 range).
 *
 * Round-trip helpers:
 *   - `roundTripPayload(message, ctor)`: encode just the payload bytes
 *     (without the varCount + CRC header) and decode them, returning the
 *     decoded instance. Use this when you want to test the payload codec
 *     in isolation.
 *   - `roundTrip(message, ctor)`: encode via the full message framework
 *     (varCount + CRC + payload) and decode via the registry. Returns the
 *     decoded instance.
 *
 * Equality:
 *   - `assertWireEqual(actual, expected)`: deep-equal that handles bigints,
 *     Uint8Array, NetworkIds inside nested structures. Throws on mismatch.
 */

import fc from 'fast-check';
import { expect } from 'vitest';

import { ByteStream } from '../archive/byte-stream.js';
import type { IReadIterator } from '../archive/interface.js';
import { ReadIterator } from '../archive/read-iterator.js';
import { encodeMessage, parseHeader } from './base.js';
import type { GameNetworkMessage } from './interface.js';

// =============================================================================
// Numeric arbitraries
// =============================================================================

/** Unsigned 8-bit integer: [0, 255]. */
export const fcU8 = (): fc.Arbitrary<number> => fc.integer({ min: 0, max: 0xff });

/** Signed 8-bit integer: [-128, 127]. */
export const fcI8 = (): fc.Arbitrary<number> => fc.integer({ min: -0x80, max: 0x7f });

/** Unsigned 16-bit integer: [0, 65535]. */
export const fcU16 = (): fc.Arbitrary<number> => fc.integer({ min: 0, max: 0xffff });

/** Signed 16-bit integer: [-32768, 32767]. */
export const fcI16 = (): fc.Arbitrary<number> => fc.integer({ min: -0x8000, max: 0x7fff });

/** Unsigned 32-bit integer: [0, 2^32 - 1]. */
export const fcU32 = (): fc.Arbitrary<number> => fc.integer({ min: 0, max: 0xffffffff });

/** Signed 32-bit integer: [-2^31, 2^31 - 1]. */
export const fcI32 = (): fc.Arbitrary<number> => fc.integer({ min: -0x80000000, max: 0x7fffffff });

/** Unsigned 64-bit bigint: [0, 2^64 - 1]. */
export const fcU64 = (): fc.Arbitrary<bigint> => fc.bigInt({ min: 0n, max: (1n << 64n) - 1n });

/** Signed 64-bit bigint: [-2^63, 2^63 - 1]. */
export const fcI64 = (): fc.Arbitrary<bigint> =>
  fc.bigInt({ min: -(1n << 63n), max: (1n << 63n) - 1n });

/**
 * Single-precision float. Excludes NaN because NaN !== NaN breaks
 * round-trip equality; signed +/-0 and +/-Infinity are kept.
 *
 * fast-check's `fc.float()` defaults to 32-bit-exact values so the
 * value round-trips through writeF32/readF32 byte-for-byte.
 */
export const fcF32 = (): fc.Arbitrary<number> => fc.float({ noNaN: true });

/**
 * Double-precision float. Excludes NaN for the same reason as fcF32.
 */
export const fcF64 = (): fc.Arbitrary<number> => fc.double({ noNaN: true });

// =============================================================================
// NetworkId arbitrary
// =============================================================================

/**
 * NetworkId is i64 LE on the wire (signed bigint in TS).
 * Full range: [-2^63, 2^63 - 1].
 *
 * Important: SWG NetworkIds are conceptually unsigned but the codec goes
 * through int64; an "unsigned bit pattern above 2^63" round-trips to the
 * equivalent negative bigint. Tests that exercise both halves of the range
 * surface bugs in helper code that assumes positive-only.
 */
export const fcNetworkId = (): fc.Arbitrary<bigint> => fcI64();

// =============================================================================
// String arbitraries
// =============================================================================

/**
 * std::string arbitrary — a JS string whose UTF-8 byte length stays
 * under `maxLen`. The wire codec encodes via TextEncoder/TextDecoder, so
 * we let fast-check pick any unicode chars but constrain the byte count.
 *
 * Default maxLen = 256 (plenty for any field except chat bodies).
 */
export const fcStdString = (opts: { maxLen?: number } = {}): fc.Arbitrary<string> => {
  const maxLen = opts.maxLen ?? 256;
  // string16bits keeps the chars in the BMP (no astral plane characters
  // with surrogate pairs) which keeps UTF-8 byte length bounded at
  // roughly 3 * charCount. We then trim to maxLen on the JS-string side
  // since the wire is just bytes, and rely on the codec to compute the
  // actual UTF-8 byte length.
  return fc
    .string({ maxLength: Math.floor(maxLen / 3), unit: 'binary' })
    .filter((s) => Buffer.byteLength(s, 'utf-8') <= maxLen);
};

/**
 * Unicode::String arbitrary — JS string of UTF-16 code units. Excludes the
 * surrogate range U+D800..U+DFFF because SWG's wire codec is fixed-width
 * 16-bit and re-emits each code-unit verbatim; a lone surrogate read back
 * would still be the same lone surrogate, so round-trip equality holds,
 * but matched surrogate pairs in JS would round-trip as a same-length
 * string (writeUnicodeString uses `charCodeAt` not `codePointAt`, so an
 * astral codepoint reads back as the same two surrogates — which is
 * correct, just verbose). The simplest safe set is BMP-minus-surrogates.
 *
 * Note: chat messages use Unicode::String. The codec's char-count prefix
 * is in JS-string-length-equivalent units (UTF-16 code units), so a
 * string of length N takes 4 + 2*N bytes.
 */
export const fcUnicodeString = (opts: { maxLen?: number } = {}): fc.Arbitrary<string> => {
  const maxLen = opts.maxLen ?? 256;
  // We hand-build a string of single code-units to keep the wire shape
  // predictable. fc.string16bits would include surrogate halves which
  // round-trip correctly through the codec but produce visually awkward
  // outputs; for a fuzz suite the simpler distribution is fine.
  return fc
    .array(
      fc.integer({ min: 0x20, max: 0xd7ff }).chain((low) =>
        // 50/50 mix of low-BMP (printable ASCII + simple Latin) and
        // high-BMP-non-surrogate codepoints. Skipping surrogate range
        // [0xD800, 0xDFFF] keeps decoded strings byte-equal to encoded.
        fc.oneof(fc.constant(low), fc.integer({ min: 0xe000, max: 0xfffd })),
      ),
      { maxLength: maxLen },
    )
    .map((codes) => String.fromCharCode(...codes));
};

// =============================================================================
// Round-trip helpers
// =============================================================================

/** Decoder shape: a class with a static `decodePayload(iter)`. */
export interface PayloadDecoder<T> {
  decodePayload(iter: IReadIterator): T;
}

/**
 * Encode `message`'s payload into a fresh ByteStream and decode it back
 * via `ctor.decodePayload`. Returns the decoded instance. Asserts that
 * the iterator is exhausted (so we know we didn't drop any trailing bytes).
 *
 * This is the most common fuzz round-trip: it skips the varCount + CRC
 * header and just exercises the message-specific codec.
 */
export function roundTripPayload<M, T extends M>(
  message: M & { encodePayload(stream: ByteStream): void },
  ctor: PayloadDecoder<T>,
): T {
  const stream = new ByteStream();
  message.encodePayload(stream);
  const bytes = stream.toBytes();
  const iter = new ReadIterator(bytes);
  const decoded = ctor.decodePayload(iter);
  // Ensure the decoder consumed every byte.
  if (iter.remaining !== 0) {
    throw new Error(
      `roundTripPayload: decoder left ${iter.remaining}/${bytes.length} bytes unread`,
    );
  }
  return decoded;
}

/**
 * Encode a full message (varCount + CRC header + payload) and decode it
 * back through `ctor.decodePayload`. Catches header-framing bugs in
 * addition to payload codec issues.
 */
export function roundTrip<T extends GameNetworkMessage>(
  message: GameNetworkMessage,
  ctor: PayloadDecoder<T>,
): T {
  const bytes = encodeMessage(message);
  const { payload } = parseHeader(bytes);
  const decoded = ctor.decodePayload(payload);
  if (payload.remaining !== 0) {
    throw new Error(`roundTrip: decoder left ${payload.remaining} bytes unread after the header`);
  }
  return decoded;
}

/**
 * Round-trip a value through an encode/decode pair (codec round-trip,
 * no message framing). Returns the decoded value.
 */
export function roundTripCodec<T>(
  value: T,
  encode: (s: ByteStream, v: T) => void,
  decode: (iter: IReadIterator) => T,
): T {
  const stream = new ByteStream();
  encode(stream, value);
  const bytes = stream.toBytes();
  const iter = new ReadIterator(bytes);
  const out = decode(iter);
  if (iter.remaining !== 0) {
    throw new Error(`roundTripCodec: decoder left ${iter.remaining}/${bytes.length} bytes unread`);
  }
  return out;
}

// =============================================================================
// Deep-equal that handles bigint, Uint8Array, nested structures
// =============================================================================

function isObject(v: unknown): v is Record<string, unknown> {
  return (
    typeof v === 'object' &&
    v !== null &&
    !Array.isArray(v) &&
    !(v instanceof Uint8Array) &&
    !(v instanceof Map) &&
    !(v instanceof Set)
  );
}

/**
 * Structural equality test that handles primitives (including bigint),
 * arrays, plain objects, Uint8Array (byte-by-byte), Map (key/value pairs),
 * and Set (members). NaN equals NaN here (different from `===`).
 *
 * On mismatch, throws a descriptive Error including the path inside the
 * structure where the divergence was found.
 */
export function wireEqual(actual: unknown, expected: unknown, path = 'root'): void {
  if (typeof actual === 'bigint' || typeof expected === 'bigint') {
    if (actual !== expected) {
      throw new Error(`wireEqual: ${path} mismatch — got ${actual}n vs expected ${expected}n`);
    }
    return;
  }
  if (typeof actual === 'number' && typeof expected === 'number') {
    if (Number.isNaN(actual) && Number.isNaN(expected)) return;
    if (actual !== expected) {
      throw new Error(`wireEqual: ${path} mismatch — got ${actual} vs expected ${expected}`);
    }
    return;
  }
  if (actual instanceof Uint8Array && expected instanceof Uint8Array) {
    if (actual.length !== expected.length) {
      throw new Error(
        `wireEqual: ${path} byte-length mismatch — got ${actual.length} vs ${expected.length}`,
      );
    }
    for (let i = 0; i < actual.length; i++) {
      if (actual[i] !== expected[i]) {
        throw new Error(
          `wireEqual: ${path}[${i}] byte mismatch — got 0x${actual[i]?.toString(16)} vs 0x${expected[i]?.toString(16)}`,
        );
      }
    }
    return;
  }
  if (Array.isArray(actual) && Array.isArray(expected)) {
    if (actual.length !== expected.length) {
      throw new Error(
        `wireEqual: ${path} array length mismatch — got ${actual.length} vs ${expected.length}`,
      );
    }
    for (let i = 0; i < actual.length; i++) {
      wireEqual(actual[i], expected[i], `${path}[${i}]`);
    }
    return;
  }
  if (actual instanceof Map && expected instanceof Map) {
    if (actual.size !== expected.size) {
      throw new Error(
        `wireEqual: ${path} Map size mismatch — got ${actual.size} vs ${expected.size}`,
      );
    }
    for (const [k, v] of expected) {
      if (!actual.has(k)) {
        throw new Error(`wireEqual: ${path} Map missing key ${String(k)}`);
      }
      wireEqual(actual.get(k), v, `${path}.${String(k)}`);
    }
    return;
  }
  if (actual instanceof Set && expected instanceof Set) {
    if (actual.size !== expected.size) {
      throw new Error(
        `wireEqual: ${path} Set size mismatch — got ${actual.size} vs ${expected.size}`,
      );
    }
    for (const v of expected) {
      if (!actual.has(v)) {
        throw new Error(`wireEqual: ${path} Set missing value ${String(v)}`);
      }
    }
    return;
  }
  if (isObject(actual) && isObject(expected)) {
    const aKeys = Object.keys(actual).sort();
    const eKeys = Object.keys(expected).sort();
    // Allow extra computed fields on actual (e.g. subtypeCrcHex on
    // ObjControllerMessage which is derived in the ctor). We only check
    // that every expected key has a matching actual value.
    for (const k of eKeys) {
      wireEqual(actual[k], expected[k], `${path}.${k}`);
    }
    // Also verify there are no extra unexpected fields if expected
    // declares the same shape. We only flag mismatches strictly if both
    // have the same key set.
    if (aKeys.length === eKeys.length && aKeys.join('|') !== eKeys.join('|')) {
      throw new Error(
        `wireEqual: ${path} key-set mismatch — got [${aKeys.join(',')}] vs [${eKeys.join(',')}]`,
      );
    }
    return;
  }
  if (actual !== expected) {
    throw new Error(
      `wireEqual: ${path} mismatch — got ${String(actual)} (${typeof actual}) vs expected ${String(expected)} (${typeof expected})`,
    );
  }
}

/**
 * Vitest-friendly assertion. Wraps wireEqual but uses vitest's expect for
 * the inline equality check so failures report nicely. We still use
 * wireEqual to traverse — vitest's `toEqual` doesn't handle Map / Set /
 * bigint identically across versions, and wireEqual gives more precise
 * paths.
 */
export function assertWireEqual(actual: unknown, expected: unknown): void {
  try {
    wireEqual(actual, expected, 'root');
  } catch (e) {
    // Re-throw as a vitest assertion failure for better reporting
    expect.fail((e as Error).message);
  }
}
