import fc from 'fast-check';
import { describe, it } from 'vitest';

import {
  assertWireEqual,
  fcF32,
  fcI32,
  fcI64,
  fcNetworkId,
  fcStdString,
  roundTrip,
} from '../_fuzz-helpers.js';
import { CmdStartScene } from './cmd-start-scene.js';

describe('CmdStartScene (fuzz)', () => {
  it('round-trips arbitrary scene-init payloads', () => {
    fc.assert(
      fc.property(
        fc.record({
          playerNetworkId: fcNetworkId(),
          sceneName: fcStdString({ maxLen: 32 }),
          startPosition: fc.record({ x: fcF32(), y: fcF32(), z: fcF32() }),
          startYaw: fcF32(),
          templateName: fcStdString({ maxLen: 128 }),
          serverTimeSeconds: fcI64(),
          serverEpoch: fcI32(),
          disableWorldSnapshot: fc.boolean(),
        }),
        (params) => {
          const m = new CmdStartScene(params);
          const decoded = roundTrip(m, CmdStartScene);
          assertWireEqual(
            {
              playerNetworkId: decoded.playerNetworkId,
              sceneName: decoded.sceneName,
              startPosition: decoded.startPosition,
              startYaw: decoded.startYaw,
              templateName: decoded.templateName,
              serverTimeSeconds: decoded.serverTimeSeconds,
              serverEpoch: decoded.serverEpoch,
              disableWorldSnapshot: decoded.disableWorldSnapshot,
            },
            {
              playerNetworkId: m.playerNetworkId,
              sceneName: m.sceneName,
              startPosition: m.startPosition,
              startYaw: m.startYaw,
              templateName: m.templateName,
              serverTimeSeconds: m.serverTimeSeconds,
              serverEpoch: m.serverEpoch,
              disableWorldSnapshot: m.disableWorldSnapshot,
            },
          );
        },
      ),
      { numRuns: 100 },
    );
  });
});
