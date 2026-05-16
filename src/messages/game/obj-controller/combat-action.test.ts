import { describe, expect, it } from 'vitest';
import { ByteStream } from '../../../archive/byte-stream.js';
import { ReadIterator } from '../../../archive/read-iterator.js';
import { CombatActionDecoder } from './combat-action.js';
import { ObjControllerSubtypeIds, objControllerRegistry } from './registry.js';

describe('CombatAction (CM_combatAction)', () => {
  it('has the right metadata', () => {
    expect(CombatActionDecoder.kind).toBe('CombatAction');
    expect(CombatActionDecoder.subtypeId).toBe(ObjControllerSubtypeIds.CM_combatAction);
    expect(CombatActionDecoder.subtypeId).toBe(204);
  });

  it('self-registers in the subtype registry', () => {
    expect(objControllerRegistry.getById(204)).toBe(CombatActionDecoder);
  });

  it('round-trips a single-defender hit with no targetLocation', () => {
    const s = new ByteStream();
    CombatActionDecoder.encode(s, {
      actionId: 0xabcd_1234,
      attacker: {
        id: 0x0011_2233_4455_6677n,
        weapon: 0x0077_6655_4433_2211n,
        endPosture: 0,
        trailBits: 0x03,
        clientEffectId: 7,
        actionNameCrc: 0x7fff_ffff,
        useLocation: false,
        targetLocation: { x: 0, y: 0, z: 0 },
        targetCell: 0n,
      },
      defenders: [
        {
          id: 0x00ab_cdef_1234_5678n,
          endPosture: 1,
          defense: 2, // hit
          clientEffectId: 11,
          hitLocation: 3,
          damageAmount: 250,
        },
      ],
    });
    // u32 actionId(4) + atk: 8+8+1+1+1+4+1 = 24 (no useLocation) = 28
    // defenderCount u16(2) + defender: 8+1+1+1+1+2 = 14 → 16
    // total: 4 + 24 + 16 = 44
    expect(s.toBytes().length).toBe(44);

    const d = CombatActionDecoder.decode(new ReadIterator(s.toBytes()));
    expect(d.actionId).toBe(0xabcd_1234);
    expect(d.attacker.id).toBe(0x0011_2233_4455_6677n);
    expect(d.attacker.weapon).toBe(0x0077_6655_4433_2211n);
    expect(d.attacker.endPosture).toBe(0);
    expect(d.attacker.trailBits).toBe(0x03);
    expect(d.attacker.clientEffectId).toBe(7);
    expect(d.attacker.actionNameCrc).toBe(0x7fff_ffff);
    expect(d.attacker.useLocation).toBe(false);
    expect(d.defenders.length).toBe(1);
    expect(d.defenders[0]?.id).toBe(0x00ab_cdef_1234_5678n);
    expect(d.defenders[0]?.endPosture).toBe(1);
    expect(d.defenders[0]?.defense).toBe(2);
    expect(d.defenders[0]?.clientEffectId).toBe(11);
    expect(d.defenders[0]?.hitLocation).toBe(3);
    expect(d.defenders[0]?.damageAmount).toBe(250);
  });

  it('round-trips an AoE-on-ground attack (useLocation=true) with multiple defenders', () => {
    const s = new ByteStream();
    CombatActionDecoder.encode(s, {
      actionId: 1,
      attacker: {
        id: 100n,
        weapon: 200n,
        endPosture: 0,
        trailBits: 0,
        clientEffectId: 0,
        actionNameCrc: 0,
        useLocation: true,
        targetLocation: { x: 100.5, y: 4.0, z: -200.75 },
        targetCell: 300n,
      },
      defenders: [
        {
          id: 1000n,
          endPosture: 0,
          defense: 1,
          clientEffectId: 0,
          hitLocation: 0,
          damageAmount: 50,
        },
        {
          id: 1001n,
          endPosture: 0,
          defense: 0, // miss
          clientEffectId: 0,
          hitLocation: 0,
          damageAmount: 0,
        },
      ],
    });
    const d = CombatActionDecoder.decode(new ReadIterator(s.toBytes()));
    expect(d.attacker.useLocation).toBe(true);
    expect(d.attacker.targetLocation.x).toBeCloseTo(100.5, 5);
    expect(d.attacker.targetLocation.z).toBeCloseTo(-200.75, 5);
    expect(d.attacker.targetCell).toBe(300n);
    expect(d.defenders.length).toBe(2);
    expect(d.defenders[1]?.damageAmount).toBe(0);
  });

  it('round-trips an attack with zero defenders', () => {
    const s = new ByteStream();
    CombatActionDecoder.encode(s, {
      actionId: 0,
      attacker: {
        id: 0n,
        weapon: 0n,
        endPosture: 0,
        trailBits: 0,
        clientEffectId: 0,
        actionNameCrc: 0,
        useLocation: false,
        targetLocation: { x: 0, y: 0, z: 0 },
        targetCell: 0n,
      },
      defenders: [],
    });
    const d = CombatActionDecoder.decode(new ReadIterator(s.toBytes()));
    expect(d.defenders.length).toBe(0);
  });
});
