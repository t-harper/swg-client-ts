import { describe, expect, it } from 'vitest';

import {
  computeDpsIn,
  createHealEvaluatorState,
  evaluateHeal,
  pushDamageSample,
} from './heal-policy.js';
import {
  DEFAULT_HEAL_POLICY,
  type RotationSlot,
  type TickSample,
  type WeaponKind,
} from './types.js';

function sample(opts: {
  hpFrac?: number;
  hpMax?: number;
  engaged?: boolean;
  dpsIn?: number;
  nowMs?: number;
}): TickSample {
  const hpMax = opts.hpMax ?? 1_000;
  const hpFrac = opts.hpFrac ?? 1;
  return {
    nowMs: opts.nowMs ?? 0,
    engaged: opts.engaged ?? true,
    targets: [],
    position: { x: 0, y: 0, z: 0 },
    health: { current: Math.round(hpMax * hpFrac), max: hpMax },
    hpFrac,
    dpsIn: opts.dpsIn ?? 0,
    timeSinceLastHitMs: opts.engaged === false ? Number.POSITIVE_INFINITY : 500,
    lastAttackerId: null,
    weapon: 'rifle' as WeaponKind,
  };
}

const healSlot: RotationSlot = {
  id: 'heal-self',
  ability: 'bh_sh_3',
  fallbackCooldownMs: 25_000,
};

describe('pushDamageSample + computeDpsIn', () => {
  it('accumulates damage over the rolling window', () => {
    const state = createHealEvaluatorState();
    pushDamageSample(state, 0, 100);
    pushDamageSample(state, 1_000, 200);
    pushDamageSample(state, 2_000, 200);
    // dpsWindow = 5000ms by default; total 500 damage / 5s = 100 dps
    expect(computeDpsIn(state, 2_500, DEFAULT_HEAL_POLICY)).toBe(100);
  });

  it('prunes entries older than the window', () => {
    const state = createHealEvaluatorState();
    pushDamageSample(state, 0, 500);
    pushDamageSample(state, 6_000, 100);
    // Window = 5000ms; cutoff for now=6000 is 1000 — only the 6000 entry remains.
    const dps = computeDpsIn(state, 6_000, DEFAULT_HEAL_POLICY);
    expect(dps).toBe(100 / 5);
    expect(state.dpsWindow).toHaveLength(1);
  });

  it('ignores negative or non-finite damage', () => {
    const state = createHealEvaluatorState();
    pushDamageSample(state, 0, -50);
    pushDamageSample(state, 0, Number.NaN);
    pushDamageSample(state, 0, 100);
    expect(state.dpsWindow).toHaveLength(1);
  });

  it('returns 0 when window empty', () => {
    const state = createHealEvaluatorState();
    expect(computeDpsIn(state, 1_000, DEFAULT_HEAL_POLICY)).toBe(0);
  });
});

describe('evaluateHeal', () => {
  it('returns null when no heal slot configured', () => {
    const state = createHealEvaluatorState();
    const decision = evaluateHeal(
      sample({ hpFrac: 0.1, dpsIn: 100 }),
      state,
      DEFAULT_HEAL_POLICY,
      undefined,
      () => 0,
    );
    expect(decision).toBeNull();
  });

  it('returns null when not engaged', () => {
    const state = createHealEvaluatorState();
    const decision = evaluateHeal(
      sample({ hpFrac: 0.1, engaged: false }),
      state,
      DEFAULT_HEAL_POLICY,
      healSlot,
      () => 0,
    );
    expect(decision).toBeNull();
  });

  it('returns null when HP above soft floor', () => {
    const state = createHealEvaluatorState();
    const decision = evaluateHeal(
      sample({ hpFrac: 0.8, dpsIn: 50 }),
      state,
      DEFAULT_HEAL_POLICY,
      healSlot,
      () => 0,
    );
    expect(decision).toBeNull();
  });

  it('fires immediately when HP below hard floor', () => {
    const state = createHealEvaluatorState();
    const decision = evaluateHeal(
      sample({ hpFrac: 0.2, dpsIn: 0 }),
      state,
      DEFAULT_HEAL_POLICY,
      healSlot,
      () => 0,
    );
    expect(decision).toBe(healSlot);
  });

  it('fires when soft-floor breached and DPS would kill within warmup+buffer', () => {
    const state = createHealEvaluatorState();
    // hp = 500 (50% of 1000), dps = 300 → ttd = 1666ms; warmup+buffer = 3500. Should fire.
    const decision = evaluateHeal(
      sample({ hpFrac: 0.5, hpMax: 1000, dpsIn: 300 }),
      state,
      DEFAULT_HEAL_POLICY,
      healSlot,
      () => 0,
    );
    expect(decision).toBe(healSlot);
  });

  it('does NOT fire when soft-floor breached but DPS allows waiting', () => {
    const state = createHealEvaluatorState();
    // hp = 600 (60%), dps = 50 → ttd = 12_000ms; warmup+buffer = 3500. Don't fire.
    const decision = evaluateHeal(
      sample({ hpFrac: 0.6, hpMax: 1000, dpsIn: 50 }),
      state,
      DEFAULT_HEAL_POLICY,
      healSlot,
      () => 0,
    );
    expect(decision).toBeNull();
  });

  it('fires when soft-floor breached and DPS is 0 (top-off before next hit)', () => {
    const state = createHealEvaluatorState();
    const decision = evaluateHeal(
      sample({ hpFrac: 0.5, dpsIn: 0 }),
      state,
      DEFAULT_HEAL_POLICY,
      healSlot,
      () => 0,
    );
    expect(decision).toBe(healSlot);
  });

  it('respects server cooldown', () => {
    const state = createHealEvaluatorState();
    const decision = evaluateHeal(
      sample({ hpFrac: 0.2 }),
      state,
      DEFAULT_HEAL_POLICY,
      healSlot,
      () => 10_000, // cd not ready
    );
    expect(decision).toBeNull();
  });

  it('respects local refire lock', () => {
    const state = createHealEvaluatorState();
    state.lastHealAtMs = 1_000;
    const decision = evaluateHeal(
      sample({ hpFrac: 0.2, nowMs: 1_500 }),
      state,
      DEFAULT_HEAL_POLICY,
      healSlot,
      () => 0,
    );
    expect(decision).toBeNull();
  });

  it('allows fire after refire lock expires', () => {
    const state = createHealEvaluatorState();
    state.lastHealAtMs = 1_000;
    const decision = evaluateHeal(
      sample({ hpFrac: 0.2, nowMs: 5_000 }),
      state,
      DEFAULT_HEAL_POLICY,
      healSlot,
      () => 0,
    );
    expect(decision).toBe(healSlot);
  });

  it('returns null when health.max is 0 (baseline not yet populated)', () => {
    const state = createHealEvaluatorState();
    const decision = evaluateHeal(
      { ...sample({ hpFrac: 0.2 }), health: { current: 0, max: 0 } },
      state,
      DEFAULT_HEAL_POLICY,
      healSlot,
      () => 0,
    );
    expect(decision).toBeNull();
  });
});
