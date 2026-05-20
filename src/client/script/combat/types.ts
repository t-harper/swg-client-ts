/**
 * Combat behavior framework — shared types.
 *
 * These shapes drive `installCombatBehavior(ctx, opts)`: a plug-and-play
 * combat layer that auto-engages when the player is attacked, runs a
 * per-profession rotation (opener → combo → filler) with predictive heals
 * and kiting, and releases control when threats clear.
 *
 * Pure type module — no runtime imports. Other files type against these
 * interfaces; the rotations under `profession/` are plain data.
 */

import type { NetworkId } from '../../../types.js';
import type { CombatTargetEntry } from '../../combat-helpers.js';

/** The six NGE combat classes supported by bundled rotations. */
export type ProfessionId = 'bounty_hunter' | 'commando' | 'spy' | 'smuggler' | 'officer' | 'jedi';

/** Why the behavior transitioned to engaged. */
export type EngageReason = 'hit-timer' | 'targets-present' | 'manual';

/** Why the behavior transitioned to disengaged. */
export type DisengageReason = 'no-targets-and-quiet' | 'manual' | 'host-disposed';

export interface EngageEvent {
  reason: EngageReason;
  targetIds: readonly NetworkId[];
  atMs: number;
}

export interface DisengageEvent {
  reason: DisengageReason;
  /** Engagement duration in ms. */
  durationMs: number;
  atMs: number;
}

/**
 * One snapshot of "what does the world look like to combat right now". The
 * tick loop builds one of these per pass and passes it through every policy
 * (heal, kite, rotation-picker). Pure data — no mutation.
 */
export interface TickSample {
  /** Wall-clock ms when the sample was taken. */
  nowMs: number;
  /** True when `hitTimer.engaged || targets.length > 0`. */
  engaged: boolean;
  /** Live hostile list from `ctx.combat.targets()`, sorted ascending by distance. */
  targets: readonly CombatTargetEntry[];
  /** Player's current 2D position. */
  position: Readonly<{ x: number; y: number; z: number }>;
  /** Player health current/max. `max <= 0` means baseline not yet populated. */
  health: { current: number; max: number };
  /** Health fraction in [0, 1]. `0` when `max <= 0`. */
  hpFrac: number;
  /** Estimated incoming damage-per-second over the last `dpsWindowMs`. */
  dpsIn: number;
  /** ms since the player was last hit (`Number.POSITIVE_INFINITY` if never). */
  timeSinceLastHitMs: number;
  /** Last attacker NetworkId (`null` if never hit this run). */
  lastAttackerId: NetworkId | null;
  /** Current weapon classification (used by `slot.when` gates). */
  weapon: WeaponKind;
}

/**
 * Coarse weapon classification — used by `RotationSlot.when` predicates to
 * gate weapon-conditional abilities (e.g. `co_hw_*` requires
 * `heavy_directional`; `fs_flurry_*` requires `saber`; `sm_*` PISTOL build
 * vs. MELEE build).
 *
 *   - `pistol`            — pistol equipped
 *   - `carbine`           — carbine equipped
 *   - `rifle`             — rifle equipped
 *   - `heavy_directional` — Commando GROUND_TARGETTING / DIRECTIONAL heavy
 *                            (acid rifle / flame thrower / lightning gun)
 *   - `melee`             — generic melee (sword / polearm / unarmed-fist)
 *   - `saber`             — lightsaber
 *   - `unknown`           — weapon CREO not yet visible or template not
 *                            classifiable
 */
export type WeaponKind =
  | 'pistol'
  | 'carbine'
  | 'rifle'
  | 'heavy_directional'
  | 'melee'
  | 'saber'
  | 'unknown';

/**
 * One ability slot in a profession's rotation. Authors declare a static
 * `Rotation` (see `profession/*.ts`); the picker walks the slots top-down
 * each tick and fires the highest-priority one whose cooldown is ready and
 * whose `when` gate passes.
 */
export interface RotationSlot {
  /** Internal slot id (used by `rotationState.markFired`). Stable across ticks. */
  id: string;
  /**
   * Ability command name passed to `ctx.useAbility(ability, targetId, params)`.
   * Should be the highest tier the character is expected to own; the server
   * auto-substitutes lower tiers via `command_series.tab` if the higher
   * tier hasn't been granted.
   */
  ability: string;
  /**
   * Server-imposed cooldown in ms. Only used when the framework hasn't yet
   * observed a `CM_commandTimer` for this ability — real cooldowns come
   * from `ctx.cooldowns.msUntil(ability)`. Treated as the "minimum spacing
   * between fires from us" until the server confirms.
   */
  fallbackCooldownMs: number;
  /**
   * Optional gate evaluated against the current `TickSample`. Return `false`
   * to skip this slot this tick (e.g. weapon-conditional abilities). When
   * omitted the slot is always eligible (subject to cooldown).
   */
  when?: (sample: TickSample) => boolean;
  /**
   * Extra params passed to `ctx.useAbility`. Most combat abilities don't
   * need this; SWG's command queue passes `params` as a single string to
   * the server-side command handler.
   */
  params?: string;
  /**
   * Target selection override:
   *   - `'current'` (default) — fire at the picker-selected target
   *   - `'self'`              — fire at self (NetworkId 0n; used for self-buffs and self-heal)
   *   - `'none'`              — fire untargeted (NetworkId 0n; used for AoE abilities and toggles)
   *
   * The wire forms self/untargeted both pass NetworkId 0n via `CommandQueueEnqueue`;
   * the server's command handler decides which interpretation applies.
   */
  target?: 'current' | 'self' | 'none';
}

/**
 * Per-engagement rotation state. Tracks which opener slots have already
 * fired this engagement so the picker doesn't repeat them, plus when each
 * slot was last fired locally (separate from server cooldowns — used for
 * one-shot-per-engagement gating and anti-double-fire).
 */
export interface RotationEngagementState {
  /** Slot ids that have already fired this engagement. */
  firedOpeners: Set<string>;
  /** Per-slot-id wall-clock ms when we last fired it. */
  lastFiredAtMs: Map<string, number>;
}

/**
 * A profession's complete rotation. Authors export one of these per class
 * from `profession/<name>.ts`.
 */
export interface Rotation {
  profession: ProfessionId;
  /**
   * Slots fired ONCE per engagement, before combo. Typical: self-buffs,
   * debuff openers, armor breaks, CC openers. Picker walks top-down and
   * fires the first ready slot whose id isn't in `firedOpeners`.
   */
  opener: readonly RotationSlot[];
  /**
   * Looped slots after opener has fired at least once. Picker walks top-down
   * and fires the first ready slot every tick.
   */
  combo: readonly RotationSlot[];
  /**
   * Always-eligible fallback — fires when nothing in `opener` or `combo` is
   * ready. Usually `attack`.
   */
  filler: RotationSlot;
  /**
   * Panic slots — selected by the heal-policy + safety logic, not the
   * rotation picker. `heal` is the primary self-heal (e.g. `bh_sh_3`);
   * `cleanse` removes stuns/debuffs; `defensive` is a damage-reduction
   * shield; `flee` is the disengage trigger.
   */
  panic: {
    heal?: RotationSlot;
    cleanse?: RotationSlot;
    defensive?: RotationSlot;
    flee?: RotationSlot;
  };
  /**
   * Signature abilities checked by `verifyAbilities` — if any are missing
   * from the character's known commands, a warning is logged at install time.
   * Provisioning is the host's job; the framework is best-effort.
   */
  signatureAbilities: readonly string[];
}

/** Tunable knobs for the predictive heal trigger. */
export interface HealPolicy {
  /**
   * HP fraction below which a heal fires immediately (no warmup math).
   * Default 0.35.
   */
  hardFloor: number;
  /**
   * HP fraction below which a heal MAY fire if predicted time-to-death is
   * shorter than `warmupMs + bufferMs`. Default 0.65.
   */
  softFloor: number;
  /**
   * Safety buffer added to the heal warmup when computing the predicted
   * time-to-death window. Default 2000.
   */
  bufferMs: number;
  /**
   * Assumed heal warmup in ms — usually 0 for combat abilities (the SWG
   * server enforces ~250ms GCD), but some heals have a 1-1.5s warmup. Used
   * in the predictive trigger. Default 1500.
   */
  warmupMs: number;
  /**
   * Rolling DPS-in window in ms. Damage older than this is dropped from the
   * estimate. Default 5000.
   */
  dpsWindowMs: number;
  /**
   * Anti-double-fire local lock — once a heal is queued, don't fire another
   * for at least this many ms (the server's `CM_commandTimer` arrives ~200ms
   * later, so we protect the window in between). Default 2500.
   */
  refireLockMs: number;
}

/** Tunable knobs for kite behavior. */
export interface KiteProfile {
  /**
   * Engagement style:
   *   - `'ranged'` — maintain distance; back off when melee enemies close to
   *                  `min`; advance when distance exceeds `max`.
   *   - `'melee'`  — close the gap; advance toward `min`; never retreat
   *                  unless the host triggers a flee.
   */
  kind: 'ranged' | 'melee';
  /** Desired minimum distance (m) — back off if a hostile is closer. */
  min: number;
  /** Desired maximum distance (m) — advance if all hostiles are farther. */
  max: number;
  /** Meters to step per kite tick. Default 6. */
  stepM: number;
}

/** Tunable knobs for target selection. */
export interface TargetingPolicy {
  /**
   * Don't switch target for at least this many ms after the last switch
   * (unless current target dies or leaves world). Default 2500.
   */
  switchCooldownMs: number;
  /**
   * Switch to a finisher target whose HP fraction is below this threshold
   * AND who is within `lowHpDistanceFactor * currentDistance`. Default 0.25.
   */
  preferLowestHpUnder: number;
  /**
   * How much closer (relative to current target's distance) a low-HP
   * candidate must be to trigger a switch. Default 1.5 — i.e. candidate's
   * distance must be < 1.5× current target's distance.
   */
  lowHpDistanceFactor: number;
}

/**
 * Top-level options for `installCombatBehavior(ctx, opts)`.
 */
export interface CombatBehaviorOptions {
  /** Profession id — selects the bundled rotation (override with `rotation`). */
  profession: ProfessionId;
  /**
   * Override the bundled rotation. When omitted, the rotation is loaded
   * from `profession/<id>.ts` at install time.
   */
  rotation?: Rotation;
  /** Heal-policy overrides. Defaults applied per field. */
  heal?: Partial<HealPolicy>;
  /** Kite-profile overrides. Defaults inferred from profession. */
  kite?: Partial<KiteProfile>;
  /** Targeting-policy overrides. Defaults applied per field. */
  targeting?: Partial<TargetingPolicy>;
  /** Tick interval in ms. Default 100. */
  tickMs?: number;
  /**
   * Run `verifyAbilities` on install and log a console.warn with missing
   * signature abilities. Default true.
   */
  verify?: boolean;
  /**
   * After this many ms of `engaged === false`, disengage and release host
   * control. Default 5000.
   */
  disengageAfterMs?: number;
  /**
   * Optional logger — called with a tag + payload for every state
   * transition / fired ability. Default: no-op.
   */
  logFn?: (tag: string, payload: unknown) => void;
}

/**
 * Public surface returned by `installCombatBehavior`. The host script holds
 * one of these; the framework owns the tick loop, engage-watcher, and
 * host-cancel controller internally.
 */
export interface CombatBehavior {
  /** True while the tick loop currently owns the actor. */
  readonly engaged: boolean;
  /** The profession this behavior was installed for. */
  readonly profession: ProfessionId;
  /**
   * Run an awaited operation under a child `AbortSignal` that combat aborts
   * on engage. Use this for any cancellable host work (movement, sampling,
   * polling loops). On engage, `fn`'s promise rejects with `AbortError`;
   * on disengage, the host may call `runHostOperation` again to resume.
   */
  runHostOperation<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T>;
  /**
   * Force-engage now (e.g. proactive pull). Returns when the tick loop has
   * taken control. `opts.targetId` seeds the targeting state (the first
   * tick will use this target if it's still hostile).
   */
  engage(opts?: { targetId?: NetworkId }): Promise<void>;
  /**
   * Force-disengage. Cancels the tick loop and lets the host's next
   * `runHostOperation` proceed normally. Idempotent.
   */
  disengage(reason?: 'manual'): void;
  /** Subscribe to engage transitions. Returns an unsubscribe function. */
  onEngage(fn: (e: EngageEvent) => void): () => void;
  /** Subscribe to disengage transitions. Returns an unsubscribe function. */
  onDisengage(fn: (e: DisengageEvent) => void): () => void;
  /**
   * Tear down all listeners + cancel the tick loop. Idempotent. Called
   * automatically when `ctx.signal` aborts.
   */
  dispose(): void;
}

/**
 * Resolved options with defaults applied. Internal — produced by
 * `install.ts` before creating the tick loop.
 */
export interface ResolvedOptions {
  profession: ProfessionId;
  rotation: Rotation;
  heal: HealPolicy;
  kite: KiteProfile;
  targeting: TargetingPolicy;
  tickMs: number;
  verify: boolean;
  disengageAfterMs: number;
  logFn: (tag: string, payload: unknown) => void;
}

export const DEFAULT_HEAL_POLICY: HealPolicy = {
  hardFloor: 0.35,
  softFloor: 0.65,
  bufferMs: 2_000,
  warmupMs: 1_500,
  dpsWindowMs: 5_000,
  refireLockMs: 2_500,
};

export const DEFAULT_TARGETING_POLICY: TargetingPolicy = {
  switchCooldownMs: 2_500,
  preferLowestHpUnder: 0.25,
  lowHpDistanceFactor: 1.5,
};

/**
 * Per-profession default kite profiles. Melee professions (Jedi) want to
 * close; ranged professions want to maintain a comfortable distance.
 */
export const DEFAULT_KITE_PROFILES: Record<ProfessionId, KiteProfile> = {
  bounty_hunter: { kind: 'ranged', min: 18, max: 28, stepM: 6 },
  commando: { kind: 'ranged', min: 14, max: 22, stepM: 6 },
  spy: { kind: 'ranged', min: 12, max: 22, stepM: 5 },
  smuggler: { kind: 'ranged', min: 16, max: 24, stepM: 6 },
  officer: { kind: 'ranged', min: 16, max: 24, stepM: 6 },
  jedi: { kind: 'melee', min: 0, max: 4, stepM: 6 },
};
