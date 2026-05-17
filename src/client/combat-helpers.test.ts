/**
 * Unit tests for the `ctx.combat` / `ctx.safety` helpers.
 *
 * Drives the fake-context test harness: simulateRecv'd CREO baselines for
 * targeting, ChatSystemMessage for kill detection, and SceneDestroyObject
 * for the auto-loot scene-destroy path. The health drop / flee watcher is
 * exercised via simulated CREO p6 deltas on the player.
 */
import { describe, expect, it } from 'vitest';

import { BaselinesMessage } from '../messages/game/baselines/baselines-message.js';
import { BaselinePackageIds, ObjectTypeTags } from '../messages/game/baselines/registry.js';
// Side-effect: register all baseline + delta decoders.
import '../messages/game/baselines/index.js';
import { ReadIterator } from '../archive/read-iterator.js';
import { DeltasMessage } from '../messages/game/baselines/deltas-message.js';
import { ChatSystemMessage } from '../messages/game/chat/chat-system-message.js';
import {
  CM_COMMAND_QUEUE_ENQUEUE,
  CommandQueueEnqueue,
  hashCommand,
} from '../messages/game/command-queue/index.js';
import { ObjControllerMessage } from '../messages/game/obj-controller-message.js';
import { SceneCreateObjectByCrc } from '../messages/game/scene-create-object-by-crc.js';
import { SceneDestroyObject } from '../messages/game/scene-destroy-object.js';
import type { GameNetworkMessage } from '../messages/interface.js';
import { createFakeContext } from './script/test-helpers.js';

const IDENTITY = { rotation: { x: 0, y: 0, z: 0, w: 1 }, position: { x: 0, y: 0, z: 0 } };

/**
 * Seed a hostile CREO at `(x,0,z)` with the given SHARED_NP baseline fields.
 * `lookAtTarget`/`intendedTarget` default to 0n; pass `targetingPlayerId`
 * to make the CREO target a specific NetworkId.
 */
function spawnCreo(
  simulateRecv: (msg: GameNetworkMessage) => void,
  id: bigint,
  position: { x: number; z: number },
  np: {
    inCombat?: boolean;
    lookAtTarget?: bigint;
    intendedTarget?: bigint;
    totalAttributes?: number[];
    totalMaxAttributes?: number[];
  } = {},
): void {
  // SceneCreate first so the world has a position cursor.
  simulateRecv(
    new SceneCreateObjectByCrc(
      id,
      { rotation: { x: 0, y: 0, z: 0, w: 1 }, position: { x: position.x, y: 0, z: position.z } },
      0,
      false,
    ),
  );
  // Then a SHARED_NP baseline with the requested fields. The fake context
  // doesn't actually decode the bytes — it uses the provided
  // `decodedBaseline.data` directly.
  simulateRecv(
    new BaselinesMessage(id, ObjectTypeTags.CREO, BaselinePackageIds.SHARED_NP, new Uint8Array(0), {
      kind: 'CreatureObjectSharedNp',
      data: {
        inCombat: np.inCombat ?? false,
        lookAtTarget: np.lookAtTarget ?? 0n,
        intendedTarget: np.intendedTarget ?? 0n,
        totalAttributes: np.totalAttributes ?? [],
        totalMaxAttributes: np.totalMaxAttributes ?? [],
      } as Record<string, unknown>,
    }),
  );
}

describe('ctx.combat.targets()', () => {
  it('returns CREOs whose lookAtTarget equals the player', () => {
    const playerId = 0x1n;
    const { ctx, simulateRecv } = createFakeContext({
      playerNetworkId: playerId,
      startPosition: { x: 0, y: 0, z: 0 },
    });

    // Three CREOs: one targeting us at 5m, one at 10m, one not targeting us at 3m.
    spawnCreo(simulateRecv, 0x10n, { x: 5, z: 0 }, { lookAtTarget: playerId });
    spawnCreo(simulateRecv, 0x20n, { x: 10, z: 0 }, { lookAtTarget: playerId });
    spawnCreo(simulateRecv, 0x30n, { x: 3, z: 0 }, { lookAtTarget: 0xffffn });

    const targets = ctx.combat.targets();
    expect(targets.map((t) => t.id)).toEqual([0x10n, 0x20n]);
    expect(targets[0]?.distance).toBeCloseTo(5, 2);
    expect(targets[1]?.distance).toBeCloseTo(10, 2);
  });

  it('also returns CREOs whose intendedTarget equals the player', () => {
    const playerId = 0xaan;
    const { ctx, simulateRecv } = createFakeContext({
      playerNetworkId: playerId,
      startPosition: { x: 0, y: 0, z: 0 },
    });
    spawnCreo(simulateRecv, 0x42n, { x: 7, z: 0 }, { intendedTarget: playerId });
    const targets = ctx.combat.targets();
    expect(targets.map((t) => t.id)).toEqual([0x42n]);
  });

  it('surfaces health from totalAttributes when available', () => {
    const playerId = 0x1n;
    const { ctx, simulateRecv } = createFakeContext({
      playerNetworkId: playerId,
      startPosition: { x: 0, y: 0, z: 0 },
    });
    spawnCreo(
      simulateRecv,
      0x42n,
      { x: 5, z: 0 },
      {
        lookAtTarget: playerId,
        totalAttributes: [500, 0, 100, 0, 80, 0],
        totalMaxAttributes: [1000, 0, 200, 0, 200, 0],
      },
    );
    const t = ctx.combat.targets()[0];
    expect(t?.ham).toEqual({ health: 500, healthMax: 1000 });
  });

  it('returns [] when no CREO is targeting us', () => {
    const { ctx, simulateRecv } = createFakeContext({});
    spawnCreo(simulateRecv, 0x10n, { x: 5, z: 0 }, { lookAtTarget: 0n });
    expect(ctx.combat.targets()).toEqual([]);
  });

  it('excludes the player from the target list', () => {
    const playerId = 0x99n;
    const { ctx, simulateRecv } = createFakeContext({
      playerNetworkId: playerId,
      startPosition: { x: 0, y: 0, z: 0 },
    });
    spawnCreo(simulateRecv, playerId, { x: 0, z: 0 }, { lookAtTarget: playerId });
    expect(ctx.combat.targets()).toEqual([]);
  });
});

describe('ctx.combat.engaged', () => {
  it('returns true when any CREO is targeting us', () => {
    const playerId = 0x1n;
    const { ctx, simulateRecv } = createFakeContext({ playerNetworkId: playerId });
    spawnCreo(simulateRecv, 0x10n, { x: 5, z: 0 }, { lookAtTarget: playerId });
    expect(ctx.combat.engaged).toBe(true);
  });

  it('returns true within the recent-hit window after a health drop', async () => {
    const playerId = 0x1n;
    const { ctx, simulateRecv } = createFakeContext({ playerNetworkId: playerId });
    // First seed: full health
    simulateRecv(
      new BaselinesMessage(
        playerId,
        ObjectTypeTags.CREO,
        BaselinePackageIds.SHARED_NP,
        new Uint8Array(0),
        {
          kind: 'CreatureObjectSharedNp',
          data: {
            inCombat: false,
            lookAtTarget: 0n,
            intendedTarget: 0n,
            totalAttributes: [1000, 0, 0, 0, 0, 0],
            totalMaxAttributes: [1000, 0, 0, 0, 0, 0],
          } as Record<string, unknown>,
        },
      ),
    );
    // Settle queueMicrotask after baseline so lastHealth is recorded.
    await Promise.resolve();
    expect(ctx.combat.engaged).toBe(false);
    // Then a delta that drops health to 800
    simulateRecv(
      new DeltasMessage(
        playerId,
        ObjectTypeTags.CREO,
        BaselinePackageIds.SHARED_NP,
        new Uint8Array(0),
        {
          kind: 'CreatureObjectSharedNpDelta',
          data: {
            totalAttributes: [800, 0, 0, 0, 0, 0],
          } as Record<string, unknown>,
        },
      ),
    );
    await Promise.resolve();
    expect(ctx.combat.engaged).toBe(true);
    expect(ctx.combat.timeSinceLastHitMs).not.toBeNull();
    expect(ctx.combat.timeSinceLastHitMs ?? 0).toBeLessThan(1000);
  });

  it('returns false when nothing is targeting us and we have not been hit', () => {
    const { ctx } = createFakeContext({});
    expect(ctx.combat.engaged).toBe(false);
    expect(ctx.combat.timeSinceLastHitMs).toBeNull();
  });
});

describe('ctx.combat.autoLoot', () => {
  it('does NOT auto-loot when autoLoot is false', () => {
    const playerId = 0x1n;
    const { ctx, sent, simulateRecv } = createFakeContext({ playerNetworkId: playerId });
    // Damage the creature so the destroy path can match.
    ctx.attackTarget(0x42n);
    sent.length = 0;
    simulateRecv(new SceneDestroyObject(0x42n, false));
    expect(sent.length).toBe(0);
  });

  it('auto-loots on SceneDestroyObject for a creature we damaged', () => {
    const playerId = 0x1n;
    const { ctx, sent, simulateRecv } = createFakeContext({ playerNetworkId: playerId });
    ctx.combat.autoLoot = true;
    // Seed the creature so the destroy event has a lastKnown with the right typeId.
    spawnCreo(simulateRecv, 0x42n, { x: 5, z: 0 }, {});
    // Tag it as damaged via attackTarget.
    ctx.attackTarget(0x42n);
    sent.length = 0;
    // Now the destroy event fires.
    simulateRecv(new SceneDestroyObject(0x42n, false));
    const lootCommands = sent.filter((m) => {
      if (!(m instanceof ObjControllerMessage)) return false;
      if (m.message !== CM_COMMAND_QUEUE_ENQUEUE) return false;
      const inner = CommandQueueEnqueue.unpack(new ReadIterator(m.data));
      return inner.commandHash === hashCommand('loot') && inner.targetId === 0x42n;
    });
    expect(lootCommands.length).toBe(1);
  });

  it('auto-loots on a kill chat message for a creature we damaged', () => {
    const playerId = 0x1n;
    const { ctx, sent, simulateRecv } = createFakeContext({ playerNetworkId: playerId });
    ctx.combat.autoLoot = true;
    spawnCreo(simulateRecv, 0x77n, { x: 5, z: 0 }, {});
    ctx.attackTarget(0x77n);
    sent.length = 0;
    // The wire encodes ASCII into the low byte of each UTF-16 codeunit.
    const oob = stringToUnicodeOob('prose_target_dead some_killer');
    simulateRecv(new ChatSystemMessage(0, '', oob));
    const lootCount = sent.filter((m) => {
      if (!(m instanceof ObjControllerMessage)) return false;
      if (m.message !== CM_COMMAND_QUEUE_ENQUEUE) return false;
      const inner = CommandQueueEnqueue.unpack(new ReadIterator(m.data));
      return inner.commandHash === hashCommand('loot');
    }).length;
    expect(lootCount).toBe(1);
  });

  it('does not auto-loot the SAME corpse twice', () => {
    const playerId = 0x1n;
    const { ctx, sent, simulateRecv } = createFakeContext({ playerNetworkId: playerId });
    ctx.combat.autoLoot = true;
    spawnCreo(simulateRecv, 0xden, { x: 5, z: 0 }, {});
    ctx.attackTarget(0xden);
    sent.length = 0;
    // Destroy first
    simulateRecv(new SceneDestroyObject(0xden, false));
    // Chat next
    simulateRecv(new ChatSystemMessage(0, '', stringToUnicodeOob('prose_target_dead')));
    const lootCount = sent.filter((m) => {
      if (!(m instanceof ObjControllerMessage)) return false;
      if (m.message !== CM_COMMAND_QUEUE_ENQUEUE) return false;
      const inner = CommandQueueEnqueue.unpack(new ReadIterator(m.data));
      return inner.commandHash === hashCommand('loot');
    }).length;
    expect(lootCount).toBe(1);
  });

  it('ignores hyperspace destroys (those are not deaths)', () => {
    const playerId = 0x1n;
    const { ctx, sent, simulateRecv } = createFakeContext({ playerNetworkId: playerId });
    ctx.combat.autoLoot = true;
    spawnCreo(simulateRecv, 0x88n, { x: 5, z: 0 }, {});
    ctx.attackTarget(0x88n);
    sent.length = 0;
    simulateRecv(new SceneDestroyObject(0x88n, true)); // hyperspace=true
    expect(
      sent.filter(
        (m) => m instanceof ObjControllerMessage && m.message === CM_COMMAND_QUEUE_ENQUEUE,
      ).length,
    ).toBe(0);
  });
});

describe('ctx.combat.attackingNearest()', () => {
  it('soft-fails when no hostile is in range', async () => {
    const { ctx } = createFakeContext({});
    await ctx.combat.attackingNearest({ timeoutMs: 50, tickMs: 25 });
    expect(ctx.assertionFailures()).toContain('attackingNearest: no hostile in range');
  });

  it('returns when the target leaves the world', async () => {
    const playerId = 0x1n;
    const { ctx, sent, simulateRecv } = createFakeContext({
      playerNetworkId: playerId,
      startPosition: { x: 0, y: 0, z: 0 },
    });
    spawnCreo(simulateRecv, 0x10n, { x: 5, z: 0 }, { inCombat: true });
    // Kick off the attack loop with a fast tick; remove the creature soon
    // after to trigger an early return.
    const p = ctx.combat.attackingNearest({ timeoutMs: 2_000, tickMs: 50 });
    setTimeout(() => simulateRecv(new SceneDestroyObject(0x10n, false)), 75);
    await p;
    // We should have queued AT LEAST one attack via the command-queue path.
    const attacks = sent.filter((m) => {
      if (!(m instanceof ObjControllerMessage)) return false;
      if (m.message !== CM_COMMAND_QUEUE_ENQUEUE) return false;
      const inner = CommandQueueEnqueue.unpack(new ReadIterator(m.data));
      return inner.commandHash === hashCommand('attack') && inner.targetId === 0x10n;
    });
    expect(attacks.length).toBeGreaterThanOrEqual(1);
  });
});

describe('ctx.safety.fleeWhenHealthBelow()', () => {
  it('fires the trigger callback when health drops below the ratio (async/microtask)', async () => {
    const playerId = 0x1n;
    const { ctx, simulateRecv } = createFakeContext({ playerNetworkId: playerId });
    // Seed baseline: full health
    simulateRecv(
      new BaselinesMessage(
        playerId,
        ObjectTypeTags.CREO,
        BaselinePackageIds.SHARED_NP,
        new Uint8Array(0),
        {
          kind: 'CreatureObjectSharedNp',
          data: {
            inCombat: false,
            lookAtTarget: 0n,
            intendedTarget: 0n,
            totalAttributes: [1000, 0, 0, 0, 0, 0],
            totalMaxAttributes: [1000, 0, 0, 0, 0, 0],
          } as Record<string, unknown>,
        },
      ),
    );
    let triggered = false;
    let triggerInfo: { healthRatio: number } | null = null;
    ctx.safety.fleeWhenHealthBelow(0.5, {
      goTo: { x: 100, z: 200 },
      usePeace: false,
      useVehicle: false,
      onTrigger: (info) => {
        triggered = true;
        triggerInfo = info as { healthRatio: number };
      },
    });
    // Drop health to 40% — below the 50% ratio
    simulateRecv(
      new DeltasMessage(
        playerId,
        ObjectTypeTags.CREO,
        BaselinePackageIds.SHARED_NP,
        new Uint8Array(0),
        {
          kind: 'CreatureObjectSharedNpDelta',
          data: { totalAttributes: [400, 0, 0, 0, 0, 0] } as Record<string, unknown>,
        },
      ),
    );
    await Promise.resolve();
    expect(triggered).toBe(true);
    expect(triggerInfo).not.toBeNull();
    expect((triggerInfo as unknown as { healthRatio: number }).healthRatio).toBeCloseTo(0.4, 2);
  });

  it('does NOT fire when health stays above the ratio', async () => {
    const playerId = 0x1n;
    const { ctx, simulateRecv } = createFakeContext({ playerNetworkId: playerId });
    simulateRecv(
      new BaselinesMessage(
        playerId,
        ObjectTypeTags.CREO,
        BaselinePackageIds.SHARED_NP,
        new Uint8Array(0),
        {
          kind: 'CreatureObjectSharedNp',
          data: {
            inCombat: false,
            lookAtTarget: 0n,
            intendedTarget: 0n,
            totalAttributes: [1000, 0, 0, 0, 0, 0],
            totalMaxAttributes: [1000, 0, 0, 0, 0, 0],
          } as Record<string, unknown>,
        },
      ),
    );
    let triggered = false;
    ctx.safety.fleeWhenHealthBelow(0.3, {
      usePeace: false,
      useVehicle: false,
      onTrigger: () => {
        triggered = true;
      },
    });
    simulateRecv(
      new DeltasMessage(
        playerId,
        ObjectTypeTags.CREO,
        BaselinePackageIds.SHARED_NP,
        new Uint8Array(0),
        {
          kind: 'CreatureObjectSharedNpDelta',
          data: { totalAttributes: [500, 0, 0, 0, 0, 0] } as Record<string, unknown>,
        },
      ),
    );
    await Promise.resolve();
    expect(triggered).toBe(false);
  });

  it('returns an unsubscribe function that disables the watcher', async () => {
    const playerId = 0x1n;
    const { ctx, simulateRecv } = createFakeContext({ playerNetworkId: playerId });
    simulateRecv(
      new BaselinesMessage(
        playerId,
        ObjectTypeTags.CREO,
        BaselinePackageIds.SHARED_NP,
        new Uint8Array(0),
        {
          kind: 'CreatureObjectSharedNp',
          data: {
            totalAttributes: [1000, 0, 0, 0, 0, 0],
            totalMaxAttributes: [1000, 0, 0, 0, 0, 0],
          } as Record<string, unknown>,
        },
      ),
    );
    let triggered = false;
    const unsub = ctx.safety.fleeWhenHealthBelow(0.5, {
      usePeace: false,
      useVehicle: false,
      onTrigger: () => {
        triggered = true;
      },
    });
    unsub();
    simulateRecv(
      new DeltasMessage(
        playerId,
        ObjectTypeTags.CREO,
        BaselinePackageIds.SHARED_NP,
        new Uint8Array(0),
        {
          kind: 'CreatureObjectSharedNpDelta',
          data: { totalAttributes: [100, 0, 0, 0, 0, 0] } as Record<string, unknown>,
        },
      ),
    );
    await Promise.resolve();
    expect(triggered).toBe(false);
  });

  it('issues the peace command when usePeace is true', async () => {
    const playerId = 0x1n;
    const { ctx, sent, simulateRecv } = createFakeContext({ playerNetworkId: playerId });
    simulateRecv(
      new BaselinesMessage(
        playerId,
        ObjectTypeTags.CREO,
        BaselinePackageIds.SHARED_NP,
        new Uint8Array(0),
        {
          kind: 'CreatureObjectSharedNp',
          data: {
            totalAttributes: [1000, 0, 0, 0, 0, 0],
            totalMaxAttributes: [1000, 0, 0, 0, 0, 0],
          } as Record<string, unknown>,
        },
      ),
    );
    ctx.safety.fleeWhenHealthBelow(0.5, { usePeace: true, useVehicle: false });
    sent.length = 0;
    simulateRecv(
      new DeltasMessage(
        playerId,
        ObjectTypeTags.CREO,
        BaselinePackageIds.SHARED_NP,
        new Uint8Array(0),
        {
          kind: 'CreatureObjectSharedNpDelta',
          data: { totalAttributes: [200, 0, 0, 0, 0, 0] } as Record<string, unknown>,
        },
      ),
    );
    await Promise.resolve();
    const hasPeace = sent.some((m) => {
      if (!(m instanceof ObjControllerMessage)) return false;
      if (m.message !== CM_COMMAND_QUEUE_ENQUEUE) return false;
      const inner = CommandQueueEnqueue.unpack(new ReadIterator(m.data));
      return inner.commandHash === hashCommand('peace');
    });
    expect(hasPeace).toBe(true);
  });
});

describe('combat helpers exist on the script context', () => {
  it('exposes ctx.combat and ctx.safety as defined objects', () => {
    const { ctx } = createFakeContext({});
    expect(ctx.combat).toBeDefined();
    expect(typeof ctx.combat.targets).toBe('function');
    expect(typeof ctx.combat.attackingNearest).toBe('function');
    expect(ctx.combat.autoLoot).toBe(false);
    expect(ctx.combat.engaged).toBe(false);
    expect(ctx.combat.timeSinceLastHitMs).toBeNull();
    expect(ctx.safety).toBeDefined();
    expect(typeof ctx.safety.fleeWhenHealthBelow).toBe('function');
  });
});

/**
 * Pack ASCII into the low byte of each UTF-16 codeunit, the same way
 * `writeUnicodeString` produces. Mirrors the inverse of `decodeSampleOob`
 * in `src/client/script/context.ts`.
 */
function stringToUnicodeOob(s: string): string {
  // Each character in the JS string is one UTF-16 codeunit. The wire
  // encoding writes each char as one UTF-16 LE codeunit, where the ASCII
  // value sits in the low byte. So just returning the string as-is is
  // sufficient — the helpers' decode loop unpacks both halves of each
  // codeunit, and the high byte will be 0 (not printable), so only the
  // low byte (the ASCII char) gets matched.
  return s;
}

// Avoid 'used before assignment' on TS in `triggerInfo` checks — wrap a
// minimal no-op import marker.
void IDENTITY;
