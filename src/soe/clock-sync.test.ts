import { describe, expect, it } from 'vitest';
import {
  type ClockSyncPacket,
  buildClockReflect,
  buildClockSync,
  CLOCK_REFLECT_SIZE,
  CLOCK_SYNC_SIZE,
  clockReflectRttMs,
  localSyncStampShort,
  parseClockReflect,
  parseClockSync,
  summarizeLatency,
} from './clock-sync.js';
import { SoePacketType } from './packet-types.js';

/**
 * Build a hand-crafted ClockSync wire packet from known field values.
 * All multi-byte fields are big-endian (UdpMisc::Put/GetValue16/32/64).
 * Layout per UdpLibrary.hpp:1442-1454.
 */
function craftClockSync(fields: Omit<ClockSyncPacket, 'zeroByte' | 'packetType'>): Uint8Array {
  const buf = new Uint8Array(CLOCK_SYNC_SIZE);
  buf[0] = 0;
  buf[1] = SoePacketType.ClockSync; // 7
  // timeStamp u16 BE at off=2
  buf[2] = (fields.timeStamp >>> 8) & 0xff;
  buf[3] = fields.timeStamp & 0xff;
  // masterPingTime i32 BE at off=4
  const writeI32 = (off: number, v: number): void => {
    const u = v >>> 0;
    buf[off] = (u >>> 24) & 0xff;
    buf[off + 1] = (u >>> 16) & 0xff;
    buf[off + 2] = (u >>> 8) & 0xff;
    buf[off + 3] = u & 0xff;
  };
  writeI32(4, fields.masterPingTime);
  writeI32(8, fields.averagePingTime);
  writeI32(12, fields.lowPingTime);
  writeI32(16, fields.highPingTime);
  writeI32(20, fields.lastPingTime);
  // ourSent i64 BE at off=24
  const writeI64 = (off: number, v: bigint): void => {
    for (let i = 7; i >= 0; i--) {
      buf[off + i] = Number(v & 0xffn);
      v >>= 8n;
    }
  };
  writeI64(24, fields.ourSent);
  writeI64(32, fields.ourReceived);
  return buf;
}

describe('ClockSync wire layout', () => {
  it('parses a golden hand-crafted ClockSync (40 bytes)', () => {
    const expected: ClockSyncPacket = {
      zeroByte: 0,
      packetType: SoePacketType.ClockSync,
      timeStamp: 0x1234,
      masterPingTime: 50,
      averagePingTime: 75,
      lowPingTime: 20,
      highPingTime: 250,
      lastPingTime: 100,
      ourSent: 0x1122334455667788n,
      ourReceived: 0x99aabbccddeeff00n,
    };
    const wire = craftClockSync(expected);
    expect(wire.length).toBe(40);
    expect(wire[0]).toBe(0);
    expect(wire[1]).toBe(7);
    // Verify each field at its known offset on the wire (golden bytes)
    expect(wire[2]).toBe(0x12);
    expect(wire[3]).toBe(0x34);
    expect(wire[24]).toBe(0x11);
    expect(wire[31]).toBe(0x88);
    expect(wire[32]).toBe(0x99);
    expect(wire[39]).toBe(0x00);

    const parsed = parseClockSync(wire);
    expect(parsed).toEqual(expected);
  });

  it('rejects packets that are too short', () => {
    expect(() => parseClockSync(new Uint8Array(20))).toThrow(/too short/);
  });

  it('rejects packets with the wrong opcode', () => {
    const wire = craftClockSync({
      timeStamp: 0,
      masterPingTime: 0,
      averagePingTime: 0,
      lowPingTime: 0,
      highPingTime: 0,
      lastPingTime: 0,
      ourSent: 0n,
      ourReceived: 0n,
    });
    wire[1] = 6; // KeepAlive — not ClockSync
    expect(() => parseClockSync(wire)).toThrow(/not a ClockSync/);
  });

  it('sign-extends negative i32 ping-time fields', () => {
    const wire = craftClockSync({
      timeStamp: 0,
      masterPingTime: -1,
      averagePingTime: -42,
      lowPingTime: 0,
      highPingTime: 0,
      lastPingTime: 0,
      ourSent: 0n,
      ourReceived: 0n,
    });
    // Verify the negative values were written as 0xffffffff / 0xffffffd6
    expect(wire[4]).toBe(0xff);
    expect(wire[5]).toBe(0xff);
    expect(wire[6]).toBe(0xff);
    expect(wire[7]).toBe(0xff);

    const parsed = parseClockSync(wire);
    expect(parsed.masterPingTime).toBe(-1);
    expect(parsed.averagePingTime).toBe(-42);
  });
});

describe('ClockSync constructor (buildClockSync)', () => {
  it('produces a 40-byte packet that round-trips through parseClockSync', () => {
    const wire = buildClockSync(0xabcd, {
      masterPingTime: 12,
      averagePingTime: 15,
      lowPingTime: 5,
      highPingTime: 40,
      lastPingTime: 10,
      ourSent: 100n,
      ourReceived: 99n,
    });
    expect(wire.length).toBe(40);
    expect(wire[0]).toBe(0);
    expect(wire[1]).toBe(7);
    // timeStamp u16 BE: 0xabcd → [0xab, 0xcd]
    expect(wire[2]).toBe(0xab);
    expect(wire[3]).toBe(0xcd);

    const parsed = parseClockSync(wire);
    expect(parsed.timeStamp).toBe(0xabcd);
    expect(parsed.masterPingTime).toBe(12);
    expect(parsed.ourSent).toBe(100n);
    expect(parsed.ourReceived).toBe(99n);
  });

  it('defaults stat fields to zero when omitted', () => {
    const wire = buildClockSync(0x0001);
    const parsed = parseClockSync(wire);
    expect(parsed.masterPingTime).toBe(0);
    expect(parsed.averagePingTime).toBe(0);
    expect(parsed.lowPingTime).toBe(0);
    expect(parsed.highPingTime).toBe(0);
    expect(parsed.lastPingTime).toBe(0);
    expect(parsed.ourSent).toBe(0n);
    expect(parsed.ourReceived).toBe(0n);
  });
});

describe('ClockReflect (build + parse round-trip)', () => {
  it('echoes the ClockSync timeStamp and the originator counts', () => {
    const sync: ClockSyncPacket = {
      zeroByte: 0,
      packetType: 7,
      timeStamp: 0xbeef,
      masterPingTime: 0,
      averagePingTime: 0,
      lowPingTime: 0,
      highPingTime: 0,
      lastPingTime: 0,
      ourSent: 4242n,
      ourReceived: 4241n,
    };
    const reflect = buildClockReflect(sync, 0x11223344, 1n, 2n);
    expect(reflect.length).toBe(CLOCK_REFLECT_SIZE);
    expect(reflect[0]).toBe(0);
    expect(reflect[1]).toBe(8);

    const parsed = parseClockReflect(reflect);
    expect(parsed.timeStamp).toBe(0xbeef); // echoed
    expect(parsed.serverSyncStampLong).toBe(0x11223344);
    expect(parsed.yourSent).toBe(4242n); // echoed
    expect(parsed.yourReceived).toBe(4241n); // echoed
    expect(parsed.ourSent).toBe(1n);
    expect(parsed.ourReceived).toBe(2n);
  });

  it('parse → buildReflect → parse preserves all fields', () => {
    const wire = craftClockSync({
      timeStamp: 0x4321,
      masterPingTime: 100,
      averagePingTime: 150,
      lowPingTime: 50,
      highPingTime: 500,
      lastPingTime: 200,
      ourSent: 0x123456789abcdef0n,
      ourReceived: 0xfedcba9876543210n,
    });
    const sync = parseClockSync(wire);
    const reflect = buildClockReflect(sync, 0xcafebabe, 0n, 0n);
    const reflected = parseClockReflect(reflect);
    expect(reflected.timeStamp).toBe(sync.timeStamp);
    expect(reflected.yourSent).toBe(sync.ourSent);
    expect(reflected.yourReceived).toBe(sync.ourReceived);
    expect(reflected.serverSyncStampLong).toBe(0xcafebabe);
  });

  it('rejects ClockReflect packets that are too short', () => {
    expect(() => parseClockReflect(new Uint8Array(10))).toThrow(/too short/);
  });

  it('rejects ClockReflect packets with the wrong opcode', () => {
    const sync: ClockSyncPacket = {
      zeroByte: 0,
      packetType: 7,
      timeStamp: 0,
      masterPingTime: 0,
      averagePingTime: 0,
      lowPingTime: 0,
      highPingTime: 0,
      lastPingTime: 0,
      ourSent: 0n,
      ourReceived: 0n,
    };
    const reflect = buildClockReflect(sync, 0, 0n, 0n);
    reflect[1] = 9; // Reliable1
    expect(() => parseClockReflect(reflect)).toThrow(/not a ClockReflect/);
  });
});

describe('clockReflectRttMs (SyncStampShortDeltaTime)', () => {
  it('returns simple difference when stamp2 > stamp1 with no wraparound', () => {
    // localStampNow=1100, reflectedStamp=1000 → RTT=100
    expect(clockReflectRttMs(1000, 1100)).toBe(100);
  });

  it('handles wraparound (16-bit stamp)', () => {
    // localStampNow=10 (just wrapped past 0xffff), reflectedStamp=0xfff0
    // delta = (10 - 0xfff0) & 0xffff = 0x001a (26), but our code computes
    // (localStampNow - reflectedStamp) & 0xffff = (10 - 0xfff0) & 0xffff
    // = (-65510) & 0xffff = 26. So RTT = 26 ms.
    expect(clockReflectRttMs(0xfff0, 10)).toBe(26);
  });

  it('returns 0 when stamps are identical', () => {
    expect(clockReflectRttMs(1234, 1234)).toBe(0);
  });

  it('treats clearly-wrapped values per SyncStampShortDeltaTime branch', () => {
    // If delta > 0x7fff we use the 0xffff-delta branch.
    // localStampNow=0, reflectedStamp=0x8001 → (0 - 0x8001) & 0xffff = 0x7fff
    // → 0x7fff is NOT > 0x7fff, simple branch returns 0x7fff.
    expect(clockReflectRttMs(0x8001, 0)).toBe(0x7fff);

    // localStampNow=0, reflectedStamp=0x7fff → (0 - 0x7fff) & 0xffff = 0x8001
    // → 0x8001 IS > 0x7fff, returns 0xffff - 0x8001 = 0x7ffe
    expect(clockReflectRttMs(0x7fff, 0)).toBe(0x7ffe);
  });
});

describe('localSyncStampShort', () => {
  it('returns low 16 bits of Date.now()', () => {
    // Take two adjacent snapshots so a 1ms tick between calls doesn't fail
    // the equality check. The two stamps must agree modulo at most 1ms of
    // wall-clock drift (modulo 16-bit wraparound, which is extraordinarily
    // unlikely to land between two adjacent statements).
    const before = Date.now() & 0xffff;
    const stamp = localSyncStampShort();
    const after = Date.now() & 0xffff;
    expect(stamp).toBeGreaterThanOrEqual(0);
    expect(stamp).toBeLessThanOrEqual(0xffff);
    expect(stamp === before || stamp === after).toBe(true);
  });
});

describe('summarizeLatency', () => {
  it('returns null on empty input', () => {
    expect(summarizeLatency([])).toBeNull();
  });

  it('computes percentiles via nearest-rank', () => {
    // 100 samples 1..100 — p50=50 (ceil(50)-1=49 → 50), p95=95, p99=99
    const samples = Array.from({ length: 100 }, (_, i) => i + 1);
    const stats = summarizeLatency(samples);
    expect(stats).not.toBeNull();
    if (stats === null) throw new Error('unreachable');
    expect(stats.count).toBe(100);
    expect(stats.p50).toBe(50);
    expect(stats.p95).toBe(95);
    expect(stats.p99).toBe(99);
    expect(stats.min).toBe(1);
    expect(stats.max).toBe(100);
    expect(stats.mean).toBe(50.5);
  });

  it('handles a single-sample list', () => {
    const stats = summarizeLatency([42]);
    if (stats === null) throw new Error('unreachable');
    expect(stats.count).toBe(1);
    expect(stats.p50).toBe(42);
    expect(stats.p95).toBe(42);
    expect(stats.p99).toBe(42);
    expect(stats.min).toBe(42);
    expect(stats.max).toBe(42);
    expect(stats.mean).toBe(42);
  });

  it('returns a defensive copy of samples (not a reference)', () => {
    const original = [10, 20, 30];
    const stats = summarizeLatency(original);
    if (stats === null) throw new Error('unreachable');
    stats.samples.push(99);
    expect(original.length).toBe(3);
  });
});
