/**
 * Jedi (Force Sensitive) rotation — saber MELEE with ranged force powers.
 *
 * Style: open with combat-attribute stance (`fs_buff_ca_6`) + reflect buff
 * (`fs_saber_reflect_buff`) + defensive evasion (`centerOfBeing`), then
 * use `fs_mind_trick_2` as a 30m ranged opener-debuff while closing with
 * `forceRun` (45s gap-closer). Combo: `fs_flurry_7` saber AoE +
 * `fs_dm_cc_6_root` for ranged CC + force-damage ranged taps.
 *
 * Weapon: ALL_LIGHTSABERS / MELEE required for `fs_flurry_*`, `fs_sweep_*`,
 * `fs_dm_*`, and `forceThrow`. Force-power abilities (`fs_dm_cc_*`,
 * `fs_ae_dm_cc_*`, `fs_maelstrom_*`, `fs_mind_trick_*`) fire at 30m
 * regardless of weapon.
 *
 * Heal: `fs_sh_3` (25s) — IMPORTANT: shares cooldown group `fs_sh` with
 * `fs_drain_*`. We omit `fs_drain` from the combo to avoid locking the heal.
 */

import type { Rotation, TickSample } from '../types.js';

const SABER = (s: TickSample): boolean => s.weapon === 'saber';

export const jedi: Rotation = {
  profession: 'jedi',
  opener: [
    // Combat-attribute stance — shares cd group with `fs_buff_def_*`.
    {
      id: 'fs-self-buff-ca',
      ability: 'fs_buff_ca_6',
      fallbackCooldownMs: 10_000,
      target: 'self',
    },
    // Reflect-blasters toggle.
    {
      id: 'fs-self-saber-reflect',
      ability: 'fs_saber_reflect_buff',
      fallbackCooldownMs: 60_000,
      target: 'self',
    },
    // Ranged opener-debuff (works at 30m while closing).
    { id: 'fs-open-mind-trick', ability: 'fs_mind_trick_2', fallbackCooldownMs: 15_000 },
    // Gap-closer sprint.
    { id: 'fs-open-force-run', ability: 'forceRun', fallbackCooldownMs: 45_000, target: 'self' },
  ],
  combo: [
    // Signature saber flurry.
    { id: 'fs-combo-flurry', ability: 'fs_flurry_7', fallbackCooldownMs: 12_000, when: SABER },
    // Ranged force damage + CC + crit.
    { id: 'fs-combo-dm-cc-crit', ability: 'fs_dm_cc_crit_5', fallbackCooldownMs: 12_000 },
    // Ranged force CC + root (7s — shorter cd than non-root).
    { id: 'fs-combo-dm-cc-root', ability: 'fs_dm_cc_6_root', fallbackCooldownMs: 7_000 },
    // AoE force damage.
    { id: 'fs-combo-maelstrom', ability: 'fs_maelstrom_5', fallbackCooldownMs: 12_000 },
    // AoE force lightning (32m).
    { id: 'fs-combo-ae-dm-cc', ability: 'fs_ae_dm_cc_6', fallbackCooldownMs: 10_000 },
    // SABER AoE sweep.
    { id: 'fs-combo-sweep', ability: 'fs_sweep_7', fallbackCooldownMs: 7_000, when: SABER },
    // SABER basic specialty damage.
    { id: 'fs-combo-dm', ability: 'fs_dm_7', fallbackCooldownMs: 3_000, when: SABER },
    // Ranged saber throw.
    { id: 'fs-combo-force-throw', ability: 'forceThrow', fallbackCooldownMs: 3_000, when: SABER },
  ],
  filler: { id: 'fs-filler', ability: 'attack', fallbackCooldownMs: 1_500 },
  panic: {
    heal: {
      id: 'fs-panic-heal',
      ability: 'fs_sh_3',
      fallbackCooldownMs: 25_000,
      target: 'self',
    },
    // saberBlock + fs_saber_reflect_buff are the real Jedi defensives;
    // centerOfBeing is a Commando heavy-weapon ability (verified in
    // command_table.tab cols: combat_ranged/HEAVY classification), NOT
    // a Jedi command.
    defensive: {
      id: 'fs-panic-saber-block',
      ability: 'saberBlock',
      fallbackCooldownMs: 60_000,
      target: 'self',
    },
    cleanse: {
      id: 'fs-panic-hermetic-touch',
      ability: 'fs_hermetic_touch',
      fallbackCooldownMs: 40_000,
      target: 'self',
    },
    flee: { id: 'fs-panic-flee', ability: 'forceRun', fallbackCooldownMs: 45_000, target: 'self' },
  },
  signatureAbilities: ['fs_flurry_7', 'fs_dm_cc_6_root', 'fs_sweep_7', 'fs_sh_3'],
};
