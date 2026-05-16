import { describe, expect, it } from 'vitest';
import { ByteStream } from '../../../archive/byte-stream.js';
import { ReadIterator } from '../../../archive/read-iterator.js';
import { CombatSpamDataType, CombatSpamDecoder, CombatSpamKind } from './combat-spam.js';
import { ObjControllerSubtypeIds, objControllerRegistry } from './registry.js';

describe('CombatSpam (CM_combatSpam)', () => {
  it('has the right metadata', () => {
    expect(CombatSpamDecoder.kind).toBe(CombatSpamKind);
    expect(CombatSpamDecoder.subtypeId).toBe(ObjControllerSubtypeIds.CM_combatSpam);
    expect(CombatSpamDecoder.subtypeId).toBe(308);
  });

  it('self-registers in the subtype registry', () => {
    expect(objControllerRegistry.getById(308)).toBe(CombatSpamDecoder);
  });

  it('round-trips a MessageData (Unicode spam) variant', () => {
    const s = new ByteStream();
    CombatSpamDecoder.encode(s, {
      dataType: CombatSpamDataType.MessageData,
      attacker: 100n,
      attackerPosition: { x: 1, y: 2, z: 3 },
      defender: 200n,
      defenderPosition: { x: 4, y: 5, z: 6 },
      spamMessage: 'You hit the rancor.',
      critical: false,
      glancing: false,
      proc: false,
      spamType: 1,
    });
    const d = CombatSpamDecoder.decode(new ReadIterator(s.toBytes()));
    expect(d.dataType).toBe(CombatSpamDataType.MessageData);
    expect(d.attacker).toBe(100n);
    expect(d.defender).toBe(200n);
    expect(d.spamMessage).toBe('You hit the rancor.');
    expect(d.critical).toBe(false);
    expect(d.spamType).toBe(1);
  });

  it('round-trips an AttackDataWeaponObject hit (success=true)', () => {
    const s = new ByteStream();
    CombatSpamDecoder.encode(s, {
      dataType: CombatSpamDataType.AttackDataWeaponObject,
      attacker: 100n,
      attackerPosition: { x: 0, y: 0, z: 0 },
      defender: 200n,
      defenderPosition: { x: 10, y: 0, z: 10 },
      weapon: 1000n,
      attackName: { table: 'cmd_n', textIndex: 0, name: 'rifleshot1' },
      success: true,
      hitDetails: {
        armor: 5000n,
        rawDamage: 500,
        damageType: 1,
        elementalDamage: 0,
        elementalDamageType: 0,
        bleedDamage: 0,
        critDamage: 100,
        blockedDamage: 0,
        finalDamage: 600,
        hitLocation: 2,
        crushing: false,
        strikethrough: false,
        strikethroughAmount: 0,
        evadeResult: false,
        evadeAmount: 0,
        blockResult: false,
        block: 0,
      },
      critical: true,
      glancing: false,
      proc: false,
      spamType: 0,
    });
    const d = CombatSpamDecoder.decode(new ReadIterator(s.toBytes()));
    expect(d.dataType).toBe(CombatSpamDataType.AttackDataWeaponObject);
    expect(d.weapon).toBe(1000n);
    expect(d.attackName?.name).toBe('rifleshot1');
    expect(d.success).toBe(true);
    expect(d.hitDetails?.rawDamage).toBe(500);
    expect(d.hitDetails?.finalDamage).toBe(600);
    expect(d.hitDetails?.critDamage).toBe(100);
    expect(d.critical).toBe(true);
  });

  it('round-trips an AttackDataWeaponObject miss (success=false, parry)', () => {
    const s = new ByteStream();
    CombatSpamDecoder.encode(s, {
      dataType: CombatSpamDataType.AttackDataWeaponObject,
      attacker: 100n,
      attackerPosition: { x: 0, y: 0, z: 0 },
      defender: 200n,
      defenderPosition: { x: 1, y: 0, z: 1 },
      weapon: 1000n,
      attackName: { table: 'cmd_n', textIndex: 0, name: 'punch1' },
      success: false,
      missDetails: { dodge: false, parry: true },
      critical: false,
      glancing: false,
      proc: false,
      spamType: 0,
    });
    const d = CombatSpamDecoder.decode(new ReadIterator(s.toBytes()));
    expect(d.success).toBe(false);
    expect(d.missDetails?.dodge).toBe(false);
    expect(d.missDetails?.parry).toBe(true);
    expect(d.hitDetails).toBeUndefined();
  });

  it('round-trips an AttackDataWeaponName variant (StringId weapon)', () => {
    const s = new ByteStream();
    CombatSpamDecoder.encode(s, {
      dataType: CombatSpamDataType.AttackDataWeaponName,
      attacker: 100n,
      attackerPosition: { x: 0, y: 0, z: 0 },
      defender: 200n,
      defenderPosition: { x: 0, y: 0, z: 0 },
      weaponName: { table: 'weapon_n', textIndex: 0, name: 'creature_weapon' },
      attackName: { table: 'cmd_n', textIndex: 0, name: 'bite' },
      success: true,
      hitDetails: {
        armor: 0n,
        rawDamage: 50,
        damageType: 0,
        elementalDamage: 0,
        elementalDamageType: 0,
        bleedDamage: 0,
        critDamage: 0,
        blockedDamage: 0,
        finalDamage: 50,
        hitLocation: 0,
        crushing: false,
        strikethrough: false,
        strikethroughAmount: 0,
        evadeResult: false,
        evadeAmount: 0,
        blockResult: false,
        block: 0,
      },
      critical: false,
      glancing: false,
      proc: false,
      spamType: 0,
    });
    const d = CombatSpamDecoder.decode(new ReadIterator(s.toBytes()));
    expect(d.dataType).toBe(CombatSpamDataType.AttackDataWeaponName);
    expect(d.weaponName?.name).toBe('creature_weapon');
    expect(d.weapon).toBeUndefined();
    expect(d.success).toBe(true);
    expect(d.hitDetails?.finalDamage).toBe(50);
  });
});
