import { describe, expect, it } from 'vitest';

import { ByteStream } from '../../../archive/byte-stream.js';
import { ReadIterator } from '../../../archive/read-iterator.js';
import { writeStdString } from '../../../archive/string.js';
import { writeMemberCount } from './auto-byte-stream.js';
import {
  type CreatureObjectSharedNpBaseline,
  CreatureObjectSharedNpDecoder,
  CreatureObjectSharedNpKind,
} from './creature-object-baseline-6.js';
import { BaselinePackageIds, ObjectTypeTags, baselineRegistry } from './registry.js';
import { StringIdCodec } from './string-id.js';

import './index.js';

/** Build a CreatureObject baseline 6 payload byte-by-byte. */
function buildPayload(data: CreatureObjectSharedNpBaseline): Uint8Array {
  const s = new ByteStream();
  writeMemberCount(s, 35);
  // ServerObject section
  s.writeU32(data.authServerProcessId);
  StringIdCodec.encode(s, data.descriptionStringId);
  // TangibleObject section
  s.writeBool(data.inCombat);
  s.writeU32(data.passiveRevealPlayerCharacter.length);
  s.writeU32(0);
  for (const id of data.passiveRevealPlayerCharacter) s.writeI64(id);
  s.writeU32(data.mapColorOverride);
  s.writeU32(data.accessList.length);
  s.writeU32(0);
  for (const id of data.accessList) s.writeI64(id);
  s.writeU32(data.guildAccessList.length);
  s.writeU32(0);
  for (const v of data.guildAccessList) s.writeI32(v);
  // effectsMap: AutoDeltaMap — [u32 size][u32 cmdCount=0][for each: u8 cmd=ADD(0), key, value]
  s.writeU32(data.effects.length);
  s.writeU32(0);
  for (const e of data.effects) {
    s.writeU8(0); // ADD
    writeStdString(s, e.name);
    writeStdString(s, e.effectScript);
    writeStdString(s, e.hardpoint);
    s.writeF32(e.offset.x);
    s.writeF32(e.offset.y);
    s.writeF32(e.offset.z);
    s.writeF32(e.scale);
  }
  // CreatureObject section
  s.writeI16(data.level);
  s.writeI32(data.levelHealthGranted);
  writeStdString(s, data.animatingSkillData);
  writeStdString(s, data.animationMood);
  s.writeI64(data.currentWeapon);
  s.writeI64(data.group);
  // PlayerAndShipPair = NetworkId + string + NetworkId
  s.writeI64(data.groupInviter.inviter);
  writeStdString(s, data.groupInviter.inviterName);
  s.writeI64(data.groupInviter.ship);
  s.writeI32(data.guildId);
  s.writeI64(data.lookAtTarget);
  s.writeI64(data.intendedTarget);
  s.writeU8(data.mood);
  s.writeI32(data.performanceStartTime);
  s.writeI32(data.performanceType);
  // totalAttributes: AutoDeltaVector<int>
  s.writeU32(data.totalAttributes.length);
  s.writeU32(0);
  for (const v of data.totalAttributes) s.writeI32(v);
  s.writeU32(data.totalMaxAttributes.length);
  s.writeU32(0);
  for (const v of data.totalMaxAttributes) s.writeI32(v);
  // wearableData: AutoDeltaVector<WearableEntry>
  s.writeU32(data.wearableData.length);
  s.writeU32(0);
  for (const w of data.wearableData) {
    writeStdString(s, w.appearanceString);
    s.writeI32(w.arrangement);
    s.writeI64(w.networkId);
    s.writeI32(w.objectTemplate);
    // isWeapon — we only encode non-weapon entries in tests
    s.writeBool(false);
  }
  writeStdString(s, data.alternateAppearanceSharedObjectTemplateName);
  s.writeBool(data.coverVisibility);
  // buffs: AutoDeltaMap<u32, PackedBuff>
  s.writeU32(data.buffs.length);
  s.writeU32(0);
  for (const b of data.buffs) {
    s.writeU8(0); // ADD
    s.writeU32(b.buffNameCrc);
    s.writeU32(b.buff.endtime);
    s.writeF32(b.buff.value);
    s.writeU32(b.buff.duration);
    s.writeI64(b.buff.caster);
    s.writeU32(b.buff.stackCount);
  }
  s.writeBool(data.clientUsesAnimationLocomotion);
  s.writeU8(data.difficulty);
  s.writeI32(data.hologramType);
  s.writeBool(data.visibleOnMapAndRadar);
  s.writeBool(data.isBeast);
  s.writeBool(data.forceShowHam);
  s.writeU32(data.wearableAppearanceData.length);
  s.writeU32(0);
  for (const w of data.wearableAppearanceData) {
    writeStdString(s, w.appearanceString);
    s.writeI32(w.arrangement);
    s.writeI64(w.networkId);
    s.writeI32(w.objectTemplate);
    s.writeBool(false);
  }
  s.writeI64(data.decoyOrigin);
  return s.toBytes();
}

function emptyBaseline(): CreatureObjectSharedNpBaseline {
  return {
    authServerProcessId: 0,
    descriptionStringId: { table: '', textIndex: 0, text: '' },
    inCombat: false,
    passiveRevealPlayerCharacter: [],
    mapColorOverride: 0,
    accessList: [],
    guildAccessList: [],
    effects: [],
    level: 1,
    levelHealthGranted: 0,
    animatingSkillData: '',
    animationMood: '',
    currentWeapon: 0n,
    group: 0n,
    groupInviter: { inviter: 0n, inviterName: '', ship: 0n },
    guildId: 0,
    lookAtTarget: 0n,
    intendedTarget: 0n,
    mood: 0,
    performanceStartTime: 0,
    performanceType: 0,
    totalAttributes: [],
    totalMaxAttributes: [],
    wearableData: [],
    alternateAppearanceSharedObjectTemplateName: '',
    coverVisibility: false,
    buffs: [],
    clientUsesAnimationLocomotion: false,
    difficulty: 0,
    hologramType: 0,
    visibleOnMapAndRadar: true,
    isBeast: false,
    forceShowHam: false,
    wearableAppearanceData: [],
    decoyOrigin: 0n,
  };
}

describe('CreatureObjectSharedNpDecoder', () => {
  it('is registered for (CREO, SHARED_NP=6)', () => {
    expect(CreatureObjectSharedNpDecoder.typeId).toBe(ObjectTypeTags.CREO);
    expect(CreatureObjectSharedNpDecoder.packageId).toBe(BaselinePackageIds.SHARED_NP);
    expect(CreatureObjectSharedNpDecoder.kind).toBe(CreatureObjectSharedNpKind);
    expect(CreatureObjectSharedNpDecoder.expectedMemberCount).toBe(35);
  });

  it('round-trips an empty / brand-new creature baseline', () => {
    const original = emptyBaseline();
    const bytes = buildPayload(original);
    const iter = new ReadIterator(bytes);
    const decoded = CreatureObjectSharedNpDecoder.decode(iter);
    expect(decoded.level).toBe(1);
    expect(decoded.wearableData).toEqual([]);
    expect(decoded.buffs).toEqual([]);
    expect(decoded.visibleOnMapAndRadar).toBe(true);
  });

  it('round-trips realistic combat-active state with attributes and a buff', () => {
    const original: CreatureObjectSharedNpBaseline = {
      ...emptyBaseline(),
      authServerProcessId: 12345,
      inCombat: true,
      level: 90,
      levelHealthGranted: 5000,
      animatingSkillData: 'mounted_animation',
      animationMood: 'happy',
      currentWeapon: 0x1234_5678_9abc_def0n,
      group: 0n,
      groupInviter: { inviter: 0x11n, inviterName: 'Foo', ship: 0n },
      lookAtTarget: 0xaaaaaaaaaaaaaaan,
      intendedTarget: 0xbbbbbbbbbbbbbn,
      mood: 5,
      totalAttributes: [1000, 100, 500, 50, 800, 80], // H,C,A,S,M,W
      totalMaxAttributes: [1500, 150, 750, 75, 1200, 120],
      coverVisibility: true,
      buffs: [
        {
          buffNameCrc: 0xdeadbeef,
          buff: {
            endtime: 1_700_000_000,
            value: 25,
            duration: 300,
            caster: 0x12345n,
            stackCount: 1,
          },
        },
      ],
      visibleOnMapAndRadar: true,
      difficulty: 2,
    };
    const bytes = buildPayload(original);
    const iter = new ReadIterator(bytes);
    const decoded = CreatureObjectSharedNpDecoder.decode(iter);
    expect(decoded.inCombat).toBe(true);
    expect(decoded.level).toBe(90);
    expect(decoded.totalAttributes).toEqual([1000, 100, 500, 50, 800, 80]);
    expect(decoded.totalMaxAttributes).toEqual([1500, 150, 750, 75, 1200, 120]);
    expect(decoded.buffs).toHaveLength(1);
    expect(decoded.buffs[0]?.buffNameCrc).toBe(0xdeadbeef);
    expect(decoded.buffs[0]?.buff.value).toBeCloseTo(25);
    expect(decoded.buffs[0]?.buff.caster).toBe(0x12345n);
    expect(decoded.lookAtTarget).toBe(0xaaaaaaaaaaaaaaan);
    expect(decoded.currentWeapon).toBe(0x1234_5678_9abc_def0n);
  });

  it('round-trips a non-empty wearableData (non-weapon)', () => {
    const original: CreatureObjectSharedNpBaseline = {
      ...emptyBaseline(),
      wearableData: [
        {
          appearanceString: '/app/torso.iff',
          arrangement: 5,
          networkId: 0x100n,
          objectTemplate: 0xcafe,
          weaponSharedBaselines: null,
          weaponSharedNpBaselines: null,
        },
      ],
    };
    const bytes = buildPayload(original);
    const iter = new ReadIterator(bytes);
    const decoded = CreatureObjectSharedNpDecoder.decode(iter);
    expect(decoded.wearableData).toHaveLength(1);
    expect(decoded.wearableData[0]?.appearanceString).toBe('/app/torso.iff');
    expect(decoded.wearableData[0]?.arrangement).toBe(5);
    expect(decoded.wearableData[0]?.networkId).toBe(0x100n);
  });

  it('found via baselineRegistry.get(CREO, SHARED_NP)', () => {
    const d = baselineRegistry.get(ObjectTypeTags.CREO, BaselinePackageIds.SHARED_NP);
    expect(d).toBe(CreatureObjectSharedNpDecoder);
  });
});
