import { describe, expect, it } from 'vitest';

import { ByteStream } from '../../../archive/byte-stream.js';
import { ReadIterator } from '../../../archive/read-iterator.js';
import { writeMemberCount } from './auto-byte-stream.js';
import {
  CreatureObjectFirstParentClientServerDecoder,
  CreatureObjectFirstParentClientServerKind,
} from './creature-object-baseline-8.js';
import { BaselinePackageIds, ObjectTypeTags, baselineRegistry } from './registry.js';

import './index.js';

describe('CreatureObjectFirstParentClientServerDecoder', () => {
  it('is registered for (CREO, FIRST_PARENT_CLIENT_SERVER=8)', () => {
    expect(CreatureObjectFirstParentClientServerDecoder.typeId).toBe(ObjectTypeTags.CREO);
    expect(CreatureObjectFirstParentClientServerDecoder.packageId).toBe(
      BaselinePackageIds.FIRST_PARENT_CLIENT_SERVER,
    );
    expect(CreatureObjectFirstParentClientServerDecoder.kind).toBe(
      CreatureObjectFirstParentClientServerKind,
    );
    expect(CreatureObjectFirstParentClientServerDecoder.expectedMemberCount).toBe(0);
  });

  it('decodes an empty package (memberCount = 0)', () => {
    const s = new ByteStream();
    writeMemberCount(s, 0);
    const iter = new ReadIterator(s.toBytes());
    const decoded = CreatureObjectFirstParentClientServerDecoder.decode(iter);
    expect(decoded._empty).toBe(true);
  });

  it('found via baselineRegistry.get(CREO, FIRST_PARENT_CLIENT_SERVER)', () => {
    const d = baselineRegistry.get(
      ObjectTypeTags.CREO,
      BaselinePackageIds.FIRST_PARENT_CLIENT_SERVER,
    );
    expect(d).toBe(CreatureObjectFirstParentClientServerDecoder);
  });
});
