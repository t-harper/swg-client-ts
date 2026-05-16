import { describe, expect, it } from 'vitest';
import { ReadIterator } from '../../../archive/read-iterator.js';
import {
  CM_COMMAND_TIMER,
  COMMAND_TIMER_FLAG_COUNT,
  CommandTimerData,
  CommandTimerFlag,
  NULL_COOLDOWN_GROUP,
} from './command-timer-data.js';

describe('CommandTimerData', () => {
  it('exposes the controller-message subtype constant (CM_commandTimer = 762)', () => {
    expect(CM_COMMAND_TIMER).toBe(762);
    expect(CommandTimerData.controllerMessage).toBe(762);
    expect(COMMAND_TIMER_FLAG_COUNT).toBe(6);
  });

  it('round-trips an empty timer (no flags, no cooldown groups, no times) — 9 bytes', () => {
    const original = new CommandTimerData(1, 0xdeadbeef);
    const bytes = original.toBytes();
    // byte flag (0) + u32 seq + u32 crc = 9 bytes
    expect(bytes.length).toBe(9);
    expect(bytes[0]).toBe(0); // flags = 0

    const decoded = CommandTimerData.unpack(new ReadIterator(bytes));
    expect(decoded.sequenceId).toBe(1);
    expect(decoded.commandNameCrc).toBe(0xdeadbeef);
    expect(decoded.cooldownGroup).toBe(NULL_COOLDOWN_GROUP);
    expect(decoded.cooldownGroup2).toBe(NULL_COOLDOWN_GROUP);
    expect(Object.keys(decoded.times).length).toBe(0);
  });

  it('round-trips with a single Warmup time entry', () => {
    const original = new CommandTimerData(7, 0x1234, NULL_COOLDOWN_GROUP, NULL_COOLDOWN_GROUP, {
      [CommandTimerFlag.Warmup]: { current: 0.5, max: 2.0 },
    });
    const bytes = original.toBytes();
    // 9 + (2 * 4 floats) = 17 bytes
    expect(bytes.length).toBe(17);
    expect(bytes[0]).toBe(1 << CommandTimerFlag.Warmup); // flags = 0x01

    const decoded = CommandTimerData.unpack(new ReadIterator(bytes));
    expect(decoded.times[CommandTimerFlag.Warmup]?.current).toBeCloseTo(0.5, 5);
    expect(decoded.times[CommandTimerFlag.Warmup]?.max).toBeCloseTo(2.0, 5);
    expect(decoded.times[CommandTimerFlag.Execute]).toBeUndefined();
  });

  it('round-trips with a Cooldown group (the group int is sandwiched between header and time pairs)', () => {
    const original = new CommandTimerData(99, 0xabcd, 42, NULL_COOLDOWN_GROUP, {
      [CommandTimerFlag.Cooldown]: { current: 5, max: 10 },
    });
    const bytes = original.toBytes();
    // 9 (header) + 4 (cooldownGroup int) + 8 (cooldown time pair) = 21 bytes
    expect(bytes.length).toBe(21);
    expect(bytes[0]).toBe(1 << CommandTimerFlag.Cooldown); // flags = 0x04

    const decoded = CommandTimerData.unpack(new ReadIterator(bytes));
    expect(decoded.cooldownGroup).toBe(42);
    expect(decoded.cooldownGroup2).toBe(NULL_COOLDOWN_GROUP);
    expect(decoded.times[CommandTimerFlag.Cooldown]?.current).toBeCloseTo(5, 5);
    expect(decoded.times[CommandTimerFlag.Cooldown]?.max).toBeCloseTo(10, 5);
  });

  it('round-trips with both cooldown groups and all six time entries', () => {
    const original = new CommandTimerData(1, 0x1111, 5, 6, {
      [CommandTimerFlag.Warmup]: { current: 0.1, max: 1.1 },
      [CommandTimerFlag.Execute]: { current: 0.2, max: 1.2 },
      [CommandTimerFlag.Cooldown]: { current: 0.3, max: 1.3 },
      [CommandTimerFlag.Failed]: { current: 0.4, max: 1.4 },
      [CommandTimerFlag.FailedRetry]: { current: 0.5, max: 1.5 },
      [CommandTimerFlag.Cooldown2]: { current: 0.6, max: 1.6 },
    });
    const bytes = original.toBytes();
    // 9 (header) + 4 (cooldownGroup) + 4 (cooldownGroup2) + 6 * 8 (pairs) = 65 bytes
    expect(bytes.length).toBe(65);

    const decoded = CommandTimerData.unpack(new ReadIterator(bytes));
    expect(decoded.cooldownGroup).toBe(5);
    expect(decoded.cooldownGroup2).toBe(6);
    for (let i = 0; i < 6; i++) {
      const flag = i as CommandTimerFlag;
      const expectedCurrent = (i + 1) * 0.1;
      const expectedMax = 1 + (i + 1) * 0.1;
      expect(decoded.times[flag]?.current).toBeCloseTo(expectedCurrent, 4);
      expect(decoded.times[flag]?.max).toBeCloseTo(expectedMax, 4);
    }
  });

  it('getFlags() returns the union of time-keys and cooldown-group presence bits', () => {
    const t = new CommandTimerData(1, 1, 42, NULL_COOLDOWN_GROUP, {
      [CommandTimerFlag.Warmup]: { current: 0, max: 0 },
    });
    // Warmup bit (0) and Cooldown bit (2) — cooldown bit is auto-added because cooldownGroup != -1
    expect(t.getFlags()).toBe(0x01 | 0x04);
  });

  it('handles negative cooldown groups by treating them as absent', () => {
    const t = new CommandTimerData(1, 1, -1, -1);
    expect(t.getFlags()).toBe(0);
    const bytes = t.toBytes();
    // No cooldown ints; no time pairs => just 9 header bytes
    expect(bytes.length).toBe(9);
  });
});
