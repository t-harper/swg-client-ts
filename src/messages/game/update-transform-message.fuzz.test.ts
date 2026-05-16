import fc from 'fast-check';
import { describe, it } from 'vitest';

import { assertWireEqual, fcI8, fcI16, fcI32, fcNetworkId, roundTrip } from '../_fuzz-helpers.js';
import { UpdateTransformMessage } from './update-transform-message.js';

describe('UpdateTransformMessage (fuzz)', () => {
  it('round-trips arbitrary 22-byte fixed payloads', () => {
    fc.assert(
      fc.property(
        fcNetworkId(),
        fcI16(),
        fcI16(),
        fcI16(),
        fcI32(),
        fcI8(),
        fcI8(),
        fcI8(),
        fcI8(),
        (id, px, py, pz, seq, speed, yaw, lookYaw, useLook) => {
          const m = new UpdateTransformMessage(id, px, py, pz, seq, speed, yaw, lookYaw, useLook);
          const decoded = roundTrip(m, UpdateTransformMessage);
          assertWireEqual(
            {
              id: decoded.networkId,
              px: decoded.positionX,
              py: decoded.positionY,
              pz: decoded.positionZ,
              seq: decoded.sequenceNumber,
              speed: decoded.speed,
              yaw: decoded.yaw,
              lookYaw: decoded.lookAtYaw,
              useLook: decoded.useLookAtYaw,
            },
            {
              id: m.networkId,
              px: m.positionX,
              py: m.positionY,
              pz: m.positionZ,
              seq: m.sequenceNumber,
              speed: m.speed,
              yaw: m.yaw,
              lookYaw: m.lookAtYaw,
              useLook: m.useLookAtYaw,
            },
          );
        },
      ),
      { numRuns: 200 },
    );
  });
});
