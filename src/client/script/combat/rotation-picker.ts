/**
 * Rotation picker — walks the rotation top-down each tick and picks the
 * highest-priority slot whose cooldown is ready and whose `when` gate
 * passes. Encodes "opener fires once per engagement, combo loops, filler is
 * always eligible" without surfacing the state machine to callers.
 *
 * The picker is pure: given a `Rotation`, `TickSample`, `RotationEngagementState`,
 * and a cooldown lookup, it returns the slot to fire (or `null` if none is
 * eligible). The tick-loop is responsible for actually calling
 * `ctx.useAbility(...)` and updating the state via `markSlotFired`.
 */

import type { Rotation, RotationEngagementState, RotationSlot, TickSample } from './types.js';

/** Where in the rotation the picked slot came from (used for telemetry). */
export type RotationSource = 'opener' | 'combo' | 'filler';

export interface RotationPickResult {
  slot: RotationSlot;
  source: RotationSource;
}

export function createRotationState(): RotationEngagementState {
  return {
    firedOpeners: new Set<string>(),
    lastFiredAtMs: new Map<string, number>(),
  };
}

/** Reset engagement-scoped state — call when transitioning out of combat. */
export function resetRotationState(state: RotationEngagementState): void {
  state.firedOpeners.clear();
  state.lastFiredAtMs.clear();
}

/** Record that a slot fired. Called by the tick loop after `useAbility`. */
export function markSlotFired(
  state: RotationEngagementState,
  slot: RotationSlot,
  source: RotationSource,
  nowMs: number,
): void {
  if (source === 'opener') state.firedOpeners.add(slot.id);
  state.lastFiredAtMs.set(slot.id, nowMs);
}

/**
 * Walk the rotation top-down and return the first eligible slot.
 *
 * Order: opener (slots NOT in `firedOpeners`) → combo → filler.
 * Eligibility per slot:
 *   - `cooldownMsUntil(slot.ability) === 0`
 *   - `slot.when?.(sample) ?? true`
 *   - Local fallback-cooldown gate: if we recently fired this slot ourselves
 *     and the server's CommandTimer hasn't arrived yet, honor
 *     `slot.fallbackCooldownMs` from `state.lastFiredAtMs[slot.id]`.
 *
 * Returns null when nothing — including filler — is eligible (e.g. filler's
 * gate returns false).
 */
export function pickRotationAction(
  rotation: Rotation,
  sample: TickSample,
  state: RotationEngagementState,
  cooldownMsUntil: (ability: string) => number,
): RotationPickResult | null {
  // 1) Opener — fire-once-per-engagement; only consider slots not yet fired.
  for (const slot of rotation.opener) {
    if (state.firedOpeners.has(slot.id)) continue;
    if (!isSlotReady(slot, sample, state, cooldownMsUntil)) continue;
    return { slot, source: 'opener' };
  }
  // 2) Combo — loop top-down by readiness.
  for (const slot of rotation.combo) {
    if (!isSlotReady(slot, sample, state, cooldownMsUntil)) continue;
    return { slot, source: 'combo' };
  }
  // 3) Filler — always-eligible fallback.
  if (isSlotReady(rotation.filler, sample, state, cooldownMsUntil)) {
    return { slot: rotation.filler, source: 'filler' };
  }
  return null;
}

function isSlotReady(
  slot: RotationSlot,
  sample: TickSample,
  state: RotationEngagementState,
  cooldownMsUntil: (ability: string) => number,
): boolean {
  if (cooldownMsUntil(slot.ability) > 0) return false;
  const lastFired = state.lastFiredAtMs.get(slot.id);
  if (lastFired !== undefined && sample.nowMs - lastFired < slot.fallbackCooldownMs) return false;
  if (slot.when !== undefined && !slot.when(sample)) return false;
  return true;
}
