import { describe, expect, it } from 'vitest';

import { ByteStream } from '../../../archive/byte-stream.js';
import { ReadIterator } from '../../../archive/read-iterator.js';
import { writeStdString } from '../../../archive/string.js';
import { writeMemberCount } from './auto-byte-stream.js';
import {
  type CreatureObjectClientServerBaseline,
  CreatureObjectClientServerDecoder,
  CreatureObjectClientServerKind,
} from './creature-object-baseline-1.js';
import { BaselinePackageIds, ObjectTypeTags, baselineRegistry } from './registry.js';

import './index.js';

function buildPayload(data: CreatureObjectClientServerBaseline): Uint8Array {
  const s = new ByteStream();
  writeMemberCount(s, 4);
  s.writeI32(data.bankBalance);
  s.writeI32(data.cashBalance);
  // maxAttributes — AutoDeltaVector<int>
  s.writeU32(data.maxAttributes.length);
  s.writeU32(0);
  for (const v of data.maxAttributes) s.writeI32(v);
  // skills — AutoDeltaSet<string>
  s.writeU32(data.skills.length);
  s.writeU32(0);
  for (const sk of data.skills) writeStdString(s, sk);
  return s.toBytes();
}

describe('CreatureObjectClientServerDecoder', () => {
  it('is registered for (CREO, CLIENT_SERVER=1)', () => {
    expect(CreatureObjectClientServerDecoder.typeId).toBe(ObjectTypeTags.CREO);
    expect(CreatureObjectClientServerDecoder.packageId).toBe(BaselinePackageIds.CLIENT_SERVER);
    expect(CreatureObjectClientServerDecoder.kind).toBe(CreatureObjectClientServerKind);
    expect(CreatureObjectClientServerDecoder.expectedMemberCount).toBe(4);
  });

  it('round-trips a brand-new character with no skills', () => {
    const original: CreatureObjectClientServerBaseline = {
      bankBalance: 5000,
      cashBalance: 0,
      maxAttributes: [1000, 100, 1000, 100, 1000, 100],
      skills: [],
    };
    const bytes = buildPayload(original);
    const iter = new ReadIterator(bytes);
    const decoded = CreatureObjectClientServerDecoder.decode(iter);
    expect(decoded.bankBalance).toBe(5000);
    expect(decoded.cashBalance).toBe(0);
    expect(decoded.maxAttributes).toEqual([1000, 100, 1000, 100, 1000, 100]);
    expect(decoded.skills).toEqual([]);
  });

  it('round-trips a character with several trained skills', () => {
    const original: CreatureObjectClientServerBaseline = {
      bankBalance: 1_000_000,
      cashBalance: 50_000,
      maxAttributes: [2500, 250, 2500, 250, 2500, 250],
      skills: [
        'combat_brawler_novice',
        'combat_brawler_1handsword_master',
        'social_entertainer_novice',
      ],
    };
    const bytes = buildPayload(original);
    const iter = new ReadIterator(bytes);
    const decoded = CreatureObjectClientServerDecoder.decode(iter);
    expect(decoded.maxAttributes).toEqual([2500, 250, 2500, 250, 2500, 250]);
    expect(decoded.skills).toEqual([
      'combat_brawler_novice',
      'combat_brawler_1handsword_master',
      'social_entertainer_novice',
    ]);
  });

  it('found via baselineRegistry.get(CREO, CLIENT_SERVER)', () => {
    const d = baselineRegistry.get(ObjectTypeTags.CREO, BaselinePackageIds.CLIENT_SERVER);
    expect(d).toBe(CreatureObjectClientServerDecoder);
  });
});
