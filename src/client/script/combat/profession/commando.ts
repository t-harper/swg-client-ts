/**
 * Commando rotation — heavy-weapon AoE with armor-break opener and
 * grenade/cluster-bomb sustained damage.
 *
 * Style: open with `co_stand_fast` (10-min self-buff, once/fight) and
 * `co_killing_spree`, then armor-break (`co_armor_cracker`), then keep
 * AoE pressure with `co_shock_grenade_4` / `co_cluster_bomb` / delayed-AoE
 * variants. Heavy-weapon-specific damage (`co_hw_*`) only fires when a
 * `heavy_directional` weapon is equipped; falls back to `co_dm_8` /
 * `co_ae_dm_3` (ranged-weapon variants) otherwise.
 *
 * Heal: `co_sh_3` (12s).
 */

import type { Rotation, TickSample } from '../types.js';

const HEAVY_DIRECTIONAL = (s: TickSample): boolean => s.weapon === 'heavy_directional';

export const commando: Rotation = {
  profession: 'commando',
  opener: [
    {
      id: 'co-self-stand-fast',
      ability: 'co_stand_fast',
      fallbackCooldownMs: 600_000,
      target: 'self',
    },
    {
      id: 'co-self-stim-armor',
      ability: 'co_stim_armor',
      fallbackCooldownMs: 64_000,
      target: 'self',
    },
    {
      id: 'co-self-killing-spree',
      ability: 'co_killing_spree',
      fallbackCooldownMs: 15_000,
      target: 'self',
    },
    { id: 'co-open-armor-cracker', ability: 'co_armor_cracker', fallbackCooldownMs: 13_000 },
  ],
  combo: [
    // Refresh armor-break — primary multi-target damage modifier.
    { id: 'co-combo-armor-cracker', ability: 'co_armor_cracker', fallbackCooldownMs: 13_000 },
    // Heavy-weapon crit — best damage when equipped.
    {
      id: 'co-combo-hw-crit',
      ability: 'co_hw_dm_crit_6',
      fallbackCooldownMs: 12_000,
      when: HEAVY_DIRECTIONAL,
    },
    // Heavy-weapon basic damage — short cooldown.
    {
      id: 'co-combo-hw-dm',
      ability: 'co_hw_dm_6',
      fallbackCooldownMs: 3_000,
      when: HEAVY_DIRECTIONAL,
    },
    // Ranged-weapon fallback when no heavy weapon equipped.
    { id: 'co-combo-dm', ability: 'co_dm_8', fallbackCooldownMs: 3_000 },
    // Delayed AoE damage at 30m — drop when 2+ targets clustered.
    { id: 'co-combo-del-ae-dm', ability: 'co_del_ae_dm_3', fallbackCooldownMs: 15_000 },
    // Delayed AoE CC.
    { id: 'co-combo-del-ae-cc', ability: 'co_del_ae_cc_2_2', fallbackCooldownMs: 15_000 },
    // AoE shock — 5s recharge, target-free.
    {
      id: 'co-combo-shock-grenade',
      ability: 'co_shock_grenade_4',
      fallbackCooldownMs: 5_000,
      target: 'none',
    },
    // Centered AoE damage.
    { id: 'co-combo-ae-dm', ability: 'co_ae_dm_3', fallbackCooldownMs: 7_000 },
    // Cluster bomb (35m AoE).
    { id: 'co-combo-cluster-bomb', ability: 'co_cluster_bomb', fallbackCooldownMs: 5_000 },
    // Remote detonator (20s).
    { id: 'co-combo-remote-det', ability: 'co_remote_detonator_5', fallbackCooldownMs: 20_000 },
  ],
  filler: { id: 'co-filler', ability: 'attack', fallbackCooldownMs: 1_500 },
  panic: {
    heal: {
      id: 'co-panic-heal',
      ability: 'co_sh_3',
      fallbackCooldownMs: 12_000,
      target: 'self',
    },
    defensive: {
      id: 'co-panic-mirror-armor',
      ability: 'co_mirror_armor',
      fallbackCooldownMs: 180_000,
      target: 'self',
    },
    flee: { id: 'co-panic-flee', ability: 'burstRun', fallbackCooldownMs: 600_000, target: 'self' },
  },
  signatureAbilities: ['co_armor_cracker', 'co_dm_8', 'co_shock_grenade_4', 'co_sh_3'],
};
