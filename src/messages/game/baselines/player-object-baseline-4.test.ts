import { describe, expect, it } from 'vitest';

import { ByteStream } from '../../../archive/byte-stream.js';
import { ReadIterator } from '../../../archive/read-iterator.js';
import { writeMemberCount } from './auto-byte-stream.js';
import {
  PlayerObjectClientServerNpDecoder,
  PlayerObjectClientServerNpKind,
} from './player-object-baseline-4.js';
import { BaselinePackageIds, ObjectTypeTags, baselineRegistry } from './registry.js';

import './index.js';

describe('PlayerObjectClientServerNpDecoder', () => {
  it('is registered for (PLAY, CLIENT_SERVER_NP=4)', () => {
    expect(PlayerObjectClientServerNpDecoder.typeId).toBe(ObjectTypeTags.PLAY);
    expect(PlayerObjectClientServerNpDecoder.packageId).toBe(BaselinePackageIds.CLIENT_SERVER_NP);
    expect(PlayerObjectClientServerNpDecoder.kind).toBe(PlayerObjectClientServerNpKind);
    expect(PlayerObjectClientServerNpDecoder.expectedMemberCount).toBe(0);
  });

  it('decodes an empty package (memberCount = 0)', () => {
    const s = new ByteStream();
    writeMemberCount(s, 0);
    const iter = new ReadIterator(s.toBytes());
    const decoded = PlayerObjectClientServerNpDecoder.decode(iter);
    expect(decoded._empty).toBe(true);
  });

  it('found via baselineRegistry.get(PLAY, CLIENT_SERVER_NP)', () => {
    const d = baselineRegistry.get(ObjectTypeTags.PLAY, BaselinePackageIds.CLIENT_SERVER_NP);
    expect(d).toBe(PlayerObjectClientServerNpDecoder);
  });
});
