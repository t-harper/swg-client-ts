/**
 * Smuggler rotation — PISTOL build (most common playstyle).
 *
 * Style: open with `sm_off_the_cuff` (damage proc) + `sm_shoot_first_5`
 * (burst opener), then chain executes (`sm_impossible_odds`, debuffs
 * `sm_skullduggery` / `sm_spot_a_sucker_4`), pistol-whip stun, and
 * `sm_dm_cc_6` / `sm_dm_dot_4` damage on tap.
 *
 * Weapon: PISTOL is assumed by all listed `sm_*` abilities here. For MELEE
 * builds users should override the rotation with the `_melee` variants
 * (`sm_dm_melee_*`, `sm_dm_cc_melee_*`, etc.).
 *
 * Heal: `sm_sh_3` (15s).
 * Panic: `sm_narrow_escape_4` (30s escape) → `sm_how_are_you` (150s CC defuse).
 */

import type { Rotation, TickSample } from '../types.js';

const PISTOL_ONLY = (s: TickSample): boolean => s.weapon === 'pistol';
const PISTOL_OR_MELEE = (s: TickSample): boolean => s.weapon === 'pistol' || s.weapon === 'melee';

export const smuggler: Rotation = {
  profession: 'smuggler',
  opener: [
    {
      id: 'sm-self-off-the-cuff',
      ability: 'sm_off_the_cuff',
      fallbackCooldownMs: 30_000,
      target: 'self',
    },
    {
      id: 'sm-open-shoot-first',
      ability: 'sm_shoot_first_5',
      fallbackCooldownMs: 60_000,
      when: PISTOL_OR_MELEE,
    },
  ],
  combo: [
    // Executes & debuffs first — they have the longest cooldowns.
    { id: 'sm-combo-impossible-odds', ability: 'sm_impossible_odds', fallbackCooldownMs: 45_000 },
    { id: 'sm-combo-skullduggery', ability: 'sm_skullduggery', fallbackCooldownMs: 45_000 },
    { id: 'sm-combo-spot-a-sucker', ability: 'sm_spot_a_sucker_4', fallbackCooldownMs: 45_000 },
    {
      id: 'sm-combo-break-the-deal',
      ability: 'sm_break_the_deal',
      fallbackCooldownMs: 45_000,
      when: PISTOL_ONLY,
    },
    // Stun.
    {
      id: 'sm-combo-pistol-whip',
      ability: 'sm_pistol_whip_4',
      fallbackCooldownMs: 30_000,
      when: PISTOL_OR_MELEE,
    },
    // AoE cover-fire (PISTOL, 46m).
    {
      id: 'sm-combo-cover-fire',
      ability: 'sm_ae_cover_fire',
      fallbackCooldownMs: 15_000,
      when: PISTOL_ONLY,
      target: 'none',
    },
    // Delayed damage+CC (any).
    { id: 'sm-combo-del-dm-cc', ability: 'sm_del_dm_cc_6', fallbackCooldownMs: 15_000 },
    // Damage + CC.
    { id: 'sm-combo-dm-cc', ability: 'sm_dm_cc_6', fallbackCooldownMs: 5_000 },
    // Bleed DoT.
    { id: 'sm-combo-dm-dot', ability: 'sm_dm_dot_4', fallbackCooldownMs: 5_000 },
    // Basic damage.
    { id: 'sm-combo-dm', ability: 'sm_dm_7', fallbackCooldownMs: 3_000 },
  ],
  filler: { id: 'sm-filler', ability: 'attack', fallbackCooldownMs: 1_500 },
  panic: {
    heal: {
      id: 'sm-panic-heal',
      ability: 'sm_sh_3',
      fallbackCooldownMs: 15_000,
      target: 'self',
    },
    defensive: {
      id: 'sm-panic-narrow-escape',
      ability: 'sm_narrow_escape_4',
      fallbackCooldownMs: 30_000,
      target: 'self',
    },
    cleanse: {
      id: 'sm-panic-how-are-you',
      ability: 'sm_how_are_you',
      fallbackCooldownMs: 150_000,
    },
    flee: { id: 'sm-panic-flee', ability: 'burstRun', fallbackCooldownMs: 600_000, target: 'self' },
  },
  signatureAbilities: ['sm_dm_7', 'sm_dm_cc_6', 'sm_pistol_whip_4', 'sm_sh_3'],
};
