/**
 * Heal policy — predictive trigger plus rolling-DPS estimation.
 *
 * The tick loop calls these three functions every pass:
 *
 *   pushDamageSample(state, nowMs, damage)   — when a hit lands
 *   computeDpsIn(state, nowMs, policy)       — to populate TickSample.dpsIn
 *   evaluateHeal(sample, state, policy, slot, cdLookup) — to decide whether to fire
 *
 * The trigger formula:
 *
 *   hpFrac < hardFloor                            → fire heal (hard panic)
 *   hpFrac < softFloor AND
 *     timeToDeath < warmupMs + bufferMs           → fire heal (predictive)
 *
 * Anti-double-fire local lock: after a heal is queued we reject re-fires
 * for `refireLockMs` ms (the server's `CM_commandTimer` arrives ~200 ms
 * later — until then `ctx.cooldowns.msUntil(heal)` still reads 0).
 *
 * The heal slot is supplied by the caller (typically `rotation.panic.heal`);
 * the policy is purely decision logic.
 */

import type { HealPolicy, RotationSlot, TickSample } from './types.js';

/**
 * Per-engagement heal state. Carried by the tick loop across passes.
 */
export interface HealEvaluatorState {
  /** Damage events received within the rolling window. Append-only; pruned on read. */
  dpsWindow: Array<{ atMs: number; damage: number }>;
  /** Wall-clock ms when we last fired the heal (anti-double-fire lock). */
  lastHealAtMs: number;
}

export function createHealEvaluatorState(): HealEvaluatorState {
  // `lastHealAtMs = -Infinity` means "never fired" — guarantees the first
  // heal isn't blocked by the local refire lock when the clock is near 0.
  return { dpsWindow: [], lastHealAtMs: Number.NEGATIVE_INFINITY };
}

/**
 * Record an inbound damage event. `damage` must be the cumulative damage of
 * a single `CM_combatAction` defender entry against us (the `damageAmount`
 * field surfaced by `ctx.hitTimer.lastHit()`). Zero-damage hits are
 * recorded too — they signal we're being attacked but don't move the
 * DPS estimate.
 */
export function pushDamageSample(state: HealEvaluatorState, atMs: number, damage: number): void {
  if (damage < 0 || !Number.isFinite(damage)) return;
  state.dpsWindow.push({ atMs, damage });
}

/**
 * Roll up the damage window into a damage-per-second estimate. Entries
 * older than `policy.dpsWindowMs` are pruned from `state.dpsWindow` as a
 * side effect (so the window stays bounded across long runs).
 */
export function computeDpsIn(state: HealEvaluatorState, nowMs: number, policy: HealPolicy): number {
  const windowMs = policy.dpsWindowMs;
  const cutoff = nowMs - windowMs;
  // Prune in place: find the first entry >= cutoff and slice the array.
  // The list is append-only, so it's already chronologically ordered.
  let firstKept = 0;
  while (firstKept < state.dpsWindow.length) {
    const entry = state.dpsWindow[firstKept];
    if (entry !== undefined && entry.atMs >= cutoff) break;
    firstKept++;
  }
  if (firstKept > 0) state.dpsWindow.splice(0, firstKept);
  if (state.dpsWindow.length === 0) return 0;
  let totalDamage = 0;
  for (const entry of state.dpsWindow) totalDamage += entry.damage;
  // Use full window (in seconds) as the divisor — this gives a conservative
  // estimate that smoothly decays even as the most recent hit ages out.
  const seconds = windowMs / 1000;
  return totalDamage / seconds;
}

/**
 * Decide whether to fire a heal this tick. Returns the slot to fire or
 * `null` to skip. The caller is responsible for actually calling
 * `ctx.useAbility(slot.ability, 0n, slot.params ?? '')` and marking
 * `state.lastHealAtMs = sample.nowMs`.
 *
 * Returns null when:
 *   - No heal slot provided (profession has no self-heal).
 *   - Within the local refire lock window.
 *   - Heal ability is still on server cooldown (`cooldownMsUntil > 0`).
 *   - Player isn't engaged.
 *   - HP fraction above `softFloor` (no need yet).
 *   - HP between hard and soft floor AND predicted time-to-death > warmup + buffer.
 */
export function evaluateHeal(
  sample: TickSample,
  state: HealEvaluatorState,
  policy: HealPolicy,
  healSlot: RotationSlot | undefined,
  cooldownMsUntil: (ability: string) => number,
): RotationSlot | null {
  if (healSlot === undefined) return null;
  // No heal needed when we're not in combat or HP is unknown / full.
  if (!sample.engaged) return null;
  if (sample.health.max <= 0) return null;
  if (sample.hpFrac >= policy.softFloor) return null;
  // Anti-double-fire local lock.
  if (sample.nowMs - state.lastHealAtMs < policy.refireLockMs) return null;
  // Server cooldown.
  if (cooldownMsUntil(healSlot.ability) > 0) return null;
  // Hard floor — fire immediately, no warmup math.
  if (sample.hpFrac < policy.hardFloor) return healSlot;
  // Predictive: do we have time to wait?
  const currentHp = sample.health.current;
  const dps = sample.dpsIn;
  if (dps <= 0) {
    // No incoming damage — soft-floor breach without DPS means we took one
    // big hit but aren't being pressured. Heal anyway to top off before the
    // next swing.
    return healSlot;
  }
  const timeToDeathMs = (currentHp / dps) * 1000;
  if (timeToDeathMs < policy.warmupMs + policy.bufferMs) return healSlot;
  return null;
}
