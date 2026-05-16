import { describe, expect, it } from 'vitest';

import { ByteStream } from '../../../archive/byte-stream.js';
import { ReadIterator } from '../../../archive/read-iterator.js';
import { writeMemberCount } from './auto-byte-stream.js';
import {
  type PlayerObjectClientServerBaseline,
  PlayerObjectClientServerDecoder,
  PlayerObjectClientServerKind,
} from './player-object-baseline-1.js';
import { BaselinePackageIds, ObjectTypeTags, baselineRegistry } from './registry.js';

import './index.js';

function buildPayload(data: PlayerObjectClientServerBaseline): Uint8Array {
  const s = new ByteStream();
  writeMemberCount(s, 2);
  s.writeI32(data.bankBalance);
  s.writeI32(data.cashBalance);
  return s.toBytes();
}

describe('PlayerObjectClientServerDecoder', () => {
  it('is registered for (PLAY, CLIENT_SERVER=1)', () => {
    expect(PlayerObjectClientServerDecoder.typeId).toBe(ObjectTypeTags.PLAY);
    expect(PlayerObjectClientServerDecoder.packageId).toBe(BaselinePackageIds.CLIENT_SERVER);
    expect(PlayerObjectClientServerDecoder.kind).toBe(PlayerObjectClientServerKind);
    expect(PlayerObjectClientServerDecoder.expectedMemberCount).toBe(2);
  });

  it('round-trips a realistic owner-data payload', () => {
    const original: PlayerObjectClientServerBaseline = {
      bankBalance: 100_000,
      cashBalance: 50_000,
    };
    const bytes = buildPayload(original);
    const iter = new ReadIterator(bytes);
    const decoded = PlayerObjectClientServerDecoder.decode(iter);
    expect(decoded.bankBalance).toBe(100_000);
    expect(decoded.cashBalance).toBe(50_000);
  });

  it('handles a brand-new character with 0 credits', () => {
    const bytes = buildPayload({ bankBalance: 0, cashBalance: 0 });
    const iter = new ReadIterator(bytes);
    const decoded = PlayerObjectClientServerDecoder.decode(iter);
    expect(decoded.bankBalance).toBe(0);
    expect(decoded.cashBalance).toBe(0);
  });

  it('found via baselineRegistry.get(PLAY, CLIENT_SERVER)', () => {
    const d = baselineRegistry.get(ObjectTypeTags.PLAY, BaselinePackageIds.CLIENT_SERVER);
    expect(d).toBe(PlayerObjectClientServerDecoder);
  });
});
