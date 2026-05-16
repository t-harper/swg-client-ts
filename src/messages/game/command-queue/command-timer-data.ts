/**
 * CommandTimerData (a.k.a. MessageQueueCommandTimer) — server → client.
 *
 * Carries cooldown / warmup / execute / failure timing for an ability that
 * was previously enqueued. Wire form is the `data` trailer of an
 * `ObjControllerMessage` whose `message` field is `CM_commandTimer` (762).
 *
 * The encoding is flag-driven: a byte of flag bits indicates which states
 * have payload data (current + max time floats) and whether either of the
 * two cooldown-group ints are present.
 *
 * Wire layout (pack() order; see SetupSwgSharedNetworkMessages.cpp:490):
 *   [byte]   flags                bitfield over Flag values (see Flag enum)
 *   [u32]    sequenceId           matches the original Enqueue's sequenceId
 *   [u32]    commandNameCrc       same hash as Enqueue.commandHash
 *   [i32]?   cooldownGroup        if (flags & (1 << Cooldown))  -- F_cooldown=2
 *   [i32]?   cooldownGroup2       if (flags & (1 << Cooldown2)) -- F_cooldown2=5
 *   for each flag set, in order Warmup..Cooldown2:
 *     [f32]  currentTime
 *     [f32]  maxTime
 *
 * The "for each" loop iterates ALL F_MAX(=6) flag positions in declaration
 * order. If a position's bit is set, its (current, max) pair appears; if not,
 * nothing is written for that position. This keeps the message compact:
 * idle ticks send just 1 + 4 + 4 = 9 bytes plus optional cooldown ints.
 *
 * Source:
 *   /home/tharper/code/swg-main/src/engine/shared/library/sharedNetworkMessages/src/shared/common/MessageQueueCommandTimer.h
 *   /home/tharper/code/swg-main/src/game/shared/library/swgSharedNetworkMessages/src/shared/core/SetupSwgSharedNetworkMessages.cpp:490 (pack/unpack)
 *   /home/tharper/code/swg-main/src/engine/shared/library/sharedFoundation/src/shared/GameControllerMessage.def:944 (CM_commandTimer = 762)
 */

import { ByteStream } from '../../../archive/byte-stream.js';
import type { IByteStream, IReadIterator } from '../../../archive/interface.js';

export const CM_COMMAND_TIMER = 762;

/** F_cooldown / F_cooldown2 special-case the cooldown-group int prefix. */
export enum CommandTimerFlag {
  Warmup = 0,
  Execute = 1,
  Cooldown = 2,
  Failed = 3,
  FailedRetry = 4,
  Cooldown2 = 5,
}

export const COMMAND_TIMER_FLAG_COUNT = 6;

/** Sentinel meaning "no cooldown group" (NULL_COOLDOWN_GROUP in C++). */
export const NULL_COOLDOWN_GROUP = -1;

/** A (currentTime, maxTime) pair for one of the timer states. */
export interface CommandTimerEntry {
  current: number;
  max: number;
}

export type CommandTimerEntries = Partial<Record<CommandTimerFlag, CommandTimerEntry>>;

export class CommandTimerData {
  static readonly controllerMessage = CM_COMMAND_TIMER;

  constructor(
    public readonly sequenceId: number,
    public readonly commandNameCrc: number,
    /** -1 = NULL_COOLDOWN_GROUP / absent. */
    public readonly cooldownGroup: number = NULL_COOLDOWN_GROUP,
    /** -1 = absent. */
    public readonly cooldownGroup2: number = NULL_COOLDOWN_GROUP,
    /** Map of flag → (current, max). Missing entries = no time data for that state. */
    public readonly times: CommandTimerEntries = {},
  ) {}

  /** Computed bitfield: union of `times` keys + cooldownGroup-present flags. */
  getFlags(): number {
    let flags = 0;
    for (const k of Object.keys(this.times)) {
      const flag = Number(k) as CommandTimerFlag;
      flags |= 1 << flag;
    }
    if (this.cooldownGroup !== NULL_COOLDOWN_GROUP) {
      flags |= 1 << CommandTimerFlag.Cooldown;
    }
    if (this.cooldownGroup2 !== NULL_COOLDOWN_GROUP) {
      flags |= 1 << CommandTimerFlag.Cooldown2;
    }
    return flags & 0xff;
  }

  pack(stream: IByteStream): void {
    const flags = this.getFlags();
    stream.writeU8(flags);
    stream.writeU32(this.sequenceId);
    stream.writeU32(this.commandNameCrc);

    if (flags & (1 << CommandTimerFlag.Cooldown)) {
      stream.writeI32(this.cooldownGroup);
    }
    if (flags & (1 << CommandTimerFlag.Cooldown2)) {
      stream.writeI32(this.cooldownGroup2);
    }

    for (let i = 0; i < COMMAND_TIMER_FLAG_COUNT; i++) {
      if (flags & (1 << i)) {
        const entry = this.times[i as CommandTimerFlag] ?? { current: 0, max: 0 };
        stream.writeF32(entry.current);
        stream.writeF32(entry.max);
      }
    }
  }

  toBytes(): Uint8Array {
    const s = new ByteStream();
    this.pack(s);
    return s.toBytes();
  }

  static unpack(iter: IReadIterator): CommandTimerData {
    const flags = iter.readU8();
    const sequenceId = iter.readU32();
    const commandNameCrc = iter.readU32();

    let cooldownGroup: number = NULL_COOLDOWN_GROUP;
    if (flags & (1 << CommandTimerFlag.Cooldown)) {
      cooldownGroup = iter.readI32();
    }
    let cooldownGroup2: number = NULL_COOLDOWN_GROUP;
    if (flags & (1 << CommandTimerFlag.Cooldown2)) {
      cooldownGroup2 = iter.readI32();
    }

    const times: CommandTimerEntries = {};
    for (let i = 0; i < COMMAND_TIMER_FLAG_COUNT; i++) {
      if (flags & (1 << i)) {
        const current = iter.readF32();
        const max = iter.readF32();
        times[i as CommandTimerFlag] = { current, max };
      }
    }

    return new CommandTimerData(sequenceId, commandNameCrc, cooldownGroup, cooldownGroup2, times);
  }
}
