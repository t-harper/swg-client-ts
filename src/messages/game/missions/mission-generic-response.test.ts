import { describe, expect, it } from 'vitest';

import { ByteStream } from '../../../archive/byte-stream.js';
import { ReadIterator } from '../../../archive/read-iterator.js';
import { ObjControllerSubtypeIds, objControllerRegistry } from '../obj-controller/registry.js';
import {
  MissionAcceptResponseDecoder,
  MissionAcceptResponseKind,
  MissionCreateResponseDecoder,
  MissionCreateResponseKind,
  MissionRemoveResponseDecoder,
  MissionRemoveResponseKind,
} from './mission-generic-response.js';

describe('MissionGenericResponse', () => {
  it('registers all three response decoders with their expected subtype ids', () => {
    expect(MissionAcceptResponseDecoder.subtypeId).toBe(
      ObjControllerSubtypeIds.CM_missionAcceptResponse,
    );
    expect(MissionAcceptResponseDecoder.subtypeId).toBe(250);
    expect(MissionRemoveResponseDecoder.subtypeId).toBe(
      ObjControllerSubtypeIds.CM_missionRemoveResponse,
    );
    expect(MissionRemoveResponseDecoder.subtypeId).toBe(252);
    expect(MissionCreateResponseDecoder.subtypeId).toBe(
      ObjControllerSubtypeIds.CM_missionCreateResponse,
    );
    expect(MissionCreateResponseDecoder.subtypeId).toBe(256);
  });

  it('self-registers each under a distinct kind', () => {
    expect(objControllerRegistry.getById(ObjControllerSubtypeIds.CM_missionAcceptResponse)).toBe(
      MissionAcceptResponseDecoder,
    );
    expect(objControllerRegistry.getById(ObjControllerSubtypeIds.CM_missionRemoveResponse)).toBe(
      MissionRemoveResponseDecoder,
    );
    expect(objControllerRegistry.getById(ObjControllerSubtypeIds.CM_missionCreateResponse)).toBe(
      MissionCreateResponseDecoder,
    );
    expect(objControllerRegistry.getByKind(MissionAcceptResponseKind)).toBe(
      MissionAcceptResponseDecoder,
    );
    expect(objControllerRegistry.getByKind(MissionRemoveResponseKind)).toBe(
      MissionRemoveResponseDecoder,
    );
    expect(objControllerRegistry.getByKind(MissionCreateResponseKind)).toBe(
      MissionCreateResponseDecoder,
    );
  });

  it('round-trips success=true', () => {
    const s = new ByteStream();
    const original = {
      missionObjectId: 0x0102_0304_0506_0708n as bigint,
      success: true,
      sequenceId: 42,
    };
    MissionAcceptResponseDecoder.encode(s, original);
    const decoded = MissionAcceptResponseDecoder.decode(new ReadIterator(s.toBytes()));
    expect(decoded.missionObjectId).toBe(0x0102_0304_0506_0708n);
    expect(decoded.success).toBe(true);
    expect(decoded.sequenceId).toBe(42);
  });

  it('round-trips success=false (mission denied)', () => {
    const s = new ByteStream();
    MissionAcceptResponseDecoder.encode(s, {
      missionObjectId: 999n,
      success: false,
      sequenceId: 7,
    });
    const decoded = MissionAcceptResponseDecoder.decode(new ReadIterator(s.toBytes()));
    expect(decoded.success).toBe(false);
    expect(decoded.sequenceId).toBe(7);
  });

  it('shares wire layout across all three response subtypes', () => {
    const data = { missionObjectId: 1n, success: true, sequenceId: 3 };
    const a = new ByteStream();
    const r = new ByteStream();
    const c = new ByteStream();
    MissionAcceptResponseDecoder.encode(a, data);
    MissionRemoveResponseDecoder.encode(r, data);
    MissionCreateResponseDecoder.encode(c, data);
    expect(Array.from(a.toBytes())).toEqual(Array.from(r.toBytes()));
    expect(Array.from(a.toBytes())).toEqual(Array.from(c.toBytes()));
  });

  it('has the exact byte layout we expect', () => {
    const s = new ByteStream();
    MissionAcceptResponseDecoder.encode(s, {
      missionObjectId: 1n,
      success: true,
      sequenceId: 0xff,
    });
    const bytes = s.toBytes();
    // i64 LE NetworkId + u8 bool + u8 sequenceId = 8 + 1 + 1 = 10
    expect(bytes.length).toBe(10);
    expect(bytes[0]).toBe(0x01); // NetworkId LSB
    for (let i = 1; i < 8; i++) expect(bytes[i]).toBe(0x00);
    expect(bytes[8]).toBe(0x01); // success = true
    expect(bytes[9]).toBe(0xff); // sequenceId
  });

  it('treats any non-zero success byte as true on decode', () => {
    // Hand-built bytes: NetworkId=1, success-byte=0x42, sequenceId=0
    const bytes = new Uint8Array(10);
    bytes[0] = 0x01;
    bytes[8] = 0x42;
    bytes[9] = 0;
    const decoded = MissionAcceptResponseDecoder.decode(new ReadIterator(bytes));
    expect(decoded.success).toBe(true);
  });
});
