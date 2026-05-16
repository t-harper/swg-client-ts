import fc from 'fast-check';
import { describe, it } from 'vitest';

import { assertWireEqual, fcF32, fcI32, fcU32, roundTripCodec } from '../../_fuzz-helpers.js';
import { CommandQueueRemove } from './command-queue-remove.js';

describe('CommandQueueRemove (fuzz)', () => {
  it('round-trips arbitrary (sequenceId, waitTime, status, statusDetail) payloads', () => {
    fc.assert(
      fc.property(fcU32(), fcF32(), fcI32(), fcI32(), (seq, wait, status, detail) => {
        const orig = new CommandQueueRemove(seq, wait, status, detail);
        const decoded = roundTripCodec(
          orig,
          (s, v) => v.pack(s),
          (iter) => CommandQueueRemove.unpack(iter),
        );
        assertWireEqual(
          {
            seq: decoded.sequenceId,
            wait: decoded.waitTime,
            status: decoded.status,
            detail: decoded.statusDetail,
          },
          {
            seq: orig.sequenceId,
            wait: orig.waitTime,
            status: orig.status,
            detail: orig.statusDetail,
          },
        );
      }),
      { numRuns: 200 },
    );
  });
});
