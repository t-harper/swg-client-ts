/**
 * Property-based round-trip coverage for CommandTimerData. The encoding is
 * flag-driven (only flagged time-state entries are serialized), so the
 * round-trip identity is over the SUBSET of `times` that actually has
 * entries plus the cooldown groups. The fuzz generator builds inputs with
 * a deterministic subset and asserts the same subset comes back.
 */

import fc from 'fast-check';
import { describe, it } from 'vitest';

import { assertWireEqual, fcF32, fcI32, fcU32, roundTripCodec } from '../../_fuzz-helpers.js';
import {
  CommandTimerData,
  type CommandTimerEntries,
  type CommandTimerEntry,
  CommandTimerFlag,
  NULL_COOLDOWN_GROUP,
} from './command-timer-data.js';

const fcTimerEntry = (): fc.Arbitrary<CommandTimerEntry> =>
  fc.record({ current: fcF32(), max: fcF32() });

/**
 * Generate an entries object that may or may not have each Flag set.
 * NOTE: the encoder treats `cooldownGroup`/`cooldownGroup2 !== -1` as the
 * authoritative source of Cooldown/Cooldown2 bits and emits time-pairs
 * for those when they're flagged. To round-trip cleanly we exercise the
 * non-cooldown flags freely; the Cooldown/Cooldown2 entries are tied to
 * non-(-1) cooldown groups below.
 */
const fcNonCooldownEntries = (): fc.Arbitrary<CommandTimerEntries> =>
  fc
    .record({
      warmup: fc.option(fcTimerEntry(), { nil: undefined }),
      execute: fc.option(fcTimerEntry(), { nil: undefined }),
      failed: fc.option(fcTimerEntry(), { nil: undefined }),
      failedRetry: fc.option(fcTimerEntry(), { nil: undefined }),
    })
    .map((opts) => {
      const out: CommandTimerEntries = {};
      if (opts.warmup) out[CommandTimerFlag.Warmup] = opts.warmup;
      if (opts.execute) out[CommandTimerFlag.Execute] = opts.execute;
      if (opts.failed) out[CommandTimerFlag.Failed] = opts.failed;
      if (opts.failedRetry) out[CommandTimerFlag.FailedRetry] = opts.failedRetry;
      return out;
    });

describe('CommandTimerData (fuzz)', () => {
  it('round-trips with cooldown groups absent and arbitrary non-cooldown flags', () => {
    fc.assert(
      fc.property(fcU32(), fcU32(), fcNonCooldownEntries(), (seq, crc, times) => {
        const orig = new CommandTimerData(
          seq,
          crc,
          NULL_COOLDOWN_GROUP,
          NULL_COOLDOWN_GROUP,
          times,
        );
        const decoded = roundTripCodec(
          orig,
          (s, v) => v.pack(s),
          (iter) => CommandTimerData.unpack(iter),
        );
        assertWireEqual(decoded.sequenceId, orig.sequenceId);
        assertWireEqual(decoded.commandNameCrc, orig.commandNameCrc);
        assertWireEqual(decoded.cooldownGroup, NULL_COOLDOWN_GROUP);
        assertWireEqual(decoded.cooldownGroup2, NULL_COOLDOWN_GROUP);
        // The encoder writes all-zero entries for keys present in `times`
        // — the round-trip preserves the original values.
        assertWireEqual(decoded.times, orig.times);
      }),
      { numRuns: 100 },
    );
  });

  it('round-trips with both cooldown groups set', () => {
    fc.assert(
      fc.property(
        fcU32(),
        fcU32(),
        fcI32().filter((v) => v !== NULL_COOLDOWN_GROUP),
        fcI32().filter((v) => v !== NULL_COOLDOWN_GROUP),
        fcTimerEntry(),
        fcTimerEntry(),
        (seq, crc, cd1, cd2, cdEntry, cd2Entry) => {
          const times: CommandTimerEntries = {
            [CommandTimerFlag.Cooldown]: cdEntry,
            [CommandTimerFlag.Cooldown2]: cd2Entry,
          };
          const orig = new CommandTimerData(seq, crc, cd1, cd2, times);
          const decoded = roundTripCodec(
            orig,
            (s, v) => v.pack(s),
            (iter) => CommandTimerData.unpack(iter),
          );
          assertWireEqual(decoded.cooldownGroup, cd1);
          assertWireEqual(decoded.cooldownGroup2, cd2);
          assertWireEqual(decoded.times, times);
        },
      ),
      { numRuns: 100 },
    );
  });
});
