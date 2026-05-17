import { describe, expect, it } from 'vitest';

import { ByteStream } from '../../../archive/byte-stream.js';
import { ReadIterator } from '../../../archive/read-iterator.js';
import {
  CreatureObjectFirstParentClientServerNpDeltaDecoder,
  CreatureObjectFirstParentClientServerNpDeltaKind,
} from './creature-object-delta-9.js';
import { deltaRegistry, tryDecodeDelta } from './delta-registry.js';
import { BaselinePackageIds, ObjectTypeTags } from './registry.js';

// Side-effect: register the decoder (and all sibling baseline + delta
// decoders, so the lookup tests can compare against the registry).
import './index.js';

describe('CreatureObjectFirstParentClientServerNpDeltaDecoder', () => {
  it('is registered for (CREO, FIRST_PARENT_CLIENT_SERVER_NP=9)', () => {
    expect(CreatureObjectFirstParentClientServerNpDeltaDecoder.typeId).toBe(ObjectTypeTags.CREO);
    expect(CreatureObjectFirstParentClientServerNpDeltaDecoder.packageId).toBe(
      BaselinePackageIds.FIRST_PARENT_CLIENT_SERVER_NP,
    );
    expect(CreatureObjectFirstParentClientServerNpDeltaDecoder.kind).toBe(
      CreatureObjectFirstParentClientServerNpDeltaKind,
    );
    // CREO p9 has zero fields — see creature-object-baseline-9.ts.
    expect(CreatureObjectFirstParentClientServerNpDeltaDecoder.fields.length).toBe(0);
  });

  it('lookup via deltaRegistry matches the exported decoder instance', () => {
    const byKey = deltaRegistry.get(
      ObjectTypeTags.CREO,
      BaselinePackageIds.FIRST_PARENT_CLIENT_SERVER_NP,
    );
    const byKind = deltaRegistry.getByKind(CreatureObjectFirstParentClientServerNpDeltaKind);
    expect(byKey).toBe(CreatureObjectFirstParentClientServerNpDeltaDecoder);
    expect(byKind).toBe(CreatureObjectFirstParentClientServerNpDeltaDecoder);
  });

  it('decodes an empty delta payload (count=0) — sparse data is empty', () => {
    // The baseline has zero fields, so the only structurally-valid delta is
    // [u16 count = 0] with no field entries following. tryDecodeDelta should
    // succeed and return an empty `data` object.
    const inner = new ByteStream();
    inner.writeU16(0);

    const result = tryDecodeDelta(
      ObjectTypeTags.CREO,
      BaselinePackageIds.FIRST_PARENT_CLIENT_SERVER_NP,
      inner.toBytes(),
      (b) => new ReadIterator(b),
    );
    expect(result).not.toBeNull();
    expect(result?.kind).toBe(CreatureObjectFirstParentClientServerNpDeltaKind);
    expect(result?.data).toEqual({});
  });

  it('returns null when a fieldIndex appears (always out-of-range — zero fields)', () => {
    // For a single-field-delta on a zero-field package, ANY fieldIndex is out
    // of range. This is the equivalent of the "single-field delta" test for
    // packages with fields — exercises the dispatch path and confirms it
    // safely returns null instead of throwing or corrupting state.
    const inner = new ByteStream();
    inner.writeU16(1); // count = 1
    inner.writeU16(0); // fieldIndex 0 — out of range (no fields registered)
    inner.writeI32(42); // dummy payload that would never be read

    const result = tryDecodeDelta(
      ObjectTypeTags.CREO,
      BaselinePackageIds.FIRST_PARENT_CLIENT_SERVER_NP,
      inner.toBytes(),
      (b) => new ReadIterator(b),
    );
    expect(result).toBeNull();
  });

  it('returns null on out-of-range fieldIndex (multi-entry case)', () => {
    // Multi-field-delta equivalent for a zero-field package: count=3 with
    // wildly out-of-range indices. tryDecodeDelta loops while remaining > 0,
    // so it'll trip on the very first fieldIndex and swallow the throw.
    const inner = new ByteStream();
    inner.writeU16(3);
    inner.writeU16(99);
    inner.writeI32(1);
    inner.writeU16(100);
    inner.writeI32(2);
    inner.writeU16(101);
    inner.writeI32(3);

    const result = tryDecodeDelta(
      ObjectTypeTags.CREO,
      BaselinePackageIds.FIRST_PARENT_CLIENT_SERVER_NP,
      inner.toBytes(),
      (b) => new ReadIterator(b),
    );
    expect(result).toBeNull();
  });
});
