import { describe, expect, it } from 'vitest';

import { ByteStream } from '../../../archive/byte-stream.js';
import { ReadIterator } from '../../../archive/read-iterator.js';
import { writeStdString } from '../../../archive/string.js';
import { writeUnicodeString } from '../../../archive/unicode-string.js';
import { writeMemberCount } from './auto-byte-stream.js';
import {
  type PlayerObjectSharedBaseline,
  PlayerObjectSharedDecoder,
  PlayerObjectSharedKind,
} from './player-object-baseline-3.js';
import { BaselinePackageIds, ObjectTypeTags, baselineRegistry } from './registry.js';
import { StringIdCodec } from './string-id.js';

import './index.js';

/** Build a PlayerObject baseline 3 payload byte-by-byte. */
function buildPayload(data: PlayerObjectSharedBaseline): Uint8Array {
  const s = new ByteStream();
  writeMemberCount(s, 20);
  // ServerObject section
  s.writeF32(data.complexity);
  StringIdCodec.encode(s, data.nameStringId);
  writeUnicodeString(s, data.objectName);
  s.writeI32(data.volume);
  // IntangibleObject section
  s.writeI32(data.count);
  // PlayerObject section
  // MatchMakingId = std::vector<int> = [i32 count][i32 values]
  s.writeI32(data.matchMakingCharacterProfileId.ints.length);
  for (const v of data.matchMakingCharacterProfileId.ints) s.writeI32(v);
  s.writeI32(data.matchMakingPersonalProfileId.ints.length);
  for (const v of data.matchMakingPersonalProfileId.ints) s.writeI32(v);
  writeStdString(s, data.skillTitle);
  s.writeI32(data.bornDate);
  s.writeU32(data.playedTime);
  s.writeI32(data.roleIconChoice);
  writeStdString(s, data.skillTemplate);
  s.writeI32(data.currentGcwPoints);
  s.writeI32(data.currentPvpKills);
  s.writeI64(data.lifetimeGcwPoints);
  s.writeI32(data.lifetimePvpKills);
  // BitArray: [i32 nBytes][i32 nBits][bytes]
  s.writeI32(data.collections.bytes.length);
  s.writeI32(data.collections.numInUseBits);
  if (data.collections.bytes.length > 0) s.writeBytes(data.collections.bytes);
  s.writeI32(data.collections2.bytes.length);
  s.writeI32(data.collections2.numInUseBits);
  if (data.collections2.bytes.length > 0) s.writeBytes(data.collections2.bytes);
  s.writeBool(data.showBackpack);
  s.writeBool(data.showHelmet);
  return s.toBytes();
}

describe('PlayerObjectSharedDecoder', () => {
  it('is registered for (PLAY, SHARED=3)', () => {
    expect(PlayerObjectSharedDecoder.typeId).toBe(ObjectTypeTags.PLAY);
    expect(PlayerObjectSharedDecoder.packageId).toBe(BaselinePackageIds.SHARED);
    expect(PlayerObjectSharedDecoder.kind).toBe(PlayerObjectSharedKind);
    expect(PlayerObjectSharedDecoder.expectedMemberCount).toBe(20);
  });

  it('round-trips a realistic payload with a typical player', () => {
    const original: PlayerObjectSharedBaseline = {
      complexity: 1,
      nameStringId: { table: '', textIndex: 0, text: '' },
      objectName: '',
      volume: 1,
      count: 0,
      matchMakingCharacterProfileId: { ints: [0, 0, 0, 0] },
      matchMakingPersonalProfileId: { ints: [0, 0, 0, 0] },
      skillTitle: 'novice_brawler',
      bornDate: 1500,
      playedTime: 7200,
      roleIconChoice: 0,
      skillTemplate: 'crafting_artisan_1ahandsamurai_master',
      currentGcwPoints: 0,
      currentPvpKills: 0,
      lifetimeGcwPoints: 0n,
      lifetimePvpKills: 0,
      collections: { numInUseBits: 0, bytes: new Uint8Array(0) },
      collections2: { numInUseBits: 0, bytes: new Uint8Array(0) },
      showBackpack: false,
      showHelmet: true,
    };
    const bytes = buildPayload(original);
    const iter = new ReadIterator(bytes);
    const decoded = PlayerObjectSharedDecoder.decode(iter);
    expect(decoded.skillTitle).toBe('novice_brawler');
    expect(decoded.bornDate).toBe(1500);
    expect(decoded.playedTime).toBe(7200);
    expect(decoded.skillTemplate).toBe('crafting_artisan_1ahandsamurai_master');
    expect(decoded.showBackpack).toBe(false);
    expect(decoded.showHelmet).toBe(true);
    expect(decoded.lifetimeGcwPoints).toBe(0n);
    expect(decoded.matchMakingCharacterProfileId.ints).toEqual([0, 0, 0, 0]);
  });

  it('round-trips an i64 lifetimeGcwPoints that exceeds 2^53', () => {
    const original: PlayerObjectSharedBaseline = {
      complexity: 0,
      nameStringId: { table: '', textIndex: 0, text: '' },
      objectName: '',
      volume: 0,
      count: 0,
      matchMakingCharacterProfileId: { ints: [0, 0, 0, 0] },
      matchMakingPersonalProfileId: { ints: [0, 0, 0, 0] },
      skillTitle: '',
      bornDate: 0,
      playedTime: 0,
      roleIconChoice: 0,
      skillTemplate: '',
      currentGcwPoints: 0,
      currentPvpKills: 0,
      lifetimeGcwPoints: 9_007_199_254_740_993n, // 2^53 + 1
      lifetimePvpKills: 0,
      collections: { numInUseBits: 0, bytes: new Uint8Array(0) },
      collections2: { numInUseBits: 0, bytes: new Uint8Array(0) },
      showBackpack: false,
      showHelmet: false,
    };
    const bytes = buildPayload(original);
    const iter = new ReadIterator(bytes);
    const decoded = PlayerObjectSharedDecoder.decode(iter);
    expect(decoded.lifetimeGcwPoints).toBe(9_007_199_254_740_993n);
  });

  it('decodes a BitArray collections payload', () => {
    const collectionsBytes = new Uint8Array([0x01, 0xff, 0x10, 0x00]);
    const original: PlayerObjectSharedBaseline = {
      complexity: 0,
      nameStringId: { table: '', textIndex: 0, text: '' },
      objectName: '',
      volume: 0,
      count: 0,
      matchMakingCharacterProfileId: { ints: [0, 0, 0, 0] },
      matchMakingPersonalProfileId: { ints: [0, 0, 0, 0] },
      skillTitle: '',
      bornDate: 0,
      playedTime: 0,
      roleIconChoice: 0,
      skillTemplate: '',
      currentGcwPoints: 0,
      currentPvpKills: 0,
      lifetimeGcwPoints: 0n,
      lifetimePvpKills: 0,
      collections: { numInUseBits: 32, bytes: collectionsBytes },
      collections2: { numInUseBits: 0, bytes: new Uint8Array(0) },
      showBackpack: false,
      showHelmet: false,
    };
    const bytes = buildPayload(original);
    const iter = new ReadIterator(bytes);
    const decoded = PlayerObjectSharedDecoder.decode(iter);
    expect(decoded.collections.numInUseBits).toBe(32);
    expect([...decoded.collections.bytes]).toEqual([0x01, 0xff, 0x10, 0x00]);
  });

  it('found via baselineRegistry.get(PLAY, SHARED)', () => {
    const d = baselineRegistry.get(ObjectTypeTags.PLAY, BaselinePackageIds.SHARED);
    expect(d).toBe(PlayerObjectSharedDecoder);
  });
});
