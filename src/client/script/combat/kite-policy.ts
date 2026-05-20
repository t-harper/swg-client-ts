/**
 * Kite policy — decide whether to back off, hold position, or close.
 *
 * Inputs:
 *   - The current `TickSample` (player position + sorted target list).
 *   - A `KiteContext` carrying the nearest target's world position and
 *     template name (for classification).
 *   - The active `KiteProfile` ('ranged' vs 'melee', plus min/max).
 *
 * Output: a `KiteDecision` describing the action this tick — `hold` (do
 * nothing), `kite` (walk away from nearest, used by ranged profiles when a
 * melee attacker closes), or `close` (walk toward nearest, used by ranged
 * profiles to maintain range and by melee profiles to gap-close).
 *
 * Movement is engine-locked at 7.3 m/s on foot, so the tick-loop emits one
 * transform per tick at `policy.stepM` meters from the current position
 * along the kite vector. The policy itself just computes the destination.
 */

import type { KiteProfile, TickSample } from './types.js';

/** Coarse attacker classification used by the kite trigger. */
export type AttackerClass = 'melee' | 'ranged' | 'unknown';

/**
 * Template-name substring table for classifyAttacker. Each entry: if the
 * lowercase template includes the substring, classify accordingly.
 *
 * Curated for the live SWG cluster's common hostile content. The list errs
 * conservative — entries that don't match fall through to `'unknown'`,
 * which the kite trigger interprets as "treat like melee" (the safer choice
 * for a ranged profession that wants to maintain distance).
 */
const MELEE_TEMPLATE_SUBSTRINGS: readonly string[] = [
  'rancor',
  'krayt',
  'tusken',
  'nightsister',
  'janta',
  'cu_pa',
  'kintan_strider',
  'angler',
  'kimogila',
  'gurk',
  'graul',
  'sand_panther',
  'merek_chasm_beast',
  'kusak',
  'malkloc',
  'narglatch',
  'piket',
  'rontotaur',
  'savage_wampa',
  'sharnaff',
  'snorbal',
  'thune',
  'voritor_lizard',
  'gungan_warrior',
  'gungan_hunter',
];

const RANGED_TEMPLATE_SUBSTRINGS: readonly string[] = [
  'rifle',
  'sniper',
  'carbine',
  'pistol',
  'imperial_trooper',
  'imperial_stormtrooper',
  'imperial_scout_trooper',
  'rebel_trooper',
  'rebel_specforce',
  'bounty_hunter',
  'mercenary',
  'pirate_marauder',
  'tusken_warrior_rifle',
  'thug',
  'commando',
  'death_watch',
  'wookiee_sentry',
];

/**
 * Classify an attacker by its template name. Returns 'unknown' when no
 * substring matches. Callers treat 'unknown' as "assume melee" for kiting
 * decisions (safer to back off than to stand still).
 */
export function classifyAttacker(templateName: string | undefined): AttackerClass {
  if (templateName === undefined || templateName.length === 0) return 'unknown';
  const lower = templateName.toLowerCase();
  for (const s of RANGED_TEMPLATE_SUBSTRINGS) {
    if (lower.includes(s)) return 'ranged';
  }
  for (const s of MELEE_TEMPLATE_SUBSTRINGS) {
    if (lower.includes(s)) return 'melee';
  }
  return 'unknown';
}

/** Carries the contextual info evaluateKite needs about the nearest target. */
export interface KiteContext {
  /** Nearest hostile's 2D world position, or null if no target. */
  nearestPos: { x: number; z: number } | null;
  /** Nearest hostile's template name (for classification). */
  nearestTemplate?: string;
}

/** Discriminated kite decision. */
export type KiteDecision =
  | { kind: 'hold' }
  | { kind: 'kite'; dest: { x: number; z: number } }
  | { kind: 'close'; dest: { x: number; z: number } };

/**
 * Decide the next kite action. Returns 'hold' when no target, when the
 * player position is unknown, or when the current distance is comfortable.
 */
export function evaluateKite(
  sample: TickSample,
  ctx: KiteContext,
  profile: KiteProfile,
  classify: (templateName: string | undefined) => AttackerClass = classifyAttacker,
): KiteDecision {
  if (sample.targets.length === 0) return { kind: 'hold' };
  if (ctx.nearestPos === null) return { kind: 'hold' };

  const nearest = sample.targets[0];
  if (nearest === undefined) return { kind: 'hold' };
  const distance = nearest.distance;
  const playerPos = sample.position;
  const targetPos = ctx.nearestPos;
  const stepM = profile.stepM;
  // Direction from target → player (the "kite away" vector). When target
  // and player are stacked (~0 distance), fall back to +x to avoid NaN.
  const dx = playerPos.x - targetPos.x;
  const dz = playerPos.z - targetPos.z;
  const len = Math.hypot(dx, dz);
  const ux = len > 1e-6 ? dx / len : 1;
  const uz = len > 1e-6 ? dz / len : 0;

  const attackerClass = classify(ctx.nearestTemplate);

  if (profile.kind === 'ranged') {
    // Ranged + melee (or unknown) attacker + too close → back off.
    if (distance < profile.min && attackerClass !== 'ranged') {
      return {
        kind: 'kite',
        dest: {
          x: playerPos.x + ux * stepM,
          z: playerPos.z + uz * stepM,
        },
      };
    }
    // Ranged + farther than max → close. (Even against ranged enemies we
    // want them in our weapon's effective range.)
    if (distance > profile.max) {
      return {
        kind: 'close',
        dest: {
          x: playerPos.x - ux * stepM,
          z: playerPos.z - uz * stepM,
        },
      };
    }
    return { kind: 'hold' };
  }

  // Melee profile (Jedi): close on any target outside our max range. The
  // "min" knob isn't used — there's no "back off" for melee.
  if (distance > profile.max) {
    return {
      kind: 'close',
      dest: {
        x: playerPos.x - ux * stepM,
        z: playerPos.z - uz * stepM,
      },
    };
  }
  return { kind: 'hold' };
}
