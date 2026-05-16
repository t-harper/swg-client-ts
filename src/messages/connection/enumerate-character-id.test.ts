import { describe, expect, it } from 'vitest';
import { ByteStream } from '../../archive/byte-stream.js';
import { ReadIterator } from '../../archive/read-iterator.js';
import { type CharacterRow, EnumerateCharacterId } from './enumerate-character-id.js';

describe('EnumerateCharacterId', () => {
  it('has the expected metadata', () => {
    expect(EnumerateCharacterId.messageName).toBe('EnumerateCharacterId');
    expect(EnumerateCharacterId.typeCrc).toBeGreaterThan(0);
  });

  it('round-trips an empty list', () => {
    const m = new EnumerateCharacterId([]);
    const s = new ByteStream();
    m.encodePayload(s);
    expect(Array.from(s.toBytes())).toEqual([0, 0, 0, 0]); // u32 zero count
    const d = EnumerateCharacterId.decodePayload(new ReadIterator(s.toBytes()));
    expect(d.characters).toEqual([]);
  });

  it('round-trips a multi-character list', () => {
    const chars: CharacterRow[] = [
      {
        name: 'Test Char',
        objectTemplateId: 0x12345678,
        networkId: 0x0011_2233_4455_6677n,
        clusterId: 1,
        characterType: 1,
      },
      {
        name: 'Jedi One',
        objectTemplateId: -1,
        networkId: 0x00ff_00ff_00ff_00ffn,
        clusterId: 1,
        characterType: 2,
      },
    ];
    const m = new EnumerateCharacterId(chars);
    const s = new ByteStream();
    m.encodePayload(s);
    const iter = new ReadIterator(s.toBytes());
    const d = EnumerateCharacterId.decodePayload(iter);
    expect(iter.remaining).toBe(0);
    expect(d.characters.length).toBe(2);
    expect(d.characters[0]?.name).toBe('Test Char');
    expect(d.characters[0]?.objectTemplateId).toBe(0x12345678);
    expect(d.characters[0]?.networkId).toBe(0x0011_2233_4455_6677n);
    expect(d.characters[0]?.clusterId).toBe(1);
    expect(d.characters[0]?.characterType).toBe(1);
    expect(d.characters[1]?.objectTemplateId).toBe(-1);
    expect(d.characters[1]?.characterType).toBe(2);
  });

  it('lays out an empty-name single-character entry correctly', () => {
    const m = new EnumerateCharacterId([
      {
        name: '',
        objectTemplateId: 0,
        networkId: 0n,
        clusterId: 0,
        characterType: 0,
      },
    ]);
    const s = new ByteStream();
    m.encodePayload(s);
    // Expected:
    //   [u32 count=1: 01 00 00 00]
    //   [UnicodeString count=0: 00 00 00 00]
    //   [i32 templateId=0: 00 00 00 00]
    //   [i64 networkId=0: 00 00 00 00 00 00 00 00]
    //   [u32 clusterId=0: 00 00 00 00]
    //   [i32 characterType=0: 00 00 00 00]
    expect(s.toBytes().length).toBe(4 + 4 + 4 + 8 + 4 + 4);
  });
});
