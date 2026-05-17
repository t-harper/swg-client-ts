import { describe, expect, it } from 'vitest';

import { ByteStream } from '../../../archive/byte-stream.js';
import type { IReadIterator } from '../../../archive/interface.js';
import { ReadIterator } from '../../../archive/read-iterator.js';
import { readStdString, writeStdString } from '../../../archive/string.js';
import {
  AutoDeltaMapCommand,
  AutoDeltaSetCommand,
  AutoDeltaVectorCommand,
  readAutoDeltaMapDelta,
  readAutoDeltaSetDelta,
  readAutoDeltaVectorDelta,
} from './auto-delta-delta-codecs.js';

// --------------------------------------------------------------------
// AutoDeltaVector
// --------------------------------------------------------------------

describe('readAutoDeltaVectorDelta', () => {
  const readI32 = (i: IReadIterator) => i.readI32();

  it('decodes ERASE: [u32 1][u32 0][u8 0][u16 5]', () => {
    const s = new ByteStream();
    s.writeU32(1); // commandCount
    s.writeU32(0); // baselineCommandCount
    s.writeU8(AutoDeltaVectorCommand.ERASE);
    s.writeU16(5);

    const iter = new ReadIterator(s.toBytes());
    const out = readAutoDeltaVectorDelta(iter, readI32);
    expect(out).toEqual([{ kind: 'erase', index: 5 }]);
    expect(iter.remaining).toBe(0);
  });

  it('decodes INSERT: [u32 1][u32 0][u8 1][u16 2][i32 42]', () => {
    const s = new ByteStream();
    s.writeU32(1);
    s.writeU32(0);
    s.writeU8(AutoDeltaVectorCommand.INSERT);
    s.writeU16(2);
    s.writeI32(42);

    const iter = new ReadIterator(s.toBytes());
    const out = readAutoDeltaVectorDelta(iter, readI32);
    expect(out).toEqual([{ kind: 'insert', index: 2, value: 42 }]);
    expect(iter.remaining).toBe(0);
  });

  it('decodes SET: [u32 1][u32 0][u8 2][u16 0][i32 99]', () => {
    const s = new ByteStream();
    s.writeU32(1);
    s.writeU32(0);
    s.writeU8(AutoDeltaVectorCommand.SET);
    s.writeU16(0);
    s.writeI32(99);

    const iter = new ReadIterator(s.toBytes());
    const out = readAutoDeltaVectorDelta(iter, readI32);
    expect(out).toEqual([{ kind: 'set', index: 0, value: 99 }]);
    expect(iter.remaining).toBe(0);
  });

  it('decodes SETALL with count=3: [u32 4][u32 0][u8 3][u16 3][i32 10][i32 20][i32 30]', () => {
    // commandCount = 1 (SETALL) + 3 (count) = 4
    const s = new ByteStream();
    s.writeU32(4);
    s.writeU32(0);
    s.writeU8(AutoDeltaVectorCommand.SETALL);
    s.writeU16(3); // count
    s.writeI32(10);
    s.writeI32(20);
    s.writeI32(30);

    const iter = new ReadIterator(s.toBytes());
    const out = readAutoDeltaVectorDelta(iter, readI32);
    expect(out).toEqual([{ kind: 'setAll', values: [10, 20, 30] }]);
    expect(iter.remaining).toBe(0);
  });

  it('decodes SETALL with count=0: [u32 1][u32 0][u8 3][u16 0]', () => {
    // commandCount = 1 (SETALL alone, no queued SETs)
    const s = new ByteStream();
    s.writeU32(1);
    s.writeU32(0);
    s.writeU8(AutoDeltaVectorCommand.SETALL);
    s.writeU16(0);

    const iter = new ReadIterator(s.toBytes());
    const out = readAutoDeltaVectorDelta(iter, readI32);
    expect(out).toEqual([{ kind: 'setAll', values: [] }]);
    expect(iter.remaining).toBe(0);
  });

  it('decodes CLEAR: [u32 1][u32 0][u8 4]', () => {
    const s = new ByteStream();
    s.writeU32(1);
    s.writeU32(0);
    s.writeU8(AutoDeltaVectorCommand.CLEAR);

    const iter = new ReadIterator(s.toBytes());
    const out = readAutoDeltaVectorDelta(iter, readI32);
    expect(out).toEqual([{ kind: 'clear' }]);
    expect(iter.remaining).toBe(0);
  });

  it('decodes a mixed-command list (ERASE, INSERT, CLEAR, SET, SETALL with count=2)', () => {
    // commandCount = 4 standalone + 1+2 for SETALL = 7
    const s = new ByteStream();
    s.writeU32(7);
    s.writeU32(0);
    // ERASE(0) at index=1
    s.writeU8(AutoDeltaVectorCommand.ERASE);
    s.writeU16(1);
    // INSERT(1) at index=4 value=7
    s.writeU8(AutoDeltaVectorCommand.INSERT);
    s.writeU16(4);
    s.writeI32(7);
    // CLEAR(4)
    s.writeU8(AutoDeltaVectorCommand.CLEAR);
    // SET(2) at index=2 value=-1
    s.writeU8(AutoDeltaVectorCommand.SET);
    s.writeU16(2);
    s.writeI32(-1);
    // SETALL(3) count=2 values=[100, 200]
    s.writeU8(AutoDeltaVectorCommand.SETALL);
    s.writeU16(2);
    s.writeI32(100);
    s.writeI32(200);

    const iter = new ReadIterator(s.toBytes());
    const out = readAutoDeltaVectorDelta(iter, readI32);
    expect(out).toEqual([
      { kind: 'erase', index: 1 },
      { kind: 'insert', index: 4, value: 7 },
      { kind: 'clear' },
      { kind: 'set', index: 2, value: -1 },
      { kind: 'setAll', values: [100, 200] },
    ]);
    expect(iter.remaining).toBe(0);
  });

  it('decodes empty command list ([u32 0][u32 0])', () => {
    const s = new ByteStream();
    s.writeU32(0);
    s.writeU32(0);
    const iter = new ReadIterator(s.toBytes());
    const out = readAutoDeltaVectorDelta(iter, readI32);
    expect(out).toEqual([]);
    expect(iter.remaining).toBe(0);
  });

  it('drops baselineCommandCount but still reads it (advances 4 bytes)', () => {
    const s = new ByteStream();
    s.writeU32(0);
    s.writeU32(0xdeadbeef); // arbitrary baselineCommandCount
    const iter = new ReadIterator(s.toBytes());
    readAutoDeltaVectorDelta(iter, readI32);
    expect(iter.position).toBe(8);
  });

  it('throws on unknown command byte', () => {
    const s = new ByteStream();
    s.writeU32(1);
    s.writeU32(0);
    s.writeU8(0xff);

    const iter = new ReadIterator(s.toBytes());
    expect(() => readAutoDeltaVectorDelta(iter, readI32)).toThrow(/unknown command byte 255/);
  });

  it('works with std::string element type', () => {
    const s = new ByteStream();
    s.writeU32(2);
    s.writeU32(0);
    s.writeU8(AutoDeltaVectorCommand.INSERT);
    s.writeU16(0);
    writeStdString(s, 'hello');
    s.writeU8(AutoDeltaVectorCommand.SET);
    s.writeU16(1);
    writeStdString(s, 'world');

    const iter = new ReadIterator(s.toBytes());
    const out = readAutoDeltaVectorDelta(iter, readStdString);
    expect(out).toEqual([
      { kind: 'insert', index: 0, value: 'hello' },
      { kind: 'set', index: 1, value: 'world' },
    ]);
    expect(iter.remaining).toBe(0);
  });
});

// --------------------------------------------------------------------
// AutoDeltaSet
// --------------------------------------------------------------------

describe('readAutoDeltaSetDelta', () => {
  const readI32 = (i: IReadIterator) => i.readI32();

  it('decodes ERASE: [u32 1][u32 0][u8 0][i32 42]', () => {
    const s = new ByteStream();
    s.writeU32(1);
    s.writeU32(0);
    s.writeU8(AutoDeltaSetCommand.ERASE);
    s.writeI32(42);

    const iter = new ReadIterator(s.toBytes());
    const out = readAutoDeltaSetDelta(iter, readI32);
    expect(out).toEqual([{ kind: 'erase', value: 42 }]);
    expect(iter.remaining).toBe(0);
  });

  it('decodes INSERT: [u32 1][u32 0][u8 1][i32 99]', () => {
    const s = new ByteStream();
    s.writeU32(1);
    s.writeU32(0);
    s.writeU8(AutoDeltaSetCommand.INSERT);
    s.writeI32(99);

    const iter = new ReadIterator(s.toBytes());
    const out = readAutoDeltaSetDelta(iter, readI32);
    expect(out).toEqual([{ kind: 'insert', value: 99 }]);
    expect(iter.remaining).toBe(0);
  });

  it('decodes CLEAR: [u32 1][u32 0][u8 2]', () => {
    const s = new ByteStream();
    s.writeU32(1);
    s.writeU32(0);
    s.writeU8(AutoDeltaSetCommand.CLEAR);

    const iter = new ReadIterator(s.toBytes());
    const out = readAutoDeltaSetDelta(iter, readI32);
    expect(out).toEqual([{ kind: 'clear' }]);
    expect(iter.remaining).toBe(0);
  });

  it('decodes a mixed-command list (INSERT, INSERT, ERASE, CLEAR)', () => {
    const s = new ByteStream();
    s.writeU32(4);
    s.writeU32(0);
    s.writeU8(AutoDeltaSetCommand.INSERT);
    s.writeI32(1);
    s.writeU8(AutoDeltaSetCommand.INSERT);
    s.writeI32(2);
    s.writeU8(AutoDeltaSetCommand.ERASE);
    s.writeI32(1);
    s.writeU8(AutoDeltaSetCommand.CLEAR);

    const iter = new ReadIterator(s.toBytes());
    const out = readAutoDeltaSetDelta(iter, readI32);
    expect(out).toEqual([
      { kind: 'insert', value: 1 },
      { kind: 'insert', value: 2 },
      { kind: 'erase', value: 1 },
      { kind: 'clear' },
    ]);
    expect(iter.remaining).toBe(0);
  });

  it('decodes empty command list ([u32 0][u32 0])', () => {
    const s = new ByteStream();
    s.writeU32(0);
    s.writeU32(0);
    const iter = new ReadIterator(s.toBytes());
    const out = readAutoDeltaSetDelta(iter, readI32);
    expect(out).toEqual([]);
    expect(iter.remaining).toBe(0);
  });

  it('drops baselineCommandCount but still reads it', () => {
    const s = new ByteStream();
    s.writeU32(0);
    s.writeU32(0x12345678);
    const iter = new ReadIterator(s.toBytes());
    readAutoDeltaSetDelta(iter, readI32);
    expect(iter.position).toBe(8);
  });

  it('throws on unknown command byte', () => {
    const s = new ByteStream();
    s.writeU32(1);
    s.writeU32(0);
    s.writeU8(0xaa);

    const iter = new ReadIterator(s.toBytes());
    expect(() => readAutoDeltaSetDelta(iter, readI32)).toThrow(/unknown command byte 170/);
  });

  it('works with std::string element type', () => {
    const s = new ByteStream();
    s.writeU32(2);
    s.writeU32(0);
    s.writeU8(AutoDeltaSetCommand.INSERT);
    writeStdString(s, 'alpha');
    s.writeU8(AutoDeltaSetCommand.ERASE);
    writeStdString(s, 'beta');

    const iter = new ReadIterator(s.toBytes());
    const out = readAutoDeltaSetDelta(iter, readStdString);
    expect(out).toEqual([
      { kind: 'insert', value: 'alpha' },
      { kind: 'erase', value: 'beta' },
    ]);
    expect(iter.remaining).toBe(0);
  });
});

// --------------------------------------------------------------------
// AutoDeltaMap
// --------------------------------------------------------------------

describe('readAutoDeltaMapDelta', () => {
  const readI32 = (i: IReadIterator) => i.readI32();

  it('decodes ADD: [u32 1][u32 0][u8 0][i32 1][i32 100]', () => {
    const s = new ByteStream();
    s.writeU32(1);
    s.writeU32(0);
    s.writeU8(AutoDeltaMapCommand.ADD);
    s.writeI32(1);
    s.writeI32(100);

    const iter = new ReadIterator(s.toBytes());
    const out = readAutoDeltaMapDelta(iter, readI32, readI32);
    expect(out).toEqual([{ kind: 'add', key: 1, value: 100 }]);
    expect(iter.remaining).toBe(0);
  });

  it('decodes ERASE: [u32 1][u32 0][u8 1][i32 2][i32 200] (carries stale value)', () => {
    // C++ packDelta emits both key and value for ERASE so the server can fire
    // onErase callbacks with the old value (AutoDeltaMap.h:404-429).
    const s = new ByteStream();
    s.writeU32(1);
    s.writeU32(0);
    s.writeU8(AutoDeltaMapCommand.ERASE);
    s.writeI32(2);
    s.writeI32(200);

    const iter = new ReadIterator(s.toBytes());
    const out = readAutoDeltaMapDelta(iter, readI32, readI32);
    expect(out).toEqual([{ kind: 'erase', key: 2, value: 200 }]);
    expect(iter.remaining).toBe(0);
  });

  it('decodes SET: [u32 1][u32 0][u8 2][i32 3][i32 300]', () => {
    const s = new ByteStream();
    s.writeU32(1);
    s.writeU32(0);
    s.writeU8(AutoDeltaMapCommand.SET);
    s.writeI32(3);
    s.writeI32(300);

    const iter = new ReadIterator(s.toBytes());
    const out = readAutoDeltaMapDelta(iter, readI32, readI32);
    expect(out).toEqual([{ kind: 'set', key: 3, value: 300 }]);
    expect(iter.remaining).toBe(0);
  });

  it('decodes a mixed-command list (ADD, SET, ERASE, ADD)', () => {
    const s = new ByteStream();
    s.writeU32(4);
    s.writeU32(0);
    s.writeU8(AutoDeltaMapCommand.ADD);
    s.writeI32(1);
    s.writeI32(10);
    s.writeU8(AutoDeltaMapCommand.SET);
    s.writeI32(1);
    s.writeI32(11);
    s.writeU8(AutoDeltaMapCommand.ERASE);
    s.writeI32(1);
    s.writeI32(11);
    s.writeU8(AutoDeltaMapCommand.ADD);
    s.writeI32(2);
    s.writeI32(20);

    const iter = new ReadIterator(s.toBytes());
    const out = readAutoDeltaMapDelta(iter, readI32, readI32);
    expect(out).toEqual([
      { kind: 'add', key: 1, value: 10 },
      { kind: 'set', key: 1, value: 11 },
      { kind: 'erase', key: 1, value: 11 },
      { kind: 'add', key: 2, value: 20 },
    ]);
    expect(iter.remaining).toBe(0);
  });

  it('decodes empty command list ([u32 0][u32 0])', () => {
    const s = new ByteStream();
    s.writeU32(0);
    s.writeU32(0);
    const iter = new ReadIterator(s.toBytes());
    const out = readAutoDeltaMapDelta(iter, readI32, readI32);
    expect(out).toEqual([]);
    expect(iter.remaining).toBe(0);
  });

  it('drops baselineCommandCount but still reads it', () => {
    const s = new ByteStream();
    s.writeU32(0);
    s.writeU32(0xcafef00d);
    const iter = new ReadIterator(s.toBytes());
    readAutoDeltaMapDelta(iter, readI32, readI32);
    expect(iter.position).toBe(8);
  });

  it('throws on unknown command byte', () => {
    const s = new ByteStream();
    s.writeU32(1);
    s.writeU32(0);
    s.writeU8(0x55);
    s.writeI32(0); // would-be key
    s.writeI32(0); // would-be value

    const iter = new ReadIterator(s.toBytes());
    expect(() => readAutoDeltaMapDelta(iter, readI32, readI32)).toThrow(/unknown command byte 85/);
  });

  it('works with std::string key and i32 value', () => {
    const s = new ByteStream();
    s.writeU32(2);
    s.writeU32(0);
    s.writeU8(AutoDeltaMapCommand.ADD);
    writeStdString(s, 'foo');
    s.writeI32(1);
    s.writeU8(AutoDeltaMapCommand.SET);
    writeStdString(s, 'foo');
    s.writeI32(2);

    const iter = new ReadIterator(s.toBytes());
    const out = readAutoDeltaMapDelta(iter, readStdString, readI32);
    expect(out).toEqual([
      { kind: 'add', key: 'foo', value: 1 },
      { kind: 'set', key: 'foo', value: 2 },
    ]);
    expect(iter.remaining).toBe(0);
  });
});

// --------------------------------------------------------------------
// Command enum value sanity check (catches anyone reshuffling them)
// --------------------------------------------------------------------

describe('command enum values', () => {
  it('AutoDeltaVector commands match the C++ header order', () => {
    expect(AutoDeltaVectorCommand.ERASE).toBe(0);
    expect(AutoDeltaVectorCommand.INSERT).toBe(1);
    expect(AutoDeltaVectorCommand.SET).toBe(2);
    expect(AutoDeltaVectorCommand.SETALL).toBe(3);
    expect(AutoDeltaVectorCommand.CLEAR).toBe(4);
  });

  it('AutoDeltaSet commands match the C++ header order', () => {
    expect(AutoDeltaSetCommand.ERASE).toBe(0);
    expect(AutoDeltaSetCommand.INSERT).toBe(1);
    expect(AutoDeltaSetCommand.CLEAR).toBe(2);
  });

  it('AutoDeltaMap commands match the C++ header order', () => {
    expect(AutoDeltaMapCommand.ADD).toBe(0);
    expect(AutoDeltaMapCommand.ERASE).toBe(1);
    expect(AutoDeltaMapCommand.SET).toBe(2);
  });
});
