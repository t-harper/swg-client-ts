import fc from 'fast-check';
import { describe, it } from 'vitest';

import { assertWireEqual, fcF32, fcNetworkId, fcStdString, roundTrip } from '../_fuzz-helpers.js';
import { SceneCreateObjectByName } from './scene-create-object-by-name.js';

describe('SceneCreateObjectByName (fuzz)', () => {
  it('round-trips arbitrary payloads', () => {
    fc.assert(
      fc.property(
        fcNetworkId(),
        fc.record({
          rotation: fc.record({ x: fcF32(), y: fcF32(), z: fcF32(), w: fcF32() }),
          position: fc.record({ x: fcF32(), y: fcF32(), z: fcF32() }),
        }),
        fcStdString({ maxLen: 128 }),
        fc.boolean(),
        (id, transform, name, hyperspace) => {
          const m = new SceneCreateObjectByName(id, transform, name, hyperspace);
          const decoded = roundTrip(m, SceneCreateObjectByName);
          assertWireEqual(
            {
              networkId: decoded.networkId,
              transform: decoded.transform,
              templateName: decoded.templateName,
              hyperspace: decoded.hyperspace,
            },
            {
              networkId: m.networkId,
              transform: m.transform,
              templateName: m.templateName,
              hyperspace: m.hyperspace,
            },
          );
        },
      ),
      { numRuns: 200 },
    );
  });
});
