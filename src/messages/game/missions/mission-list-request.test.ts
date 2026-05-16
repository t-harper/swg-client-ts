import { describe, expect, it } from 'vitest';

import { ByteStream } from '../../../archive/byte-stream.js';
import { ReadIterator } from '../../../archive/read-iterator.js';
import { ObjControllerSubtypeIds, objControllerRegistry } from '../obj-controller/registry.js';
import {
  MissionListRequestDecoder,
  MissionListRequestFlags,
  MissionListRequestKind,
} from './mission-list-request.js';

describe('MissionListRequest (CM_missionListRequest)', () => {
  it('has the expected metadata', () => {
    expect(MissionListRequestDecoder.kind).toBe('MissionListRequest');
    expect(MissionListRequestDecoder.subtypeId).toBe(ObjControllerSubtypeIds.CM_missionListRequest);
    expect(MissionListRequestDecoder.subtypeId).toBe(245);
  });

  it('self-registers in the subtype registry', () => {
    const found = objControllerRegistry.getById(ObjControllerSubtypeIds.CM_missionListRequest);
    expect(found).toBe(MissionListRequestDecoder);
    expect(objControllerRegistry.getByKind(MissionListRequestKind)).toBe(MissionListRequestDecoder);
  });

  it('round-trips encode → decode for a typical mineOnly=false request', () => {
    const s = new ByteStream();
    const original = {
      flags: 0,
      sequenceId: 7,
      terminalId: 0x4321_0000_dead_beefn as bigint,
    };
    MissionListRequestDecoder.encode(s, original);
    const bytes = s.toBytes();
    const decoded = MissionListRequestDecoder.decode(new ReadIterator(bytes));
    expect(decoded.flags).toBe(0);
    expect(decoded.sequenceId).toBe(7);
    expect(decoded.terminalId).toBe(0x4321_0000_dead_beefn);
  });

  it('round-trips mineOnly=true', () => {
    const s = new ByteStream();
    const original = {
      flags: MissionListRequestFlags.MineOnly,
      sequenceId: 255,
      terminalId: 1n,
    };
    MissionListRequestDecoder.encode(s, original);
    const decoded = MissionListRequestDecoder.decode(new ReadIterator(s.toBytes()));
    expect(decoded.flags).toBe(0x01);
    expect(decoded.sequenceId).toBe(255);
    expect(decoded.terminalId).toBe(1n);
  });

  it('has the exact byte layout we expect', () => {
    const s = new ByteStream();
    // flags=0 sequenceId=1 terminalId=2
    MissionListRequestDecoder.encode(s, { flags: 0, sequenceId: 1, terminalId: 2n });
    const bytes = s.toBytes();
    // u8 flags + u8 sequenceId + i64 LE NetworkId = 1 + 1 + 8 = 10 bytes
    expect(bytes.length).toBe(10);
    expect(bytes[0]).toBe(0x00); // flags
    expect(bytes[1]).toBe(0x01); // sequenceId
    expect(bytes[2]).toBe(0x02); // NetworkId LSB
    for (let i = 3; i < 10; i++) {
      expect(bytes[i]).toBe(0x00);
    }
  });
});
