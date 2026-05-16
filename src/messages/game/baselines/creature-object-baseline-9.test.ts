import { describe, expect, it } from 'vitest';

import { ByteStream } from '../../../archive/byte-stream.js';
import { ReadIterator } from '../../../archive/read-iterator.js';
import { writeMemberCount } from './auto-byte-stream.js';
import {
  CreatureObjectFirstParentClientServerNpDecoder,
  CreatureObjectFirstParentClientServerNpKind,
} from './creature-object-baseline-9.js';
import { BaselinePackageIds, ObjectTypeTags, baselineRegistry } from './registry.js';

import './index.js';

describe('CreatureObjectFirstParentClientServerNpDecoder', () => {
  it('is registered for (CREO, FIRST_PARENT_CLIENT_SERVER_NP=9)', () => {
    expect(CreatureObjectFirstParentClientServerNpDecoder.typeId).toBe(ObjectTypeTags.CREO);
    expect(CreatureObjectFirstParentClientServerNpDecoder.packageId).toBe(
      BaselinePackageIds.FIRST_PARENT_CLIENT_SERVER_NP,
    );
    expect(CreatureObjectFirstParentClientServerNpDecoder.kind).toBe(
      CreatureObjectFirstParentClientServerNpKind,
    );
    expect(CreatureObjectFirstParentClientServerNpDecoder.expectedMemberCount).toBe(0);
  });

  it('decodes an empty package (memberCount = 0)', () => {
    const s = new ByteStream();
    writeMemberCount(s, 0);
    const iter = new ReadIterator(s.toBytes());
    const decoded = CreatureObjectFirstParentClientServerNpDecoder.decode(iter);
    expect(decoded._empty).toBe(true);
  });

  it('found via baselineRegistry.get(CREO, FIRST_PARENT_CLIENT_SERVER_NP)', () => {
    const d = baselineRegistry.get(
      ObjectTypeTags.CREO,
      BaselinePackageIds.FIRST_PARENT_CLIENT_SERVER_NP,
    );
    expect(d).toBe(CreatureObjectFirstParentClientServerNpDecoder);
  });
});
