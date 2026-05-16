import { describe, expect, it } from 'vitest';

import { ByteStream } from '../../../archive/byte-stream.js';
import { ReadIterator } from '../../../archive/read-iterator.js';
import { ObjControllerSubtypeIds, objControllerRegistry } from '../obj-controller/registry.js';
import { MissionAbortDecoder, MissionAbortKind } from './mission-abort.js';

describe('MissionAbort (CM_missionAbort)', () => {
  it('has the expected metadata', () => {
    expect(MissionAbortDecoder.kind).toBe('MissionAbort');
    expect(MissionAbortDecoder.subtypeId).toBe(ObjControllerSubtypeIds.CM_missionAbort);
    expect(MissionAbortDecoder.subtypeId).toBe(322);
  });

  it('self-registers in the subtype registry', () => {
    expect(objControllerRegistry.getById(ObjControllerSubtypeIds.CM_missionAbort)).toBe(
      MissionAbortDecoder,
    );
    expect(objControllerRegistry.getByKind(MissionAbortKind)).toBe(MissionAbortDecoder);
  });

  it('round-trips a typical NetworkId', () => {
    const s = new ByteStream();
    // NetworkId is signed i64 on the wire — pick a value that fits in i63 to round-trip as a positive.
    MissionAbortDecoder.encode(s, { missionObjectId: 0x1234_5678_dead_beefn as bigint });
    const decoded = MissionAbortDecoder.decode(new ReadIterator(s.toBytes()));
    expect(decoded.missionObjectId).toBe(0x1234_5678_dead_beefn);
  });

  it('has the exact 8-byte layout (NetworkId only)', () => {
    const s = new ByteStream();
    MissionAbortDecoder.encode(s, { missionObjectId: 1n });
    const bytes = s.toBytes();
    expect(bytes.length).toBe(8);
    expect(bytes[0]).toBe(0x01);
    for (let i = 1; i < 8; i++) expect(bytes[i]).toBe(0x00);
  });

  it('handles negative NetworkIds (signed bigint round-trip)', () => {
    const s = new ByteStream();
    MissionAbortDecoder.encode(s, { missionObjectId: -42n as bigint });
    const decoded = MissionAbortDecoder.decode(new ReadIterator(s.toBytes()));
    expect(decoded.missionObjectId).toBe(-42n);
  });
});
