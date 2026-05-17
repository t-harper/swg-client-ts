import { describe, expect, it } from 'vitest';

import { ByteStream } from '../../../archive/byte-stream.js';
import { ReadIterator } from '../../../archive/read-iterator.js';
import { deltaRegistry, tryDecodeDelta } from './delta-registry.js';
import {
  PlayerObjectClientServerNpDeltaDecoder,
  PlayerObjectClientServerNpDeltaKind,
} from './player-object-delta-4.js';
import { BaselinePackageIds, ObjectTypeTags } from './registry.js';

// Side-effect: ensure the PLAY/CLIENT_SERVER_NP delta decoder is registered.
import './player-object-delta-4.js';

const TYPE_ID = ObjectTypeTags.PLAY;
const PACKAGE_ID = BaselinePackageIds.CLIENT_SERVER_NP;

function decode(payload: Uint8Array) {
  return tryDecodeDelta(TYPE_ID, PACKAGE_ID, payload, (b) => new ReadIterator(b));
}

describe('PlayerObjectClientServerNpDelta', () => {
  it('is registered for (PLAY, CLIENT_SERVER_NP=4) with zero fields', () => {
    expect(PlayerObjectClientServerNpDeltaDecoder.typeId).toBe(TYPE_ID);
    expect(PlayerObjectClientServerNpDeltaDecoder.packageId).toBe(PACKAGE_ID);
    expect(PlayerObjectClientServerNpDeltaDecoder.kind).toBe(PlayerObjectClientServerNpDeltaKind);
    expect(PlayerObjectClientServerNpDeltaDecoder.fields).toEqual([]);

    // Registry lookup by (typeId, packageId) should yield this decoder.
    expect(deltaRegistry.get(TYPE_ID, PACKAGE_ID)).toBe(PlayerObjectClientServerNpDeltaDecoder);
    // Lookup by kind matches.
    expect(deltaRegistry.getByKind(PlayerObjectClientServerNpDeltaKind)).toBe(
      PlayerObjectClientServerNpDeltaDecoder,
    );
  });

  it('decodes an empty delta payload (count=0, no entries)', () => {
    // PLAY p4 has zero fields, so the only valid delta is an empty one.
    // Wire form: [u16 count=0] with no following entries.
    const inner = new ByteStream();
    inner.writeU16(0);

    const result = decode(inner.toBytes());
    expect(result).not.toBeNull();
    expect(result?.kind).toBe(PlayerObjectClientServerNpDeltaKind);
    // Sparse data object is empty — no fields decoded.
    expect(result?.data).toEqual({});
    expect(Object.keys(result?.data ?? {})).toHaveLength(0);
  });

  it('decodes a still-empty delta when the count header lies (count is informational)', () => {
    // Per delta-registry.ts: the leading u16 count is informational; the
    // authoritative termination condition is "iterator exhausted". So a
    // header claiming 99 entries but carrying no body still decodes as
    // an empty delta — we exit the while loop immediately because
    // `iter.remaining` is 0.
    const inner = new ByteStream();
    inner.writeU16(99);

    const result = decode(inner.toBytes());
    expect(result).not.toBeNull();
    expect(result?.kind).toBe(PlayerObjectClientServerNpDeltaKind);
    expect(result?.data).toEqual({});
  });

  it('returns null on any non-empty payload (every fieldIndex is out of range)', () => {
    // Since the package has zero fields, ANY fieldIndex is out of range and
    // the registry's try/catch swallows the throw, yielding null.
    const inner = new ByteStream();
    inner.writeU16(1); // count
    inner.writeU16(0); // fieldIndex 0 — out of range because fields.length == 0
    inner.writeI32(0); // unused payload bytes

    const result = decode(inner.toBytes());
    expect(result).toBeNull();
  });

  it('returns null on an out-of-range fieldIndex (explicit large index)', () => {
    const inner = new ByteStream();
    inner.writeU16(1);
    inner.writeU16(99); // clearly out of range
    inner.writeI32(0);

    const result = decode(inner.toBytes());
    expect(result).toBeNull();
  });
});
