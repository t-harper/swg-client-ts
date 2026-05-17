import { describe, expect, it } from 'vitest';

import { ByteStream } from '../../../archive/byte-stream.js';
import { ReadIterator } from '../../../archive/read-iterator.js';
import {
  CreatureObjectFirstParentClientServerDeltaDecoder,
  CreatureObjectFirstParentClientServerDeltaKind,
} from './creature-object-delta-8.js';
import { deltaRegistry, tryDecodeDelta } from './delta-registry.js';
import { BaselinePackageIds, ObjectTypeTags } from './registry.js';

// Side-effect: ensure all built-in decoders register.
import './index.js';

/**
 * CREO p8 (FIRST_PARENT_CLIENT_SERVER) is the empty CreatureObject
 * package — `Packager.cpp` adds zero fields for ServerObject /
 * TangibleObject / CreatureObject at this level (PlayerObject's 9 fields
 * land in PLAY p8, a different `(typeId, packageId)` key).
 *
 * So the delta has `fields: []`. The interesting cases for an empty
 * package are:
 *   - the canonical empty payload `[u16 0]` decodes to a delta with no
 *     fields (kind set, data empty)
 *   - a multi-field claim (count > 0) is unreachable — every fieldIndex
 *     is out of range, so `tryDecodeDelta` returns null
 *   - any trailing-bytes / malformed payload likewise returns null
 *   - lookup by (typeId, packageId) and by kind both surface our decoder
 */
describe('CreatureObjectFirstParentClientServerDeltaDecoder', () => {
  it('registers with the right (typeId, packageId, kind, field count)', () => {
    expect(CreatureObjectFirstParentClientServerDeltaKind).toBe(
      'CreatureObjectFirstParentClientServerDelta',
    );
    expect(CreatureObjectFirstParentClientServerDeltaDecoder.typeId).toBe(ObjectTypeTags.CREO);
    expect(CreatureObjectFirstParentClientServerDeltaDecoder.packageId).toBe(
      BaselinePackageIds.FIRST_PARENT_CLIENT_SERVER,
    );
    // CREO p8 is empty — zero `addFirstParentAuthClientServerVariable` calls
    // contribute from ServerObject / TangibleObject / CreatureObject.
    expect(CreatureObjectFirstParentClientServerDeltaDecoder.fields.length).toBe(0);

    const byKey = deltaRegistry.get(
      ObjectTypeTags.CREO,
      BaselinePackageIds.FIRST_PARENT_CLIENT_SERVER,
    );
    const byKind = deltaRegistry.getByKind('CreatureObjectFirstParentClientServerDelta');
    expect(byKey).toBe(CreatureObjectFirstParentClientServerDeltaDecoder);
    expect(byKind).toBe(byKey);
  });

  it('decodes the canonical empty payload [u16 0] to an empty `data`', () => {
    // The only well-formed delta for an empty package is one that claims
    // zero changed fields and carries no further bytes.
    const inner = new ByteStream();
    inner.writeU16(0); // count = 0

    const result = tryDecodeDelta(
      ObjectTypeTags.CREO,
      BaselinePackageIds.FIRST_PARENT_CLIENT_SERVER,
      inner.toBytes(),
      (b) => new ReadIterator(b),
    );

    expect(result).not.toBeNull();
    expect(result?.kind).toBe('CreatureObjectFirstParentClientServerDelta');
    expect(result?.data).toEqual({});
    expect(Object.keys(result?.data ?? {}).length).toBe(0);
  });

  it('returns null when the payload references a (necessarily out-of-range) field index', () => {
    // For an empty package, ANY non-zero count puts us in out-of-range
    // territory immediately — there's no field 0, 1, ... anything. Mirrors
    // the equivalent "Multi-field delta / Single-field delta" tests for
    // non-empty packages (which here collapse into the same out-of-range
    // case because the package contributes no fields).
    const inner = new ByteStream();
    inner.writeU16(1); // count
    inner.writeU16(0); // fieldIndex 0 — doesn't exist in CREO p8
    inner.writeI32(123);

    const result = tryDecodeDelta(
      ObjectTypeTags.CREO,
      BaselinePackageIds.FIRST_PARENT_CLIENT_SERVER,
      inner.toBytes(),
      (b) => new ReadIterator(b),
    );

    expect(result).toBeNull();
  });

  it('returns null for an out-of-range fieldIndex (count claims 2, both indices invalid)', () => {
    const inner = new ByteStream();
    inner.writeU16(2); // count (informational)
    inner.writeU16(5); // fieldIndex 5 — invalid (package has 0 fields)
    inner.writeI32(0);
    inner.writeU16(99); // fieldIndex 99 — also invalid
    inner.writeI32(0);

    const result = tryDecodeDelta(
      ObjectTypeTags.CREO,
      BaselinePackageIds.FIRST_PARENT_CLIENT_SERVER,
      inner.toBytes(),
      (b) => new ReadIterator(b),
    );

    expect(result).toBeNull();
  });

  it('handles a completely empty payload (no count word) without throwing', () => {
    // Zero bytes: `iter.readU16()` for the count throws (under-read), so
    // `tryDecodeDelta` swallows it and returns null — same behavior as any
    // other malformed payload, doesn't crash the dispatcher.
    const result = tryDecodeDelta(
      ObjectTypeTags.CREO,
      BaselinePackageIds.FIRST_PARENT_CLIENT_SERVER,
      new Uint8Array(0),
      (b) => new ReadIterator(b),
    );

    expect(result).toBeNull();
  });
});
