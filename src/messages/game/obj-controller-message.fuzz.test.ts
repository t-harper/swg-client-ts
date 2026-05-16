/**
 * Property-based round-trip coverage for ObjControllerMessage. The
 * variable-length trailer is encoded verbatim and the decoder also
 * attempts subtype dispatch — we only assert the header fields + raw
 * `data` trailer round-trip (the decoded `decodedSubtype` shape depends
 * on the registry state which is exercised by per-subtype fuzz files).
 *
 * Trailer bytes are limited to controller-message subtypes the registry
 * does NOT decode (decodedSubtype === null), which keeps this test
 * independent of whether subtypes change shape.
 */

import fc from 'fast-check';
import { describe, it } from 'vitest';

import { assertWireEqual, fcF32, fcNetworkId, fcU32, roundTrip } from '../_fuzz-helpers.js';
import { ObjControllerMessage } from './obj-controller-message.js';
import { ObjControllerSubtypeIds } from './obj-controller/registry.js';

// Pick a subtype id that's NOT in the registry so dispatch returns null
// and the trailer round-trips as-is.
const REGISTERED_SUBTYPE_IDS = Object.values(ObjControllerSubtypeIds) as readonly number[];
const fcUnregisteredSubtype = (): fc.Arbitrary<number> =>
  fcU32().filter((v) => !REGISTERED_SUBTYPE_IDS.includes(v & 0x7fffffff));

describe('ObjControllerMessage (fuzz)', () => {
  it('round-trips arbitrary header + opaque trailer', () => {
    fc.assert(
      fc.property(
        fcU32(),
        fcUnregisteredSubtype(),
        fcNetworkId(),
        fcF32(),
        fc.uint8Array({ maxLength: 64 }),
        (flags, message, networkId, value, trailer) => {
          const m = new ObjControllerMessage(flags, message | 0, networkId, value, trailer);
          const decoded = roundTrip(m, ObjControllerMessage);
          assertWireEqual(
            {
              flags: decoded.flags,
              message: decoded.message,
              networkId: decoded.networkId,
              value: decoded.value,
              data: decoded.data,
            },
            {
              flags: m.flags,
              message: m.message,
              networkId: m.networkId,
              value: m.value,
              data: m.data,
            },
          );
        },
      ),
      { numRuns: 100 },
    );
  });

  it('round-trips an empty trailer', () => {
    const m = new ObjControllerMessage(0, 0x7fff_0001, 0n, 0, new Uint8Array(0));
    const decoded = roundTrip(m, ObjControllerMessage);
    assertWireEqual(decoded.data, new Uint8Array(0));
  });
});
