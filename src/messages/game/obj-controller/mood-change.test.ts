import { describe, expect, it } from 'vitest';
import { ByteStream } from '../../../archive/byte-stream.js';
import { ReadIterator } from '../../../archive/read-iterator.js';
import { MoodChangeDecoder, MoodChangeKind } from './mood-change.js';
import { ObjControllerSubtypeIds, objControllerRegistry } from './registry.js';

describe('MoodChange (CM_setMood)', () => {
  it('has the right metadata', () => {
    expect(MoodChangeDecoder.kind).toBe(MoodChangeKind);
    expect(MoodChangeDecoder.subtypeId).toBe(ObjControllerSubtypeIds.CM_setMood);
    expect(MoodChangeDecoder.subtypeId).toBe(422);
  });

  it('self-registers in the subtype registry', () => {
    expect(objControllerRegistry.getById(422)).toBe(MoodChangeDecoder);
  });

  it('round-trips encode → decode', () => {
    const s = new ByteStream();
    MoodChangeDecoder.encode(s, { mood: 0x12345678 });
    expect(s.toBytes().length).toBe(4);
    const d = MoodChangeDecoder.decode(new ReadIterator(s.toBytes()));
    expect(d.mood).toBe(0x12345678);
  });

  it('has the exact LE byte layout for mood=0x12345678', () => {
    const s = new ByteStream();
    MoodChangeDecoder.encode(s, { mood: 0x12345678 });
    expect(Array.from(s.toBytes())).toEqual([0x78, 0x56, 0x34, 0x12]);
  });

  it('handles mood=0 cleanly', () => {
    const s = new ByteStream();
    MoodChangeDecoder.encode(s, { mood: 0 });
    expect(Array.from(s.toBytes())).toEqual([0, 0, 0, 0]);
    expect(MoodChangeDecoder.decode(new ReadIterator(s.toBytes())).mood).toBe(0);
  });
});
