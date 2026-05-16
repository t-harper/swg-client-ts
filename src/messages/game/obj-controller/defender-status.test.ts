import { describe, expect, it } from 'vitest';
import { ByteStream } from '../../../archive/byte-stream.js';
import { ReadIterator } from '../../../archive/read-iterator.js';
import { DefenderStatusDecoder, DefenderStatusKind } from './defender-status.js';
import { ObjControllerSubtypeIds, objControllerRegistry } from './registry.js';

describe('DefenderStatus (CM_setCombatTarget)', () => {
  it('has the right metadata', () => {
    expect(DefenderStatusDecoder.kind).toBe('DefenderStatus');
    expect(DefenderStatusDecoder.subtypeId).toBe(ObjControllerSubtypeIds.CM_setCombatTarget);
    expect(DefenderStatusDecoder.subtypeId).toBe(386);
  });

  it('self-registers in the subtype registry', () => {
    const found = objControllerRegistry.getById(ObjControllerSubtypeIds.CM_setCombatTarget);
    expect(found).toBe(DefenderStatusDecoder);
    expect(objControllerRegistry.getByKind(DefenderStatusKind)).toBe(DefenderStatusDecoder);
  });

  it('round-trips a target update', () => {
    // NetworkId is signed i64 on the wire; keep the high bit clear.
    const s = new ByteStream();
    DefenderStatusDecoder.encode(s, { targetId: 0x0ead_beef_1234_5678n });
    const d = DefenderStatusDecoder.decode(new ReadIterator(s.toBytes()));
    expect(d.targetId).toBe(0x0ead_beef_1234_5678n);
  });

  it('round-trips "drop target" (targetId=0)', () => {
    const s = new ByteStream();
    DefenderStatusDecoder.encode(s, { targetId: 0n });
    const d = DefenderStatusDecoder.decode(new ReadIterator(s.toBytes()));
    expect(d.targetId).toBe(0n);
  });

  it('has the exact byte layout (8 bytes i64 LE)', () => {
    const s = new ByteStream();
    DefenderStatusDecoder.encode(s, { targetId: 1n });
    const bytes = s.toBytes();
    expect(bytes.length).toBe(8);
    expect(Array.from(bytes)).toEqual([0x01, 0, 0, 0, 0, 0, 0, 0]);
  });
});
