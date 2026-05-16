import fc from 'fast-check';
import { describe, it } from 'vitest';

import { assertWireEqual, roundTrip } from '../_fuzz-helpers.js';
import { CmdSceneReady } from './cmd-scene-ready.js';

describe('CmdSceneReady (fuzz)', () => {
  it('round-trips every encode -> decode (empty body)', () => {
    fc.assert(
      fc.property(fc.constant(new CmdSceneReady()), (m) => {
        const decoded = roundTrip(m, CmdSceneReady);
        assertWireEqual(decoded, m);
      }),
      { numRuns: 50 },
    );
  });
});
