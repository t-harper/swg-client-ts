import { describe, expect, it } from 'vitest';

import {
  createRotationState,
  markSlotFired,
  pickRotationAction,
  resetRotationState,
} from './rotation-picker.js';
import type { Rotation, RotationSlot, TickSample, WeaponKind } from './types.js';

function tick(nowMs = 0): TickSample {
  return {
    nowMs,
    engaged: true,
    targets: [],
    position: { x: 0, y: 0, z: 0 },
    health: { current: 1000, max: 1000 },
    hpFrac: 1,
    dpsIn: 0,
    timeSinceLastHitMs: 500,
    lastAttackerId: null,
    weapon: 'rifle' as WeaponKind,
  };
}

const slot = (
  id: string,
  ability: string,
  cd = 1500,
  opts?: Partial<RotationSlot>,
): RotationSlot => ({
  id,
  ability,
  fallbackCooldownMs: cd,
  ...opts,
});

const baseRotation: Rotation = {
  profession: 'bounty_hunter',
  opener: [slot('open-1', 'bh_dread_strike_5', 30_000)],
  combo: [slot('combo-crit', 'bh_dm_crit_8', 6_000), slot('combo-dm', 'bh_dm_8', 3_000)],
  filler: slot('filler', 'attack', 1_500),
  panic: {},
  signatureAbilities: [],
};

describe('pickRotationAction', () => {
  it('fires opener first when nothing has fired yet', () => {
    const state = createRotationState();
    const picked = pickRotationAction(baseRotation, tick(), state, () => 0);
    expect(picked?.slot.id).toBe('open-1');
    expect(picked?.source).toBe('opener');
  });

  it('skips opener after it has fired and picks the first ready combo slot', () => {
    const state = createRotationState();
    state.firedOpeners.add('open-1');
    const picked = pickRotationAction(baseRotation, tick(), state, () => 0);
    expect(picked?.slot.id).toBe('combo-crit');
    expect(picked?.source).toBe('combo');
  });

  it('skips combo slot whose ability is on server cooldown', () => {
    const state = createRotationState();
    state.firedOpeners.add('open-1');
    const cd = (a: string): number => (a === 'bh_dm_crit_8' ? 5_000 : 0);
    const picked = pickRotationAction(baseRotation, tick(), state, cd);
    expect(picked?.slot.id).toBe('combo-dm');
  });

  it('falls back to filler when nothing in opener/combo is ready', () => {
    const state = createRotationState();
    state.firedOpeners.add('open-1');
    const cd = (a: string): number => (a === 'bh_dm_crit_8' || a === 'bh_dm_8' ? 5_000 : 0);
    const picked = pickRotationAction(baseRotation, tick(), state, cd);
    expect(picked?.slot.id).toBe('filler');
    expect(picked?.source).toBe('filler');
  });

  it('honors local fallbackCooldownMs after we fired ourselves', () => {
    const state = createRotationState();
    state.firedOpeners.add('open-1');
    const comboFirst = baseRotation.combo[0];
    if (comboFirst === undefined) throw new Error('baseRotation missing combo');
    markSlotFired(state, comboFirst, 'combo', 0);
    // Same tick — fallback cooldown 6000ms hasn't elapsed; combo-crit should
    // skip even though the server reports cd = 0.
    const picked = pickRotationAction(baseRotation, tick(100), state, () => 0);
    expect(picked?.slot.id).toBe('combo-dm');
  });

  it('skips slots whose when gate returns false', () => {
    const rotation: Rotation = {
      ...baseRotation,
      opener: [],
      combo: [
        slot('combo-conditional', 'co_hw_dm_6', 3_000, {
          when: (s) => s.weapon === 'heavy_directional',
        }),
        slot('combo-fallback', 'co_dm_8', 3_000),
      ],
    };
    const state = createRotationState();
    const picked = pickRotationAction(rotation, tick(), state, () => 0);
    expect(picked?.slot.id).toBe('combo-fallback');
  });

  it('returns null when filler.when also returns false', () => {
    const rotation: Rotation = {
      ...baseRotation,
      filler: slot('filler', 'attack', 1500, { when: () => false }),
    };
    const state = createRotationState();
    state.firedOpeners.add('open-1');
    const cd = (a: string): number => (a === 'bh_dm_crit_8' || a === 'bh_dm_8' ? 5_000 : 0);
    const picked = pickRotationAction(rotation, tick(), state, cd);
    expect(picked).toBeNull();
  });

  it('opener fires only once per engagement even with multiple opener slots', () => {
    const rotation: Rotation = {
      ...baseRotation,
      opener: [slot('open-a', 'op_a', 30_000), slot('open-b', 'op_b', 30_000)],
    };
    const state = createRotationState();

    // First tick → open-a
    const p1 = pickRotationAction(rotation, tick(), state, () => 0);
    if (p1 === null) throw new Error('expected pick');
    expect(p1.slot.id).toBe('open-a');
    markSlotFired(state, p1.slot, p1.source, 0);

    // Second tick → open-b (open-a is in firedOpeners now)
    const p2 = pickRotationAction(rotation, tick(100), state, () => 0);
    if (p2 === null) throw new Error('expected pick');
    expect(p2.slot.id).toBe('open-b');
    markSlotFired(state, p2.slot, p2.source, 100);

    // Third tick → combo (both openers fired)
    const p3 = pickRotationAction(rotation, tick(200), state, () => 0);
    expect(p3?.slot.id).toBe('combo-crit');
  });
});

describe('resetRotationState', () => {
  it('clears firedOpeners and lastFiredAtMs', () => {
    const state = createRotationState();
    state.firedOpeners.add('open-1');
    state.lastFiredAtMs.set('combo-a', 100);
    resetRotationState(state);
    expect(state.firedOpeners.size).toBe(0);
    expect(state.lastFiredAtMs.size).toBe(0);
  });

  it('lets opener fire again in the next engagement', () => {
    const state = createRotationState();
    const p1 = pickRotationAction(baseRotation, tick(), state, () => 0);
    if (p1 === null) throw new Error('expected pick');
    expect(p1.source).toBe('opener');
    markSlotFired(state, p1.slot, 'opener', 0);
    resetRotationState(state);
    const p2 = pickRotationAction(baseRotation, tick(100), state, () => 0);
    expect(p2?.source).toBe('opener');
  });
});

describe('markSlotFired', () => {
  it('only adds opener-source slots to firedOpeners', () => {
    const state = createRotationState();
    const comboFirst = baseRotation.combo[0];
    const openerFirst = baseRotation.opener[0];
    if (comboFirst === undefined || openerFirst === undefined) {
      throw new Error('baseRotation missing slots');
    }
    markSlotFired(state, comboFirst, 'combo', 0);
    expect(state.firedOpeners.has('combo-crit')).toBe(false);
    markSlotFired(state, openerFirst, 'opener', 0);
    expect(state.firedOpeners.has('open-1')).toBe(true);
  });
});
