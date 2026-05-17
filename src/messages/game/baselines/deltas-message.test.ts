import { describe, expect, it } from 'vitest';

import { ByteStream } from '../../../archive/byte-stream.js';
import { encodeMessage, parseHeader } from '../../base.js';
import { messageRegistry } from '../../registry.js';
import { DeltasMessage } from './deltas-message.js';
import { BaselinePackageIds, ObjectTypeTags, stringToTag } from './registry.js';
import type { TangibleObjectClientServerBaseline } from './tangible-object-baseline-1.js';

// Side-effect import: ensure all decoders register.
import './index.js';

describe('DeltasMessage', () => {
  it('has the right metadata', () => {
    expect(DeltasMessage.messageName).toBe('DeltasMessage');
    expect(DeltasMessage.varCount).toBe(5);
    expect(DeltasMessage.typeCrc).toBeGreaterThan(0);
  });

  it('round-trips encode → decode (empty package)', () => {
    const original = new DeltasMessage(
      0x1234n,
      ObjectTypeTags.TANO,
      BaselinePackageIds.CLIENT_ONLY,
      new Uint8Array(0),
      null,
    );
    const bytes = encodeMessage(original);

    const { varCount, typeCrc, payload } = parseHeader(bytes);
    expect(varCount).toBe(5);
    expect(typeCrc).toBe(DeltasMessage.typeCrc);

    const decoder = messageRegistry.getByCrc(typeCrc);
    expect(decoder).toBeDefined();
    const decoded = decoder?.decodePayload(payload);
    expect(decoded).toBeInstanceOf(DeltasMessage);
    if (!(decoded instanceof DeltasMessage)) throw new Error('typeguard');

    expect(decoded.target).toBe(0x1234n);
    expect(decoded.typeId).toBe(ObjectTypeTags.TANO);
    expect(decoded.typeIdString).toBe('TANO');
    expect(decoded.packageId).toBe(BaselinePackageIds.CLIENT_ONLY);
    expect(decoded.packageBytes.length).toBe(0);
    // No decoder for (TANO, CLIENT_ONLY=0) → null
    expect(decoded.decodedDelta).toBeNull();
  });

  it('has the exact byte layout we expect for an empty payload', () => {
    const msg = new DeltasMessage(
      0x42n,
      ObjectTypeTags.TANO,
      BaselinePackageIds.SHARED,
      new Uint8Array(0),
      null,
    );
    const bytes = encodeMessage(msg);
    // varCount = 5 → 05 00
    // typeCrc (4 bytes)
    // target = 0x42 i64 LE → 42 00 00 00 00 00 00 00
    // typeId TANO serialized LE: bytes 'O','N','A','T' = 4F 4E 41 54
    // packageId = 3 → 03
    // packageLen = 0 → 00 00 00 00
    // Total: 2 + 4 + 8 + 4 + 1 + 4 = 23 bytes
    expect(bytes.length).toBe(23);
    expect(bytes[0]).toBe(0x05);
    expect(bytes[1]).toBe(0x00);
    expect(bytes[6]).toBe(0x42);
    expect(bytes[14]).toBe(0x4f);
    expect(bytes[15]).toBe(0x4e);
    expect(bytes[16]).toBe(0x41);
    expect(bytes[17]).toBe(0x54);
    expect(bytes[18]).toBe(0x03);
    expect(bytes[19]).toBe(0x00);
    expect(bytes[22]).toBe(0x00);
  });

  it('dispatches a TANO p1 delta (both fields changed) through the registry', () => {
    // Build a real TANO p1 delta payload: bankBalance + cashBalance both updated.
    // packDeltas wire: [u16 count=2][u16 idx=0][i32 bankBalance][u16 idx=1][i32 cashBalance]
    const inner = new ByteStream();
    inner.writeU16(2); // count
    inner.writeU16(0); // fieldIndex 0 = bankBalance
    inner.writeI32(99_000);
    inner.writeU16(1); // fieldIndex 1 = cashBalance
    inner.writeI32(150);

    const packageBytes = inner.toBytes();
    const msg = new DeltasMessage(
      0xabcdn,
      ObjectTypeTags.TANO,
      BaselinePackageIds.CLIENT_SERVER,
      packageBytes,
      null,
    );
    const wire = encodeMessage(msg);
    const { payload } = parseHeader(wire);
    const decoded = messageRegistry
      .getByCrc(DeltasMessage.typeCrc)
      ?.decodePayload(payload) as DeltasMessage;

    expect(decoded.target).toBe(0xabcdn);
    expect(decoded.packageBytes).toEqual(packageBytes);
    expect(decoded.decodedDelta).not.toBeNull();
    expect(decoded.decodedDelta?.kind).toBe('TangibleObjectClientServerDelta');

    const changes = decoded.decodedDelta?.data as Partial<TangibleObjectClientServerBaseline>;
    expect(changes.bankBalance).toBe(99_000);
    expect(changes.cashBalance).toBe(150);
  });

  it('decodes a sparse delta (only one field changed)', () => {
    // Only bankBalance changed — cashBalance stays at its baseline value.
    const inner = new ByteStream();
    inner.writeU16(1); // count
    inner.writeU16(0); // fieldIndex 0
    inner.writeI32(42);

    const msg = new DeltasMessage(
      0xfeedn,
      ObjectTypeTags.TANO,
      BaselinePackageIds.CLIENT_SERVER,
      inner.toBytes(),
      null,
    );
    const wire = encodeMessage(msg);
    const { payload } = parseHeader(wire);
    const decoded = messageRegistry
      .getByCrc(DeltasMessage.typeCrc)
      ?.decodePayload(payload) as DeltasMessage;

    expect(decoded.decodedDelta).not.toBeNull();
    const changes = decoded.decodedDelta?.data as Partial<TangibleObjectClientServerBaseline>;
    expect(changes.bankBalance).toBe(42);
    expect(changes.cashBalance).toBeUndefined();
    expect(Object.keys(changes).length).toBe(1);
  });

  it('honors the source-exhausted-loop rule (mirrors C++ unpackDeltas)', () => {
    // C++ reads `count` then loops while bytes remain — `count` is informational.
    // A payload that claims count=99 but only has 1 entry's worth of bytes
    // should decode exactly 1 entry, not throw.
    const inner = new ByteStream();
    inner.writeU16(99); // misleading count
    inner.writeU16(1); // fieldIndex 1
    inner.writeI32(7);

    const msg = new DeltasMessage(
      0n,
      ObjectTypeTags.TANO,
      BaselinePackageIds.CLIENT_SERVER,
      inner.toBytes(),
      null,
    );
    const wire = encodeMessage(msg);
    const { payload } = parseHeader(wire);
    const decoded = messageRegistry
      .getByCrc(DeltasMessage.typeCrc)
      ?.decodePayload(payload) as DeltasMessage;

    expect(decoded.decodedDelta).not.toBeNull();
    const changes = decoded.decodedDelta?.data as Partial<TangibleObjectClientServerBaseline>;
    expect(changes.cashBalance).toBe(7);
    expect(Object.keys(changes).length).toBe(1);
  });

  it('returns null when a delta references an out-of-range field index', () => {
    const inner = new ByteStream();
    inner.writeU16(1); // count
    inner.writeU16(42); // fieldIndex 42 doesn't exist in TANO p1 (only 0, 1)
    inner.writeI32(0);

    const msg = new DeltasMessage(
      0n,
      ObjectTypeTags.TANO,
      BaselinePackageIds.CLIENT_SERVER,
      inner.toBytes(),
      null,
    );
    const wire = encodeMessage(msg);
    const { payload } = parseHeader(wire);
    const decoded = messageRegistry
      .getByCrc(DeltasMessage.typeCrc)
      ?.decodePayload(payload) as DeltasMessage;

    // tryDecodeDelta swallows the thrown error and returns null;
    // the raw bytes survive for forensic inspection.
    expect(decoded.decodedDelta).toBeNull();
    expect(decoded.packageBytes.length).toBeGreaterThan(0);
  });

  it('returns null for unknown (typeId, packageId) pairs', () => {
    const stub = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    const msg = new DeltasMessage(
      0n,
      stringToTag('XXXX'), // not registered
      BaselinePackageIds.SHARED,
      stub,
      null,
    );
    const wire = encodeMessage(msg);
    const { payload } = parseHeader(wire);
    const decoded = messageRegistry
      .getByCrc(DeltasMessage.typeCrc)
      ?.decodePayload(payload) as DeltasMessage;

    expect(decoded.decodedDelta).toBeNull();
    expect(decoded.typeIdString).toBe('XXXX');
    expect(decoded.packageBytes).toEqual(stub);
  });
});
