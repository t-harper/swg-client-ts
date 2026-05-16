import { describe, expect, it } from 'vitest';
import { ByteStream } from '../../../archive/byte-stream.js';
import { ReadIterator } from '../../../archive/read-iterator.js';
import { AttributeChangedDecoder } from './attribute-changed.js';
import { ObjControllerSubtypeIds, objControllerRegistry } from './registry.js';

describe('AttributeChanged (CM_alterHitPoints)', () => {
  it('has the right metadata', () => {
    expect(AttributeChangedDecoder.kind).toBe('AttributeChanged');
    expect(AttributeChangedDecoder.subtypeId).toBe(ObjControllerSubtypeIds.CM_alterHitPoints);
    expect(AttributeChangedDecoder.subtypeId).toBe(384);
  });

  it('self-registers in the subtype registry', () => {
    expect(objControllerRegistry.getById(384)).toBe(AttributeChangedDecoder);
  });

  it('round-trips a damage tick (negative delta)', () => {
    const s = new ByteStream();
    AttributeChangedDecoder.encode(s, { delta: -42, source: 0x0011_2233_4455_6677n });
    // i32 delta (4) + NetworkId i64 (8) = 12 bytes
    expect(s.toBytes().length).toBe(12);

    const d = AttributeChangedDecoder.decode(new ReadIterator(s.toBytes()));
    expect(d.delta).toBe(-42);
    expect(d.source).toBe(0x0011_2233_4455_6677n);
  });

  it('round-trips a heal tick (positive delta, no source)', () => {
    const s = new ByteStream();
    AttributeChangedDecoder.encode(s, { delta: 100, source: 0n });
    const d = AttributeChangedDecoder.decode(new ReadIterator(s.toBytes()));
    expect(d.delta).toBe(100);
    expect(d.source).toBe(0n);
  });

  it('has the exact byte layout for delta=-1, source=0', () => {
    const s = new ByteStream();
    AttributeChangedDecoder.encode(s, { delta: -1, source: 0n });
    const bytes = Array.from(s.toBytes());
    // -1 as i32 LE: 0xff 0xff 0xff 0xff
    // source = 0 as i64 LE: 8 zero bytes
    expect(bytes).toEqual([0xff, 0xff, 0xff, 0xff, 0, 0, 0, 0, 0, 0, 0, 0]);
  });
});
