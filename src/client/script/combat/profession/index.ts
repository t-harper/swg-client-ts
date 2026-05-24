/**
 * Per-profession rotations. Each rotation is a static `Rotation` value;
 * the bundle indexes them by `ProfessionId` for `installCombatBehavior` to
 * resolve at install time.
 *
 * Ability names + cooldown groups were validated against
 * `~/code/swg-main/dsrc/sku.0/sys.shared/compiled/game/datatables/command/command_table.tab`
 * as of the Phase 2 ability research. The server's `command_series.tab`
 * auto-substitutes lower tiers when the base name is sent, so authors can
 * write the highest tier they expect the character to own.
 */

import type { ProfessionId, Rotation } from '../types.js';
import { bountyHunter } from './bounty-hunter.js';
import { commando } from './commando.js';
import { jedi } from './jedi.js';
import { officer } from './officer.js';
import { smuggler } from './smuggler.js';
import { spy } from './spy.js';

export const PROFESSION_ROTATIONS: Record<ProfessionId, Rotation> = {
  bounty_hunter: bountyHunter,
  commando,
  spy,
  smuggler,
  officer,
  jedi,
};

/** Look up the bundled rotation for a profession id. Throws on unknown. */
export function resolveProfessionRotation(id: ProfessionId): Rotation {
  const rotation = PROFESSION_ROTATIONS[id];
  if (rotation === undefined) {
    throw new Error(`combat: no bundled rotation for profession '${id}'`);
  }
  return rotation;
}

export { bountyHunter, commando, jedi, officer, smuggler, spy };
