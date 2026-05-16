import { describe, expect, it } from 'vitest';

import { ByteStream } from '../../../archive/byte-stream.js';
import { ReadIterator } from '../../../archive/read-iterator.js';
import { ObjControllerSubtypeIds, objControllerRegistry } from '../obj-controller/registry.js';
import {
  MissionAcceptRequestDecoder,
  MissionAcceptRequestKind,
  MissionRemoveRequestDecoder,
  MissionRemoveRequestKind,
} from './mission-generic-request.js';

describe('MissionGenericRequest', () => {
  it('registers both accept and remove decoders', () => {
    expect(MissionAcceptRequestDecoder.subtypeId).toBe(
      ObjControllerSubtypeIds.CM_missionAcceptRequest,
    );
    expect(MissionAcceptRequestDecoder.subtypeId).toBe(249);
    expect(MissionRemoveRequestDecoder.subtypeId).toBe(
      ObjControllerSubtypeIds.CM_missionRemoveRequest,
    );
    expect(MissionRemoveRequestDecoder.subtypeId).toBe(251);
  });

  it('self-registers both under distinct kinds in the registry', () => {
    expect(objControllerRegistry.getById(ObjControllerSubtypeIds.CM_missionAcceptRequest)).toBe(
      MissionAcceptRequestDecoder,
    );
    expect(objControllerRegistry.getById(ObjControllerSubtypeIds.CM_missionRemoveRequest)).toBe(
      MissionRemoveRequestDecoder,
    );
    expect(objControllerRegistry.getByKind(MissionAcceptRequestKind)).toBe(
      MissionAcceptRequestDecoder,
    );
    expect(objControllerRegistry.getByKind(MissionRemoveRequestKind)).toBe(
      MissionRemoveRequestDecoder,
    );
  });

  it('round-trips encode → decode', () => {
    const s = new ByteStream();
    const original = {
      missionObjectId: 0x0102_0304_0506_0708n as bigint,
      terminalId: 0x4321_8765_dead_beefn as bigint,
      sequenceId: 42,
    };
    MissionAcceptRequestDecoder.encode(s, original);
    const decoded = MissionAcceptRequestDecoder.decode(new ReadIterator(s.toBytes()));
    expect(decoded.missionObjectId).toBe(0x0102_0304_0506_0708n);
    expect(decoded.terminalId).toBe(0x4321_8765_dead_beefn);
    expect(decoded.sequenceId).toBe(42);
  });

  it('shares wire layout between accept and remove (same encode/decode)', () => {
    const data = { missionObjectId: 1n, terminalId: 2n, sequenceId: 3 };
    const acceptStream = new ByteStream();
    const removeStream = new ByteStream();
    MissionAcceptRequestDecoder.encode(acceptStream, data);
    MissionRemoveRequestDecoder.encode(removeStream, data);
    expect(Array.from(acceptStream.toBytes())).toEqual(Array.from(removeStream.toBytes()));
  });

  it('has the exact byte layout we expect', () => {
    const s = new ByteStream();
    MissionAcceptRequestDecoder.encode(s, {
      missionObjectId: 1n,
      terminalId: 2n,
      sequenceId: 0xab,
    });
    const bytes = s.toBytes();
    // 8 (NetworkId LE) + 8 (NetworkId LE) + 1 (u8) = 17
    expect(bytes.length).toBe(17);
    expect(bytes[0]).toBe(0x01); // missionObjectId LSB
    for (let i = 1; i < 8; i++) expect(bytes[i]).toBe(0x00);
    expect(bytes[8]).toBe(0x02); // terminalId LSB
    for (let i = 9; i < 16; i++) expect(bytes[i]).toBe(0x00);
    expect(bytes[16]).toBe(0xab); // sequenceId
  });

  it('handles signed NetworkId edge cases (high bit set)', () => {
    const s = new ByteStream();
    const original = {
      missionObjectId: -1n as bigint, // 0xFFFFFFFFFFFFFFFF as signed
      terminalId: 0x7fff_ffff_ffff_ffffn as bigint,
      sequenceId: 0,
    };
    MissionAcceptRequestDecoder.encode(s, original);
    const decoded = MissionAcceptRequestDecoder.decode(new ReadIterator(s.toBytes()));
    expect(decoded.missionObjectId).toBe(-1n);
    expect(decoded.terminalId).toBe(0x7fff_ffff_ffff_ffffn);
  });
});
