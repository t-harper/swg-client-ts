/**
 * Unit tests for `src/client/timing.ts` — cooldowns, server-time, combat.
 *
 * Drives the trackers against `createFakeContext()` so the SoeConnection
 * stub is in play (provides `addClockReflectListener` + the fake dispatcher
 * provides `onMessage` / `onAny` plumbing). For wire-byte synthesis, we use
 * the project's actual codecs (CommandTimerData.pack, CombatActionDecoder.encode)
 * so the round-trip is exercised end-to-end.
 */

import { describe, expect, it } from 'vitest';

import { ByteStream } from '../archive/byte-stream.js';
import {
  CM_COMMAND_TIMER,
  CommandTimerData,
  CommandTimerFlag,
  hashCommand,
} from '../messages/game/command-queue/index.js';
import { ObjControllerMessage } from '../messages/game/obj-controller-message.js';
import {
  CombatActionDecoder,
  type CombatActionData,
  ObjControllerSubtypeIds,
} from '../messages/game/obj-controller/index.js';
import type { NetworkId } from '../types.js';
import { createFakeContext } from './script/test-helpers.js';
import { createCombatTimer, createServerTimeTracker } from './timing.js';

const PLAYER_ID = 0x1234n as NetworkId;
const ATTACKER_ID = 0xa11cen as NetworkId;

// ──────────────────────────────────────────────────────────────────────────
// Cooldown tracker
// ──────────────────────────────────────────────────────────────────────────

function buildCommandTimer(commandHash: number, cooldownSeconds: number): ObjControllerMessage {
  const data = new CommandTimerData(1, commandHash, -1, -1, {
    [CommandTimerFlag.Cooldown]: { current: cooldownSeconds, max: cooldownSeconds },
  });
  const stream = new ByteStream();
  data.pack(stream);
  return new ObjControllerMessage(0x00, CM_COMMAND_TIMER, PLAYER_ID, 0, stream.toBytes());
}

function buildCombatAction(damageAmount: number, defense = 0): ObjControllerMessage {
  const data: CombatActionData = {
    actionId: 0,
    attacker: {
      id: ATTACKER_ID,
      weapon: 0n,
      endPosture: 0,
      trailBits: 0,
      clientEffectId: 0,
      actionNameCrc: 0,
      useLocation: false,
      targetLocation: { x: 0, y: 0, z: 0 },
      targetCell: 0n,
    },
    defenders: [
      {
        id: PLAYER_ID,
        endPosture: 0,
        defense,
        clientEffectId: 0,
        hitLocation: 0,
        damageAmount,
      },
    ],
  };
  const stream = new ByteStream();
  CombatActionDecoder.encode(stream, data);
  return new ObjControllerMessage(
    0x00,
    ObjControllerSubtypeIds.CM_combatAction,
    ATTACKER_ID,
    0,
    stream.toBytes(),
    { kind: CombatActionDecoder.kind, data },
  );
}

describe('CooldownTracker (createScriptContext-wired)', () => {
  it('starts with every command ready (no expirations recorded)', () => {
    const { ctx } = createFakeContext({ playerNetworkId: PLAYER_ID });
    expect(ctx.cooldowns.msUntil('mount')).toBe(0);
    expect(ctx.cooldowns.isReady('mount')).toBe(true);
    expect(ctx.cooldowns.all().size).toBe(0);
  });

  it('reflects a CommandTimer cooldown for a registered command name', () => {
    const { ctx, simulateRecv } = createFakeContext({ playerNetworkId: PLAYER_ID });
    // Issue useAbility so the friendly name is registered for hash → name lookup
    ctx.useAbility('mount', 0n);
    // Server pushes a CommandTimer for that command with 5s cooldown
    const hash = hashCommand('mount');
    simulateRecv(buildCommandTimer(hash, 5));
    const remaining = ctx.cooldowns.msUntil('mount');
    expect(remaining).toBeGreaterThan(4_000);
    expect(remaining).toBeLessThanOrEqual(5_000);
    expect(ctx.cooldowns.isReady('mount')).toBe(false);
    const snapshot = ctx.cooldowns.all();
    expect(snapshot.size).toBe(1);
    expect(snapshot.get('mount')?.msUntilReady).toBeGreaterThan(4_000);
  });

  it('decays automatically over wall-clock time without further wire input', async () => {
    const { ctx, simulateRecv } = createFakeContext({ playerNetworkId: PLAYER_ID });
    ctx.useAbility('mount', 0n);
    const hash = hashCommand('mount');
    simulateRecv(buildCommandTimer(hash, 0.05)); // 50ms cooldown
    expect(ctx.cooldowns.isReady('mount')).toBe(false);
    await new Promise((r) => setTimeout(r, 75));
    expect(ctx.cooldowns.msUntil('mount')).toBe(0);
    expect(ctx.cooldowns.isReady('mount')).toBe(true);
  });

  it('keeps the LATER of overlapping cooldown windows for the same command', () => {
    const { ctx, simulateRecv } = createFakeContext({ playerNetworkId: PLAYER_ID });
    ctx.useAbility('mount', 0n);
    const hash = hashCommand('mount');
    simulateRecv(buildCommandTimer(hash, 2.0));
    const first = ctx.cooldowns.msUntil('mount');
    // Push a SHORTER cooldown — the tracker should keep the longer first one.
    simulateRecv(buildCommandTimer(hash, 0.5));
    const second = ctx.cooldowns.msUntil('mount');
    // Allow a few ms of jitter for Date.now() drift between calls.
    expect(second).toBeGreaterThanOrEqual(first - 50);
  });

  it('rawExpiries() is keyed by command hash (testable without name lookup)', () => {
    const { ctx, simulateRecv } = createFakeContext({ playerNetworkId: PLAYER_ID });
    const hash = hashCommand('berserk1');
    simulateRecv(buildCommandTimer(hash, 30));
    const raw = ctx.cooldowns.rawExpiries();
    expect(raw.has(hash)).toBe(true);
    const expiresAt = raw.get(hash);
    if (expiresAt === undefined) throw new Error('expected expiry');
    expect(expiresAt).toBeGreaterThan(Date.now() + 20_000);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Combat timer
// ──────────────────────────────────────────────────────────────────────────

describe('CombatTimer', () => {
  it('reports POSITIVE_INFINITY and engaged=false when never hit', () => {
    const { ctx } = createFakeContext({ playerNetworkId: PLAYER_ID });
    expect(ctx.hitTimer.timeSinceLastHitMs).toBe(Number.POSITIVE_INFINITY);
    expect(ctx.hitTimer.engaged).toBe(false);
    expect(ctx.hitTimer.lastHit()).toBeNull();
  });

  it('updates timeSinceLastHitMs after a CombatAction targeting us', async () => {
    const { ctx, simulateRecv } = createFakeContext({ playerNetworkId: PLAYER_ID });
    simulateRecv(buildCombatAction(42));
    expect(ctx.hitTimer.timeSinceLastHitMs).toBeLessThan(50);
    expect(ctx.hitTimer.engaged).toBe(true);
    const hit = ctx.hitTimer.lastHit();
    expect(hit).not.toBeNull();
    expect(hit?.attackerId).toBe(ATTACKER_ID);
    expect(hit?.damageAmount).toBe(42);
    // Wait a beat, then re-read — the elapsed time should grow.
    await new Promise((r) => setTimeout(r, 30));
    expect(ctx.hitTimer.timeSinceLastHitMs).toBeGreaterThanOrEqual(30);
  });

  it('ignores CombatActions where we are not in the defender list', () => {
    const otherId = 0xbaben as NetworkId;
    const { ctx, simulateRecv } = createFakeContext({ playerNetworkId: PLAYER_ID });
    // Build a CombatAction where someone else is the defender.
    const data: CombatActionData = {
      actionId: 0,
      attacker: {
        id: ATTACKER_ID,
        weapon: 0n,
        endPosture: 0,
        trailBits: 0,
        clientEffectId: 0,
        actionNameCrc: 0,
        useLocation: false,
        targetLocation: { x: 0, y: 0, z: 0 },
        targetCell: 0n,
      },
      defenders: [
        {
          id: otherId,
          endPosture: 0,
          defense: 0,
          clientEffectId: 0,
          hitLocation: 0,
          damageAmount: 100,
        },
      ],
    };
    const stream = new ByteStream();
    CombatActionDecoder.encode(stream, data);
    simulateRecv(
      new ObjControllerMessage(
        0x00,
        ObjControllerSubtypeIds.CM_combatAction,
        ATTACKER_ID,
        0,
        stream.toBytes(),
        { kind: CombatActionDecoder.kind, data },
      ),
    );
    expect(ctx.hitTimer.timeSinceLastHitMs).toBe(Number.POSITIVE_INFINITY);
    expect(ctx.hitTimer.engaged).toBe(false);
  });

  it('engaged flips to false after the engagement window elapses', () => {
    const { ctx } = createFakeContext({ playerNetworkId: PLAYER_ID });
    // Construct a custom combat timer with a tight 30ms window so the test
    // doesn't pause for 10s.
    // Reach into the internal handle to set lastHit; this is the test path
    // the tracker exposes via `testSetLastHit`.
    const internal = ctx as unknown as {
      _combatTimerHandle: { testSetLastHit(info: import('./timing.js').CombatHitInfo): void };
    };
    internal._combatTimerHandle.testSetLastHit({
      receivedAtMs: Date.now(),
      attackerId: ATTACKER_ID,
      damageAmount: 1,
      defense: 0,
    });
    expect(ctx.hitTimer.engaged).toBe(true);
    // Default window is 10s; we want to assert the WINDOW logic, not wait
    // 10 seconds. Force an old timestamp instead.
    internal._combatTimerHandle.testSetLastHit({
      receivedAtMs: Date.now() - 15_000,
      attackerId: ATTACKER_ID,
      damageAmount: 1,
      defense: 0,
    });
    expect(ctx.hitTimer.engaged).toBe(false);
  });

  it('honors a custom engagementWindowMs', async () => {
    // Construct a fresh tracker bound to a fake dispatcher with a 50ms window.
    const { ctx } = createFakeContext({ playerNetworkId: PLAYER_ID });
    const tracker = createCombatTimer({
      dispatcher: ctx.dispatcher,
      playerNetworkId: PLAYER_ID,
      engagementWindowMs: 50,
    });
    tracker.testSetLastHit({
      receivedAtMs: Date.now(),
      attackerId: ATTACKER_ID,
      damageAmount: 1,
      defense: 0,
    });
    expect(tracker.view.engaged).toBe(true);
    await new Promise((r) => setTimeout(r, 80));
    expect(tracker.view.engaged).toBe(false);
    tracker.detach();
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Server-time tracker
// ──────────────────────────────────────────────────────────────────────────

describe('ServerTimeTracker', () => {
  it('returns 0 when no seed and no samples', () => {
    const { ctx } = createFakeContext({ playerNetworkId: PLAYER_ID });
    expect(ctx.serverTime.hasSeed).toBe(false);
    expect(ctx.serverTime.ms()).toBe(0);
    expect(ctx.serverTime.seconds()).toBe(0n);
    expect(ctx.serverTime.samples).toBe(0);
  });

  it('uses the SceneStart seed when provided (via serverEpoch)', () => {
    const seedSec = Math.floor(Date.now() / 1000);
    const { ctx } = createFakeContext({
      playerNetworkId: PLAYER_ID,
      serverEpoch: seedSec,
    });
    expect(ctx.serverTime.hasSeed).toBe(true);
    // Within a few ms of Date.now() — the seed is "right now" projected.
    expect(Math.abs(ctx.serverTime.ms() - Date.now())).toBeLessThan(5_000);
  });

  it('refines the offset from a ClockReflect sample', () => {
    const seedSec = Math.floor(Date.now() / 1000);
    const { ctx, simulateClockReflect } = createFakeContext({
      playerNetworkId: PLAYER_ID,
      serverEpoch: seedSec,
    });
    expect(ctx.serverTime.samples).toBe(0);
    simulateClockReflect({
      rttMs: 30,
      serverSyncStampLong: 0x12345678,
      clientRecvWallMs: Date.now(),
    });
    expect(ctx.serverTime.samples).toBe(1);
    // After a sample, ms() is still close to Date.now() (within a few ms of
    // the seed projection — the offset is small for "right now" seeds).
    expect(Math.abs(ctx.serverTime.ms() - Date.now())).toBeLessThan(5_000);
  });

  it('seconds() projects whole seconds from ms()', () => {
    const seedSec = 1_700_000_000;
    const { ctx } = createFakeContext({
      playerNetworkId: PLAYER_ID,
      serverEpoch: seedSec,
    });
    // We can't pin Date.now() but ms() should be ~ seed plus a few ms of
    // elapsed wall-clock between createFakeContext and the call below.
    const ms = ctx.serverTime.ms();
    const sec = ctx.serverTime.seconds();
    expect(BigInt(Math.floor(ms / 1000))).toBe(sec);
  });

  it('survives bogus seed values (negative / zero) without going to NaN', () => {
    const { ctx } = createFakeContext({
      playerNetworkId: PLAYER_ID,
      serverEpoch: 0,
    });
    // 0 seed → not "set" — surface 0 from ms().
    expect(ctx.serverTime.hasSeed).toBe(false);
    expect(ctx.serverTime.ms()).toBe(0);
  });

  it('detach() unsubscribes from the clock-reflect stream', () => {
    const { ctx, simulateClockReflect } = createFakeContext({
      playerNetworkId: PLAYER_ID,
      serverEpoch: Math.floor(Date.now() / 1000),
    });
    // Now construct a SECOND tracker on the same dispatcher and detach it.
    const handle = createServerTimeTracker({ dispatcher: ctx.dispatcher });
    expect(handle.view.samples).toBe(0);
    handle.detach();
    simulateClockReflect({
      rttMs: 10,
      serverSyncStampLong: 0,
      clientRecvWallMs: Date.now(),
    });
    // The detached tracker should NOT have received the sample.
    expect(handle.view.samples).toBe(0);
    // But the script context's tracker should still see it.
    expect(ctx.serverTime.samples).toBe(1);
  });
});
