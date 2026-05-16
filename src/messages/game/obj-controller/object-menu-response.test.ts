import { describe, expect, it } from 'vitest';
import { ByteStream } from '../../../archive/byte-stream.js';
import { ReadIterator } from '../../../archive/read-iterator.js';
import { ObjectMenuItemFlags } from './object-menu-request.js';
import { ObjectMenuResponseDecoder, ObjectMenuResponseKind } from './object-menu-response.js';
import { ObjControllerSubtypeIds, objControllerRegistry } from './registry.js';

describe('ObjectMenuResponse (CM_objectMenuResponse)', () => {
  it('has the right metadata', () => {
    expect(ObjectMenuResponseDecoder.kind).toBe(ObjectMenuResponseKind);
    expect(ObjectMenuResponseDecoder.subtypeId).toBe(ObjControllerSubtypeIds.CM_objectMenuResponse);
    expect(ObjectMenuResponseDecoder.subtypeId).toBe(327);
  });

  it('self-registers in the subtype registry', () => {
    expect(objControllerRegistry.getById(327)).toBe(ObjectMenuResponseDecoder);
  });

  it('shares the wire format with ObjectMenuRequest (round-trips a populated menu)', () => {
    const s = new ByteStream();
    ObjectMenuResponseDecoder.encode(s, {
      targetId: 0x0011_2233_4455_6677n,
      requestorId: 0n,
      items: [
        {
          id: 1,
          parent: 0,
          menuItemType: 0x0040,
          flags: ObjectMenuItemFlags.Enabled,
          label: 'Use',
        },
      ],
      sequence: 3,
    });
    const d = ObjectMenuResponseDecoder.decode(new ReadIterator(s.toBytes()));
    expect(d.items.length).toBe(1);
    expect(d.items[0]?.label).toBe('Use');
    expect(d.sequence).toBe(3);
  });
});
