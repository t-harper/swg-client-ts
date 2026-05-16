import { describe, expect, it } from 'vitest';

import { ByteStream } from '../../../archive/byte-stream.js';
import { ReadIterator } from '../../../archive/read-iterator.js';
import { writeUnicodeString } from '../../../archive/unicode-string.js';
import { encodeMessage, parseHeader } from '../../base.js';
import { messageRegistry } from '../../registry.js';
import { writeMemberCount } from './auto-byte-stream.js';
import { BaselinesMessage } from './baselines-message.js';
import { BaselinePackageIds, ObjectTypeTags, stringToTag } from './registry.js';
import { StringIdCodec } from './string-id.js';
import type { TangibleObjectSharedBaseline } from './tangible-object-baseline-3.js';

// Side-effect import: ensure all decoders register.
import './index.js';

describe('BaselinesMessage', () => {
  it('has the right metadata', () => {
    expect(BaselinesMessage.messageName).toBe('BaselinesMessage');
    expect(BaselinesMessage.varCount).toBe(5);
    expect(BaselinesMessage.typeCrc).toBeGreaterThan(0);
  });

  it('round-trips encode → decode (empty package)', () => {
    const original = new BaselinesMessage(
      0x1234n,
      ObjectTypeTags.TANO,
      BaselinePackageIds.CLIENT_ONLY,
      new Uint8Array(0),
      null,
    );
    const bytes = encodeMessage(original);

    const { varCount, typeCrc, payload } = parseHeader(bytes);
    expect(varCount).toBe(5);
    expect(typeCrc).toBe(BaselinesMessage.typeCrc);

    const decoder = messageRegistry.getByCrc(typeCrc);
    expect(decoder).toBeDefined();
    const decoded = decoder?.decodePayload(payload);
    expect(decoded).toBeInstanceOf(BaselinesMessage);
    if (!(decoded instanceof BaselinesMessage)) throw new Error('typeguard');

    expect(decoded.target).toBe(0x1234n);
    expect(decoded.typeId).toBe(ObjectTypeTags.TANO);
    expect(decoded.typeIdString).toBe('TANO');
    expect(decoded.packageId).toBe(BaselinePackageIds.CLIENT_ONLY);
    expect(decoded.packageBytes.length).toBe(0);
    // No decoder for (TANO, CLIENT_ONLY=0) → null
    expect(decoded.decodedBaseline).toBeNull();
  });

  it('has the exact byte layout we expect for an empty payload', () => {
    const msg = new BaselinesMessage(
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
    // typeId TANO: C++ TAG(T,A,N,O) packs as T<<24|A<<16|N<<8|O = 0x54414E4F.
    //   Serialized LE → bytes [4F, 4E, 41, 54] ('O','N','A','T') on the wire.
    // packageId = 3 → 03
    // packageLen = 0 → 00 00 00 00
    // Total: 2 + 4 + 8 + 4 + 1 + 4 = 23 bytes
    expect(bytes.length).toBe(23);
    // varCount
    expect(bytes[0]).toBe(0x05);
    expect(bytes[1]).toBe(0x00);
    // skip typeCrc 4 bytes
    // target i64 LE - first byte
    expect(bytes[6]).toBe(0x42);
    // typeId TANO serialized LE at offset 6 + 8 = 14: bytes 'O','N','A','T'
    expect(bytes[14]).toBe(0x4f);
    expect(bytes[15]).toBe(0x4e);
    expect(bytes[16]).toBe(0x41);
    expect(bytes[17]).toBe(0x54);
    // packageId at offset 18
    expect(bytes[18]).toBe(0x03);
    // packageLen u32 = 0 at offsets 19-22
    expect(bytes[19]).toBe(0x00);
    expect(bytes[22]).toBe(0x00);
  });

  it('dispatches a TangibleObjectShared payload through the registry', () => {
    // Build a real TANO baseline 3 payload
    const data: TangibleObjectSharedBaseline = {
      complexity: 5.5,
      nameStringId: { table: 'item_n', textIndex: 0, text: 'cool_sword' },
      objectName: 'My Sword',
      volume: 1,
      pvpFaction: 0,
      pvpType: 1,
      appearanceData: '',
      components: [],
      condition: 0,
      count: 1,
      damageTaken: 0,
      maxHitPoints: 500,
      visible: true,
    };
    const inner = new ByteStream();
    writeMemberCount(inner, 13);
    inner.writeF32(data.complexity);
    StringIdCodec.encode(inner, data.nameStringId);
    writeUnicodeString(inner, data.objectName);
    inner.writeI32(data.volume);
    inner.writeU32(data.pvpFaction);
    inner.writeI32(data.pvpType);
    // empty appearanceData
    inner.writeU16(0); // std::string length
    // empty components set
    inner.writeU32(0);
    inner.writeU32(0);
    inner.writeI32(data.condition);
    inner.writeI32(data.count);
    inner.writeI32(data.damageTaken);
    inner.writeI32(data.maxHitPoints);
    inner.writeBool(data.visible);

    const packageBytes = inner.toBytes();
    const msg = new BaselinesMessage(
      0xabcdn,
      ObjectTypeTags.TANO,
      BaselinePackageIds.SHARED,
      packageBytes,
      null,
    );
    const wire = encodeMessage(msg);

    const { payload } = parseHeader(wire);
    const decoder = messageRegistry.getByCrc(BaselinesMessage.typeCrc);
    const decoded = decoder?.decodePayload(payload) as BaselinesMessage;

    expect(decoded.target).toBe(0xabcdn);
    expect(decoded.typeId).toBe(ObjectTypeTags.TANO);
    expect(decoded.packageId).toBe(BaselinePackageIds.SHARED);
    expect(decoded.packageBytes).toEqual(packageBytes);

    // The registry dispatch should have populated decodedBaseline
    expect(decoded.decodedBaseline).not.toBeNull();
    expect(decoded.decodedBaseline?.kind).toBe('TangibleObjectShared');
    const tangData = decoded.decodedBaseline?.data as TangibleObjectSharedBaseline;
    expect(tangData.complexity).toBeCloseTo(5.5, 5);
    expect(tangData.nameStringId.text).toBe('cool_sword');
    expect(tangData.objectName).toBe('My Sword');
    expect(tangData.maxHitPoints).toBe(500);
    expect(tangData.visible).toBe(true);
  });

  it('gracefully handles a payload that the decoder rejects (returns null)', () => {
    // Send a TANO/SHARED baseline with a malformed payload (member count mismatch)
    const inner = new ByteStream();
    writeMemberCount(inner, 5); // wrong! should be 13
    const packageBytes = inner.toBytes();
    const msg = new BaselinesMessage(
      0x99n,
      ObjectTypeTags.TANO,
      BaselinePackageIds.SHARED,
      packageBytes,
      null,
    );
    const wire = encodeMessage(msg);
    const { payload } = parseHeader(wire);
    const decoder = messageRegistry.getByCrc(BaselinesMessage.typeCrc);
    const decoded = decoder?.decodePayload(payload) as BaselinesMessage;
    expect(decoded.decodedBaseline).toBeNull();
    // The raw packageBytes are still preserved so callers can inspect
    expect(decoded.packageBytes).toEqual(packageBytes);
  });

  it('decodes an unknown typeId by exposing only the raw bytes', () => {
    const stub = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    const msg = new BaselinesMessage(
      0n,
      stringToTag('XXXX'), // not registered
      BaselinePackageIds.SHARED,
      stub,
      null,
    );
    const wire = encodeMessage(msg);
    const { payload } = parseHeader(wire);
    const decoder = messageRegistry.getByCrc(BaselinesMessage.typeCrc);
    const decoded = decoder?.decodePayload(payload) as BaselinesMessage;
    expect(decoded.decodedBaseline).toBeNull();
    expect(decoded.typeIdString).toBe('XXXX');
    expect(decoded.packageBytes).toEqual(stub);
  });
});
