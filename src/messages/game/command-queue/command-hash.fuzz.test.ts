import fc from 'fast-check';
import { describe, it } from 'vitest';

import { hashCommand } from './command-hash.js';

describe('hashCommand (fuzz)', () => {
  it('is case-insensitive for any ASCII command name', () => {
    fc.assert(
      fc.property(
        fc.string({ unit: fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789'.split('')) }),
        (name) => {
          const lower = name.toLowerCase();
          const upper = name.toUpperCase();
          return hashCommand(lower) === hashCommand(upper);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('always returns a u32 (non-negative, < 2^32)', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 32 }), (name) => {
        const h = hashCommand(name);
        return h >= 0 && h < 2 ** 32;
      }),
      { numRuns: 200 },
    );
  });
});
