import { describe, expect, it } from 'vitest';
import { ByteStream } from '../../../archive/byte-stream.js';
import { ReadIterator } from '../../../archive/read-iterator.js';
import { ObjControllerSubtypeIds, objControllerRegistry } from './registry.js';
import { SitOnObjectDecoder } from './sit-on-object.js';

describe('SitOnObject (CM_sitOnObject)', () => {
  it('has the right metadata', () => {
    expect(SitOnObjectDecoder.kind).toBe('SitOnObject');
    expect(SitOnObjectDecoder.subtypeId).toBe(ObjControllerSubtypeIds.CM_sitOnObject);
    expect(SitOnObjectDecoder.subtypeId).toBe(315);
  });

  it('self-registers in the subtype registry', () => {
    expect(objControllerRegistry.getById(315)).toBe(SitOnObjectDecoder);
  });

  it('round-trips with a cell-relative seat position', () => {
    const s = new ByteStream();
    SitOnObjectDecoder.encode(s, {
      chairCellId: 0x0011_2233_4455_6677n,
      chairPosition: { x: 1.5, y: 0.25, z: -3.75 },
    });
    // NetworkId (8) + 3 floats (12) = 20 bytes
    expect(s.toBytes().length).toBe(20);

    const d = SitOnObjectDecoder.decode(new ReadIterator(s.toBytes()));
    expect(d.chairCellId).toBe(0x0011_2233_4455_6677n);
    expect(d.chairPosition.x).toBeCloseTo(1.5, 5);
    expect(d.chairPosition.y).toBeCloseTo(0.25, 5);
    expect(d.chairPosition.z).toBeCloseTo(-3.75, 5);
  });

  it('handles a top-level seat (chairCellId=0)', () => {
    const s = new ByteStream();
    SitOnObjectDecoder.encode(s, {
      chairCellId: 0n,
      chairPosition: { x: 0, y: 0, z: 0 },
    });
    const d = SitOnObjectDecoder.decode(new ReadIterator(s.toBytes()));
    expect(d.chairCellId).toBe(0n);
    expect(d.chairPosition).toEqual({ x: 0, y: 0, z: 0 });
  });
});
