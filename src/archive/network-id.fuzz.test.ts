/**
 * Property-based round-trip coverage for NetworkIdCodec — signed i64
 * bigint over the full [-2^63, 2^63 - 1] range.
 */

import fc from 'fast-check';
import { describe, it } from 'vitest';

import { assertWireEqual, fcNetworkId, roundTripCodec } from '../messages/_fuzz-helpers.js';
import { NetworkIdCodec } from './network-id.js';

describe('NetworkIdCodec (fuzz)', () => {
  it('round-trips every signed i64', () => {
    fc.assert(
      fc.property(fcNetworkId(), (id) => {
        const out = roundTripCodec(id, NetworkIdCodec.encode, NetworkIdCodec.decode);
        assertWireEqual(out, id);
      }),
      { numRuns: 500 },
    );
  });

  it('round-trips the signed range boundary values', () => {
    const boundaries = [
      -(1n << 63n), // INT64_MIN
      (1n << 63n) - 1n, // INT64_MAX
      0n,
      1n,
      -1n,
      (1n << 32n) - 1n, // UINT32_MAX
      1n << 32n, // 2^32
      (1n << 63n) - 1n, // INT64_MAX
    ];
    for (const id of boundaries) {
      const out = roundTripCodec(id, NetworkIdCodec.encode, NetworkIdCodec.decode);
      assertWireEqual(out, id);
    }
  });
});
