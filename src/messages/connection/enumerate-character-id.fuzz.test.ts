import fc from 'fast-check';
import { describe, it } from 'vitest';

import {
  assertWireEqual,
  fcI32,
  fcNetworkId,
  fcU32,
  fcUnicodeString,
  roundTrip,
} from '../_fuzz-helpers.js';
import { type CharacterRow, EnumerateCharacterId } from './enumerate-character-id.js';

const fcCharacterRow = (): fc.Arbitrary<CharacterRow> =>
  fc.record({
    name: fcUnicodeString({ maxLen: 32 }),
    objectTemplateId: fcI32(),
    networkId: fcNetworkId(),
    clusterId: fcU32(),
    characterType: fcI32(),
  });

describe('EnumerateCharacterId (fuzz)', () => {
  it('round-trips arbitrary character lists', () => {
    fc.assert(
      fc.property(fc.array(fcCharacterRow(), { maxLength: 16 }), (chars) => {
        const m = new EnumerateCharacterId(chars);
        const decoded = roundTrip(m, EnumerateCharacterId);
        assertWireEqual(decoded.characters, m.characters);
      }),
      { numRuns: 100 },
    );
  });

  it('round-trips the empty list', () => {
    const m = new EnumerateCharacterId([]);
    const decoded = roundTrip(m, EnumerateCharacterId);
    assertWireEqual(decoded.characters, []);
  });
});
