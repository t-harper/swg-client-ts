/**
 * Combat behavior framework — public exports.
 *
 * Plug-and-play per-NGE-profession combat layer that auto-engages when the
 * character is attacked, runs a strategic ability rotation, fires heals
 * predictively, and kites melee enemies when ranged.
 *
 * Usage:
 *
 *   import { installCombatBehavior } from 'swg-ts-client';
 *
 *   const cb = installCombatBehavior(ctx, { profession: 'spy' });
 *   try {
 *     await cb.runHostOperation(async (signal) => {
 *       // Your script work — walks, surveys, sampling.
 *       await ctx.walkCircle({ centerX: 100, centerZ: 100, radius: 30, durationMs: 60_000 });
 *     });
 *   } catch (err) {
 *     // AbortError when combat took over.
 *   }
 *   cb.dispose();
 */

export { installCombatBehavior } from './install.js';
export {
  PROFESSION_ROTATIONS,
  bountyHunter,
  commando,
  jedi,
  officer,
  resolveProfessionRotation,
  smuggler,
  spy,
} from './profession/index.js';
export { verifyAbilities, readKnownCommands } from './verify-abilities.js';
export type { AbilityCheckResult, VerifyAbilitiesOpts } from './verify-abilities.js';
export type {
  CombatBehavior,
  CombatBehaviorOptions,
  DisengageEvent,
  DisengageReason,
  EngageEvent,
  EngageReason,
  HealPolicy,
  KiteProfile,
  ProfessionId,
  Rotation,
  RotationEngagementState,
  RotationSlot,
  TargetingPolicy,
  TickSample,
  WeaponKind,
} from './types.js';
export {
  DEFAULT_HEAL_POLICY,
  DEFAULT_KITE_PROFILES,
  DEFAULT_TARGETING_POLICY,
} from './types.js';
