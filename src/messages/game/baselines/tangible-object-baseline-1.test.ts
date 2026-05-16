import { describe, expect, it } from 'vitest';

import { ByteStream } from '../../../archive/byte-stream.js';
import { ReadIterator } from '../../../archive/read-iterator.js';
import { writeMemberCount } from './auto-byte-stream.js';
import { BaselinePackageIds, ObjectTypeTags, baselineRegistry } from './registry.js';
import {
  type TangibleObjectClientServerBaseline,
  TangibleObjectClientServerDecoder,
  TangibleObjectClientServerKind,
} from './tangible-object-baseline-1.js';

import './index.js';

function buildPayload(data: TangibleObjectClientServerBaseline): Uint8Array {
  const s = new ByteStream();
  writeMemberCount(s, 2);
  s.writeI32(data.bankBalance);
  s.writeI32(data.cashBalance);
  return s.toBytes();
}

describe('TangibleObjectClientServerDecoder', () => {
  it('is registered for (TANO, CLIENT_SERVER=1)', () => {
    expect(TangibleObjectClientServerDecoder.typeId).toBe(ObjectTypeTags.TANO);
    expect(TangibleObjectClientServerDecoder.packageId).toBe(BaselinePackageIds.CLIENT_SERVER);
    expect(TangibleObjectClientServerDecoder.kind).toBe(TangibleObjectClientServerKind);
    expect(TangibleObjectClientServerDecoder.expectedMemberCount).toBe(2);
  });

  it('round-trips the typical zero-balance non-player tangible', () => {
    const bytes = buildPayload({ bankBalance: 0, cashBalance: 0 });
    const iter = new ReadIterator(bytes);
    const decoded = TangibleObjectClientServerDecoder.decode(iter);
    expect(decoded.bankBalance).toBe(0);
    expect(decoded.cashBalance).toBe(0);
  });

  it('found via baselineRegistry.get(TANO, CLIENT_SERVER)', () => {
    const d = baselineRegistry.get(ObjectTypeTags.TANO, BaselinePackageIds.CLIENT_SERVER);
    expect(d).toBe(TangibleObjectClientServerDecoder);
  });
});
