/**
 * Officer rotation — tactical buffer/debuffer with PISTOL filler.
 *
 * Style: stack self-buffs (`of_buff_def_9`, `of_focus_fire_6`, `of_inspiration_6`),
 * open with armor-debuff (`of_deb_def_8`), then layer
 * `of_deadeye_debuff` + `of_dm_8` + delayed-AoE / centered-AoE damage
 * with `of_leg_strike_7` as the snare kite tool (MELEE only).
 *
 * Weapon: most `of_*` abilities accept ALL weapons. PISTOL-specific:
 * `of_pistol_dm`, `of_pistol_bleed`, `of_drillmaster_1`. MELEE-specific:
 * `of_decapitate_6`, `of_vortex_5`, `of_leg_strike_7`.
 *
 * Filler: `of_pistol_dm` (1s cd) if pistol equipped, else `attack`.
 * Heal: `of_sh_3` (15s) + `of_stimulator_1` (60s).
 */

import type { Rotation, TickSample } from '../types.js';

const MELEE_ONLY = (s: TickSample): boolean => s.weapon === 'melee' || s.weapon === 'saber';
const PISTOL_ONLY = (s: TickSample): boolean => s.weapon === 'pistol';
const NOT_PISTOL = (s: TickSample): boolean => s.weapon !== 'pistol';

export const officer: Rotation = {
  profession: 'officer',
  opener: [
    // Self-buff stack.
    {
      id: 'of-self-buff-def',
      ability: 'of_buff_def_9',
      fallbackCooldownMs: 7_000,
      target: 'self',
    },
    {
      id: 'of-self-focus-fire',
      ability: 'of_focus_fire_6',
      fallbackCooldownMs: 5_000,
      target: 'self',
    },
    {
      id: 'of-self-inspiration',
      ability: 'of_inspiration_6',
      fallbackCooldownMs: 60_000,
      target: 'self',
    },
    // Armor debuff opener.
    { id: 'of-open-deb-def', ability: 'of_deb_def_8', fallbackCooldownMs: 5_000 },
  ],
  combo: [
    // Big-debuff first (long cd, gate for low priority by listing earlier).
    { id: 'of-combo-deadeye', ability: 'of_deadeye_debuff', fallbackCooldownMs: 45_000 },
    // MELEE execute + AoE spin.
    {
      id: 'of-combo-decapitate',
      ability: 'of_decapitate_6',
      fallbackCooldownMs: 35_000,
      when: MELEE_ONLY,
    },
    { id: 'of-combo-vortex', ability: 'of_vortex_5', fallbackCooldownMs: 45_000, when: MELEE_ONLY },
    // Snare kite tool (MELEE 15m).
    {
      id: 'of-combo-leg-strike',
      ability: 'of_leg_strike_7',
      fallbackCooldownMs: 6_000,
      when: MELEE_ONLY,
    },
    // AoE CC.
    { id: 'of-combo-ae-dm-cc', ability: 'of_ae_dm_cc_3', fallbackCooldownMs: 15_000 },
    // Delayed AoE damage variants.
    { id: 'of-combo-del-ae-dm', ability: 'of_del_ae_dm_3', fallbackCooldownMs: 15_000 },
    { id: 'of-combo-del-ae-dm-dot', ability: 'of_del_ae_dm_dot_3', fallbackCooldownMs: 15_000 },
    // Refresh def debuff (5s).
    { id: 'of-combo-deb-def', ability: 'of_deb_def_8', fallbackCooldownMs: 5_000 },
    // Signature damage.
    { id: 'of-combo-dm', ability: 'of_dm_8', fallbackCooldownMs: 3_000 },
    // PISTOL bleed (3s).
    {
      id: 'of-combo-pistol-bleed',
      ability: 'of_pistol_bleed',
      fallbackCooldownMs: 3_000,
      when: PISTOL_ONLY,
    },
    // PISTOL spam filler (1s).
    {
      id: 'of-combo-pistol-dm',
      ability: 'of_pistol_dm',
      fallbackCooldownMs: 1_000,
      when: PISTOL_ONLY,
    },
  ],
  filler: {
    id: 'of-filler',
    ability: 'attack',
    fallbackCooldownMs: 1_500,
    when: NOT_PISTOL,
  },
  panic: {
    heal: {
      id: 'of-panic-heal',
      ability: 'of_sh_3',
      fallbackCooldownMs: 15_000,
      target: 'self',
    },
    defensive: {
      id: 'of-panic-emergency-shield',
      ability: 'of_emergency_shield',
      fallbackCooldownMs: 300_000,
      target: 'self',
    },
    cleanse: {
      id: 'of-panic-purge',
      ability: 'of_purge_1',
      fallbackCooldownMs: 60_000,
      target: 'self',
    },
    flee: { id: 'of-panic-flee', ability: 'burstRun', fallbackCooldownMs: 600_000, target: 'self' },
  },
  signatureAbilities: ['of_deb_def_8', 'of_dm_8', 'of_ae_dm_cc_3', 'of_sh_3'],
};
