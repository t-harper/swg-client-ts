import fc from 'fast-check';
import { describe, it } from 'vitest';

import {
  assertWireEqual,
  fcF32,
  fcI32,
  fcNetworkId,
  fcStdString,
  fcU32,
  fcUnicodeString,
  roundTripCodec,
} from '../../_fuzz-helpers.js';
import {
  type CombatSpamData,
  CombatSpamDataType,
  CombatSpamDecoder,
  type CombatSpamHitDetails,
  type CombatSpamMissDetails,
  type StringIdValue,
} from './combat-spam.js';

const fcStringId = (): fc.Arbitrary<StringIdValue> =>
  fc.record({
    table: fcStdString({ maxLen: 32 }),
    textIndex: fcU32(),
    name: fcStdString({ maxLen: 32 }),
  });

const fcVector3 = (): fc.Arbitrary<{ x: number; y: number; z: number }> =>
  fc.record({ x: fcF32(), y: fcF32(), z: fcF32() });

const fcHitDetails = (): fc.Arbitrary<CombatSpamHitDetails> =>
  fc.record({
    armor: fcNetworkId(),
    rawDamage: fcI32(),
    damageType: fcI32(),
    elementalDamage: fcI32(),
    elementalDamageType: fcI32(),
    bleedDamage: fcI32(),
    critDamage: fcI32(),
    blockedDamage: fcI32(),
    finalDamage: fcI32(),
    hitLocation: fcI32(),
    crushing: fc.boolean(),
    strikethrough: fc.boolean(),
    strikethroughAmount: fcF32(),
    evadeResult: fc.boolean(),
    evadeAmount: fcF32(),
    blockResult: fc.boolean(),
    block: fcI32(),
  });

const fcMissDetails = (): fc.Arbitrary<CombatSpamMissDetails> =>
  fc.record({
    dodge: fc.boolean(),
    parry: fc.boolean(),
  });

// MessageData variant: only spamMessage + common tail fields are present.
const fcMessageData = (): fc.Arbitrary<CombatSpamData> =>
  fc.record({
    dataType: fc.constant(CombatSpamDataType.MessageData),
    attacker: fcNetworkId(),
    attackerPosition: fcVector3(),
    defender: fcNetworkId(),
    defenderPosition: fcVector3(),
    spamMessage: fcUnicodeString({ maxLen: 128 }),
    critical: fc.boolean(),
    glancing: fc.boolean(),
    proc: fc.boolean(),
    spamType: fcI32(),
  });

const fcAttackHitWeaponObject = (): fc.Arbitrary<CombatSpamData> =>
  fc.record({
    dataType: fc.constant(CombatSpamDataType.AttackDataWeaponObject),
    attacker: fcNetworkId(),
    attackerPosition: fcVector3(),
    defender: fcNetworkId(),
    defenderPosition: fcVector3(),
    weapon: fcNetworkId(),
    attackName: fcStringId(),
    success: fc.constant(true),
    hitDetails: fcHitDetails(),
    critical: fc.boolean(),
    glancing: fc.boolean(),
    proc: fc.boolean(),
    spamType: fcI32(),
  });

const fcAttackMissWeaponObject = (): fc.Arbitrary<CombatSpamData> =>
  fc.record({
    dataType: fc.constant(CombatSpamDataType.AttackDataWeaponObject),
    attacker: fcNetworkId(),
    attackerPosition: fcVector3(),
    defender: fcNetworkId(),
    defenderPosition: fcVector3(),
    weapon: fcNetworkId(),
    attackName: fcStringId(),
    success: fc.constant(false),
    missDetails: fcMissDetails(),
    critical: fc.boolean(),
    glancing: fc.boolean(),
    proc: fc.boolean(),
    spamType: fcI32(),
  });

const fcAttackHitWeaponName = (): fc.Arbitrary<CombatSpamData> =>
  fc.record({
    dataType: fc.constant(CombatSpamDataType.AttackDataWeaponName),
    attacker: fcNetworkId(),
    attackerPosition: fcVector3(),
    defender: fcNetworkId(),
    defenderPosition: fcVector3(),
    weaponName: fcStringId(),
    attackName: fcStringId(),
    success: fc.constant(true),
    hitDetails: fcHitDetails(),
    critical: fc.boolean(),
    glancing: fc.boolean(),
    proc: fc.boolean(),
    spamType: fcI32(),
  });

const fcAttackMissWeaponName = (): fc.Arbitrary<CombatSpamData> =>
  fc.record({
    dataType: fc.constant(CombatSpamDataType.AttackDataWeaponName),
    attacker: fcNetworkId(),
    attackerPosition: fcVector3(),
    defender: fcNetworkId(),
    defenderPosition: fcVector3(),
    weaponName: fcStringId(),
    attackName: fcStringId(),
    success: fc.constant(false),
    missDetails: fcMissDetails(),
    critical: fc.boolean(),
    glancing: fc.boolean(),
    proc: fc.boolean(),
    spamType: fcI32(),
  });

describe('CombatSpam (fuzz)', () => {
  it('round-trips MessageData variants', () => {
    fc.assert(
      fc.property(fcMessageData(), (data) => {
        const out = roundTripCodec(data, CombatSpamDecoder.encode, CombatSpamDecoder.decode);
        assertWireEqual(out, data);
      }),
      { numRuns: 100 },
    );
  });

  it('round-trips AttackDataWeaponObject hit variants', () => {
    fc.assert(
      fc.property(fcAttackHitWeaponObject(), (data) => {
        const out = roundTripCodec(data, CombatSpamDecoder.encode, CombatSpamDecoder.decode);
        assertWireEqual(out, data);
      }),
      { numRuns: 50 },
    );
  });

  it('round-trips AttackDataWeaponObject miss variants', () => {
    fc.assert(
      fc.property(fcAttackMissWeaponObject(), (data) => {
        const out = roundTripCodec(data, CombatSpamDecoder.encode, CombatSpamDecoder.decode);
        assertWireEqual(out, data);
      }),
      { numRuns: 50 },
    );
  });

  it('round-trips AttackDataWeaponName hit variants', () => {
    fc.assert(
      fc.property(fcAttackHitWeaponName(), (data) => {
        const out = roundTripCodec(data, CombatSpamDecoder.encode, CombatSpamDecoder.decode);
        assertWireEqual(out, data);
      }),
      { numRuns: 50 },
    );
  });

  it('round-trips AttackDataWeaponName miss variants', () => {
    fc.assert(
      fc.property(fcAttackMissWeaponName(), (data) => {
        const out = roundTripCodec(data, CombatSpamDecoder.encode, CombatSpamDecoder.decode);
        assertWireEqual(out, data);
      }),
      { numRuns: 50 },
    );
  });
});
