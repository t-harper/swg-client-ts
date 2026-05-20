/**
 * Target selection — sticky closest-first with a low-HP "finisher" override.
 *
 * Default: closest hostile from `sample.targets[0]`.
 * Stickiness: stay on the current target for at least
 * `targeting.switchCooldownMs` after the last switch (unless the target
 * dies / leaves world / becomes unreachable).
 * Override: switch to a finisher target whose HP fraction is below
 * `targeting.preferLowestHpUnder` AND who is within
 * `targeting.lowHpDistanceFactor * currentDistance`.
 */

import type { NetworkId } from '../../../types.js';
import type { CombatTargetEntry } from '../../combat-helpers.js';
import type { TargetingPolicy, TickSample } from './types.js';

/**
 * Per-engagement targeting state. Carried by the tick loop across passes.
 */
export interface TargetingState {
  /** Current selected target id, or null if no target was ever selected. */
  currentId: NetworkId | null;
  /** Wall-clock ms when `currentId` was last changed. */
  lastSwitchAtMs: number;
}

export function createTargetingState(): TargetingState {
  return { currentId: null, lastSwitchAtMs: 0 };
}

/**
 * Select the next target for this tick. Mutates `state` in place when the
 * selection changes. Returns the picked target entry, or `null` when there
 * are no hostiles.
 */
export function selectTarget(
  sample: TickSample,
  state: TargetingState,
  policy: TargetingPolicy,
): CombatTargetEntry | null {
  if (sample.targets.length === 0) {
    state.currentId = null;
    return null;
  }

  const currentEntry =
    state.currentId === null ? null : findTarget(sample.targets, state.currentId);

  // No current target (or it's gone) → pick the closest.
  if (currentEntry === null) {
    const closest = sample.targets[0];
    if (closest === undefined) {
      state.currentId = null;
      return null;
    }
    if (state.currentId !== closest.id) {
      state.currentId = closest.id;
      state.lastSwitchAtMs = sample.nowMs;
    }
    return closest;
  }

  // Sticky window: don't even consider switching until it expires.
  if (sample.nowMs - state.lastSwitchAtMs < policy.switchCooldownMs) {
    return currentEntry;
  }

  // Low-HP finisher override: any target below the threshold AND within
  // `lowHpDistanceFactor` of the current target's distance wins.
  const currentDistance = currentEntry.distance;
  let bestFinisher: CombatTargetEntry | null = null;
  let bestFinisherFrac = 1;
  for (const t of sample.targets) {
    if (t.id === currentEntry.id) continue;
    if (t.ham === null || t.ham.healthMax <= 0) continue;
    const frac = t.ham.health / t.ham.healthMax;
    if (frac >= policy.preferLowestHpUnder) continue;
    if (t.distance > currentDistance * policy.lowHpDistanceFactor) continue;
    if (frac < bestFinisherFrac) {
      bestFinisherFrac = frac;
      bestFinisher = t;
    }
  }
  if (bestFinisher !== null) {
    state.currentId = bestFinisher.id;
    state.lastSwitchAtMs = sample.nowMs;
    return bestFinisher;
  }

  return currentEntry;
}

function findTarget(
  targets: readonly CombatTargetEntry[],
  id: NetworkId,
): CombatTargetEntry | null {
  for (const t of targets) {
    if (t.id === id) return t;
  }
  return null;
}
