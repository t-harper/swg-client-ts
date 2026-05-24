/**
 * Spy rotation — stealth-based burst with DoT stacks.
 *
 * Style: open from stealth (`sp_buff_stealth_4` toggle), drop
 * `sp_shifty_setup` (precision buff), place `sp_assassins_mark` on the
 * target so every subsequent hit procs bonus damage, then run the DoT-stack
 * combo (`sp_dot_5` + `sp_improved_cc_dot_3`) interleaved with `sp_hd_*`
 * (Hidden Strike, weapon-routed).
 *
 * Note: `sp_stealth_ranged_*` / `sp_stealth_melee_*` openers require
 * actively-stealthed state; they're omitted from the default rotation since
 * the framework can't reliably detect stealth state from the wire alone.
 * `sp_buff_invis_3` (smoke-bomb burst stealth) is in panic.defensive as an
 * emergency escape.
 *
 * Heal: `sp_sh_3` (15s).
 */

import type { Rotation, TickSample } from '../types.js';

const PISTOL_OR_CARBINE_OR_RIFLE = (s: TickSample): boolean =>
  s.weapon === 'pistol' || s.weapon === 'carbine' || s.weapon === 'rifle';
const MELEE_OR_SABER = (s: TickSample): boolean => s.weapon === 'melee' || s.weapon === 'saber';

export const spy: Rotation = {
  profession: 'spy',
  opener: [
    // Persistent stealth toggle — re-enter Stealth stance.
    {
      id: 'sp-self-stealth',
      ability: 'sp_buff_stealth_4',
      fallbackCooldownMs: 10_000,
      target: 'self',
    },
    // Precision/setup self-buff.
    {
      id: 'sp-self-shifty-setup',
      ability: 'sp_shifty_setup',
      fallbackCooldownMs: 120_000,
      target: 'self',
    },
    // Place the assassin's mark for proc bonuses on every hit.
    { id: 'sp-open-mark', ability: 'sp_assassins_mark', fallbackCooldownMs: 5_000 },
  ],
  combo: [
    // Refresh mark every 5s.
    { id: 'sp-combo-mark', ability: 'sp_assassins_mark', fallbackCooldownMs: 5_000 },
    // Hidden Strike — weapon-routed; ranged variant requires pistol/carbine/rifle.
    {
      id: 'sp-combo-hd-range',
      ability: 'sp_hd_range_6',
      fallbackCooldownMs: 3_000,
      when: PISTOL_OR_CARBINE_OR_RIFLE,
    },
    // Melee variant.
    {
      id: 'sp-combo-hd-melee',
      ability: 'sp_hd_melee_6',
      fallbackCooldownMs: 3_000,
      when: MELEE_OR_SABER,
    },
    // DoT stack.
    { id: 'sp-combo-dot', ability: 'sp_dot_5', fallbackCooldownMs: 6_000 },
    { id: 'sp-combo-cc-dot', ability: 'sp_improved_cc_dot_3', fallbackCooldownMs: 7_000 },
    // AoE snare — kite tool.
    { id: 'sp-combo-snare', ability: 'sp_fldmot_3_snare', fallbackCooldownMs: 15_000 },
    // AoE debuff (35m).
    { id: 'sp-combo-fld-debuff', ability: 'sp_fld_debuff_ca', fallbackCooldownMs: 30_000 },
    // Basic specialty damage.
    { id: 'sp-combo-dm', ability: 'sp_dm_8', fallbackCooldownMs: 3_000 },
    // Reactive CC+DoT.
    { id: 'sp-combo-cc-dot-reac', ability: 'sp_cc_dot_reac', fallbackCooldownMs: 5_000 },
  ],
  filler: { id: 'sp-filler', ability: 'attack', fallbackCooldownMs: 1_500 },
  panic: {
    heal: {
      id: 'sp-panic-heal',
      ability: 'sp_sh_3',
      fallbackCooldownMs: 15_000,
      target: 'self',
    },
    defensive: {
      id: 'sp-panic-invis',
      ability: 'sp_buff_invis_3',
      fallbackCooldownMs: 240_000,
      target: 'self',
    },
    cleanse: {
      id: 'sp-panic-cleanse',
      ability: 'sp_run_its_course',
      fallbackCooldownMs: 60_000,
      target: 'self',
    },
    flee: { id: 'sp-panic-flee', ability: 'burstRun', fallbackCooldownMs: 600_000, target: 'self' },
  },
  signatureAbilities: ['sp_assassins_mark', 'sp_dm_8', 'sp_dot_5', 'sp_sh_3'],
};
