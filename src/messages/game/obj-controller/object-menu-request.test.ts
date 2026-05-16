import { describe, expect, it } from 'vitest';
import { ByteStream } from '../../../archive/byte-stream.js';
import { ReadIterator } from '../../../archive/read-iterator.js';
import { ObjectMenuItemFlags, ObjectMenuRequestDecoder } from './object-menu-request.js';
import { ObjControllerSubtypeIds, objControllerRegistry } from './registry.js';

describe('ObjectMenuRequest (CM_objectMenuRequest)', () => {
  it('has the right metadata', () => {
    expect(ObjectMenuRequestDecoder.kind).toBe('ObjectMenuRequest');
    expect(ObjectMenuRequestDecoder.subtypeId).toBe(ObjControllerSubtypeIds.CM_objectMenuRequest);
    expect(ObjectMenuRequestDecoder.subtypeId).toBe(326);
  });

  it('self-registers in the subtype registry', () => {
    expect(objControllerRegistry.getById(326)).toBe(ObjectMenuRequestDecoder);
  });

  it('round-trips an empty radial menu (client→server style)', () => {
    const s = new ByteStream();
    ObjectMenuRequestDecoder.encode(s, {
      targetId: 0x0011_2233_4455_6677n,
      requestorId: 0x0077_6655_4433_2211n,
      items: [],
      sequence: 42,
    });
    // 8 + 8 + 4 (count) + 1 (sequence) = 21
    expect(s.toBytes().length).toBe(21);

    const d = ObjectMenuRequestDecoder.decode(new ReadIterator(s.toBytes()));
    expect(d.targetId).toBe(0x0011_2233_4455_6677n);
    expect(d.requestorId).toBe(0x0077_6655_4433_2211n);
    expect(d.items.length).toBe(0);
    expect(d.sequence).toBe(42);
  });

  it('round-trips a populated menu with two items', () => {
    const s = new ByteStream();
    ObjectMenuRequestDecoder.encode(s, {
      targetId: 100n,
      requestorId: 200n,
      items: [
        {
          id: 1,
          parent: 0,
          menuItemType: 0x0040, // ITEM_USE
          flags: ObjectMenuItemFlags.Enabled | ObjectMenuItemFlags.ServerNotify,
          label: 'Use',
        },
        {
          id: 2,
          parent: 0,
          menuItemType: 0x0041, // ITEM_EXAMINE
          flags: ObjectMenuItemFlags.Enabled,
          label: 'Examine',
        },
      ],
      sequence: 1,
    });
    const d = ObjectMenuRequestDecoder.decode(new ReadIterator(s.toBytes()));
    expect(d.items.length).toBe(2);
    expect(d.items[0]?.label).toBe('Use');
    expect(d.items[0]?.flags).toBe(0x03);
    expect(d.items[1]?.label).toBe('Examine');
    expect(d.items[1]?.menuItemType).toBe(0x0041);
    expect(d.sequence).toBe(1);
  });

  it('handles a sub-menu (parent set) with out-of-range flag', () => {
    const s = new ByteStream();
    ObjectMenuRequestDecoder.encode(s, {
      targetId: 1n,
      requestorId: 2n,
      items: [
        {
          id: 5,
          parent: 1,
          menuItemType: 0x0080,
          flags: ObjectMenuItemFlags.OutOfRange,
          label: '',
        },
      ],
      sequence: 0,
    });
    const d = ObjectMenuRequestDecoder.decode(new ReadIterator(s.toBytes()));
    const first = d.items[0];
    expect(first).toBeDefined();
    if (!first) throw new Error('typeguard');
    expect(first.parent).toBe(1);
    expect(first.flags & ObjectMenuItemFlags.OutOfRange).toBe(ObjectMenuItemFlags.OutOfRange);
    expect(first.label).toBe('');
  });
});
