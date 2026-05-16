import fc from 'fast-check';
import { describe, it } from 'vitest';

import { assertWireEqual, fcF32, fcNetworkId, fcU32, roundTrip } from '../_fuzz-helpers.js';
import { SceneCreateObjectByCrc } from './scene-create-object-by-crc.js';

describe('SceneCreateObjectByCrc (fuzz)', () => {
  it('round-trips arbitrary payloads', () => {
    fc.assert(
      fc.property(
        fcNetworkId(),
        fc.record({
          rotation: fc.record({ x: fcF32(), y: fcF32(), z: fcF32(), w: fcF32() }),
          position: fc.record({ x: fcF32(), y: fcF32(), z: fcF32() }),
        }),
        fcU32(),
        fc.boolean(),
        (id, transform, crc, hyperspace) => {
          const m = new SceneCreateObjectByCrc(id, transform, crc, hyperspace);
          const decoded = roundTrip(m, SceneCreateObjectByCrc);
          assertWireEqual(
            {
              networkId: decoded.networkId,
              transform: decoded.transform,
              templateCrc: decoded.templateCrc,
              hyperspace: decoded.hyperspace,
            },
            {
              networkId: m.networkId,
              transform: m.transform,
              templateCrc: m.templateCrc,
              hyperspace: m.hyperspace,
            },
          );
        },
      ),
      { numRuns: 200 },
    );
  });
});
