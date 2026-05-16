import { describe, expect, it } from 'vitest';
import { ByteStream } from '../../../archive/byte-stream.js';
import { ReadIterator } from '../../../archive/read-iterator.js';
import { GroupInviteDecoder, GroupInviteKind } from './group-invite.js';
import { ObjControllerSubtypeIds, objControllerRegistry } from './registry.js';

describe('GroupInvite (CM_setGroupInviter)', () => {
  it('has the right metadata', () => {
    expect(GroupInviteDecoder.kind).toBe('GroupInvite');
    expect(GroupInviteDecoder.subtypeId).toBe(ObjControllerSubtypeIds.CM_setGroupInviter);
    expect(GroupInviteDecoder.subtypeId).toBe(351);
  });

  it('self-registers in the subtype registry', () => {
    const found = objControllerRegistry.getById(ObjControllerSubtypeIds.CM_setGroupInviter);
    expect(found).toBe(GroupInviteDecoder);
    expect(objControllerRegistry.getByKind(GroupInviteKind)).toBe(GroupInviteDecoder);
  });

  it('round-trips a typical ground-invite', () => {
    const data = {
      inviterName: 'Han',
      inviterId: 0xdead_beefn,
      inviterShipId: 0n,
    };
    const s = new ByteStream();
    GroupInviteDecoder.encode(s, data);
    const d = GroupInviteDecoder.decode(new ReadIterator(s.toBytes()));
    expect(d).toEqual(data);
  });

  it('round-trips a "clear inviter" message (decline)', () => {
    const data = {
      inviterName: '',
      inviterId: 0n,
      inviterShipId: 0n,
    };
    const s = new ByteStream();
    GroupInviteDecoder.encode(s, data);
    const d = GroupInviteDecoder.decode(new ReadIterator(s.toBytes()));
    expect(d).toEqual(data);
  });

  it('round-trips with a POB-ship invitation', () => {
    const data = {
      inviterName: 'Lando',
      inviterId: 0x11n,
      inviterShipId: 0x22n,
    };
    const s = new ByteStream();
    GroupInviteDecoder.encode(s, data);
    const d = GroupInviteDecoder.decode(new ReadIterator(s.toBytes()));
    expect(d).toEqual(data);
  });

  it('has the exact byte layout for inviterName="Hi" inviterId=1 shipId=0', () => {
    const s = new ByteStream();
    GroupInviteDecoder.encode(s, {
      inviterName: 'Hi',
      inviterId: 1n,
      inviterShipId: 0n,
    });
    const bytes = s.toBytes();
    // [u16 LE byteLen=2][0x48 'H'][0x69 'i'][i64 LE 1][i64 LE 0] = 2 + 2 + 8 + 8 = 20 bytes
    expect(bytes.length).toBe(20);
    expect(Array.from(bytes.subarray(0, 2))).toEqual([0x02, 0x00]); // length=2
    expect(Array.from(bytes.subarray(2, 4))).toEqual([0x48, 0x69]); // "Hi"
    expect(Array.from(bytes.subarray(4, 12))).toEqual([0x01, 0, 0, 0, 0, 0, 0, 0]); // id=1
    expect(Array.from(bytes.subarray(12, 20))).toEqual([0, 0, 0, 0, 0, 0, 0, 0]); // ship=0
  });
});
