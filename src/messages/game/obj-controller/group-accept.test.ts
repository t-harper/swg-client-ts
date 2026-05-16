import { describe, expect, it } from 'vitest';
import { ByteStream } from '../../../archive/byte-stream.js';
import { ReadIterator } from '../../../archive/read-iterator.js';
import { GroupAcceptDecoder, GroupAcceptKind } from './group-accept.js';
import { ObjControllerSubtypeIds, objControllerRegistry } from './registry.js';

describe('GroupAccept (CM_setGroup)', () => {
  it('has the right metadata', () => {
    expect(GroupAcceptDecoder.kind).toBe('GroupAccept');
    expect(GroupAcceptDecoder.subtypeId).toBe(ObjControllerSubtypeIds.CM_setGroup);
    expect(GroupAcceptDecoder.subtypeId).toBe(421);
  });

  it('self-registers in the subtype registry', () => {
    const found = objControllerRegistry.getById(ObjControllerSubtypeIds.CM_setGroup);
    expect(found).toBe(GroupAcceptDecoder);
    expect(objControllerRegistry.getByKind(GroupAcceptKind)).toBe(GroupAcceptDecoder);
  });

  it('round-trips a typical accept (join group, not disbanding)', () => {
    // NetworkId is signed i64 on the wire; stay in positive i64 range.
    const data = {
      disbandingCurrentGroup: false,
      groupId: 0x0afe_babe_dead_beefn,
    };
    const s = new ByteStream();
    GroupAcceptDecoder.encode(s, data);
    const d = GroupAcceptDecoder.decode(new ReadIterator(s.toBytes()));
    expect(d).toEqual(data);
  });

  it('round-trips "leave group" (groupId=0)', () => {
    const data = {
      disbandingCurrentGroup: false,
      groupId: 0n,
    };
    const s = new ByteStream();
    GroupAcceptDecoder.encode(s, data);
    const d = GroupAcceptDecoder.decode(new ReadIterator(s.toBytes()));
    expect(d).toEqual(data);
  });

  it('round-trips a disbanding transition', () => {
    const data = {
      disbandingCurrentGroup: true,
      groupId: 0x42n,
    };
    const s = new ByteStream();
    GroupAcceptDecoder.encode(s, data);
    const d = GroupAcceptDecoder.decode(new ReadIterator(s.toBytes()));
    expect(d).toEqual(data);
  });

  it('has the exact byte layout (1 byte bool + 8 bytes NetworkId)', () => {
    const s = new ByteStream();
    GroupAcceptDecoder.encode(s, { disbandingCurrentGroup: true, groupId: 1n });
    const bytes = s.toBytes();
    expect(bytes.length).toBe(9);
    expect(bytes[0]).toBe(0x01);
    expect(Array.from(bytes.subarray(1, 9))).toEqual([0x01, 0, 0, 0, 0, 0, 0, 0]);
  });
});
