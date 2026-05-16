import { describe, expect, it } from 'vitest';

import { ByteStream } from '../../../archive/byte-stream.js';
import { ReadIterator } from '../../../archive/read-iterator.js';
import { writeMemberCount } from './auto-byte-stream.js';
import { BaselinePackageIds, ObjectTypeTags, baselineRegistry } from './registry.js';
import {
  TangibleObjectClientServerNpDecoder,
  TangibleObjectClientServerNpKind,
} from './tangible-object-baseline-4.js';

import './index.js';

describe('TangibleObjectClientServerNpDecoder', () => {
  it('is registered for (TANO, CLIENT_SERVER_NP=4)', () => {
    expect(TangibleObjectClientServerNpDecoder.typeId).toBe(ObjectTypeTags.TANO);
    expect(TangibleObjectClientServerNpDecoder.packageId).toBe(BaselinePackageIds.CLIENT_SERVER_NP);
    expect(TangibleObjectClientServerNpDecoder.kind).toBe(TangibleObjectClientServerNpKind);
    expect(TangibleObjectClientServerNpDecoder.expectedMemberCount).toBe(0);
  });

  it('decodes an empty package (memberCount = 0)', () => {
    const s = new ByteStream();
    writeMemberCount(s, 0);
    const iter = new ReadIterator(s.toBytes());
    const decoded = TangibleObjectClientServerNpDecoder.decode(iter);
    expect(decoded._empty).toBe(true);
  });

  it('found via baselineRegistry.get(TANO, CLIENT_SERVER_NP)', () => {
    const d = baselineRegistry.get(ObjectTypeTags.TANO, BaselinePackageIds.CLIENT_SERVER_NP);
    expect(d).toBe(TangibleObjectClientServerNpDecoder);
  });
});
