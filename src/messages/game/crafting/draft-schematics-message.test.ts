import { describe, expect, it } from 'vitest';
import { ByteStream } from '../../../archive/byte-stream.js';
import { ReadIterator } from '../../../archive/read-iterator.js';
import { encodeMessage, parseHeader } from '../../base.js';
import { messageRegistry } from '../../registry.js';
import { ObjControllerMessage } from '../obj-controller-message.js';
// Side-effect import so ObjControllerMessage decoder is registered.
import '../obj-controller-message.js';
import { ObjControllerSubtypeIds, objControllerRegistry } from '../obj-controller/registry.js';
import {
  type DraftSchematicsData,
  DraftSchematicsDecoder,
  DraftSchematicsKind,
} from './draft-schematics-message.js';

describe('DraftSchematicsMessage (CM_draftSchematicsMessage)', () => {
  it('has the right metadata', () => {
    expect(DraftSchematicsDecoder.kind).toBe('DraftSchematics');
    expect(DraftSchematicsDecoder.subtypeId).toBe(
      ObjControllerSubtypeIds.CM_draftSchematicsMessage,
    );
    expect(DraftSchematicsDecoder.subtypeId).toBe(258);
  });

  it('self-registers in the subtype registry', () => {
    const found = objControllerRegistry.getById(ObjControllerSubtypeIds.CM_draftSchematicsMessage);
    expect(found).toBe(DraftSchematicsDecoder);
    expect(objControllerRegistry.getByKind(DraftSchematicsKind)).toBe(DraftSchematicsDecoder);
  });

  it('round-trips encode → decode (single entry)', () => {
    const data: DraftSchematicsData = {
      toolId: 0xabcd_1234n,
      stationId: 0n,
      schematics: [{ serverCrc: 0xdead_beef, sharedCrc: 0xc0de_face, category: 7 }],
    };
    const s = new ByteStream();
    DraftSchematicsDecoder.encode(s, data);
    const d = DraftSchematicsDecoder.decode(new ReadIterator(s.toBytes()));
    expect(d.toolId).toBe(0xabcd_1234n);
    expect(d.stationId).toBe(0n);
    expect(d.schematics).toHaveLength(1);
    expect(d.schematics[0]?.serverCrc).toBe(0xdead_beef);
    expect(d.schematics[0]?.sharedCrc).toBe(0xc0de_face);
    expect(d.schematics[0]?.category).toBe(7);
  });

  it('round-trips encode → decode (empty list)', () => {
    const data: DraftSchematicsData = {
      toolId: 0x1n,
      stationId: 0x2n,
      schematics: [],
    };
    const s = new ByteStream();
    DraftSchematicsDecoder.encode(s, data);
    // 8 (toolId) + 8 (stationId) + 4 (count=0) = 20 bytes
    expect(s.toBytes().length).toBe(20);
    const d = DraftSchematicsDecoder.decode(new ReadIterator(s.toBytes()));
    expect(d.schematics).toEqual([]);
    expect(d.toolId).toBe(0x1n);
    expect(d.stationId).toBe(0x2n);
  });

  it('round-trips encode → decode (multiple entries)', () => {
    const data: DraftSchematicsData = {
      toolId: 0x10n,
      stationId: 0x20n,
      schematics: [
        { serverCrc: 0x11111111, sharedCrc: 0x22222222, category: 1 },
        { serverCrc: 0x33333333, sharedCrc: 0x44444444, category: 2 },
        { serverCrc: 0x55555555, sharedCrc: 0x66666666, category: -1 },
      ],
    };
    const s = new ByteStream();
    DraftSchematicsDecoder.encode(s, data);
    const d = DraftSchematicsDecoder.decode(new ReadIterator(s.toBytes()));
    expect(d.schematics).toHaveLength(3);
    expect(d.schematics[2]?.category).toBe(-1); // signed I32 round-trips
  });

  it('has the exact byte layout we expect (smallest non-empty)', () => {
    const data: DraftSchematicsData = {
      toolId: 0n,
      stationId: 0n,
      schematics: [{ serverCrc: 0x04030201, sharedCrc: 0x08070605, category: 0 }],
    };
    const s = new ByteStream();
    DraftSchematicsDecoder.encode(s, data);
    const bytes = Array.from(s.toBytes());
    expect(bytes.length).toBe(20 + 12);
    // 8 zero bytes (toolId)
    expect(bytes.slice(0, 8)).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    // 8 zero bytes (stationId)
    expect(bytes.slice(8, 16)).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    // count = 1 (LE i32)
    expect(bytes.slice(16, 20)).toEqual([0x01, 0x00, 0x00, 0x00]);
    // serverCrc = 0x04030201 (LE u32)
    expect(bytes.slice(20, 24)).toEqual([0x01, 0x02, 0x03, 0x04]);
    // sharedCrc = 0x08070605 (LE u32)
    expect(bytes.slice(24, 28)).toEqual([0x05, 0x06, 0x07, 0x08]);
    // category = 0 (LE i32)
    expect(bytes.slice(28, 32)).toEqual([0, 0, 0, 0]);
  });

  it('rejects a negative schematic count on decode', () => {
    const bytes = new Uint8Array(20);
    // last 4 bytes = -1 (LE i32: 0xff ff ff ff)
    bytes[16] = 0xff;
    bytes[17] = 0xff;
    bytes[18] = 0xff;
    bytes[19] = 0xff;
    expect(() => DraftSchematicsDecoder.decode(new ReadIterator(bytes))).toThrow(/negative count/);
  });

  it('dispatches through the parent ObjControllerMessage decoder', () => {
    const data: DraftSchematicsData = {
      toolId: 0xaaaan,
      stationId: 0xbbbbn,
      schematics: [{ serverCrc: 0xcafe_babe, sharedCrc: 0xfeed_face, category: 5 }],
    };
    const s = new ByteStream();
    DraftSchematicsDecoder.encode(s, data);
    const parent = new ObjControllerMessage(
      0x01, // SEND from server to client
      ObjControllerSubtypeIds.CM_draftSchematicsMessage,
      0xaaaan, // creature receiving
      0,
      s.toBytes(),
    );
    const bytes = encodeMessage(parent);
    const { typeCrc, payload } = parseHeader(bytes);
    const decoder = messageRegistry.getByCrc(typeCrc);
    if (!decoder) throw new Error('ObjControllerMessage decoder not registered');
    const decoded = decoder.decodePayload(payload) as ObjControllerMessage;
    expect(decoded.decodedSubtype?.kind).toBe('DraftSchematics');
    const decodedData = decoded.decodedSubtype?.data as DraftSchematicsData;
    expect(decodedData.toolId).toBe(0xaaaan);
    expect(decodedData.stationId).toBe(0xbbbbn);
    expect(decodedData.schematics[0]?.category).toBe(5);
  });
});
