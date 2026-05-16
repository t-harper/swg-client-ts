import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import { encodeMessage } from '../base.js';
import { decodeMessageStrict } from '../registry.js';
import { ServerNowEpochTime } from './server-now-epoch-time.js';

describe('ServerNowEpochTime (INBOUND, GenericValueTypeMessage<int32>)', () => {
  it('has the expected constcrc identifier', () => {
    // constcrc("ServerNowEpochTime") = 0x24b73893
    expect(ServerNowEpochTime.typeCrc).toBe(0x24b73893);
  });

  it('encodes to [2 varCount][4 CRC][4 int32 LE]', () => {
    const time = 1_715_864_400; // 2024-05-16ish
    const msg = new ServerNowEpochTime(time);
    const bytes = encodeMessage(msg);

    // [2] varCount = 2 (cmd + value) LE = 02 00
    // [4] CRC = 0x24B73893 LE = 93 38 b7 24
    // [4] int32 time LE
    const expected = Buffer.concat([
      Buffer.from([0x02, 0x00]),
      Buffer.from([0x93, 0x38, 0xb7, 0x24]),
      (() => {
        const b = Buffer.alloc(4);
        b.writeInt32LE(time, 0);
        return b;
      })(),
    ]);
    expect(Array.from(bytes)).toEqual(Array.from(expected));
    expect(bytes.byteLength).toBe(10);
  });

  it('round-trips a typical epoch second value', () => {
    const time = Math.floor(Date.now() / 1000);
    const msg = new ServerNowEpochTime(time);
    const decoded = decodeMessageStrict(encodeMessage(msg));
    expect((decoded as InstanceType<typeof ServerNowEpochTime>).value).toBe(time);
  });

  it('handles negative epoch values (pre-1970)', () => {
    const msg = new ServerNowEpochTime(-1);
    const decoded = decodeMessageStrict(encodeMessage(msg));
    expect((decoded as InstanceType<typeof ServerNowEpochTime>).value).toBe(-1);
  });

  it('decoded value is an instanceof ServerNowEpochTime', () => {
    const msg = new ServerNowEpochTime(42);
    const decoded = decodeMessageStrict(encodeMessage(msg));
    expect(decoded).toBeInstanceOf(ServerNowEpochTime);
  });
});
