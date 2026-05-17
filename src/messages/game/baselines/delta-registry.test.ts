import { describe, expect, it } from 'vitest';

import { ByteStream } from '../../../archive/byte-stream.js';
import { ReadIterator } from '../../../archive/read-iterator.js';
import {
  type DeltaPackageDecoder,
  deltaRegistry,
  registerDelta,
  tryDecodeDelta,
} from './delta-registry.js';
import { BaselinePackageIds, ObjectTypeTags, stringToTag } from './registry.js';

// Side-effect: ensure built-in decoders are registered (TANO p1).
import './index.js';

describe('deltaRegistry', () => {
  it('exposes a TANO/CLIENT_SERVER decoder out of the box', () => {
    const decoder = deltaRegistry.get(ObjectTypeTags.TANO, BaselinePackageIds.CLIENT_SERVER);
    expect(decoder).toBeDefined();
    expect(decoder?.kind).toBe('TangibleObjectClientServerDelta');
    expect(decoder?.fields.length).toBe(2);
    expect(decoder?.fields[0]?.name).toBe('bankBalance');
    expect(decoder?.fields[1]?.name).toBe('cashBalance');
  });

  it('returns undefined for unregistered (typeId, packageId) pairs', () => {
    expect(deltaRegistry.get(stringToTag('XXXX'), 0)).toBeUndefined();
    expect(deltaRegistry.get(ObjectTypeTags.TANO, 99)).toBeUndefined();
  });

  it('lookup by kind matches lookup by (typeId, packageId)', () => {
    const byKey = deltaRegistry.get(ObjectTypeTags.TANO, BaselinePackageIds.CLIENT_SERVER);
    const byKind = deltaRegistry.getByKind('TangibleObjectClientServerDelta');
    expect(byKey).toBe(byKind);
  });

  it('refuses to register two decoders for the same key', () => {
    const phantom: DeltaPackageDecoder = {
      kind: 'PhantomConflict',
      typeId: ObjectTypeTags.TANO,
      packageId: BaselinePackageIds.CLIENT_SERVER,
      fields: [{ name: 'foo', decode: (i) => i.readI32() }],
    };
    expect(() => registerDelta(phantom)).toThrow(/collision/i);
  });

  it('register is idempotent for the same decoder instance', () => {
    const existing = deltaRegistry.get(ObjectTypeTags.TANO, BaselinePackageIds.CLIENT_SERVER);
    if (!existing) throw new Error('expected TANO/CLIENT_SERVER decoder to be registered');
    // Re-registering the same instance should NOT throw — it's a no-op
    // (modules sometimes get loaded twice in test runners).
    expect(() => registerDelta(existing)).not.toThrow();
  });

  it('tryDecodeDelta returns null when no decoder is registered', () => {
    const result = tryDecodeDelta(
      stringToTag('XXXX'),
      0,
      new Uint8Array(0),
      (b) => new ReadIterator(b),
    );
    expect(result).toBeNull();
  });

  it('tryDecodeDelta decodes a well-formed payload', () => {
    const inner = new ByteStream();
    inner.writeU16(1); // count
    inner.writeU16(0); // fieldIndex 0 = bankBalance
    inner.writeI32(123_456);

    const result = tryDecodeDelta(
      ObjectTypeTags.TANO,
      BaselinePackageIds.CLIENT_SERVER,
      inner.toBytes(),
      (b) => new ReadIterator(b),
    );
    expect(result).not.toBeNull();
    expect(result?.kind).toBe('TangibleObjectClientServerDelta');
    expect((result?.data as { bankBalance?: number }).bankBalance).toBe(123_456);
  });

  it('tryDecodeDelta returns null on out-of-range fieldIndex (swallows throw)', () => {
    const inner = new ByteStream();
    inner.writeU16(1);
    inner.writeU16(99); // out of range
    inner.writeI32(0);

    const result = tryDecodeDelta(
      ObjectTypeTags.TANO,
      BaselinePackageIds.CLIENT_SERVER,
      inner.toBytes(),
      (b) => new ReadIterator(b),
    );
    expect(result).toBeNull();
  });
});
