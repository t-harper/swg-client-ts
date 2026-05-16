import fc from 'fast-check';
import { describe, it } from 'vitest';

import { assertWireEqual, fcStdString, roundTrip } from '../_fuzz-helpers.js';
import { CharacterCreationDisabled } from './character-creation-disabled.js';

describe('CharacterCreationDisabled (fuzz)', () => {
  it('round-trips arbitrary string-set payloads', () => {
    fc.assert(
      fc.property(fc.uniqueArray(fcStdString({ maxLen: 32 }), { maxLength: 16 }), (entries) => {
        const set = new Set(entries);
        const m = new CharacterCreationDisabled(set);
        const decoded = roundTrip(m, CharacterCreationDisabled);
        assertWireEqual(decoded.value, set);
      }),
      { numRuns: 100 },
    );
  });

  it('round-trips the empty set', () => {
    const empty = new Set<string>();
    const m = new CharacterCreationDisabled(empty);
    const decoded = roundTrip(m, CharacterCreationDisabled);
    assertWireEqual(decoded.value, empty);
  });
});
