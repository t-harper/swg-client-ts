import { describe, expect, it } from 'vitest';
import { ByteStream } from '../../../archive/byte-stream.js';
import { ReadIterator } from '../../../archive/read-iterator.js';
import {
  CM_COMMAND_QUEUE_REMOVE,
  CommandErrorCode,
  CommandQueueRemove,
} from './command-queue-remove.js';

describe('CommandQueueRemove', () => {
  it('exposes the controller-message subtype constant (CM_commandQueueRemove = 279)', () => {
    expect(CM_COMMAND_QUEUE_REMOVE).toBe(279);
    expect(CommandQueueRemove.controllerMessage).toBe(279);
  });

  it('round-trips pack → unpack with Success status', () => {
    const original = new CommandQueueRemove(42, 0, CommandErrorCode.Success, 0);
    const bytes = original.toBytes();
    const decoded = CommandQueueRemove.unpack(new ReadIterator(bytes));
    expect(decoded.sequenceId).toBe(42);
    expect(decoded.waitTime).toBe(0);
    expect(decoded.status).toBe(0);
    expect(decoded.statusDetail).toBe(0);
  });

  it('round-trips with a non-zero waitTime and Failure status', () => {
    const original = new CommandQueueRemove(7, 1.5, CommandErrorCode.Failure, 42);
    const bytes = original.toBytes();
    const decoded = CommandQueueRemove.unpack(new ReadIterator(bytes));
    expect(decoded.sequenceId).toBe(7);
    expect(decoded.waitTime).toBeCloseTo(1.5, 5);
    expect(decoded.status).toBe(1);
    expect(decoded.statusDetail).toBe(42);
  });

  it('has the exact byte layout we expect (golden bytes, 16 bytes total)', () => {
    // sequenceId = 1     -> 01 00 00 00
    // waitTime = 0.0     -> 00 00 00 00
    // status = 0         -> 00 00 00 00
    // statusDetail = 0   -> 00 00 00 00
    const msg = new CommandQueueRemove(1, 0, 0, 0);
    const s = new ByteStream();
    msg.pack(s);
    const bytes = s.toBytes();
    expect(bytes.length).toBe(16);
    expect(Array.from(bytes)).toEqual([
      0x01, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00,
    ]);
  });

  it('encodes negative status (signed int32)', () => {
    const msg = new CommandQueueRemove(0, 0, -1, -2);
    const bytes = msg.toBytes();
    const decoded = CommandQueueRemove.unpack(new ReadIterator(bytes));
    expect(decoded.status).toBe(-1);
    expect(decoded.statusDetail).toBe(-2);
  });
});
