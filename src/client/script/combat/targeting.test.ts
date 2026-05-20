import { describe, expect, it } from 'vitest';

import type { CombatTargetEntry } from '../../combat-helpers.js';
import { createTargetingState, selectTarget } from './targeting.js';
import { DEFAULT_TARGETING_POLICY, type TickSample, type WeaponKind } from './types.js';

function tick(targets: CombatTargetEntry[], nowMs = 1_000): TickSample {
  return {
    nowMs,
    engaged: targets.length > 0,
    targets,
    position: { x: 0, y: 0, z: 0 },
    health: { current: 1000, max: 1000 },
    hpFrac: 1,
    dpsIn: 0,
    timeSinceLastHitMs: Number.POSITIVE_INFINITY,
    lastAttackerId: null,
    weapon: 'rifle' as WeaponKind,
  };
}

function target(
  id: bigint,
  distance: number,
  ham?: { health: number; healthMax: number },
): CombatTargetEntry {
  return { id, distance, ham: ham ?? null };
}

describe('selectTarget', () => {
  it('returns null when no hostiles', () => {
    const state = createTargetingState();
    const picked = selectTarget(tick([]), state, DEFAULT_TARGETING_POLICY);
    expect(picked).toBeNull();
    expect(state.currentId).toBeNull();
  });

  it('picks targets[0] (caller is expected to pre-sort ascending by distance)', () => {
    const state = createTargetingState();
    const picked = selectTarget(
      tick([target(1n, 5), target(2n, 10)]),
      state,
      DEFAULT_TARGETING_POLICY,
    );
    expect(picked?.id).toBe(1n);
    expect(state.currentId).toBe(1n);
    expect(state.lastSwitchAtMs).toBe(1_000);
  });

  it('stays on current target during the sticky window', () => {
    const state = createTargetingState();
    selectTarget(tick([target(1n, 5)]), state, DEFAULT_TARGETING_POLICY);
    // Now a closer target appears, but we're inside the sticky window.
    const picked = selectTarget(
      tick([target(99n, 2), target(1n, 6)], 1_500),
      state,
      DEFAULT_TARGETING_POLICY,
    );
    expect(picked?.id).toBe(1n);
    expect(state.currentId).toBe(1n);
  });

  it('switches off current after sticky window expires when a finisher is available', () => {
    const state = createTargetingState();
    selectTarget(
      tick([target(1n, 10, { health: 1000, healthMax: 1000 })]),
      state,
      DEFAULT_TARGETING_POLICY,
    );
    // 5 seconds later — sticky window (2500ms) elapsed. A low-HP target now appears at
    // distance 12 (within 1.5× = 15m of current). It should win.
    const picked = selectTarget(
      tick(
        [
          target(1n, 10, { health: 1000, healthMax: 1000 }),
          target(2n, 12, { health: 100, healthMax: 1000 }),
        ],
        6_000,
      ),
      state,
      DEFAULT_TARGETING_POLICY,
    );
    expect(picked?.id).toBe(2n);
    expect(state.currentId).toBe(2n);
    expect(state.lastSwitchAtMs).toBe(6_000);
  });

  it('does NOT switch to a low-HP target that is too far away', () => {
    const state = createTargetingState();
    selectTarget(
      tick([target(1n, 10, { health: 1000, healthMax: 1000 })]),
      state,
      DEFAULT_TARGETING_POLICY,
    );
    // 5 seconds later — low-HP target at distance 20 (> 1.5× 10 = 15). Should stay.
    const picked = selectTarget(
      tick(
        [
          target(1n, 10, { health: 1000, healthMax: 1000 }),
          target(2n, 20, { health: 50, healthMax: 1000 }),
        ],
        6_000,
      ),
      state,
      DEFAULT_TARGETING_POLICY,
    );
    expect(picked?.id).toBe(1n);
  });

  it('does NOT switch to a target whose HP fraction is above threshold', () => {
    const state = createTargetingState();
    selectTarget(
      tick([target(1n, 10, { health: 1000, healthMax: 1000 })]),
      state,
      DEFAULT_TARGETING_POLICY,
    );
    // Low-HP candidate has 50% HP — above the 0.25 threshold. Stay on current.
    const picked = selectTarget(
      tick(
        [
          target(1n, 10, { health: 1000, healthMax: 1000 }),
          target(2n, 11, { health: 500, healthMax: 1000 }),
        ],
        6_000,
      ),
      state,
      DEFAULT_TARGETING_POLICY,
    );
    expect(picked?.id).toBe(1n);
  });

  it('switches when current target leaves the targets list', () => {
    const state = createTargetingState();
    selectTarget(tick([target(1n, 10)]), state, DEFAULT_TARGETING_POLICY);
    const picked = selectTarget(tick([target(2n, 15)], 1_200), state, DEFAULT_TARGETING_POLICY);
    expect(picked?.id).toBe(2n);
    expect(state.currentId).toBe(2n);
  });

  it('clears currentId when targets become empty', () => {
    const state = createTargetingState();
    selectTarget(tick([target(1n, 10)]), state, DEFAULT_TARGETING_POLICY);
    expect(state.currentId).toBe(1n);
    selectTarget(tick([]), state, DEFAULT_TARGETING_POLICY);
    expect(state.currentId).toBeNull();
  });

  it('picks the LOWEST-HP finisher among multiple candidates', () => {
    const state = createTargetingState();
    selectTarget(
      tick([target(1n, 10, { health: 1000, healthMax: 1000 })]),
      state,
      DEFAULT_TARGETING_POLICY,
    );
    const picked = selectTarget(
      tick(
        [
          target(1n, 10, { health: 1000, healthMax: 1000 }),
          target(2n, 11, { health: 200, healthMax: 1000 }),
          target(3n, 12, { health: 50, healthMax: 1000 }),
        ],
        6_000,
      ),
      state,
      DEFAULT_TARGETING_POLICY,
    );
    expect(picked?.id).toBe(3n);
  });

  it('ignores finisher candidates with no HAM data', () => {
    const state = createTargetingState();
    selectTarget(
      tick([target(1n, 10, { health: 1000, healthMax: 1000 })]),
      state,
      DEFAULT_TARGETING_POLICY,
    );
    const picked = selectTarget(
      tick([target(1n, 10, { health: 1000, healthMax: 1000 }), target(2n, 11)], 6_000),
      state,
      DEFAULT_TARGETING_POLICY,
    );
    expect(picked?.id).toBe(1n);
  });
});
