import fc from 'fast-check';
import { describe, it } from 'vitest';

import {
  assertWireEqual,
  fcNetworkId,
  fcU32,
  fcUnicodeString,
  roundTripCodec,
} from '../../_fuzz-helpers.js';
import { CommandQueueEnqueue } from './command-queue-enqueue.js';

describe('CommandQueueEnqueue (fuzz)', () => {
  it('round-trips arbitrary (sequenceId, commandHash, targetId, params) payloads', () => {
    fc.assert(
      fc.property(
        fcU32(),
        fcU32(),
        fcNetworkId(),
        fcUnicodeString({ maxLen: 64 }),
        (seq, hash, target, params) => {
          const orig = new CommandQueueEnqueue(seq, hash, target, params);
          const decoded = roundTripCodec(
            orig,
            (s, v) => v.pack(s),
            (iter) => CommandQueueEnqueue.unpack(iter),
          );
          assertWireEqual(
            {
              seq: decoded.sequenceId,
              hash: decoded.commandHash,
              target: decoded.targetId,
              params: decoded.params,
            },
            {
              seq: orig.sequenceId,
              hash: orig.commandHash,
              target: orig.targetId,
              params: orig.params,
            },
          );
        },
      ),
      { numRuns: 200 },
    );
  });
});
