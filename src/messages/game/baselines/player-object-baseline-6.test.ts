import { describe, expect, it } from 'vitest';

import { ByteStream } from '../../../archive/byte-stream.js';
import { NetworkIdCodec } from '../../../archive/network-id.js';
import { ReadIterator } from '../../../archive/read-iterator.js';
import { writeStdString } from '../../../archive/string.js';
import { writeMemberCount } from './auto-byte-stream.js';
import {
  type GcwDefenderRegion,
  type PlayerObjectSharedNpBaseline,
  PlayerObjectSharedNpDecoder,
} from './player-object-baseline-6.js';
import { BaselinePackageIds, ObjectTypeTags, baselineRegistry } from './registry.js';
import { StringIdCodec } from './string-id.js';

import './index.js';

function writeGcwRegion(s: ByteStream, r: GcwDefenderRegion): void {
  writeStdString(s, r.region);
  s.writeBool(r.qualifiesForBonus);
  s.writeBool(r.qualifiesForTitle);
}

function buildPayload(data: PlayerObjectSharedNpBaseline): Uint8Array {
  const s = new ByteStream();
  writeMemberCount(s, 17);
  // ServerObject section
  s.writeU32(data.authServerProcessId);
  StringIdCodec.encode(s, data.descriptionStringId);
  // PlayerObject section
  s.writeI8(data.privledgedTitle);
  s.writeI32(data.currentGcwRank);
  s.writeF32(data.currentGcwRankProgress);
  s.writeI32(data.maxGcwImperialRank);
  s.writeI32(data.maxGcwRebelRank);
  s.writeI32(data.gcwRatingActualCalcTime);
  writeStdString(s, data.citizenshipCity);
  s.writeI8(data.citizenshipType);
  writeGcwRegion(s, data.cityGcwDefenderRegion);
  writeGcwRegion(s, data.guildGcwDefenderRegion);
  NetworkIdCodec.encode(s, data.squelchedById);
  writeStdString(s, data.squelchedByName);
  s.writeI32(data.squelchExpireTime);
  s.writeI32(data.environmentFlags);
  writeStdString(s, data.defaultAttackOverride);
  return s.toBytes();
}

describe('PlayerObjectSharedNpDecoder', () => {
  it('is registered for (PLAY, SHARED_NP=6)', () => {
    expect(PlayerObjectSharedNpDecoder.typeId).toBe(ObjectTypeTags.PLAY);
    expect(PlayerObjectSharedNpDecoder.packageId).toBe(BaselinePackageIds.SHARED_NP);
    expect(PlayerObjectSharedNpDecoder.expectedMemberCount).toBe(17);
  });

  it('round-trips a default-state payload', () => {
    const original: PlayerObjectSharedNpBaseline = {
      authServerProcessId: 42,
      descriptionStringId: { table: '', textIndex: 0, text: '' },
      privledgedTitle: 0,
      currentGcwRank: 0,
      currentGcwRankProgress: 0,
      maxGcwImperialRank: 0,
      maxGcwRebelRank: 0,
      gcwRatingActualCalcTime: 0,
      citizenshipCity: '',
      citizenshipType: 0,
      cityGcwDefenderRegion: { region: '', qualifiesForBonus: false, qualifiesForTitle: false },
      guildGcwDefenderRegion: { region: '', qualifiesForBonus: false, qualifiesForTitle: false },
      squelchedById: 0n,
      squelchedByName: '',
      squelchExpireTime: 0,
      environmentFlags: 0,
      defaultAttackOverride: '',
    };
    const bytes = buildPayload(original);
    const iter = new ReadIterator(bytes);
    const decoded = PlayerObjectSharedNpDecoder.decode(iter);
    expect(decoded).toEqual(original);
  });

  it('round-trips a fully-populated payload', () => {
    const original: PlayerObjectSharedNpBaseline = {
      authServerProcessId: 0x12345678,
      descriptionStringId: { table: 'player_n', textIndex: 7, text: 'jedi_knight' },
      privledgedTitle: 1,
      currentGcwRank: 14,
      currentGcwRankProgress: 0.5,
      maxGcwImperialRank: 14,
      maxGcwRebelRank: 0,
      gcwRatingActualCalcTime: 1234567890,
      citizenshipCity: 'mos_eisley',
      citizenshipType: 2,
      cityGcwDefenderRegion: {
        region: 'tatooine_dune_sea',
        qualifiesForBonus: true,
        qualifiesForTitle: false,
      },
      guildGcwDefenderRegion: {
        region: 'naboo_keren',
        qualifiesForBonus: true,
        qualifiesForTitle: true,
      },
      squelchedById: 0x4242424242424242n,
      squelchedByName: 'AdminGuy',
      squelchExpireTime: -1,
      environmentFlags: 0x0f,
      defaultAttackOverride: 'kick',
    };
    const bytes = buildPayload(original);
    const iter = new ReadIterator(bytes);
    const decoded = PlayerObjectSharedNpDecoder.decode(iter);
    expect(decoded).toEqual(original);
  });

  it('found via baselineRegistry.get(PLAY, SHARED_NP)', () => {
    const d = baselineRegistry.get(ObjectTypeTags.PLAY, BaselinePackageIds.SHARED_NP);
    expect(d).toBe(PlayerObjectSharedNpDecoder);
  });
});
