import { describe, expect, it } from 'vitest';

import type { CombatTargetEntry } from '../../combat-helpers.js';
import {
  type AttackerClass,
  type KiteContext,
  classifyAttacker,
  evaluateKite,
} from './kite-policy.js';
import type { KiteProfile, TickSample, WeaponKind } from './types.js';

function tick(targets: CombatTargetEntry[], position = { x: 100, y: 0, z: 100 }): TickSample {
  return {
    nowMs: 0,
    engaged: targets.length > 0,
    targets,
    position,
    health: { current: 1000, max: 1000 },
    hpFrac: 1,
    dpsIn: 0,
    timeSinceLastHitMs: Number.POSITIVE_INFINITY,
    lastAttackerId: null,
    weapon: 'rifle' as WeaponKind,
  };
}

const RANGED: KiteProfile = { kind: 'ranged', min: 18, max: 28, stepM: 6 };
const MELEE: KiteProfile = { kind: 'melee', min: 0, max: 4, stepM: 6 };

describe('classifyAttacker', () => {
  it('classifies rancor / krayt / tusken as melee', () => {
    expect(classifyAttacker('object/mobile/rancor.iff')).toBe('melee');
    expect(classifyAttacker('object/mobile/krayt_dragon.iff')).toBe('melee');
    expect(classifyAttacker('object/mobile/tusken_raider.iff')).toBe('melee');
  });

  it('classifies imperial troopers / snipers / pirates as ranged', () => {
    expect(classifyAttacker('object/mobile/imperial_trooper.iff')).toBe('ranged');
    expect(classifyAttacker('object/mobile/imperial_sniper.iff')).toBe('ranged');
    expect(classifyAttacker('object/mobile/pirate_marauder_rifle.iff')).toBe('ranged');
  });

  it('returns unknown for empty/undefined templates', () => {
    expect(classifyAttacker(undefined)).toBe('unknown');
    expect(classifyAttacker('')).toBe('unknown');
  });

  it('returns unknown for templates with no matching substring', () => {
    expect(classifyAttacker('object/mobile/some_random_npc.iff')).toBe('unknown');
  });

  it('is case-insensitive', () => {
    expect(classifyAttacker('OBJECT/MOBILE/RANCOR.IFF')).toBe('melee');
  });
});

describe('evaluateKite — ranged profile', () => {
  it('holds when no targets', () => {
    const decision = evaluateKite(tick([]), { nearestPos: null }, RANGED);
    expect(decision.kind).toBe('hold');
  });

  it('holds when distance is within band', () => {
    const decision = evaluateKite(
      tick([{ id: 1n, distance: 22, ham: null }]),
      { nearestPos: { x: 100, z: 100 }, nearestTemplate: 'object/mobile/rancor.iff' },
      RANGED,
    );
    expect(decision.kind).toBe('hold');
  });

  it('kites away from melee attacker that closed inside min', () => {
    // Player at (100, 100), target at (105, 100). Distance 5. min = 18 → kite.
    const decision = evaluateKite(
      tick([{ id: 1n, distance: 5, ham: null }], { x: 100, y: 0, z: 100 }),
      { nearestPos: { x: 105, z: 100 }, nearestTemplate: 'object/mobile/rancor.iff' },
      RANGED,
    );
    expect(decision.kind).toBe('kite');
    if (decision.kind === 'kite') {
      // Step away from target → -x direction. Step size 6.
      expect(decision.dest.x).toBeCloseTo(94, 5);
      expect(decision.dest.z).toBeCloseTo(100, 5);
    }
  });

  it('does NOT kite from a ranged attacker even when close', () => {
    const decision = evaluateKite(
      tick([{ id: 1n, distance: 5, ham: null }], { x: 100, y: 0, z: 100 }),
      { nearestPos: { x: 105, z: 100 }, nearestTemplate: 'object/mobile/imperial_trooper.iff' },
      RANGED,
    );
    // Distance 5 < min 18 but target is ranged → don't kite. But also distance 5 < max 28
    // so don't close either. Hold.
    expect(decision.kind).toBe('hold');
  });

  it('closes when distance exceeds max', () => {
    const decision = evaluateKite(
      tick([{ id: 1n, distance: 35, ham: null }], { x: 100, y: 0, z: 100 }),
      { nearestPos: { x: 135, z: 100 }, nearestTemplate: 'object/mobile/imperial_trooper.iff' },
      RANGED,
    );
    expect(decision.kind).toBe('close');
    if (decision.kind === 'close') {
      // Step toward target → +x direction.
      expect(decision.dest.x).toBeCloseTo(106, 5);
      expect(decision.dest.z).toBeCloseTo(100, 5);
    }
  });

  it('treats unknown attackers as melee for kite trigger', () => {
    const decision = evaluateKite(
      tick([{ id: 1n, distance: 5, ham: null }], { x: 100, y: 0, z: 100 }),
      { nearestPos: { x: 105, z: 100 }, nearestTemplate: 'object/mobile/something_weird.iff' },
      RANGED,
    );
    expect(decision.kind).toBe('kite');
  });

  it('handles stacked target/player (zero distance) without NaN', () => {
    const decision = evaluateKite(
      tick([{ id: 1n, distance: 0.0001, ham: null }], { x: 100, y: 0, z: 100 }),
      { nearestPos: { x: 100, z: 100 }, nearestTemplate: 'object/mobile/rancor.iff' },
      RANGED,
    );
    expect(decision.kind).toBe('kite');
    if (decision.kind === 'kite') {
      expect(Number.isFinite(decision.dest.x)).toBe(true);
      expect(Number.isFinite(decision.dest.z)).toBe(true);
    }
  });
});

describe('evaluateKite — melee profile', () => {
  it('closes on any target outside max range', () => {
    const decision = evaluateKite(
      tick([{ id: 1n, distance: 20, ham: null }], { x: 100, y: 0, z: 100 }),
      { nearestPos: { x: 120, z: 100 }, nearestTemplate: 'object/mobile/rancor.iff' },
      MELEE,
    );
    expect(decision.kind).toBe('close');
  });

  it('holds when target is within melee range', () => {
    const decision = evaluateKite(
      tick([{ id: 1n, distance: 3, ham: null }], { x: 100, y: 0, z: 100 }),
      { nearestPos: { x: 103, z: 100 }, nearestTemplate: 'object/mobile/rancor.iff' },
      MELEE,
    );
    expect(decision.kind).toBe('hold');
  });
});

describe('evaluateKite — classifier override', () => {
  it('uses the injected classifier instead of the default', () => {
    const allRanged = (_template: string | undefined): AttackerClass => 'ranged';
    const decision = evaluateKite(
      tick([{ id: 1n, distance: 5, ham: null }], { x: 100, y: 0, z: 100 }),
      { nearestPos: { x: 105, z: 100 }, nearestTemplate: 'object/mobile/rancor.iff' },
      RANGED,
      allRanged,
    );
    // Default would say melee (rancor) and kite; overridden classifier says
    // ranged → hold.
    expect(decision.kind).toBe('hold');
  });
});

describe('evaluateKite — context edge cases', () => {
  it('holds when nearestPos is null', () => {
    const decision = evaluateKite(
      tick([{ id: 1n, distance: 5, ham: null }]),
      { nearestPos: null } as KiteContext,
      RANGED,
    );
    expect(decision.kind).toBe('hold');
  });
});
