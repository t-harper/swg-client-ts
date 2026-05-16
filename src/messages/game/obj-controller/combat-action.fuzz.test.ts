import fc from 'fast-check';
import { describe, it } from 'vitest';

import {
  assertWireEqual,
  fcF32,
  fcI8,
  fcI32,
  fcNetworkId,
  fcU8,
  fcU16,
  fcU32,
  roundTripCodec,
} from '../../_fuzz-helpers.js';
import {
  type CombatActionAttacker,
  CombatActionDecoder,
  type CombatActionDefender,
} from './combat-action.js';

const fcAttackerWithLocation = (): fc.Arbitrary<CombatActionAttacker> =>
  fc.record({
    id: fcNetworkId(),
    weapon: fcNetworkId(),
    endPosture: fcI8(),
    trailBits: fcU8(),
    clientEffectId: fcU8(),
    actionNameCrc: fcI32(),
    useLocation: fc.constant(true),
    targetLocation: fc.record({ x: fcF32(), y: fcF32(), z: fcF32() }),
    targetCell: fcNetworkId(),
  });

const fcAttackerNoLocation = (): fc.Arbitrary<CombatActionAttacker> =>
  fc.record({
    id: fcNetworkId(),
    weapon: fcNetworkId(),
    endPosture: fcI8(),
    trailBits: fcU8(),
    clientEffectId: fcU8(),
    actionNameCrc: fcI32(),
    useLocation: fc.constant(false),
    // The trailer doesn't include targetLocation / targetCell when
    // useLocation is false; we set defaults so the round-trip check
    // sees the same values.
    targetLocation: fc.constant({ x: 0, y: 0, z: 0 }),
    targetCell: fc.constant(0n),
  });

const fcDefender = (): fc.Arbitrary<CombatActionDefender> =>
  fc.record({
    id: fcNetworkId(),
    endPosture: fcI8(),
    defense: fcU8(),
    clientEffectId: fcU8(),
    hitLocation: fcU8(),
    damageAmount: fcU16(),
  });

describe('CombatAction (fuzz)', () => {
  it('round-trips arbitrary attacks WITHOUT location data', () => {
    fc.assert(
      fc.property(
        fc.record({
          actionId: fcU32(),
          attacker: fcAttackerNoLocation(),
          defenders: fc.array(fcDefender(), { maxLength: 8 }),
        }),
        (data) => {
          const out = roundTripCodec(data, CombatActionDecoder.encode, CombatActionDecoder.decode);
          assertWireEqual(out, data);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('round-trips arbitrary attacks WITH location data', () => {
    fc.assert(
      fc.property(
        fc.record({
          actionId: fcU32(),
          attacker: fcAttackerWithLocation(),
          defenders: fc.array(fcDefender(), { maxLength: 8 }),
        }),
        (data) => {
          const out = roundTripCodec(data, CombatActionDecoder.encode, CombatActionDecoder.decode);
          assertWireEqual(out, data);
        },
      ),
      { numRuns: 100 },
    );
  });
});
