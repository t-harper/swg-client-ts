/**
 * Tick loop — the central decision engine. Runs at `tickMs` (default 100ms)
 * while engaged. Each pass:
 *
 *   1. Build a `TickSample` from current views (combat/hitTimer/character/world).
 *   2. Sweep any new damage into the heal evaluator's rolling DPS window.
 *   3. Evaluate heal — if triggered, `useAbility(healSlot.ability)` and skip rotation.
 *   4. Evaluate kite — if reposition needed, emit a single transform (does NOT block rotation).
 *   5. Pick target — sticky closest with finisher override.
 *   6. Pick rotation slot — opener → combo → filler; if ready, `useAbility(slot.ability, target.id)`.
 *
 * Invariants:
 *   - At most ONE useAbility() call per tick (heal OR rotation, never both).
 *   - Movement and ability share the tick (we can strafe-back while shooting).
 *   - The loop never throws; aborts via `signal.aborted` and exits cleanly.
 *
 * The host injection is everything the loop needs that's not in the
 * static options — live views, action methods, and the weapon classifier.
 * Defined locally so tests can use a fake.
 */

import { ByteStream } from '../../../archive/byte-stream.js';
import { yawToQuat } from '../../../archive/transform.js';
import type { CreatureObjectSharedNpBaseline } from '../../../messages/game/baselines/creature-object-baseline-6.js';
import { BaselinePackageIds } from '../../../messages/game/baselines/registry.js';
import { CLIENT_TO_AUTH_SERVER_FLAGS } from '../../../messages/game/command-queue/index.js';
import { ObjControllerMessage } from '../../../messages/game/obj-controller-message.js';
import {
  type NetUpdateTransformData,
  NetUpdateTransformDecoder,
  ObjControllerSubtypeIds,
} from '../../../messages/game/obj-controller/index.js';
import type { GameNetworkMessage } from '../../../messages/interface.js';
import type { NetworkId, Vector3 } from '../../../types.js';
import type { CharacterSheet } from '../../character-sheet.js';
import type { CombatView } from '../../combat-helpers.js';
import type { CombatHitInfo, CombatTimerView, CooldownView } from '../../timing.js';
import type { WorldModel } from '../../world-model.js';
import {
  type HealEvaluatorState,
  computeDpsIn,
  createHealEvaluatorState,
  evaluateHeal,
  pushDamageSample,
} from './heal-policy.js';
import {
  type AttackerClass,
  type KiteContext,
  classifyAttacker as defaultClassifyAttacker,
  evaluateKite,
} from './kite-policy.js';
import {
  type RotationPickResult,
  createRotationState,
  markSlotFired,
  pickRotationAction,
  resetRotationState,
} from './rotation-picker.js';
import { createTargetingState, selectTarget } from './targeting.js';
import type {
  HealPolicy,
  KiteProfile,
  Rotation,
  RotationEngagementState,
  TargetingPolicy,
  TickSample,
  WeaponKind,
} from './types.js';

/** Minimal host surface the tick loop needs. */
export interface TickLoopHost {
  readonly combat: CombatView;
  readonly hitTimer: CombatTimerView;
  readonly cooldowns: CooldownView;
  readonly character: CharacterSheet;
  readonly world: WorldModel;
  readonly sceneStart: { playerNetworkId: NetworkId };
  position(): Readonly<Vector3>;
  yaw(): number;
  useAbility(commandName: string, targetId?: NetworkId, params?: string): number;
  send(msg: GameNetworkMessage): void;
  nextSyncStamp(): number;
  nextSequenceNumber(): number;
  setPose(position: Vector3, yaw: number): void;
}

export interface TickLoopOptions {
  rotation: Rotation;
  heal: HealPolicy;
  kite: KiteProfile;
  targeting: TargetingPolicy;
  tickMs: number;
  /** Signal that ends the loop. */
  signal: AbortSignal;
  /** Optional weapon classifier override. */
  classifyWeapon?: (host: TickLoopHost) => WeaponKind;
  /** Optional attacker classifier override. */
  classifyAttacker?: (templateName: string | undefined) => AttackerClass;
  /** Optional now() override for testing. */
  now?: () => number;
  /** Optional logger override. */
  logFn?: (tag: string, payload: unknown) => void;
}

/** Per-engagement state. Exposed so install.ts can reset between engagements. */
export interface TickLoopState {
  heal: HealEvaluatorState;
  rotation: RotationEngagementState;
  targeting: ReturnType<typeof createTargetingState>;
  /** Receive timestamp of the last hit we folded into the DPS window. */
  lastFoldedHitAtMs: number;
  /**
   * Optional target id forced by `cb.engage({ targetId })`. When set AND the
   * target is still in the world AND `combat.targets()` doesn't already
   * include it, the tick loop synthesizes a target entry for it. This
   * covers the "we initiate" case: docile NPCs don't set their
   * `lookAtTarget` to us until they counter-attack, so `combat.targets()`
   * stays empty and the rotation picker has nothing to fire at. Cleared
   * on engagement reset.
   */
  forcedTargetId: NetworkId | null;
}

export function createTickLoopState(): TickLoopState {
  return {
    heal: createHealEvaluatorState(),
    rotation: createRotationState(),
    targeting: createTargetingState(),
    lastFoldedHitAtMs: 0,
    forcedTargetId: null,
  };
}

/** Reset all engagement-scoped state. Call when transitioning out of combat. */
export function resetTickLoopState(state: TickLoopState): void {
  state.heal.dpsWindow.length = 0;
  state.heal.lastHealAtMs = Number.NEGATIVE_INFINITY;
  resetRotationState(state.rotation);
  state.targeting.currentId = null;
  state.targeting.lastSwitchAtMs = 0;
  state.lastFoldedHitAtMs = 0;
  state.forcedTargetId = null;
}

/**
 * Run the tick loop until `opts.signal` aborts. Returns the total number of
 * ticks executed (useful for tests).
 */
export async function runTickLoop(
  host: TickLoopHost,
  state: TickLoopState,
  opts: TickLoopOptions,
): Promise<number> {
  const tickMs = opts.tickMs;
  const now = opts.now ?? ((): number => Date.now());
  const classifyWeapon = opts.classifyWeapon ?? defaultClassifyWeapon;
  const classifyAttacker = opts.classifyAttacker ?? defaultClassifyAttacker;
  const logFn = opts.logFn ?? ((_tag, _payload): void => {});
  let ticks = 0;

  while (!opts.signal.aborted) {
    const tickStart = now();
    try {
      runSingleTick(host, state, opts, tickStart, classifyWeapon, classifyAttacker, logFn);
    } catch (err) {
      // Never let a tick throw kill the loop. Log and continue.
      logFn('combat:tick:error', { err: (err as Error).message });
    }
    ticks++;
    const elapsed = now() - tickStart;
    const delay = Math.max(0, tickMs - elapsed);
    await sleepUntilAborted(delay, opts.signal);
  }
  return ticks;
}

/** Exposed for tests — runs exactly one tick with the supplied clock. */
export function runSingleTick(
  host: TickLoopHost,
  state: TickLoopState,
  opts: Pick<TickLoopOptions, 'rotation' | 'heal' | 'kite' | 'targeting'>,
  nowMs: number,
  classifyWeapon: (h: TickLoopHost) => WeaponKind,
  classifyAttacker: (t: string | undefined) => AttackerClass,
  logFn: (tag: string, payload: unknown) => void,
): void {
  // 1) Fold any new damage into the DPS window.
  foldHitDamage(host, state, nowMs);

  // 2) Build sample.
  const sample = buildTickSample(host, state, opts, nowMs, classifyWeapon);

  // 3) Heal check — if fires, take this tick.
  const healSlot = opts.rotation.panic.heal;
  const healDecision = evaluateHeal(sample, state.heal, opts.heal, healSlot, (a) =>
    host.cooldowns.msUntil(a),
  );
  if (healDecision !== null) {
    fireAbility(host, healDecision, healDecision.target ?? 'self', null);
    state.heal.lastHealAtMs = nowMs;
    logFn('combat:heal', { ability: healDecision.ability, hpFrac: sample.hpFrac });
    return;
  }

  // 4) Kite check — non-blocking; emits at most one transform.
  const kiteCtx = buildKiteContext(host, sample);
  const kiteDecision = evaluateKite(sample, kiteCtx, opts.kite, classifyAttacker);
  if (kiteDecision.kind === 'kite' || kiteDecision.kind === 'close') {
    emitMovementTick(host, kiteDecision.dest);
    logFn('combat:kite', { kind: kiteDecision.kind, dest: kiteDecision.dest });
  }

  // 5) Target selection.
  const target = selectTarget(sample, state.targeting, opts.targeting);
  if (target === null) {
    // No target — nothing to fire (filler-no-target is fine; we'll fall through).
    return;
  }

  // 6) Rotation pick.
  const pick = pickRotationAction(opts.rotation, sample, state.rotation, (a) =>
    host.cooldowns.msUntil(a),
  );
  if (pick === null) return;

  const targetMode = pick.slot.target ?? 'current';
  fireAbility(host, pick.slot, targetMode, target.id);
  markSlotFired(state.rotation, pick.slot, pick.source, nowMs);
  logFn('combat:fire', {
    ability: pick.slot.ability,
    source: pick.source,
    target: targetMode === 'current' ? target.id.toString() : targetMode,
  });
}

function fireAbility(
  host: TickLoopHost,
  slot: { ability: string; params?: string },
  mode: 'current' | 'self' | 'none',
  currentTargetId: NetworkId | null,
): void {
  const params = slot.params ?? '';
  if (mode === 'self' || mode === 'none') {
    host.useAbility(slot.ability, 0n, params);
    return;
  }
  if (currentTargetId === null) {
    host.useAbility(slot.ability, 0n, params);
    return;
  }
  host.useAbility(slot.ability, currentTargetId, params);
}

function buildTickSample(
  host: TickLoopHost,
  state: TickLoopState,
  opts: Pick<TickLoopOptions, 'heal'>,
  nowMs: number,
  classifyWeapon: (h: TickLoopHost) => WeaponKind,
): TickSample {
  const liveTargets = host.combat.targets();
  let targets = liveTargets;
  // If we have a forced target (from cb.engage({targetId})) and combat.targets()
  // doesn't include it, synthesize a target entry. Covers the case where the
  // server-side enemy hasn't set its lookAtTarget back to us yet — common for
  // low-level passive NPCs.
  const position = host.position();
  if (state.forcedTargetId !== null) {
    const forcedIdInLive = liveTargets.some((t) => t.id === state.forcedTargetId);
    if (!forcedIdInLive) {
      const forced = host.world.get(state.forcedTargetId);
      if (forced !== undefined) {
        const dx = forced.position.x - position.x;
        const dz = forced.position.z - position.z;
        targets = [
          { id: state.forcedTargetId, distance: Math.hypot(dx, dz), ham: null },
          ...liveTargets,
        ];
      } else {
        // Forced target gone from world → clear it.
        state.forcedTargetId = null;
      }
    }
  }
  const health = host.character.health;
  const hpFrac = health.max > 0 ? health.current / health.max : 0;
  const dpsIn = computeDpsIn(state.heal, nowMs, opts.heal);
  const lastHit = host.hitTimer.lastHit();
  const timeSinceLastHitMs = host.hitTimer.timeSinceLastHitMs;
  const weapon = classifyWeapon(host);
  return {
    nowMs,
    engaged: host.hitTimer.engaged || targets.length > 0,
    targets,
    position,
    health: { current: health.current, max: health.max },
    hpFrac,
    dpsIn,
    timeSinceLastHitMs,
    lastAttackerId: lastHit === null ? null : lastHit.attackerId,
    weapon,
  };
}

function buildKiteContext(host: TickLoopHost, sample: TickSample): KiteContext {
  const nearest = sample.targets[0];
  if (nearest === undefined) return { nearestPos: null };
  const obj = host.world.get(nearest.id);
  if (obj === undefined) return { nearestPos: null };
  return {
    nearestPos: { x: obj.position.x, z: obj.position.z },
    nearestTemplate: obj.templateName,
  };
}

function foldHitDamage(host: TickLoopHost, state: TickLoopState, nowMs: number): void {
  const hit: CombatHitInfo | null = host.hitTimer.lastHit();
  if (hit === null) return;
  if (hit.receivedAtMs <= state.lastFoldedHitAtMs) return;
  if (hit.damageAmount > 0) {
    pushDamageSample(state.heal, hit.receivedAtMs, hit.damageAmount);
  }
  state.lastFoldedHitAtMs = hit.receivedAtMs;
  void nowMs;
}

function emitMovementTick(host: TickLoopHost, dest: { x: number; z: number }): void {
  const current = host.position();
  const dx = dest.x - current.x;
  const dz = dest.z - current.z;
  const yaw = Math.atan2(dx, dz);
  const data: NetUpdateTransformData = {
    syncStamp: host.nextSyncStamp(),
    sequenceNumber: host.nextSequenceNumber(),
    rotation: yawToQuat(yaw),
    position: { x: dest.x, y: current.y, z: dest.z },
    speed: 0,
    lookAtYaw: 0,
    useLookAtYaw: false,
  };
  const stream = new ByteStream();
  NetUpdateTransformDecoder.encode(stream, data);
  host.send(
    new ObjControllerMessage(
      CLIENT_TO_AUTH_SERVER_FLAGS,
      ObjControllerSubtypeIds.CM_netUpdateTransform,
      host.sceneStart.playerNetworkId,
      0,
      stream.toBytes(),
      { kind: NetUpdateTransformDecoder.kind, data },
    ),
  );
  host.setPose({ x: dest.x, y: current.y, z: dest.z }, yaw);
}

function sleepUntilAborted(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    if (ms <= 0) {
      resolve();
      return;
    }
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    (t as { unref?: () => void }).unref?.();
    const onAbort = (): void => {
      clearTimeout(t);
      resolve();
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Default weapon classifier — reads the player's CREO p6 `weaponId`, looks
 * up the weapon CREO in the world, and substring-matches its templateName.
 *
 * Substring rules (curated for live SWG cluster content):
 *   - 'lightsaber' / 'jedi'                         → 'saber'
 *   - 'pistol'                                       → 'pistol'
 *   - 'rifle' (not in 'carbine')                     → 'rifle'
 *   - 'carbine'                                      → 'carbine'
 *   - 'flame_thrower' / 'acid_rifle' / 'lightning'   → 'heavy_directional'
 *   - 'sword' / 'polearm' / 'axe' / 'club' / 'knife' → 'melee'
 *   - 'unarmed' / no weapon                          → 'melee'
 *   - anything else                                  → 'unknown'
 */
export function defaultClassifyWeapon(host: TickLoopHost): WeaponKind {
  const player = host.world.get(host.sceneStart.playerNetworkId);
  if (player === undefined) return 'unknown';
  const p6 = player.baselines.get(BaselinePackageIds.SHARED_NP) as
    | CreatureObjectSharedNpBaseline
    | undefined;
  if (p6 === undefined) return 'unknown';
  const weaponId: NetworkId | undefined = (p6 as { weaponId?: NetworkId }).weaponId;
  if (weaponId === undefined || weaponId === 0n) return 'melee'; // unarmed fallback
  const weapon = host.world.get(weaponId);
  if (weapon === undefined) return 'unknown';
  return classifyWeaponTemplate(weapon.templateName);
}

/** Pure classifier — exposed for tests. */
export function classifyWeaponTemplate(templateName: string | undefined): WeaponKind {
  if (templateName === undefined || templateName.length === 0) return 'unknown';
  const lower = templateName.toLowerCase();
  if (lower.includes('lightsaber') || lower.includes('jedi')) return 'saber';
  if (
    lower.includes('flame_thrower') ||
    lower.includes('acid_rifle') ||
    lower.includes('lightning_rifle') ||
    lower.includes('lightning_cannon')
  ) {
    return 'heavy_directional';
  }
  if (lower.includes('carbine')) return 'carbine';
  if (lower.includes('rifle')) return 'rifle';
  if (lower.includes('pistol') || lower.includes('blaster_pistol')) return 'pistol';
  if (
    lower.includes('sword') ||
    lower.includes('polearm') ||
    lower.includes('axe') ||
    lower.includes('club') ||
    lower.includes('knife') ||
    lower.includes('dagger') ||
    lower.includes('vibroblade') ||
    lower.includes('two_hand')
  ) {
    return 'melee';
  }
  // Unrecognized weapon (e.g. crafting tool, decorative item, etc.) →
  // unknown. Weapon-conditional slots default to skipping.
  return 'unknown';
}
