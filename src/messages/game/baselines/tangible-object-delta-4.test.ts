/**
 * Tests for `TangibleObjectClientServerNpDeltaDecoder`.
 *
 * TANO p4 has **zero fields** in the baseline (and therefore zero in the
 * delta) — both ServerObject and TangibleObject contribute no
 * `addAuthClientServerVariable_np` entries. So this test suite differs
 * from the typical "single-field / multi-field / container / OOB" matrix:
 *
 *   - There are no valid field indices, so EVERY field index is
 *     out-of-range (no "single-field decode" can succeed in the usual
 *     sense — the only valid payload is `count=0` with no body).
 *   - The "multi-field" test correspondingly checks that a delta with
 *     count > 0 returns null because the first read pulls a fieldIndex
 *     that's by definition out of range.
 *   - There are no AutoDelta* container fields to exercise.
 *
 * Test coverage instead:
 *   1. Decoder registration (kind / typeId / packageId / empty fields)
 *   2. Empty payload (count=0) returns an empty `data` object
 *   3. Any field index attempt (e.g. 0, the would-be-first field)
 *      returns null because the package has no fields
 *   4. Out-of-range fieldIndex (e.g. 99) returns null
 *   5. Lookup parity (registry by key matches lookup by kind)
 */

import { describe, expect, it } from 'vitest';

import { ByteStream } from '../../../archive/byte-stream.js';
import { ReadIterator } from '../../../archive/read-iterator.js';
import { deltaRegistry, tryDecodeDelta } from './delta-registry.js';
import { BaselinePackageIds, ObjectTypeTags } from './registry.js';
import {
  TangibleObjectClientServerNpDeltaDecoder,
  TangibleObjectClientServerNpDeltaKind,
} from './tangible-object-delta-4.js';

// Side-effect: ensure the TANO/CLIENT_SERVER_NP delta decoder is registered.
import './tangible-object-delta-4.js';

const TYPE_ID = ObjectTypeTags.TANO;
const PACKAGE_ID = BaselinePackageIds.CLIENT_SERVER_NP;

function decode(payload: Uint8Array) {
  return tryDecodeDelta(TYPE_ID, PACKAGE_ID, payload, (b) => new ReadIterator(b));
}

describe('TangibleObjectClientServerNpDelta', () => {
  it('is registered for (TANO, CLIENT_SERVER_NP=4) with zero fields', () => {
    expect(TangibleObjectClientServerNpDeltaDecoder.typeId).toBe(ObjectTypeTags.TANO);
    expect(TangibleObjectClientServerNpDeltaDecoder.packageId).toBe(
      BaselinePackageIds.CLIENT_SERVER_NP,
    );
    expect(TangibleObjectClientServerNpDeltaDecoder.kind).toBe(
      TangibleObjectClientServerNpDeltaKind,
    );
    expect(TangibleObjectClientServerNpDeltaDecoder.fields.length).toBe(0);
  });

  it('decodes an empty-count payload (single-field analog: count=0)', () => {
    // The "single-field delta" equivalent for a zero-field package: the
    // wire still carries the [u16 count] header, set to zero, with no body.
    const inner = new ByteStream();
    inner.writeU16(0); // count = 0 (no field entries)

    const result = decode(inner.toBytes());
    expect(result).not.toBeNull();
    expect(result?.kind).toBe('TangibleObjectClientServerNpDelta');
    expect(result?.data).toEqual({});
    expect(Object.keys(result?.data ?? {})).toEqual([]);
  });

  it('returns null on count > 0 (multi-field analog: any index is OOR)', () => {
    // For a zero-field package, even a "valid-looking" count=2 payload
    // is undecodable — the first u16 read after count pulls a fieldIndex
    // that has no decoder. This mirrors the multi-field test's structural
    // shape (count > 1) but the expected outcome is null because every
    // possible fieldIndex is out-of-range.
    const inner = new ByteStream();
    inner.writeU16(2); // count = 2
    inner.writeU16(0); // would-be fieldIndex 0 (no such field)
    inner.writeI32(123);
    inner.writeU16(1); // would-be fieldIndex 1 (no such field)
    inner.writeI32(456);

    const result = decode(inner.toBytes());
    expect(result).toBeNull();
  });

  it('returns null when attempting fieldIndex 0 (no fields registered)', () => {
    // A package with zero fields has no valid indices at all — even
    // fieldIndex 0 is out-of-range.
    const inner = new ByteStream();
    inner.writeU16(1); // count
    inner.writeU16(0); // fieldIndex 0 — not present in this package
    inner.writeI32(0);

    const result = decode(inner.toBytes());
    expect(result).toBeNull();
  });

  it('returns null on far-out-of-range fieldIndex (e.g. 99)', () => {
    const inner = new ByteStream();
    inner.writeU16(1);
    inner.writeU16(99); // way past anything that could be valid
    inner.writeI32(0);

    const result = decode(inner.toBytes());
    expect(result).toBeNull();
  });

  it('lookup by kind matches lookup by (typeId, packageId)', () => {
    const byKey = deltaRegistry.get(TYPE_ID, PACKAGE_ID);
    const byKind = deltaRegistry.getByKind('TangibleObjectClientServerNpDelta');
    expect(byKey).toBe(byKind);
    expect(byKey).toBe(TangibleObjectClientServerNpDeltaDecoder);
  });
});
