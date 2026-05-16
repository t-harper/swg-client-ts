import fc from 'fast-check';
import { describe, it } from 'vitest';

import { assertWireEqual, fcStdString, fcU32, roundTrip } from '../_fuzz-helpers.js';
import { ClientIdMsg } from './client-id-msg.js';

describe('ClientIdMsg (fuzz)', () => {
  it('round-trips arbitrary (gameBitsToClear, token, version) triples', () => {
    fc.assert(
      fc.property(
        fc.uint8Array({ maxLength: 256 }),
        fcU32(),
        fcStdString({ maxLen: 32 }),
        (token, gameBits, version) => {
          const m = new ClientIdMsg(token, gameBits, version);
          const decoded = roundTrip(m, ClientIdMsg);
          assertWireEqual(
            {
              token: decoded.token,
              bits: decoded.gameBitsToClear,
              ver: decoded.version,
            },
            { token: m.token, bits: m.gameBitsToClear, ver: m.version },
          );
        },
      ),
      { numRuns: 200 },
    );
  });

  it('round-trips an empty token', () => {
    const m = new ClientIdMsg(new Uint8Array(0), 0, '');
    const decoded = roundTrip(m, ClientIdMsg);
    assertWireEqual(decoded.token, new Uint8Array(0));
  });
});
