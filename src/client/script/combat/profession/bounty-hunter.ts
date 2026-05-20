/**
 * Bounty Hunter rotation — ranged kiter with debuff opener and crit burst.
 *
 * Style: stand at ~22–28m, lead with armor-break + duelist-stance self-buff,
 * then crit-chain `bh_dm_crit_8` / `bh_dm_8`. Refresh `bh_dread_strike_5`
 * every 30s for sustained armor-break uptime. Heal via `bh_sh_3` (25s).
 *
 * Weapon: HEAVY recommended for most signature abilities, but the listed
 * combo doesn't have hard weapon gates — `attack` falls back to whatever
 * is equipped. Carbine/pistol-only variants (`bh_relentless_1`,
 * `bh_cover_1`) are omitted from the default rotation; users can override.
 *
 * Cooldown groups per `command_table.tab` col 87 — sharing means using one
 * tier locks the entire family.
 */

import type { Rotation } from '../types.js';

export const bountyHunter: Rotation = {
  profession: 'bounty_hunter',
  opener: [
    {
      id: 'bh-self-armor-duelist',
      ability: 'bh_armor_duelist_5',
      fallbackCooldownMs: 120_000,
      target: 'self',
    },
    {
      id: 'bh-open-dread-strike',
      ability: 'bh_dread_strike_5',
      fallbackCooldownMs: 30_000,
    },
  ],
  combo: [
    // Refresh armor-debuff aggressively — primary damage modifier.
    { id: 'bh-combo-dread-strike', ability: 'bh_dread_strike_5', fallbackCooldownMs: 30_000 },
    // Execute when off cooldown — high single-hit damage.
    { id: 'bh-combo-flawless', ability: 'bh_flawless_strike', fallbackCooldownMs: 54_000 },
    // Crit specialty — 6s recharge, fires often.
    { id: 'bh-combo-crit', ability: 'bh_dm_crit_8', fallbackCooldownMs: 6_000 },
    // Damage + CC every 15s.
    { id: 'bh-combo-dm-cc', ability: 'bh_dm_cc_3', fallbackCooldownMs: 15_000 },
    // Delayed AoE damage + DoT — drop when multi-target.
    { id: 'bh-combo-del-cc-dot', ability: 'bh_del_dm_cc_dot_3', fallbackCooldownMs: 15_000 },
    // Single-target debuff stack.
    { id: 'bh-combo-intimidate', ability: 'bh_intimidate_6', fallbackCooldownMs: 60_000 },
    { id: 'bh-combo-fumble', ability: 'bh_fumble_6', fallbackCooldownMs: 30_000 },
    { id: 'bh-combo-stun', ability: 'bh_stun_5', fallbackCooldownMs: 30_000 },
    // Basic specialty damage — short cooldown filler.
    { id: 'bh-combo-dm', ability: 'bh_dm_8', fallbackCooldownMs: 3_000 },
  ],
  filler: { id: 'bh-filler', ability: 'attack', fallbackCooldownMs: 1_500 },
  panic: {
    heal: {
      id: 'bh-panic-heal',
      ability: 'bh_sh_3',
      fallbackCooldownMs: 25_000,
      target: 'self',
    },
    defensive: {
      id: 'bh-panic-shield',
      ability: 'bh_shields_1',
      fallbackCooldownMs: 180_000,
      target: 'self',
    },
    flee: { id: 'bh-panic-flee', ability: 'burstRun', fallbackCooldownMs: 600_000, target: 'self' },
  },
  signatureAbilities: ['bh_dread_strike_5', 'bh_dm_crit_8', 'bh_dm_8', 'bh_sh_3'],
};
