import { describe, expect, it } from 'vitest';
import { ByteStream } from '../../../archive/byte-stream.js';
import { ReadIterator } from '../../../archive/read-iterator.js';
import {
  type CraftingExperimentData,
  CraftingExperimentDecoder,
  CraftingExperimentKind,
} from './crafting-experiment.js';
import { ObjControllerSubtypeIds, objControllerRegistry } from './registry.js';

describe('CraftingExperiment (CM_experimentMessage)', () => {
  it('has the right metadata', () => {
    expect(CraftingExperimentDecoder.kind).toBe('CraftingExperiment');
    expect(CraftingExperimentDecoder.subtypeId).toBe(ObjControllerSubtypeIds.CM_experimentMessage);
    expect(CraftingExperimentDecoder.subtypeId).toBe(262);
  });

  it('self-registers in the subtype registry', () => {
    const found = objControllerRegistry.getById(ObjControllerSubtypeIds.CM_experimentMessage);
    expect(found).toBe(CraftingExperimentDecoder);
    expect(objControllerRegistry.getByKind(CraftingExperimentKind)).toBe(CraftingExperimentDecoder);
  });

  it('round-trips encode → decode with a single attribute', () => {
    const data: CraftingExperimentData = {
      sequenceId: 5,
      experiments: [{ attributeIndex: 2, experimentPoints: 7 }],
      coreLevel: 3,
    };
    const s = new ByteStream();
    CraftingExperimentDecoder.encode(s, data);
    // 1 (u8 seq) + 4 (count) + 4+4 (entry) + 4 (core) = 17 bytes
    expect(s.toBytes().length).toBe(17);
    const d = CraftingExperimentDecoder.decode(new ReadIterator(s.toBytes()));
    expect(d).toEqual(data);
  });

  it('round-trips encode → decode with multiple attributes', () => {
    const data: CraftingExperimentData = {
      sequenceId: 0,
      experiments: [
        { attributeIndex: 0, experimentPoints: 1 },
        { attributeIndex: 1, experimentPoints: 2 },
        { attributeIndex: 5, experimentPoints: 10 },
      ],
      coreLevel: 7,
    };
    const s = new ByteStream();
    CraftingExperimentDecoder.encode(s, data);
    const d = CraftingExperimentDecoder.decode(new ReadIterator(s.toBytes()));
    expect(d).toEqual(data);
  });

  it('round-trips an empty experiments array', () => {
    const data: CraftingExperimentData = {
      sequenceId: 1,
      experiments: [],
      coreLevel: 0,
    };
    const s = new ByteStream();
    CraftingExperimentDecoder.encode(s, data);
    // 1 + 4 + 4 = 9 bytes
    expect(s.toBytes().length).toBe(9);
    const d = CraftingExperimentDecoder.decode(new ReadIterator(s.toBytes()));
    expect(d).toEqual(data);
  });

  it('rejects a negative experiment count on decode', () => {
    const s = new ByteStream();
    s.writeU8(0); // seq
    s.writeI32(-1); // negative count
    expect(() => CraftingExperimentDecoder.decode(new ReadIterator(s.toBytes()))).toThrow(
      /negative experiment count/,
    );
  });

  it('has the exact byte layout for the simplest non-empty form', () => {
    const data: CraftingExperimentData = {
      sequenceId: 1,
      experiments: [{ attributeIndex: 0, experimentPoints: 5 }],
      coreLevel: 2,
    };
    const s = new ByteStream();
    CraftingExperimentDecoder.encode(s, data);
    expect(Array.from(s.toBytes())).toEqual([
      0x01, // sequenceId
      0x01,
      0x00,
      0x00,
      0x00, // count = 1
      0x00,
      0x00,
      0x00,
      0x00, // attributeIndex = 0
      0x05,
      0x00,
      0x00,
      0x00, // experimentPoints = 5
      0x02,
      0x00,
      0x00,
      0x00, // coreLevel = 2
    ]);
  });
});
